/**
 * 鉴权闸门 + 登录/改密页面 + 账号接口。
 *
 * 两种凭据并存，各管一件事：
 *   - 用户名密码 → 人用，签发签名会话 Cookie（kb_session）
 *   - 访问令牌   → 脚本 / Agent 用，Cookie kb_token 或 Authorization: Bearer
 *
 * 强制改密只约束「人」：令牌持有者本来就能读整库，要求它改密没有意义。
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthError, AuthService, type PublicUser, type Role, type UserRecord,
} from './core/auth.ts';
import { changePasswordPage, loginPage } from './auth-pages.ts';

export interface AuthPluginOpts {
  service: AuthService;
  /** 机器凭据；空字符串表示不启用令牌 */
  token?: string;
  /** 是否启用用户名密码登录（没有账号时为 false） */
  passwordEnabled?: boolean;
  tokenCookie?: string;
  sessionCookie?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    habitatUser: UserRecord | null;
  }
  interface FastifyInstance {
    habitatAuth: AuthService;
    /** 是否启用了用户名密码登录（没有账号时为 false） */
    habitatPasswordAuth: boolean;
    /** 是否启用了访问令牌 */
    habitatTokenAuth: boolean;
  }
}

const MAX_AGE = 2_592_000; // 30 天

function cookieOf(req: FastifyRequest, key: string): string {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== key) continue;
    const v = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return '';
}

function bearerOf(req: FastifyRequest): string {
  const h = req.headers.authorization ?? '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const x = req.headers['x-kb-token'];
  return typeof x === 'string' ? x.trim() : '';
}

/** 定长比较，不给按字节试探留口子 */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function acceptsHtml(req: FastifyRequest): boolean {
  return String(req.headers.accept ?? '').includes('text/html');
}

function cookieHeader(req: FastifyRequest, name: string, value: string, maxAge: number): string {
  const secure = String(req.headers['x-forwarded-proto'] ?? '').includes('https');
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (secure ? '; Secure' : '');
}

function fieldsOf(body: unknown): Record<string, string> {
  const parse = (s: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(s)) out[k] = v;
    return out;
  };
  // 表单是 urlencoded；JSON 客户端也可能来打同一个口
  if (Buffer.isBuffer(body)) return parse(body.toString('utf8'));
  if (typeof body === 'string') return parse(body);
  if (body && typeof body === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    }
    return out;
  }
  return {};
}

/** 只允许站内路径：`//evil.com`、反斜杠、控制字符一律回首页 */
function safeNext(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s || s.length > 2000) return '/';
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\')) return '/';
  if (/[\u0000-\u001f]/.test(s)) return '/';
  return s;
}

/**
 * 判断一个写请求是不是跨站。
 *
 * 不能只看 Origin：手机浏览器 / 隐私模式 / 某些 WebView 在同源表单提交时也会发 `Origin: null`。
 * 之前直接 `new URL('null')` 会抛错，把正常登录拦成 403（生产事故）。
 *
 * Sec-Fetch-Site 是浏览器强制写入的 forbidden header，优先用它：
 *   same-origin / none → 同源；same-site / cross-site → 跨站。
 * 老浏览器没有这个头，再退回 Origin 与 Host / X-Forwarded-Host 比较；
 * Origin 缺失或为 null 时不在这里拦，会话 Cookie 还有 SameSite=Lax 兜底。
 */
function crossOrigin(req: FastifyRequest): boolean {
  const site = String(req.headers['sec-fetch-site'] ?? '').trim().toLowerCase();
  if (site === 'same-origin' || site === 'none') return false;
  if (site === 'same-site' || site === 'cross-site') return true;

  const origin = String(req.headers.origin ?? '').trim();
  if (!origin || origin === 'null') return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
    const host = (forwarded || String(req.headers.host ?? '')).toLowerCase();
    return u.host.toLowerCase() !== host;
  } catch {
    return true;
  }
}

