import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {
  AuthService, AuthError, hashPassword, verifyPassword, randomPassword,
} from '../../server/core/auth.ts';
import { authPlugin } from '../../server/auth.ts';
import { checkPassword } from '../../shared/password.ts';

const dirs: string[] = [];

async function tempService(opts: { passwordDays?: number; now?: () => Date } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'habitat-auth-'));
  dirs.push(dir);
  const svc = await AuthService.open({
    file: path.join(dir, 'auth.json'),
    passwordDays: opts.passwordDays ?? 0,
    now: opts.now,
  });
  return { svc, dir };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

function form(payload: Record<string, string>): string {
  return new URLSearchParams(payload).toString();
}

function cookieOf(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')];
  const hit = list.find((s) => s.startsWith(`${name}=`));
  return hit?.split(';')[0] ?? '';
}

describe('密码策略', () => {
  it('长度、字符类别、用户名与弱密码都挡住', () => {
    expect(checkPassword('short').ok).toBe(false);
    expect(checkPassword('abcdefghij').ok).toBe(false); // 10 位但只有一类
    expect(checkPassword('abcdefghij1').ok).toBe(true);
    expect(checkPassword('correct horse battery staple').ok).toBe(true); // 长口令放宽类别
    expect(checkPassword('alice12345', { username: 'alice' }).ok).toBe(false); // 含用户名
    expect(checkPassword('password', { username: 'bob' }).ok).toBe(false);
    expect(checkPassword('abcdefghij1', { current: 'abcdefghij1' }).ok).toBe(false);
    expect(checkPassword(' abcdefghij1').ok).toBe(false); // 首尾空格
  });

  it('临时密码本身能通过策略', () => {
    for (let i = 0; i < 20; i += 1) {
      const pw = randomPassword();
      expect(checkPassword(pw).ok, pw).toBe(true);
    }
  });
});

describe('密码哈希', () => {
  it('同一密码两次哈希不同，验证仍然通过', async () => {
    const a = await hashPassword('NewPassw0rd!23');
    const b = await hashPassword('NewPassw0rd!23');
    expect(a).not.toBe(b);
    expect(await verifyPassword('NewPassw0rd!23', a)).toBe(true);
    expect(await verifyPassword('NewPassw0rd!23', b)).toBe(true);
    expect(await verifyPassword('wrong', a)).toBe(false);
    expect(await verifyPassword('NewPassw0rd!23', 'scrypt$bad$bad$bad$bad$bad')).toBe(false);
  });
});

describe('账号与会话', () => {
  it('新建账号是临时密码；改密后旧密码与旧会话一起作废', async () => {
    const { svc } = await tempService();
    const r = await svc.addUser({ username: 'Alice', role: 'owner' });
    expect(r.tempPassword).toBeTruthy();
    expect(r.user.change).toMatchObject({ required: true, reason: 'initial' });

    const first = await svc.authenticate('alice', r.tempPassword!);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const session = svc.issueSession(first.user);
    expect(svc.readSession(session)?.user.username).toBe('Alice');

    await svc.changePassword('Alice', r.tempPassword!, 'NewPassw0rd!23');
    expect(svc.readSession(session)).toBeNull();
    expect((await svc.authenticate('Alice', r.tempPassword!)).ok).toBe(false);
    const next = await svc.authenticate('Alice', 'NewPassw0rd!23');
    expect(next.ok).toBe(true);
    if (next.ok) expect(svc.changeState(next.user).required).toBe(false);
  });

  it('密码超过有效期 → 必须改密', async () => {
    let now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const { svc } = await tempService({ passwordDays: 90, now: () => new Date(now) });
    await svc.addUser({ username: 'bob', password: 'NewPassw0rd!23', mustChange: false });
    const bob = svc.find('bob')!;
    expect(svc.changeState(bob).required).toBe(false);

    now += 91 * 86_400_000;
    const state = svc.changeState(bob);
    expect(state.required).toBe(true);
    expect(state.reason).toBe('expired');
    expect(state.message).toContain('90');
  });

  it('会话过期、被篡改、停用账号都会失效', async () => {
    const { svc } = await tempService();
    const r = await svc.addUser({ username: 'carol', role: 'member', password: 'NewPassw0rd!23', mustChange: false });
    const user = svc.find('carol')!;
    const s = svc.issueSession(user, 60);
    expect(svc.readSession(s)).not.toBeNull();
    expect(svc.readSession(`${s}x`)).toBeNull();

    await svc.updateUser('carol', { disabled: true }, 'admin');
    expect(svc.readSession(s)).toBeNull();
    expect((await svc.authenticate('carol', 'NewPassw0rd!23')).ok).toBe(false);
    expect(r.user.username).toBe('carol');
  });

  it('连续失败 5 次后锁定，且锁定期间正确密码也进不去', async () => {
    const { svc } = await tempService();
    const r = await svc.addUser({ username: 'dave', password: 'NewPassw0rd!23', mustChange: false });
    for (let i = 0; i < 5; i += 1) {
      const bad = await svc.authenticate('dave', 'wrong-password');
      expect(bad.ok).toBe(false);
    }
    const locked = await svc.authenticate('dave', 'NewPassw0rd!23');
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.reason).toBe('locked');
      expect(locked.retryAfter).toBeGreaterThan(0);
    }
    expect(r.user.username).toBe('dave');
  });

  it('不能停用最后一个 owner', async () => {
    const { svc } = await tempService();
    await svc.addUser({ username: 'owner1', role: 'owner', password: 'NewPassw0rd!23', mustChange: false });
    await expect(svc.updateUser('owner1', { disabled: true }, 'cli')).rejects.toBeInstanceOf(AuthError);
    await expect(svc.updateUser('owner1', { role: 'member' }, 'cli')).rejects.toBeInstanceOf(AuthError);
  });
});

