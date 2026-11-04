/**
 * 一个进程、一个端口：同时吐前端和接口，并带鉴权。
 *
 * 为什么要鉴权：这个进程常常会被反向隧道 / 内网穿透暴露到公网，
 * 知识库里全是 private 内容，裸奔等于把整库公开。
 *
 * 两种凭据（见 server/auth.ts）：
 *   - 用户名密码 → 人的会话 Cookie（kb_session），支持首次登录 / 过期 / 管理员重置后强制改密
 *   - 访问令牌   → 脚本与 Agent（Cookie kb_token / Authorization: Bearer），不受改密限制
 *
 * 与现有基础设施的契约（不要随意改）：
 *   - 监听 127.0.0.1:<port>，由家里那台的 SSH 反向隧道转到服务器 18765
 *   - GET /healthz 免鉴权、返回 200，给 nginx 与 doctor 探活
 *   - 未登录访问页面 → 302 到 /login；访问接口 → 401
 *   - 令牌 Cookie 名沿用 kb_token，现有脚本 / 会话不用改
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './routes/api.ts';
import { authPlugin } from './auth.ts';
import {
  AuthService, defaultAuthFile, defaultPasswordDays, normalizeAuthMode, type AuthMode,
} from './core/auth.ts';
import { runRules } from './core/rules.ts';
import { runReminders } from './core/reminders.ts';
import { sendDailyBrief, runTidy } from './core/tidy.ts';
import { appendReceipt } from './core/loops.ts';
import { nowISO } from '../shared/id.ts';

export const DEFAULT_ROOT = process.env.HABITAT_SPACE ?? path.resolve('space');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');

const VERSION = (() => {
  try {
    return String((JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

export interface ServerOpts {
  root?: string;
  /** 访问令牌；空字符串表示不启用令牌 */
  token?: string;
  /** 前端产物目录；没有就只提供接口 */
  dist?: string;
  /** auto：有账号就开密码登录；on：没有账号也开并初始化管理员；off：只留令牌 */
  authMode?: AuthMode;
  /** 账号文件；默认 ~/.habitat/auth.json */
  usersFile?: string;
  /** 密码有效期天数；0 = 永不过期 */
  passwordDays?: number;
  /** 令牌 Cookie 名（沿用旧看板） */
  tokenCookie?: string;
  /** 人的会话 Cookie 名 */
  sessionCookie?: string;
}

