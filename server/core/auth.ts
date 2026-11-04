/**
 * 账号、密码与会话。
 *
 * 为什么放在 ~/.habitat 而不是空间目录：密码哈希不该躺在常被同步到云盘的数据目录里；
 * 而且一个进程可以有多个空间共用同一套登录。路径用 HABITAT_AUTH_FILE 可覆盖。
 *
 * 密码：scrypt(N=32768, r=8, p=1) + 16 字节随机盐，格式里带参数，
 *       以后调参不影响老密码验证。
 * 会话：`base64url(payload).hmac` 的签名 Cookie，服务端无状态、重启不掉线；
 *       改密 / 停用账号时 pwv+1，旧会话立刻失效。
 * 强制改密：mustChangePassword 标记，或 passwordUpdatedAt 超过有效期。
 *       令牌（HABITAT_TOKEN）是机器凭据，不受这条限制。
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkPassword, PASSWORD_MAX } from '../../shared/password.ts';

export type Role = 'owner' | 'member';

export interface UserRecord {
  username: string;
  displayName?: string;
  role: Role;
  /** scrypt$N$r$p$salt$hash；只存在这个文件里，不出接口 */
  hash: string;
  /** 密码版本：改密 / 停用 +1，用来一次性踢掉旧会话 */
  pwv: number;
  mustChangePassword: boolean;
  passwordUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  lastLoginAt?: string | null;
  lastLoginIp?: string | null;
  disabled?: boolean;
}

export interface PasswordChangeState {
  required: boolean;
  reason: 'initial' | 'admin' | 'expired' | null;
  /** 给界面直接显示的一句话 */
  message: string;
  changedAt: string | null;
  expiresAt: string | null;
  /** 已经用了多少天；没有改过密码时为 null */
  daysUsed: number | null;
  /** 距离过期还有多少天；不启用有效期时为 null */
  daysLeft: number | null;
}

export interface PublicUser {
  username: string;
  displayName?: string;
  role: Role;
  disabled: boolean;
  mustChangePassword: boolean;
  passwordUpdatedAt: string | null;
  passwordExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  change: PasswordChangeState;
}

export interface CredentialResult {
  user: PublicUser;
  /** 仅新建 / 重置时返回一次；之后再也拿不到 */
  tempPassword?: string;
}

export type AuthErrorCode =
  | 'not_found' | 'duplicate' | 'invalid_username' | 'weak_password'
  | 'bad_current_password' | 'locked' | 'self' | 'last_owner' | 'disabled';

export class AuthError extends Error {
  constructor(
    public code: AuthErrorCode,
    message: string,
    public status = 400,
    public detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };
const DAY_MS = 86_400_000;
const SESSION_TTL = 30 * 86_400;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface AuthFile {
  version: 1;
  /** 会话 Cookie 的 HMAC 密钥；随文件持久化，重启后会话还在 */
  secret: string;
  users: UserRecord[];
}

export interface AuthOpenOpts {
  file?: string;
  passwordDays?: number;
  now?: () => Date;
}

export function defaultAuthFile(): string {
  return process.env.HABITAT_AUTH_FILE?.trim() || path.join(os.homedir(), '.habitat', 'auth.json');
}

export function defaultPasswordDays(): number {
  const raw = process.env.HABITAT_PASSWORD_DAYS;
  if (raw === undefined || raw === '') return 90;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 90;
  return Math.min(3650, Math.floor(n));
}

export type AuthMode = 'auto' | 'on' | 'off';

/** auto：有账号就开；on：没账号也开（首次启动造一个管理员）；off：只留令牌 */
export function normalizeAuthMode(raw: string | undefined): AuthMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'on' || v === 'password' || v === 'users' || v === '1' || v === 'true') return 'on';
  if (v === 'off' || v === 'none' || v === 'token' || v === '0' || v === 'false') return 'off';
  return 'auto';
}