describe('HTTP 闸门与强制改密', () => {
  async function appWithAdmin() {
    const { svc } = await tempService();
    const boot = await svc.bootstrapAdmin({ username: 'admin' });
    const app = Fastify();
    await app.register(authPlugin, {
      service: svc,
      token: 'test-token',
      passwordEnabled: true,
      tokenCookie: 'kb_token',
      sessionCookie: 'kb_session',
    });
    app.get('/api/ping', async () => ({ pong: true }));
    app.get('/', async () => ({ page: 'home' }));
    await app.ready();
    return { app, svc, tempPassword: boot.tempPassword! };
  }

  it('未登录跳登录页；表单登录后强制改密；改完才放行 API', async () => {
    const { app, tempPassword } = await appWithAdmin();
    try {
      const unauth = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
      expect(unauth.statusCode).toBe(302);
      expect(unauth.headers.location).toBe('/login?next=%2F');

      const page = await app.inject({ method: 'GET', url: '/login' });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('用户名');

      const wrong = await app.inject({
        method: 'POST', url: '/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ username: 'admin', password: 'wrong-password' }),
      });
      expect(wrong.statusCode).toBe(401);

      const login = await app.inject({
        method: 'POST', url: '/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ username: 'admin', password: tempPassword }),
      });
      expect(login.statusCode).toBe(302);
      expect(login.headers.location).toContain('/change-password');
      const firstCookie = cookieOf(login, 'kb_session');
      expect(firstCookie).not.toBe('');

      const blocked = await app.inject({ method: 'GET', url: '/api/ping', headers: { cookie: firstCookie } });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json()).toMatchObject({ code: 'password_change_required' });

      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: firstCookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.username).toBe('admin');
      expect(me.json().change.required).toBe(true);

      const changed = await app.inject({
        method: 'POST', url: '/change-password',
        headers: { cookie: firstCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ current: tempPassword, nextPassword: 'NewPassw0rd!23', confirm: 'NewPassw0rd!23' }),
      });
      expect(changed.statusCode).toBe(302);
      expect(changed.headers.location).toBe('/');
      const nextCookie = cookieOf(changed, 'kb_session');
      expect(nextCookie).not.toBe(firstCookie);

      const ok = await app.inject({ method: 'GET', url: '/api/ping', headers: { cookie: nextCookie } });
      expect(ok.statusCode).toBe(200);

      const stale = await app.inject({ method: 'GET', url: '/api/ping', headers: { cookie: firstCookie } });
      expect(stale.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('手机浏览器 Origin: null 的同源表单能登录；真正跨站仍拦', async () => {
    const { app, tempPassword } = await appWithAdmin();
    try {
      // 三星浏览器 / 隐私模式 / 某些 WebView：同源表单也会带 Origin: null
      const mobile = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'null',
          'sec-fetch-site': 'same-origin',
        },
        payload: form({ username: 'admin', password: tempPassword, mode: 'password' }),
      });
      expect(mobile.statusCode).toBe(302);
      expect(mobile.headers.location).toContain('/change-password');

      const evil = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
        payload: form({ username: 'admin', password: tempPassword, mode: 'password' }),
      });
      expect(evil.statusCode).toBe(403);

      // 老浏览器没有 Sec-Fetch-Site：退回 Origin/Host 比较，跨站照样拦
      const evilLegacy = await app.inject({
        method: 'POST',
        url: '/login',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'https://evil.example',
        },
        payload: form({ username: 'admin', password: tempPassword, mode: 'password' }),
      });
      expect(evilLegacy.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('令牌不受强制改密限制；但不能管理账号', async () => {
    const { app } = await appWithAdmin();
    try {
      const ping = await app.inject({
        method: 'GET', url: '/api/ping',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(ping.statusCode).toBe(200);

      const users = await app.inject({
        method: 'GET', url: '/api/auth/users',
        headers: { authorization: 'Bearer test-token' },
      });
      expect(users.statusCode).toBe(403);
      expect(users.json().code).toBe('session_required');
    } finally {
      await app.close();
    }
  });

  it('令牌链接仍可用；错误令牌会被节流', async () => {
    const { app } = await appWithAdmin();
    try {
      const good = await app.inject({ method: 'GET', url: '/login?token=test-token' });
      expect(good.statusCode).toBe(302);
      expect(good.headers.location).toBe('/');
      expect(cookieOf(good, 'kb_token')).toBe('kb_token=test-token');

      for (let i = 0; i < 5; i += 1) {
        const bad = await app.inject({ method: 'GET', url: '/login?token=wrong' });
        expect(bad.statusCode).toBe(401);
      }
      const locked = await app.inject({ method: 'GET', url: '/login?token=wrong' });
      expect(locked.statusCode).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('owner 建号 / 重置；新账号首次登录必须改密；member 不能看账号列表', async () => {
    const { app, tempPassword } = await appWithAdmin();
    try {
      const login = await app.inject({
        method: 'POST', url: '/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ username: 'admin', password: tempPassword }),
      });
      const firstCookie = cookieOf(login, 'kb_session');
      const changed = await app.inject({
        method: 'POST', url: '/change-password',
        headers: { cookie: firstCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ current: tempPassword, nextPassword: 'NewPassw0rd!23', confirm: 'NewPassw0rd!23' }),
      });
      const adminCookie = cookieOf(changed, 'kb_session');

      const created = await app.inject({
        method: 'POST', url: '/api/auth/users',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        payload: { username: 'bob', displayName: 'Bob', role: 'member' },
      });
      expect(created.statusCode).toBe(201);
      const bobTemp = created.json().tempPassword as string;
      expect(bobTemp).toBeTruthy();
      expect(created.json().user.change.required).toBe(true);

      const bobLogin = await app.inject({
        method: 'POST', url: '/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ username: 'bob', password: bobTemp }),
      });
      expect(bobLogin.headers.location).toContain('/change-password');
      const bobFirst = cookieOf(bobLogin, 'kb_session');

      const bobChanged = await app.inject({
        method: 'POST', url: '/change-password',
        headers: { cookie: bobFirst, 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ current: bobTemp, nextPassword: 'RobertPassw0rd!23', confirm: 'RobertPassw0rd!23' }),
      });
      const bobCookie = cookieOf(bobChanged, 'kb_session');

      const denied = await app.inject({ method: 'GET', url: '/api/auth/users', headers: { cookie: bobCookie } });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe('forbidden');

      const reset = await app.inject({
        method: 'POST', url: '/api/auth/users/bob/reset',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        payload: {},
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().tempPassword).toBeTruthy();
      // 重置后 bob 的旧会话立即失效
      const stale = await app.inject({ method: 'GET', url: '/api/ping', headers: { cookie: bobCookie } });
      expect(stale.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