export async function buildServer(opts: ServerOpts | string = {}) {
  const o: ServerOpts = typeof opts === 'string' ? { root: opts } : opts;
  const root = o.root ?? DEFAULT_ROOT;
  const token = (o.token ?? process.env.HABITAT_TOKEN ?? process.env.KB_TOKEN ?? '').trim();
  const dist = o.dist ?? DIST;
  const mode = o.authMode ?? normalizeAuthMode(process.env.HABITAT_AUTH);
  const auth = await AuthService.open({
    file: o.usersFile ?? defaultAuthFile(),
    passwordDays: o.passwordDays ?? defaultPasswordDays(),
  });

  // 显式开启密码登录但一个账号都没有：造一个管理员，把临时密码打在启动日志里。
  // 不这么做的话，第一次部署会卡在「登录页存在但没有账号可用」。
  let bootTemp: string | undefined;
  if (mode === 'on' && !auth.hasUsers()) {
    const r = await auth.bootstrapAdmin({
      username: process.env.HABITAT_ADMIN_USER?.trim() || 'admin',
      password: process.env.HABITAT_ADMIN_PASSWORD || undefined,
      mustChange: process.env.HABITAT_ADMIN_FORCE_CHANGE !== '0',
    });
    bootTemp = r.tempPassword;
    console.log(`[habitat] 已创建初始管理员：${r.user.username}`);
    if (bootTemp) {
      console.log(`[habitat] 临时密码：${bootTemp}`);
      console.log('[habitat] 这串密码只显示这一次；首次登录必须先修改。');
    } else {
      console.log('[habitat] 初始密码取自 HABITAT_ADMIN_PASSWORD；首次登录仍需修改');
    }
  }

  const passwordEnabled = mode !== 'off' && auth.hasUsers();
  if (mode === 'off' && auth.hasUsers()) {
    console.warn('[habitat] HABITAT_AUTH=off：账号文件里有用户，但密码登录被显式关闭；没有令牌时所有请求都会放行');
  }

  const app = Fastify({ logger: { level: process.env.HABITAT_LOG ?? 'info' }, bodyLimit: 8 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  // 字段与旧看板保持一致：kb_remote.py 的 doctor 会看 auth / version，
  // 换成别的形状它会把「正常」判成「异常」。
  const startedAt = Date.now();
  app.get('/healthz', async () => ({
    ok: true,
    service: 'habitat',
    version: VERSION,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    auth: Boolean(token) || passwordEnabled,
    auth_modes: [...(passwordEnabled ? ['password'] : []), ...(token ? ['token'] : [])],
    users: passwordEnabled ? auth.count() : 0,
    read_only: false,
  }));

  await app.register(authPlugin, {
    service: auth,
    token,
    passwordEnabled,
    tokenCookie: o.tokenCookie ?? process.env.HABITAT_COOKIE ?? 'kb_token',
    sessionCookie: o.sessionCookie ?? process.env.HABITAT_SESSION_COOKIE ?? 'kb_session',
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
  const modes: string[] = [];
  if (app.habitatPasswordAuth) modes.push(`用户名密码（${app.habitatAuth.count()} 个账号）`);
  if (app.habitatTokenAuth) modes.push('访问令牌');
  console.log(`[habitat] 服务已启动 http://${host}:${port}  空间：${root}`);
  console.log(`[habitat] 鉴权：${modes.length ? `已开启 · ${modes.join(' + ')}` : '未开启（仅限本机）'}`);
  if (app.habitatPasswordAuth) {
    console.log(`[habitat] 账号文件：${app.habitatAuth.file}（密码有效期 ${app.habitatAuth.passwordDays || '不限'} 天）`);
  }

  // 规则调度：让「自动化」真的会自己跑。只产出通知，不碰正文。
  //
  // 每一条定时器都必须留回执：没有回执，「跑没跑」就只能靠猜，
  // 而猜不出来的闭环最后都会变成文档里的空壳（见 docs/automation-loops.md）。
  const beatAt = new Map<string, number>();
  const shouldBeat = (id: string, hot: boolean, gapMin = 30) => {
    const last = beatAt.get(id) ?? 0;
    if (!hot && Date.now() - last < gapMin * 60_000) return false;
    beatAt.set(id, Date.now());
    return true;
  };
  const record = async (
    loop: string,
    result: 'ok' | 'fail' | 'skipped',
    counts?: Record<string, number>,
    note?: string,
  ) => {
    try {
      await appendReceipt(app.habitat, { loop, at: nowISO(), by: 'system', trigger: 'timer', result, counts, note });
    } catch (e) {
      console.warn(`[habitat] 回执写入失败（${loop}）：${(e as Error).message}`);
    }
  };

  const rulesMs = Number(process.env.HABITAT_RULES_MS ?? 300000);
  const ruleTimer = rulesMs > 0
    ? setInterval(() => {
        if (writes > 0) return; // 有人在写就先不插一脚
        void runRules(app.habitat)
          .then(async (r) => {
            if (r.fired.length) console.log(`[habitat] 规则触发 ${r.fired.length} 条：${r.fired.map((f) => f.rule).join('、')}`);
            if (shouldBeat('rules', r.fired.length > 0)) await record('rules', 'ok', { rules: r.rules, evaluated: r.evaluated, fired: r.fired.length });
          })
          .catch(async (e) => {
            console.warn(`[habitat] 规则执行出错：${(e as Error).message}`);
            await record('rules', 'fail', undefined, (e as Error).message);
          });
      }, rulesMs)
    : undefined;
  ruleTimer?.unref?.();

  // 提醒：每分钟看一次「有没有快到点的日程」。没配邮件通道就静默跳过。
  const remindMs = Number(process.env.HABITAT_REMIND_MS ?? 60000);
  const remindTimer = remindMs > 0
    ? setInterval(() => {
        if (writes > 0) return;
        void runReminders(app.habitat)
          .then(async (r) => {
            if (r.sent.length) console.log(`[habitat] 已发提醒 ${r.sent.length} 条：${r.sent.map((x) => x.kind).join('、')}`);
            if (r.error) console.warn(`[habitat] 提醒发送失败：${r.error}`);
            if (!r.enabled) {
              if (shouldBeat('reminders', false, 120)) await record('reminders', 'skipped', { sent: 0 }, '没有配置邮件通道');
            } else if (shouldBeat('reminders', r.sent.length > 0)) {
              await record('reminders', r.error ? 'fail' : 'ok', { sent: r.sent.length, skipped: r.skipped.length }, r.error);
            }
          })
          .catch(async (e) => {
            console.warn(`[habitat] 提醒出错：${(e as Error).message}`);
            await record('reminders', 'fail', undefined, (e as Error).message);
          });
      }, remindMs)
    : undefined;
  remindTimer?.unref?.();

  // 代谢：归档已完成超 30 天的任务。默认落盘（走变更集，可整批撤销）；
  // HABITAT_TIDY_APPLY=0 退回「只出报告」，HABITAT_TIDY_MS=0 完全关掉。
  const tidyMs = Number(process.env.HABITAT_TIDY_MS ?? 6 * 3600_000);
  const tidyTimer = tidyMs > 0
    ? setInterval(() => {
        if (writes > 0) return;
        void runTidy(app.habitat, { dryRun: process.env.HABITAT_TIDY_APPLY === '0' })
          .then(async (r) => {
            if (r.archived) console.log(`[habitat] 代谢归档 ${r.archived} 条已完成任务`);
            if (shouldBeat('metabolism', r.archived > 0, 240)) {
              await record('metabolism', r.error ? 'fail' : 'ok', { archived: r.archived, candidates: r.candidates }, r.error);
            }
          })
          .catch(async (e) => {
            console.warn(`[habitat] 代谢出错：${(e as Error).message}`);
            await record('metabolism', 'fail', undefined, (e as Error).message);
          });
      }, tidyMs)
    : undefined;
  tidyTimer?.unref?.();

  // 每天一封简报：默认 08:00 之后第一次检查时发。没配邮件通道就什么都不做。
  const briefHour = Number(process.env.HABITAT_BRIEF_HOUR ?? 8);
  const briefTimer = setInterval(() => {
    const now = new Date();
    if (now.getHours() < briefHour) return;
    if (writes > 0) return;
    void sendDailyBrief(app.habitat)
      .then(async (r) => {
        if (r.sent) {
          console.log('[habitat] 今日简报已发送');
          await record('daily-brief', 'ok', undefined, '已发邮件');
        } else if (r.reason && r.reason !== '今天已经发过') {
          console.warn(`[habitat] 简报未发送：${r.reason}`);
          if (shouldBeat('daily-brief', false, 120)) await record('daily-brief', 'skipped', undefined, r.reason);
        } else if (shouldBeat('daily-brief', false, 120)) {
          await record('daily-brief', 'ok', undefined, '今天已经发过');
        }
      })
      .catch(async (e) => {
        console.warn(`[habitat] 简报出错：${(e as Error).message}`);
        await record('daily-brief', 'fail', undefined, (e as Error).message);
      });
  }, 600_000);
  briefTimer.unref?.();

  const watchMs = Number(process.env.HABITAT_WATCH_MS ?? 15000);
  const watcher = watchMs > 0
    ? setInterval(() => {
        void app.habitat.pollExternal(() => writes).then(async (changed) => {
          if (changed) console.log('[habitat] 检测到外部改动，已重扫');
          if (shouldBeat('watch-external', changed)) await record('watch-external', 'ok', undefined, changed ? '检测到外部改动' : '无改动');
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
      if (tidyTimer) clearInterval(tidyTimer);
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
