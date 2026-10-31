/**
 * 一个进程、一个端口：同时吐前端和接口，并带 Token 鉴权。
 *
 * 为什么要鉴权：这个进程常常会被反向隧道 / 内网穿透暴露到公网，
 * 知识库里全是 private 内容，裸奔等于把整库公开。
 *
 * 与现有基础设施的契约（不要随意改）：
 *   - 监听 127.0.0.1:<port>，由家里那台的 SSH 反向隧道转到服务器 18765
 *   - GET /healthz 免鉴权、返回 200，给 nginx 与 doctor 探活
 *   - 未登录访问页面 → 302 到 /login；访问接口 → 401
 *   - Cookie 名沿用 kb_token、属性与旧看板一致，现有会话不用重新登录
 */
import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './routes/api.ts';
import { runRules } from './core/rules.ts';
import { runReminders } from './core/reminders.ts';
import { sendDailyBrief } from './core/tidy.ts';

export const DEFAULT_ROOT = process.env.HABITAT_SPACE ?? path.resolve('space');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const COOKIE = 'kb_token';
const MAX_AGE = 2592000; // 30 天，与旧看板一致

const VERSION = (() => {
  try {
    return String((JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

export interface ServerOpts {
  root?: string;
  /** 访问令牌；空字符串表示不鉴权（仅限本机开发） */
  token?: string;
  /** 前端产物目录；没有就只提供接口 */
  dist?: string;
}

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
function sameToken(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · Habitat</title>
<style>
  :root{--bg:#F6F1E7;--surface:#FFFDF9;--text:#201C17;--muted:#6B6157;--accent:#7A4B2A;--border:#E2D8C8}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);
       font:15px/1.7 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .card{width:min(420px,92vw);background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px}
  h1{margin:0 0 6px;font:600 20px/1.4 Georgia,"Songti SC",serif}
  p{margin:0 0 18px;color:var(--muted);font-size:13px}
  input{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:#fff;
        font:inherit;color:inherit;outline:none}
  input:focus{border-color:var(--accent)}
  button{margin-top:14px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:var(--accent);
         color:#fff;font:600 15px/1.4 inherit;cursor:pointer}
  .err{margin-top:10px;color:#A0342B;font-size:13px;min-height:1.2em}
</style></head>
<body><form class="card" method="post" action="/login">
  <h1>Habitat</h1>
  <p>这是私人的知识工作台。粘贴访问令牌，或直接用带 token 的链接打开。</p>
  <input name="token" type="password" placeholder="访问令牌" autofocus autocomplete="current-password" />
  <button type="submit">进入</button>
  <div class="err">__ERR__</div>
</form></body></html>`;

export async function buildServer(opts: ServerOpts | string = {}) {
  const o: ServerOpts = typeof opts === 'string' ? { root: opts } : opts;
  const root = o.root ?? DEFAULT_ROOT;
  const token = (o.token ?? process.env.HABITAT_TOKEN ?? process.env.KB_TOKEN ?? '').trim();
  const dist = o.dist ?? DIST;

  const app = Fastify({ logger: { level: process.env.HABITAT_LOG ?? 'info' }, bodyLimit: 8 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  const secure = (req: FastifyRequest) => String(req.headers['x-forwarded-proto'] ?? '').includes('https');
  const cookie = (req: FastifyRequest, value: string, maxAge: number) =>
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (secure(req) ? '; Secure' : '');

  // 字段与旧看板保持一致：kb_remote.py 的 doctor 会看 auth / version，
  // 换成别的形状它会把「正常」判成「异常」。
  const startedAt = Date.now();
  app.get('/healthz', async () => ({
    ok: true,
    service: 'habitat',
    version: VERSION,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    auth: Boolean(token),
    read_only: false,
  }));

  app.get('/login', async (req, reply) => {
    const q = (req.query ?? {}) as { token?: string };
    // 带 token 的链接直接登进去，省得在手机上再粘一遍
    if (q.token && sameToken(q.token.trim(), token)) {
      reply.header('set-cookie', cookie(req, token, MAX_AGE));
      return reply.redirect('/');
    }
    return reply.type('text/html; charset=utf-8').send(LOGIN_HTML.replace('__ERR__', q.token ? '令牌不对，再试一次。' : ''));
  });

  app.post('/login', async (req, reply) => {
    const b = (req.body ?? {}) as { token?: string };
    if (!sameToken(String(b.token ?? '').trim(), token)) {
      return reply.code(401).type('text/html; charset=utf-8').send(LOGIN_HTML.replace('__ERR__', '令牌不对，再试一次。'));
    }
    reply.header('set-cookie', cookie(req, token, MAX_AGE));
    return reply.redirect('/');
  });

  app.get('/logout', async (req, reply) => {
    reply.header('set-cookie', cookie(req, '', 0));
    return reply.redirect('/login');
  });

  // 鉴权闸门：不配 token 就放行（本机开发）
  app.addHook('onRequest', async (req, reply) => {
    if (!token) return;
    const url = req.url.split('?')[0];
    if (url === '/healthz' || url.startsWith('/login') || url.startsWith('/logout')) return;
    if (sameToken(cookieOf(req, COOKIE), token) || sameToken(bearerOf(req), token)) return;
    if (url.startsWith('/api')) {
      return reply.code(401).send({
        ok: false,
        error: '未登录：带上 token（Cookie kb_token / Authorization: Bearer / X-KB-Token）',
      });
    }
    if (req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) return reply.redirect('/login');
    return reply.code(401).send({ ok: false, error: '未登录' });
  });

  // 二进制上传：除了 JSON，这些内容类型一律按 Buffer 收。
  // 这样 PUT /api/assets 不用装 multipart 插件，curl / 任意 Agent / 手机浏览器都能直接传。
  for (const t of ['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']) {
    app.addContentTypeParser(t, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }
  // 兜底：文件上传的类型是浏览器说了算的（text/plain、application/zip…），
  // 不可能枚举完。JSON 有内建解析器会先命中，这里只接住其余的。
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  await app.register(api, { root });

  const hasUi = fs.existsSync(path.join(dist, 'index.html'));
  if (hasUi) {
    await app.register(fastifyStatic, { root: dist, prefix: '/' });
    // 前端是 hash 路由，正常走不到这里；留着兜底，刷新深层路径不至于 404
    app.setNotFoundHandler((req, reply) => {
      const url = req.url.split('?')[0];
      if (url.startsWith('/api')) return reply.code(404).send({ ok: false, error: `没有这个接口：${url}` });
      if (req.method === 'GET') return reply.type('text/html; charset=utf-8').sendFile('index.html');
      return reply.code(405).send({ ok: false, error: '不支持的方法' });
    });
  }

  app.get('/info', async () => ({ name: 'habitat', space: root, ui: hasUi ? 'dist' : 'dev-server' }));

  return app;
}

const isMain = process.argv[1] && /server[\\/]index\.ts$/.test(process.argv[1]);

/** 起服务并挂上优雅退出。生产模式由 scripts/serve.ts 调用，开发模式走下面的 isMain 分支 */
export async function start(rootArg?: string) {
  const root = rootArg ?? process.argv[2] ?? DEFAULT_ROOT;
  if (!fs.existsSync(path.join(root, 'space.yaml'))) {
    console.warn(`[habitat] 空间缺少 space.yaml：${root}（仍会尝试启动）`);
  }
  const port = Number(process.env.HABITAT_PORT ?? 8787);
  const host = process.env.HABITAT_HOST ?? '127.0.0.1';
  const app = await buildServer({ root });

  // 外部写入轮询：Agent 用 CLI 写进来的内容，界面要能自己看见，不能靠人手动刷新。
  // 有写请求在飞就跳过，避免和提交抢 store。钩子必须在 listen 之前注册。
  let writes = 0;
  const isWrite = (m: string) => m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
  app.addHook('onRequest', async (req) => {
    if (isWrite(req.method)) writes += 1;
  });
  app.addHook('onResponse', async (req) => {
    if (isWrite(req.method)) writes = Math.max(0, writes - 1);
  });

  await app.listen({ port, host });
  const tok = (process.env.HABITAT_TOKEN ?? process.env.KB_TOKEN ?? '').trim();
  console.log(`[habitat] 服务已启动 http://${host}:${port}  空间：${root}`);
  console.log(`[habitat] 鉴权：${tok ? '已开启（Cookie kb_token / Authorization: Bearer）' : '未开启（仅限本机）'}`);

  // 规则调度：让「自动化」真的会自己跑。只产出通知，不碰正文。
  const rulesMs = Number(process.env.HABITAT_RULES_MS ?? 300000);
  const ruleTimer = rulesMs > 0
    ? setInterval(() => {
        if (writes > 0) return; // 有人在写就先不插一脚
        void runRules(app.habitat)
          .then((r) => {
            if (r.fired.length) console.log(`[habitat] 规则触发 ${r.fired.length} 条：${r.fired.map((f) => f.rule).join('、')}`);
          })
          .catch((e) => console.warn(`[habitat] 规则执行出错：${(e as Error).message}`));
      }, rulesMs)
    : undefined;
  ruleTimer?.unref?.();

  // 提醒：每分钟看一次「有没有快到点的日程」。没配邮件通道就静默跳过。
  const remindMs = Number(process.env.HABITAT_REMIND_MS ?? 60000);
  const remindTimer = remindMs > 0
    ? setInterval(() => {
        if (writes > 0) return;
        void runReminders(app.habitat)
          .then((r) => {
            if (r.sent.length) console.log(`[habitat] 已发提醒 ${r.sent.length} 条：${r.sent.map((x) => x.kind).join('、')}`);
            if (r.error) console.warn(`[habitat] 提醒发送失败：${r.error}`);
          })
          .catch((e) => console.warn(`[habitat] 提醒出错：${(e as Error).message}`));
      }, remindMs)
    : undefined;
  remindTimer?.unref?.();

  // 每天一封简报：默认 08:00 之后第一次检查时发。没配邮件通道就什么都不做。
  const briefHour = Number(process.env.HABITAT_BRIEF_HOUR ?? 8);
  const briefTimer = setInterval(() => {
    const now = new Date();
    if (now.getHours() < briefHour) return;
    if (writes > 0) return;
    void sendDailyBrief(app.habitat)
      .then((r) => {
        if (r.sent) console.log('[habitat] 今日简报已发送');
        else if (r.reason && r.reason !== '今天已经发过') console.warn(`[habitat] 简报未发送：${r.reason}`);
      })
      .catch((e) => console.warn(`[habitat] 简报出错：${(e as Error).message}`));
  }, 600_000);
  briefTimer.unref?.();

  const watchMs = Number(process.env.HABITAT_WATCH_MS ?? 15000);
  const watcher = watchMs > 0
    ? setInterval(() => {
        void app.habitat.pollExternal(() => writes).then((changed) => {
          if (changed) console.log('[habitat] 检测到外部改动，已重扫');
        });
      }, watchMs)
    : undefined;
  watcher?.unref?.();

  // 优雅退出：先关 SQLite（WAL checkpoint）再退进程。
  // 否则强杀会留下 habitat.db-wal 与文件锁，下一次重建空间时删不掉。
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
      if (watcher) clearInterval(watcher);
      if (ruleTimer) clearInterval(ruleTimer);
      if (remindTimer) clearInterval(remindTimer);
      if (briefTimer) clearInterval(briefTimer);
      app.habitat.close();
      console.log(`[habitat] 已收到 ${sig}，连接已关闭`);
    } catch (e) {
      console.warn(`[habitat] 关闭时出错：${(e as Error).message}`);
    } finally {
      process.exit(0);
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => void shutdown(sig));
  }
  return app;
}

if (isMain) await start();