/* ---------------- 密码哈希 ---------------- */

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // 防止被篡改的文件让进程去算一个天价参数（等于自带 DoS）
  if (!Number.isInteger(N) || N < 1024 || N > 1 << 20) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32) return false;
  if (!Number.isInteger(p) || p < 1 || p > 16) return false;
  let salt: Buffer;
  let want: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    want = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (salt.length < 8 || salt.length > 64 || want.length < 16 || want.length > 128) return false;
  let got: Buffer;
  try {
    got = await scryptAsync(password, salt, want.length, { N, r, p, maxmem: SCRYPT.maxmem });
  } catch {
    return false;
  }
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** 临时密码：去掉 0/O/1/l/I 这类看错的字符，四段一组方便手输 */
export function randomPassword(chars = 16): string {
  let out = '';
  for (let i = 0; i < chars; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out.match(/.{1,4}/g)?.join('-') ?? out;
}

/* ---------------- 用户名 ---------------- */

export function normalizeUsername(name: string): string {
  return name.trim().toLowerCase();
}

export function validateUsername(name: string): string[] {
  const v = name.trim();
  const problems: string[] = [];
  if (v.length < 2 || v.length > 32) problems.push('用户名长度 2–32 个字符');
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(v)) problems.push('只能包含字母、数字、中文、点、下划线和短横线，且以字母或数字开头');
  return problems;
}

/* ---------------- 登录节流 ---------------- */

export class LoginThrottle {
  private hits = new Map<string, { count: number; lockedUntil: number; lastAt: number }>();

  constructor(
    private limit = 5,
    private baseMs = 5 * 60_000,
    private maxMs = 30 * 60_000,
  ) {}

  check(key: string, now = Date.now()): { locked: boolean; retryAfter: number; remaining: number } {
    const h = this.hits.get(key);
    if (!h) return { locked: false, retryAfter: 0, remaining: this.limit };
    if (h.lockedUntil) {
      if (h.lockedUntil > now) {
        return {
          locked: true,
          retryAfter: Math.ceil((h.lockedUntil - now) / 1000),
          remaining: 0,
        };
      }
      // 锁过期，重新计数：等了五分钟的人不该只差一次就又被锁
      this.hits.delete(key);
      return { locked: false, retryAfter: 0, remaining: this.limit };
    }
    return { locked: false, retryAfter: 0, remaining: Math.max(0, this.limit - h.count) };
  }

  fail(key: string, now = Date.now()): void {
    const h = this.hits.get(key) ?? { count: 0, lockedUntil: 0, lastAt: now };
    h.count += 1;
    h.lastAt = now;
    if (h.count >= this.limit) {
      const over = h.count - this.limit;
      h.lockedUntil = now + Math.min(this.maxMs, this.baseMs * 2 ** Math.min(over, 4));
    }
    this.hits.set(key, h);
    if (this.hits.size > 2000) {
      for (const [k, v] of this.hits) if (now - v.lastAt > 3_600_000) this.hits.delete(k);
    }
  }

  succeed(key: string): void {
    this.hits.delete(key);
  }
}

/* ---------------- 账号服务 ---------------- */

function nowISO(clock: () => Date): string {
  return clock().toISOString();
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

let dummyHash: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(24).toString('base64url'));
  return dummyHash;
}

export class AuthService {
  readonly throttle = new LoginThrottle();

  private constructor(
    public readonly file: string,
    public readonly passwordDays: number,
    private data: AuthFile,
    private clock: () => Date,
  ) {}