export const authPlugin = fp<AuthPluginOpts>(async (app: FastifyInstance, opts: AuthPluginOpts) => {
  const service = opts.service;
  const token = (opts.token ?? '').trim();
  const passwordEnabled = opts.passwordEnabled ?? service.enabled;
  const tokenCookie = opts.tokenCookie?.trim() || 'kb_token';
  const sessionCookie = opts.sessionCookie?.trim() || 'kb_session';
  const active = Boolean(token) || passwordEnabled;

  app.decorate('habitatAuth', service);
  app.decorate('habitatPasswordAuth', passwordEnabled);
  app.decorate('habitatTokenAuth', Boolean(token));
  app.decorateRequest('habitatUser', null);

  // 登录表单是 urlencoded。Fastify 默认只认 JSON，不显式注册就会 415；
  // 这也顺手修掉了旧版「表单提交一直提示令牌不对」的根因。
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body),
    );
  }

  // 登录页 / 账号接口一律不走缓存：里面可能有临时密码与会话状态
  app.addHook('onSend', async (req, reply, payload) => {
    const url = req.url.split('?')[0];
    if (url === '/login' || url === '/change-password' || url === '/logout' || url.startsWith('/api/auth/')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  const sessionOf = (req: FastifyRequest): { user: UserRecord } | null =>
    service.readSession(cookieOf(req, sessionCookie) || bearerOf(req));

  const tokenOk = (req: FastifyRequest): boolean =>
    Boolean(token) && (sameSecret(bearerOf(req), token) || sameSecret(cookieOf(req, tokenCookie), token));

  const html = (reply: FastifyReply, code: number, body: string): FastifyReply =>
    reply.code(code)
      .header('cache-control', 'no-store')
      .header('x-frame-options', 'DENY')
      .type('text/html; charset=utf-8')
      .send(body);

  const loginError = (
    reply: FastifyReply,
    code: number,
    message: string,
    extra: { username?: string; next?: string; mode?: 'password' | 'token'; lockedSeconds?: number } = {},
  ): FastifyReply => html(reply, code, loginPage({
    passwordEnabled,
    tokenEnabled: Boolean(token),
    error: message,
    ...extra,
  }));

  /* ---------------- 页面 ---------------- */

  app.get('/login', async (req, reply) => {
    if (!active) return reply.redirect('/');
    const q = (req.query ?? {}) as { token?: string; next?: string; mode?: string; bye?: string };
    const next = safeNext(q.next);

    // 老链接 ?token=… 继续可用，省得手机上再粘一遍
    if (q.token && token) {
      const tkey = `token:${req.ip}`;
      const gate = service.throttle.check(tkey);
      if (gate.locked) {
        reply.header('retry-after', String(gate.retryAfter));
        return html(reply, 429, loginPage({
          passwordEnabled,
          tokenEnabled: Boolean(token),
          error: `尝试次数过多，请 ${Math.max(1, Math.ceil(gate.retryAfter / 60))} 分钟后再试。`,
          lockedSeconds: gate.retryAfter,
          next,
        }));
      }
      if (token && sameSecret(q.token.trim(), token)) {
        service.throttle.succeed(tkey);
        reply.header('set-cookie', [
          cookieHeader(req, tokenCookie, token, MAX_AGE),
          cookieHeader(req, sessionCookie, '', 0),
        ]);
        return reply.redirect(next);
      }
      service.throttle.fail(tkey);
      return html(reply, 401, loginPage({
        passwordEnabled,
        tokenEnabled: Boolean(token),
        error: '令牌不对，再试一次。',
        mode: 'token',
        next,
      }));
    }

    // 已经用令牌登录过：直接进，不必再看一次登录页
    if (tokenOk(req)) return reply.redirect(next);

    const s = sessionOf(req);
    if (s && !tokenOk(req)) {
      const change = service.changeState(s.user);
      if (change.required) return reply.redirect(`/change-password?next=${encodeURIComponent(next)}`);
      return reply.redirect(next);
    }

    return html(reply, 200, loginPage({
      passwordEnabled,
      tokenEnabled: Boolean(token),
      mode: q.mode === 'token' ? 'token' : undefined,
      notice: q.bye ? '已退出登录。' : undefined,
      next,
    }));
  });

  app.post('/login', async (req, reply) => {
    if (!active) return reply.redirect('/');
    const f = fieldsOf(req.body);
    const next = safeNext(f.next);
    const mode = f.mode === 'token' || (!passwordEnabled && token) ? 'token' : 'password';
    // 登录 CSRF：别人诱导你登进他的账号。Origin 存在时必须是同源
    if (crossOrigin(req)) return loginError(reply, 403, '跨站请求被拒绝。', { next, mode });

    if (mode === 'token') {
      if (!token) return loginError(reply, 400, '没有配置访问令牌，请用用户名密码登录。', { next });
      const tkey = `token:${req.ip}`;
      const gate = service.throttle.check(tkey);
      if (gate.locked) {
        reply.header('retry-after', String(gate.retryAfter));
        return loginError(reply, 429, `尝试次数过多，请 ${Math.max(1, Math.ceil(gate.retryAfter / 60))} 分钟后再试。`, {
          next, mode: 'token', lockedSeconds: gate.retryAfter,
        });
      }
      if (!sameSecret(String(f.token ?? '').trim(), token)) {
        service.throttle.fail(tkey);
        return loginError(reply, 401, '令牌不对，再试一次。', { next, mode: 'token' });
      }
      service.throttle.succeed(tkey);
      reply.header('set-cookie', [
        cookieHeader(req, tokenCookie, token, MAX_AGE),
        cookieHeader(req, sessionCookie, '', 0),
      ]);
      return reply.redirect(next);
    }

    if (!passwordEnabled) {
      return loginError(reply, 400, '还没有启用用户名密码登录，请先用 habitat user add 建一个账号。', { next });
    }

    const username = String(f.username ?? '').trim();
    const password = String(f.password ?? '');
    if (!username || !password) {
      return loginError(reply, 400, '用户名和密码都要填。', { username, next });
    }

    const r = await service.authenticate(username, password, { ip: req.ip });
    if (!r.ok) {
      if (r.reason === 'locked') {
        const retry = r.retryAfter ?? 300;
        reply.header('retry-after', String(retry));
        return loginError(reply, 429, `尝试次数过多，请 ${Math.max(1, Math.ceil(retry / 60))} 分钟后再试。`, {
          username, next, lockedSeconds: retry,
        });
      }
      if (r.reason === 'disabled') {
        return loginError(reply, 403, '这个账号已停用，请联系管理员。', { username, next });
      }
      return loginError(reply, 401, '用户名或密码不对。', { username, next });
    }

    const user = r.user;
    const change = service.changeState(user);
    const sid = service.issueSession(user);
    reply.header('set-cookie', [
      cookieHeader(req, sessionCookie, sid, MAX_AGE),
      // 清掉旧的令牌 Cookie：同一浏览器里不该同时挂两种身份
      cookieHeader(req, tokenCookie, '', 0),
    ]);
    await service.touchLogin(user.username, req.ip);

    if (change.required) {
      return reply.redirect(`/change-password?next=${encodeURIComponent(next)}`);
    }
    return reply.redirect(next);
  });

  app.get('/logout', async (req, reply) => {
    reply.header('set-cookie', [
      cookieHeader(req, sessionCookie, '', 0),
      cookieHeader(req, tokenCookie, '', 0),
    ]);
    return reply.redirect('/login?bye=1');
  });

  app.get('/change-password', async (req, reply) => {
    if (!passwordEnabled) return reply.redirect('/');
    const s = sessionOf(req);
    if (!s) return reply.redirect(`/login?next=${encodeURIComponent('/')}`);
    const q = (req.query ?? {}) as { next?: string };
    return html(reply, 200, changePasswordPage({
      username: s.user.username,
      displayName: s.user.displayName,
      change: service.changeState(s.user),
      next: safeNext(q.next),
    }));
  });

  app.post('/change-password', async (req, reply) => {
    if (!passwordEnabled) return reply.redirect('/');
    const s = sessionOf(req);
    if (!s) return reply.redirect(`/login?next=${encodeURIComponent('/')}`);
    const f = fieldsOf(req.body);
    const next = safeNext(f.next);

    const render = (code: number, message: string): FastifyReply => html(reply, code, changePasswordPage({
      username: s.user.username,
      displayName: s.user.displayName,
      change: service.changeState(service.find(s.user.username) ?? s.user),
      error: message,
      next,
    }));

    if ((f.nextPassword ?? '') !== (f.confirm ?? '')) {
      return render(400, '两次输入的新密码不一致。');
    }
    try {
      const user = await service.changePassword(s.user.username, f.current ?? '', f.nextPassword ?? '');
      reply.header('set-cookie', cookieHeader(req, sessionCookie, service.issueSession(user), MAX_AGE));
      return reply.redirect(next);
    } catch (e) {
      if (e instanceof AuthError) {
        if (e.code === 'locked') reply.header('retry-after', String(e.detail?.retryAfter ?? 300));
        return render(e.status, e.message);
      }
      return render(500, `改密失败：${(e as Error).message}`);
    }
  });

  /* ---------------- 账号接口 ---------------- */

  const ownerOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const u = req.habitatUser;
    if (!u) {
      reply.code(403).send({ ok: false, code: 'session_required', error: '账号管理需要用管理员账号登录（访问令牌不能管理账号）' });
      return false;
    }
    if (u.role !== 'owner') {
      reply.code(403).send({ ok: false, code: 'forbidden', error: '只有 owner 能管理账号' });
      return false;
    }
    return true;
  };

  const fail = (reply: FastifyReply, e: unknown): FastifyReply => {
    if (e instanceof AuthError) {
      return reply.code(e.status).send({ ok: false, code: e.code, error: e.message, ...(e.detail ?? {}) });
    }
    return reply.code(500).send({ ok: false, error: (e as Error).message });
  };

  app.get('/api/auth/me', async (req) => {
    const user = req.habitatUser;
    return {
      ok: true,
      user: user ? service.publicUser(user) : null,
      auth: {
        mode: user ? 'password' : tokenOk(req) ? 'token' : active ? 'unknown' : 'none',
        password: passwordEnabled,
        token: Boolean(token),
      },
      change: user ? service.changeState(user) : null,
      canManageUsers: Boolean(user && user.role === 'owner'),
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    reply.header('set-cookie', [
      cookieHeader(req, sessionCookie, '', 0),
      cookieHeader(req, tokenCookie, '', 0),
    ]);
    return { ok: true };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const user = req.habitatUser;
    if (!user) return reply.code(401).send({ ok: false, code: 'session_required', error: '请先用账号登录' });
    const b = fieldsOf(req.body);
    try {
      const updated = await service.changePassword(user.username, b.currentPassword ?? b.current ?? '', b.newPassword ?? b.nextPassword ?? '');
      reply.header('set-cookie', cookieHeader(req, sessionCookie, service.issueSession(updated), MAX_AGE));
      return { ok: true, user: service.publicUser(updated) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/auth/users', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply;
    return {
      ok: true,
      users: service.list(),
      passwordDays: service.passwordDays,
      file: service.file,
    };
  });

  app.post('/api/auth/users', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply;
    const b = (req.body ?? {}) as { username?: string; displayName?: string; role?: Role; password?: string };
    try {
      const r = await service.addUser({
        username: String(b.username ?? ''),
        displayName: b.displayName ? String(b.displayName) : undefined,
        role: b.role === 'owner' ? 'owner' : 'member',
        password: b.password ? String(b.password) : undefined,
        mustChange: true,
        createdBy: req.habitatUser?.username ?? 'admin',
      });
      return reply.code(201).send({ ok: true, user: r.user, tempPassword: r.tempPassword });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.patch('/api/auth/users/:username', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply;
    const { username } = req.params as { username: string };
    const b = (req.body ?? {}) as { displayName?: string | null; role?: Role; disabled?: boolean; mustChangePassword?: boolean };
    try {
      const user: PublicUser = await service.updateUser(username, {
        displayName: b.displayName,
        role: b.role === 'owner' || b.role === 'member' ? b.role : undefined,
        disabled: typeof b.disabled === 'boolean' ? b.disabled : undefined,
        mustChangePassword: typeof b.mustChangePassword === 'boolean' ? b.mustChangePassword : undefined,
      }, req.habitatUser?.username);
      return { ok: true, user };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/auth/users/:username/reset', async (req, reply) => {
    if (!ownerOnly(req, reply)) return reply;
    const { username } = req.params as { username: string };
    const b = (req.body ?? {}) as { password?: string; mustChange?: boolean };
    try {
      const r = await service.resetPassword(username, {
        password: b.password ? String(b.password) : undefined,
        mustChange: b.mustChange !== false,
        by: req.habitatUser?.username ?? 'admin',
      });
      return { ok: true, user: r.user, tempPassword: r.tempPassword };
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ---------------- 闸门 ---------------- */

  app.addHook('onRequest', async (req, reply) => {
    if (!active) return;
    if (req.method === 'OPTIONS') return;
    const url = req.url.split('?')[0];
    if (url === '/healthz' || url === '/login' || url === '/logout' || url === '/change-password') return;
    // 分享出去的抽印本是公开面：只读页必须能被未登录的外部浏览器打开。
    // 这里只放行页面本身；/api/* 一律照旧要求登录，分享管理接口也在其中。
    if (url.startsWith('/s/')) return;
    // harness 的 MCP 回调只认 session token（Bearer），在 /api/agent/mcp 路由里自行校验。
    if (url === '/api/agent/mcp') return;
    // 远端 bridge 用一次性配对码加入；码在 /api/agent/bridge/join 路由里校验。
    if (url === '/api/agent/bridge/join') return;

    const isToken = tokenOk(req);
    if (isToken) return;

    if (req.method !== 'GET' && req.method !== 'HEAD' && crossOrigin(req)) {
      return reply.code(403).send({ ok: false, code: 'cross_origin', error: '跨站请求被拒绝' });
    }

    const session = sessionOf(req);
    if (!session) {
      if (url.startsWith('/api')) {
        return reply.code(401).send({
          ok: false,
          code: 'unauthenticated',
          error: '未登录：用账号登录，或带上令牌（Authorization: Bearer / X-KB-Token / Cookie kb_token）',
        });
      }
      if (req.method === 'GET' && acceptsHtml(req)) {
        return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
      }
      return reply.code(401).send({ ok: false, code: 'unauthenticated', error: '未登录' });
    }

    req.habitatUser = session.user;
    // 只放行「改密所必需」的三个接口；账号管理不在其列
    if (url === '/api/auth/me' || url === '/api/auth/logout' || url === '/api/auth/password') return;

    const change = service.changeState(session.user);
    if (!change.required) return;

    if (url.startsWith('/api')) {
      return reply.code(403).send({
        ok: false,
        code: 'password_change_required',
        error: change.message,
        change,
      });
    }
    if (req.method === 'GET' && acceptsHtml(req)) {
      return reply.redirect(`/change-password?next=${encodeURIComponent(req.url)}`);
    }
    return reply.code(403).send({ ok: false, code: 'password_change_required', error: change.message, change });
  });
});