  static async open(opts: AuthOpenOpts = {}): Promise<AuthService> {
    const file = opts.file ?? defaultAuthFile();
    const days = opts.passwordDays ?? defaultPasswordDays();
    const clock = opts.now ?? (() => new Date());
    let data: AuthFile = { version: 1, secret: crypto.randomBytes(32).toString('hex'), users: [] };

    let raw = '';
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`账号文件读不出来：${file}（${(e as Error).message}）`);
      }
    }
    let missingSecret = false;
    if (raw.trim()) {
      let parsed: Partial<AuthFile>;
      try {
        parsed = JSON.parse(raw) as Partial<AuthFile>;
      } catch (e) {
        // 宁可启动失败，也不能把坏文件当成「没有账号」然后悄悄重建一个管理员
        throw new Error(`账号文件不是合法 JSON：${file}（${(e as Error).message}）`);
      }
      if (!Array.isArray(parsed.users)) throw new Error(`账号文件缺少 users 数组：${file}`);
      const users = parsed.users.map((u, i) => normalizeUser(u, i, clock));
      missingSecret = !(typeof parsed.secret === 'string' && parsed.secret.length >= 32);
      data = {
        version: 1,
        secret: missingSecret ? crypto.randomBytes(32).toString('hex') : parsed.secret as string,
        users,
      };
    }

    const svc = new AuthService(file, days, data, clock);
    // 老文件没有 secret：立刻补上，否则每次重启会话都失效。
    // 文件不存在时不主动创建——本机开发不启用登录，不该凭空多一个凭据文件。
    if (missingSecret) await svc.save();
    return svc;
  }

  get path(): string {
    return this.file;
  }

  get enabled(): boolean {
    return this.data.users.length > 0;
  }

  hasUsers(): boolean {
    return this.data.users.length > 0;
  }

  count(): number {
    return this.data.users.length;
  }

  find(username: string): UserRecord | undefined {
    const key = normalizeUsername(username);
    if (!key) return undefined;
    return this.data.users.find((u) => normalizeUsername(u.username) === key);
  }

  require(username: string): UserRecord {
    const u = this.find(username);
    if (!u) throw new AuthError('not_found', `没有这个账号：${username}`, 404);
    return u;
  }

  list(): PublicUser[] {
    return [...this.data.users]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((u) => this.publicUser(u));
  }

  publicUser(user: UserRecord): PublicUser {
    const change = this.changeState(user);
    return {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      disabled: !!user.disabled,
      mustChangePassword: user.mustChangePassword,
      passwordUpdatedAt: user.passwordUpdatedAt,
      passwordExpiresAt: change.expiresAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt ?? null,
      lastLoginIp: user.lastLoginIp ?? null,
      change,
    };
  }

  /**
   * 现在这个账号是否必须先改密码。
   * 三种来源：管理员新建/重置（mustChangePassword）、密码超过有效期、没设过密码。
   */
  changeState(user: UserRecord, now = this.clock()): PasswordChangeState {
    const changedAt = user.passwordUpdatedAt ? new Date(user.passwordUpdatedAt) : null;
    const expiresAt = changedAt && this.passwordDays > 0
      ? new Date(changedAt.getTime() + this.passwordDays * DAY_MS)
      : null;
    const daysUsed = changedAt ? Math.max(0, Math.floor((now.getTime() - changedAt.getTime()) / DAY_MS)) : null;
    const daysLeft = expiresAt
      ? Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS))
      : null;

    if (user.mustChangePassword) {
      // 初始密码的时间戳就是创建时间；管理员重置会另有一个更新的时间戳
      const initial = !changedAt || Math.abs(changedAt.getTime() - new Date(user.createdAt).getTime()) < 2000;
      return {
        required: true,
        reason: initial ? 'initial' : 'admin',
        message: initial
          ? '首次登录，请先设置自己的密码。'
          : '管理员要求你更新密码，改完才能继续使用。',
        changedAt: changedAt?.toISOString() ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
        daysUsed,
        daysLeft,
      };
    }

    if (expiresAt && now.getTime() >= expiresAt.getTime()) {
      return {
        required: true,
        reason: 'expired',
        message: `密码已使用 ${daysUsed ?? this.passwordDays} 天，超过 ${this.passwordDays} 天有效期，请更新后再继续。`,
        changedAt: changedAt?.toISOString() ?? null,
        expiresAt: expiresAt.toISOString(),
        daysUsed,
        daysLeft: 0,
      };
    }

    return {
      required: false,
      reason: null,
      message: expiresAt ? `密码还有 ${daysLeft} 天到期。` : '密码长期有效。',
      changedAt: changedAt?.toISOString() ?? null,
      expiresAt: expiresAt?.toISOString() ?? null,
      daysUsed,
      daysLeft,
    };
  }

  /* ---------------- 认证 ---------------- */

  async authenticate(
    username: string,
    password: string,
    meta: { ip?: string } = {},
  ): Promise<
    | { ok: true; user: UserRecord }
    | { ok: false; reason: 'bad_credentials' | 'disabled' | 'locked'; retryAfter?: number; remaining?: number }
  > {
    const key = `login:${meta.ip ?? '-'}:${normalizeUsername(username)}`;
    const gate = this.throttle.check(key);
    if (gate.locked) return { ok: false, reason: 'locked', retryAfter: gate.retryAfter };
    // 超长输入不进入 scrypt：否则一个 8MB 的请求就能让每次登录都变慢
    if (password.length > PASSWORD_MAX * 2) {
      this.throttle.fail(key);
      return { ok: false, reason: 'bad_credentials' };
    }

    const user = this.find(username);
    // 用户不存在也照常算一次哈希：响应时间不泄露「这个名字存不存在」
    const hash = user?.hash ?? await dummyPasswordHash();
    const ok = await verifyPassword(password, hash);

    if (!user || !ok) {
      this.throttle.fail(key);
      return { ok: false, reason: 'bad_credentials', remaining: Math.max(0, gate.remaining - 1) };
    }
    if (user.disabled) return { ok: false, reason: 'disabled' };
    this.throttle.succeed(key);
    return { ok: true, user };
  }

  async touchLogin(username: string, ip?: string): Promise<void> {
    const u = this.find(username);
    if (!u) return;
    u.lastLoginAt = nowISO(this.clock);
    u.lastLoginIp = ip ?? null;
    u.updatedAt = u.lastLoginAt;
    // 登录时间写不进去不该让登录失败；密码变更则必须报错
    try {
      await this.save();
    } catch {
      /* 只影响「上次登录」这一行审计信息 */
    }
  }

  /* ---------------- 会话 ---------------- */

  issueSession(user: UserRecord, ttlSeconds = SESSION_TTL): string {
    const exp = Math.floor(this.clock().getTime() / 1000) + Math.max(60, ttlSeconds);
    const payload = Buffer.from(JSON.stringify({ u: user.username, v: user.pwv, exp })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  readSession(token: string): { user: UserRecord; exp: number } | null {
    const raw = token.trim();
    const dot = raw.lastIndexOf('.');
    if (dot <= 0) return null;
    const payload = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    if (!sameText(sig, this.sign(payload))) return null;

    let body: { u?: string; v?: number; exp?: number };
    try {
      body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof body;
    } catch {
      return null;
    }
    if (!body.u || typeof body.v !== 'number' || typeof body.exp !== 'number') return null;
    if (body.exp <= Math.floor(this.clock().getTime() / 1000)) return null;
    const user = this.find(body.u);
    if (!user || user.disabled) return null;
    // 改密 / 停用后 pwv 变了，旧 Cookie 到这里就作废
    if (user.pwv !== body.v) return null;
    return { user, exp: body.exp };
  }

  private sign(payload: string): string {
    return crypto.createHmac('sha256', this.data.secret).update(payload).digest('base64url');
  }

  /* ---------------- 写账号 ---------------- */

  async bootstrapAdmin(input: {
    username?: string;
    password?: string;
    displayName?: string;
    mustChange?: boolean;
  } = {}): Promise<CredentialResult> {
    if (this.hasUsers()) throw new AuthError('duplicate', '已经有账号了，不能重复初始化', 409);
    const username = (input.username ?? 'admin').trim() || 'admin';
    const nameProblems = validateUsername(username);
    if (nameProblems.length) throw new AuthError('invalid_username', `HABITAT_ADMIN_USER 不合法：${nameProblems[0]}`, 400);
    const provided = input.password?.trim() ? input.password : '';
    const temp = provided || randomPassword();
    const user = await this.makeUser({
      username,
      displayName: input.displayName ?? '管理员',
      role: 'owner',
      password: temp,
      // 环境变量给的初始密码同样视为临时凭据：必须改，避免「部署完就一直是它」
      mustChange: input.mustChange ?? true,
      createdBy: 'system',
    });
    // 哈希是异步的，期间可能有另一个初始化挤进来；落库前再确认一次
    if (this.hasUsers()) throw new AuthError('duplicate', '已经有账号了，不能重复初始化', 409);
    this.data.users.push(user);
    await this.save();
    return { user: this.publicUser(user), tempPassword: provided ? undefined : temp };
  }

  async addUser(input: {
    username: string;
    displayName?: string;
    role?: Role;
    password?: string;
    mustChange?: boolean;
    createdBy?: string;
  }): Promise<CredentialResult> {
    const username = input.username.trim();
    const problems = validateUsername(username);
    if (problems.length) throw new AuthError('invalid_username', problems[0], 400, { problems });
    if (this.find(username)) throw new AuthError('duplicate', `用户名已被占用：${username}`, 409);

    const generated = !input.password;
    const temp = input.password || randomPassword();
    if (!generated) {
      const check = checkPassword(temp, { username });
      if (!check.ok) throw new AuthError('weak_password', check.problems[0], 400, { problems: check.problems });
    }
    // 第一个账号默认 owner：否则启用密码登录后没有任何人能管理账号
    const hasOwner = this.data.users.some((u) => u.role === 'owner' && !u.disabled);
    const user = await this.makeUser({
      username,
      displayName: input.displayName,
      role: input.role ?? (hasOwner ? 'member' : 'owner'),
      password: temp,
      mustChange: input.mustChange ?? true,
      createdBy: input.createdBy ?? 'admin',
    });
    if (this.find(username)) throw new AuthError('duplicate', `用户名已被占用：${username}`, 409);
    this.data.users.push(user);
    await this.save();
    return { user: this.publicUser(user), tempPassword: generated ? temp : undefined };
  }

  /** 管理员重置：生成临时密码并强制下次登录修改；同时踢掉已有会话 */
  async resetPassword(
    username: string,
    opts: { password?: string; mustChange?: boolean; by?: string } = {},
  ): Promise<CredentialResult> {
    const user = this.require(username);
    const generated = !opts.password;
    const temp = opts.password || randomPassword();
    if (!generated) {
      const check = checkPassword(temp, { username: user.username });
      if (!check.ok) throw new AuthError('weak_password', check.problems[0], 400, { problems: check.problems });
    }
    await this.writePassword(user, temp, {
      mustChange: opts.mustChange ?? true,
      by: opts.by ?? 'admin',
    });
    await this.save();
    return { user: this.publicUser(user), tempPassword: generated ? temp : undefined };
  }

  /** 自己改密：必须先验当前密码。成功后 pwv+1，其它设备上的会话一起失效 */
  async changePassword(username: string, currentPassword: string, newPassword: string): Promise<UserRecord> {
    const user = this.require(username);
    await this.verifyCurrent(user, currentPassword, `change:${normalizeUsername(username)}`);

    const check = checkPassword(newPassword, { username: user.username, current: currentPassword });
    if (!check.ok) throw new AuthError('weak_password', check.problems[0], 400, { problems: check.problems });

    await this.writePassword(user, newPassword, { mustChange: false, by: user.username });
    await this.save();
    return user;
  }

  async updateUser(
    username: string,
    patch: {
      displayName?: string | null;
      role?: Role;
      disabled?: boolean;
      mustChangePassword?: boolean;
    },
    actor?: string,
  ): Promise<PublicUser> {
    const user = this.require(username);
    const self = actor ? normalizeUsername(actor) === normalizeUsername(user.username) : false;
    const nextDisabled = patch.disabled ?? !!user.disabled;
    const nextRole = patch.role ?? user.role;

    // 先把所有约束校验完再改内存：否则抛错时对象已经被改了一半，下一次保存会把半截状态落盘
    if (patch.disabled === true && !user.disabled) {
      if (self) throw new AuthError('self', '不能停用自己的账号', 400);
      this.assertOtherOwner(user, '停用');
    }
    if (nextRole !== user.role) {
      if (self) throw new AuthError('self', '不能修改自己的角色', 400);
      if (user.role === 'owner' && nextRole !== 'owner') this.assertOtherOwner(user, '降级');
    }

    if (nextDisabled !== !!user.disabled) {
      user.disabled = nextDisabled;
      // 停用即踢线；重新启用后旧 Cookie 也不会复活
      if (nextDisabled) user.pwv += 1;
    }
    if (nextRole !== user.role) user.role = nextRole;
    if (patch.displayName !== undefined) {
      const name = (patch.displayName ?? '').trim().slice(0, 40);
      user.displayName = name || undefined;
    }
    if (patch.mustChangePassword !== undefined) user.mustChangePassword = patch.mustChangePassword;
    user.updatedAt = nowISO(this.clock);
    await this.save();
    return this.publicUser(user);
  }

  private assertOtherOwner(user: UserRecord, action: string): void {
    if (user.role !== 'owner') return;
    const other = this.data.users.some(
      (u) => u.role === 'owner' && !u.disabled && normalizeUsername(u.username) !== normalizeUsername(user.username),
    );
    if (!other) throw new AuthError('last_owner', `至少要保留一个可用的 owner，不能${action}最后一个`, 400);
  }

  private async verifyCurrent(user: UserRecord, password: string, key: string): Promise<void> {
    const gate = this.throttle.check(key);
    if (gate.locked) {
      throw new AuthError('locked', `尝试次数过多，请 ${Math.ceil(gate.retryAfter / 60)} 分钟后再试`, 429, {
        retryAfter: gate.retryAfter,
      });
    }
    const ok = await verifyPassword(password, user.hash);
    if (!ok) {
      this.throttle.fail(key);
      throw new AuthError('bad_current_password', '当前密码不对', 400);
    }
    this.throttle.succeed(key);
  }

  private async makeUser(input: {
    username: string;
    displayName?: string;
    role: Role;
    password: string;
    mustChange: boolean;
    createdBy: string;
  }): Promise<UserRecord> {
    const at = nowISO(this.clock);
    return {
      username: input.username,
      displayName: input.displayName?.trim() || undefined,
      role: input.role,
      hash: await hashPassword(input.password),
      pwv: 1,
      mustChangePassword: input.mustChange,
      passwordUpdatedAt: at,
      createdAt: at,
      updatedAt: at,
      createdBy: input.createdBy,
      lastLoginAt: null,
      lastLoginIp: null,
      disabled: false,
    };
  }

  private async writePassword(
    user: UserRecord,
    password: string,
    opts: { mustChange: boolean; by: string },
  ): Promise<void> {
    user.hash = await hashPassword(password);
    user.pwv += 1;
    user.mustChangePassword = opts.mustChange;
    user.passwordUpdatedAt = nowISO(this.clock);
    user.updatedAt = user.passwordUpdatedAt;
    user.createdBy = user.createdBy ?? opts.by;
  }

  /* ---------------- 落盘 ---------------- */

  private writeChain: Promise<void> = Promise.resolve();

  private async save(): Promise<void> {
    const run = this.writeChain.then(async () => {
      const body = `${JSON.stringify(this.data, null, 2)}\n`;
      await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await fsp.writeFile(tmp, body, { mode: 0o600 });
        await fsp.rename(tmp, this.file);
        try {
          await fsp.chmod(this.file, 0o600);
        } catch {
          /* Windows / 某些文件系统不支持，忽略 */
        }
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
      }
    });
    this.writeChain = run.catch(() => undefined);
    await run;
  }
}

function normalizeUser(raw: unknown, index: number, clock: () => Date): UserRecord {
  const u = (raw ?? {}) as Partial<UserRecord>;
  if (!u.username || typeof u.username !== 'string') {
    throw new Error(`账号文件损坏：第 ${index + 1} 个账号缺少 username`);
  }
  if (!u.hash || typeof u.hash !== 'string') {
    throw new Error(`账号文件损坏：账号 ${u.username} 缺少密码哈希`);
  }
  const at = nowISO(clock);
  return {
    username: u.username,
    displayName: typeof u.displayName === 'string' ? u.displayName : undefined,
    role: u.role === 'owner' ? 'owner' : 'member',
    hash: u.hash,
    pwv: Number.isInteger(u.pwv) && (u.pwv as number) > 0 ? (u.pwv as number) : 1,
    mustChangePassword: u.mustChangePassword === true,
    passwordUpdatedAt: typeof u.passwordUpdatedAt === 'string' ? u.passwordUpdatedAt : null,
    createdAt: typeof u.createdAt === 'string' ? u.createdAt : at,
    updatedAt: typeof u.updatedAt === 'string' ? u.updatedAt : at,
    createdBy: typeof u.createdBy === 'string' ? u.createdBy : undefined,
    lastLoginAt: typeof u.lastLoginAt === 'string' ? u.lastLoginAt : null,
    lastLoginIp: typeof u.lastLoginIp === 'string' ? u.lastLoginIp : null,
    disabled: u.disabled === true,
  };
}
