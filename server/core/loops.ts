/**
 * 闭环运行时：配置、回执、健康、协商、执行。
 *
 * 这一层的职责只有一个：让「跑没跑」变成可回答的问题。
 *   - 配置（.habitat/state/automation.json）：谁负责、开没开
 *   - 回执（.habitat/state/loop-runs.jsonl）：谁在什么时候跑的、跑出什么、失败原因
 *   - 健康（computeStatuses）：按 maxSilence 判 ok/late/down/never/blocked
 *
 * 不在这里做的事：
 *   - 不替判断类闭环下结论（只准备工单）
 *
 * P1 补上的三件事：
 *   - 跨进程租约：平台定时器与外部 cron 撞车时，只有一个能真正执行
 *   - 认领（claim）：判断类工单里的条目可以被某个 agent 先占住，避免重复劳动
 *   - 告警：down 不再只靠人看，落到 Notifier（可选邮件）
 */
import type { Habitat } from './space.ts';
import { newId, nowISO } from '../../shared/id.ts';
import { ConflictError } from './storage.ts';
import {
  LOOPS, loopById, evaluateLoop, fitAll, summarizeStates,
  type HarnessFit, type HarnessProfile, type LoopDef, type LoopReceipt, type LoopState,
} from '../../shared/loops.ts';
import { loadMailConfig, sendMail } from './mailer.ts';
import { collectBrief, renderBrief, runTidy } from './tidy.ts';
import { runReminders } from './reminders.ts';
import { runRules } from './rules.ts';
import { ingestMail } from './inbox-mail.ts';
import { reviewQueue } from './renew.ts';
import { lifeSnapshot, renderNext } from './lifecycle.ts';
import { exportSpace, verifyExport } from './export.ts';
import { Notifier } from './notify.ts';

export const LOOP_RUNS = '.habitat/state/loop-runs.jsonl';
export const AUTOMATION_CONFIG = '.habitat/state/automation.json';

export interface LoopOverride {
  enabled?: boolean;
  /** 归属：server / platform / harness 名 / human */
  owner?: string;
  note?: string;
}

export interface AutomationConfig {
  version: 1;
  loops: Record<string, LoopOverride>;
  harness?: HarnessProfile;
}

export async function loadAutomation(hab: Habitat): Promise<AutomationConfig> {
  const raw = await hab.store.adapter.read(AUTOMATION_CONFIG).catch(() => '');
  // 每次都要返回全新的 loops 对象：共用同一个默认对象的话，
  // 某个调用方改一笔配置，会把「默认全开」污染成全局修改（测试里踩过）。
  if (!raw.trim()) return { version: 1, loops: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<AutomationConfig>;
    return {
      version: 1,
      loops: parsed.loops && typeof parsed.loops === 'object' ? parsed.loops : {},
      harness: parsed.harness,
    };
  } catch {
    return { version: 1, loops: {} };
  }
}

export async function saveAutomation(hab: Habitat, cfg: AutomationConfig): Promise<void> {
  await hab.store.adapter.write(AUTOMATION_CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, { backup: false });
}

export async function readReceipts(hab: Habitat): Promise<LoopReceipt[]> {
  const raw = await hab.store.adapter.read(LOOP_RUNS).catch(() => '');
  const out: LoopReceipt[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as LoopReceipt;
      if (r && typeof r.loop === 'string' && typeof r.at === 'string') out.push(r);
    } catch {
      /* 半截行忽略：追加写没有事务，最后一行可能不完整 */
    }
  }
  return out;
}

export function latestByLoop(receipts: LoopReceipt[]): Record<string, LoopReceipt> {
  const out: Record<string, LoopReceipt> = {};
  for (const r of receipts) {
    const prev = out[r.loop];
    if (!prev || Date.parse(r.at) >= Date.parse(prev.at)) out[r.loop] = r;
  }
  return out;
}

export async function appendReceipt(hab: Habitat, r: LoopReceipt): Promise<void> {
  await hab.store.adapter.append(LOOP_RUNS, JSON.stringify(r));
}

/* ---------------- 租约：同一时刻只有一个执行者 ---------------- */

export const LOOP_LEASES = '.habitat/state/loop-leases.json';
export const LOOP_CLAIMS = '.habitat/state/loop-claims.json';

export interface LoopLease {
  owner: string;
  at: string;
  until: string;
  token: string;
}

export interface LoopClaim {
  loop: string;
  /** 对象 id，或断链目标这类字符串 */
  target: string;
  by: string;
  at: string;
  until: string;
  note?: string;
}

type LeaseMap = Record<string, LoopLease>;
type ClaimMap = Record<string, LoopClaim>;

async function readMap<T>(hab: Habitat, rel: string): Promise<T> {
  const raw = await hab.store.adapter.read(rel).catch(() => '');
  try {
    return (raw.trim() ? JSON.parse(raw) : {}) as T;
  } catch {
    return {} as T;
  }
}

/**
 * 条件写重试循环：读当前哈希 → 算新值 → 带 ifHash 写。
 * 两个进程同时改时，后写的会拿到 ConflictError，重读一次就能看到对方的决定。
 */
async function writeMap<T>(hab: Habitat, rel: string, fn: (cur: T) => T): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const st = await hab.store.adapter.stat(rel).catch(() => null);
    const cur = await readMap<T>(hab, rel);
    const next = fn(cur);
    try {
      await hab.store.adapter.write(rel, `${JSON.stringify(next, null, 2)}
`, {
        ifHash: st ? st.hash : 'new',
        backup: false,
      });
      return;
    } catch (e) {
      if (e instanceof ConflictError) continue;
      throw e;
    }
  }
  throw new Error(`并发写入冲突：${rel}`);
}

export async function acquireLease(
  hab: Habitat,
  loop: string,
  owner: string,
  ttlMin = Number(process.env.HABITAT_LOOP_LEASE_MIN ?? 10),
): Promise<{ ok: true; lease: LoopLease; release: () => Promise<void> } | { ok: false; holder?: LoopLease }> {
  const token = newId('lse');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const st = await hab.store.adapter.stat(LOOP_LEASES).catch(() => null);
    const map = await readMap<LeaseMap>(hab, LOOP_LEASES);
    const cur = map[loop];
    if (cur && Date.parse(cur.until) > Date.now() && cur.owner !== owner) return { ok: false, holder: cur };
    const lease: LoopLease = {
      owner,
      at: nowISO(),
      until: nowISO(Date.now() + Math.max(1, ttlMin) * 60_000),
      token,
    };
    try {
      await hab.store.adapter.write(LOOP_LEASES, `${JSON.stringify({ ...map, [loop]: lease }, null, 2)}
`, {
        ifHash: st ? st.hash : 'new',
        backup: false,
      });
      return {
        ok: true,
        lease,
        release: async () => {
          await writeMap<LeaseMap>(hab, LOOP_LEASES, (m) => {
            if (m[loop]?.token !== token) return m;
            const next = { ...m };
            delete next[loop];
            return next;
          }).catch(() => undefined);
        },
      };
    } catch (e) {
      if (e instanceof ConflictError) continue;
      throw e;
    }
  }
  return { ok: false };
}

/** 租约状态（CLI / 调试用）：过期的不返回 */
export async function listLeases(hab: Habitat): Promise<Record<string, LoopLease>> {
  const map = await readMap<LeaseMap>(hab, LOOP_LEASES);
  const now = Date.now();
  return Object.fromEntries(Object.entries(map).filter(([, l]) => Date.parse(l.until) > now));
}

/* ---------------- 认领：判断类工单里的条目先到先得 ---------------- */

export async function listClaims(hab: Habitat, loop?: string): Promise<LoopClaim[]> {
  const map = await readMap<ClaimMap>(hab, LOOP_CLAIMS);
  const now = Date.now();
  return Object.values(map)
    .filter((c) => Date.parse(c.until) > now && (!loop || c.loop === loop))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export async function claimTarget(
  hab: Habitat,
  loop: string,
  target: string,
  by: string,
  ttlMin = Number(process.env.HABITAT_CLAIM_MIN ?? 120),
): Promise<{ ok: true; claim: LoopClaim } | { ok: false; holder: LoopClaim }> {
  const key = `${loop}:${target}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const st = await hab.store.adapter.stat(LOOP_CLAIMS).catch(() => null);
    const map = await readMap<ClaimMap>(hab, LOOP_CLAIMS);
    const cur = map[key];
    if (cur && Date.parse(cur.until) > Date.now() && cur.by !== by) return { ok: false, holder: cur };
    const claim: LoopClaim = {
      loop,
      target,
      by,
      at: nowISO(),
      until: nowISO(Date.now() + Math.max(1, ttlMin) * 60_000),
    };
    try {
      await hab.store.adapter.write(LOOP_CLAIMS, `${JSON.stringify({ ...map, [key]: claim }, null, 2)}
`, {
        ifHash: st ? st.hash : 'new',
        backup: false,
      });
      return { ok: true, claim };
    } catch (e) {
      if (e instanceof ConflictError) continue;
      throw e;
    }
  }
  throw new Error('认领竞争激烈，稍后再试');
}

export async function releaseClaims(hab: Habitat, loop: string, by?: string): Promise<number> {
  let removed = 0;
  const now = Date.now();
  await writeMap<ClaimMap>(hab, LOOP_CLAIMS, (map) => {
    const next: ClaimMap = {};
    for (const [k, c] of Object.entries(map)) {
      const expired = Date.parse(c.until) <= now;
      const mine = c.loop === loop && (!by || c.by === by);
      if (expired || mine) {
        removed += 1;
        continue;
      }
      next[k] = c;
    }
    return next;
  });
  return removed;
}

/** 环境变量把某个定时器关掉时，健康状态要如实说「被关了」，而不是「从未运行」 */
export function envDisabled(def: LoopDef): string | null {
  const zero = (k: string) => process.env[k] === '0';
  if (def.id === 'watch-external' && zero('HABITAT_WATCH_MS')) return 'HABITAT_WATCH_MS=0';
  if (def.id === 'rules' && zero('HABITAT_RULES_MS')) return 'HABITAT_RULES_MS=0';
  if (def.id === 'reminders' && zero('HABITAT_REMIND_MS')) return 'HABITAT_REMIND_MS=0';
  if (def.id === 'metabolism' && zero('HABITAT_TIDY_MS')) return 'HABITAT_TIDY_MS=0';
  return null;
}

export interface BacklogCounts {
  inbox: number;
  agentReady: number;
  unresolved: number;
  reviewDue: number;
  proposal: number;
  job: number;
}

async function countJsonl(hab: Habitat, rel: string, keep: (o: Record<string, unknown>) => boolean): Promise<number> {
  const raw = await hab.store.adapter.read(rel).catch(() => '');
  let n = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      if (keep(JSON.parse(line) as Record<string, unknown>)) n += 1;
    } catch {
      /* 忽略坏行 */
    }
  }
  return n;
}

export async function collectBacklog(hab: Habitat): Promise<BacklogCounts> {
  const snap = await lifeSnapshot(hab);
  const due = await reviewQueue(hab);
  return {
    inbox: hab.inbox().length,
    agentReady: snap.stuck.filter((x) => !!x.aiHook).length,
    unresolved: hab.store.unresolvedTargets().reduce((a, x) => a + x.refs.length, 0),
    reviewDue: due.length,
    proposal: await countJsonl(hab, '.habitat/state/proposals.jsonl', (o) => o.state === 'pending'),
    job: await countJsonl(hab, '.habitat/state/jobs.jsonl', (o) => o.state !== 'done' && o.state !== 'failed'),
  };
}

export interface StatusReport {
  at: string;
  states: LoopState[];
  summary: Record<string, number>;
  backlog: BacklogCounts;
  config: AutomationConfig;
}

export async function computeStatuses(hab: Habitat): Promise<StatusReport> {
  const [cfg, receipts, backlog] = await Promise.all([loadAutomation(hab), readReceipts(hab), collectBacklog(hab)]);
  const latest = latestByLoop(receipts);
  const mail = loadMailConfig();
  const now = Date.now();

  const states = LOOPS.map((def) => {
    const ov = cfg.loops[def.id] ?? {};
    const blocked: string[] = [];
    if (!mail && def.requires.includes('mail:smtp')) blocked.push('邮件通道');
    if (!mail && def.requires.includes('mail:imap')) blocked.push('收信通道');
    const env = envDisabled(def);
    const enabled = ov.enabled !== false && !env;

    return evaluateLoop(def, latest[def.id], {
      now,
      enabled,
      blocked,
      backlog: def.backlog ? backlog[def.backlog] : undefined,
      pausedReason: env ? `被 ${env} 关闭` : ov.enabled === false ? '配置里停用' : undefined,
    });
  });

  return { at: nowISO(), states, summary: summarizeStates(states), backlog, config: cfg };
}

/* ---------------- 执行 ---------------- */

export interface RunOptions {
  dryRun?: boolean;
  actor?: string;
  force?: boolean;
  /** 简报：真的发信 */
  mail?: boolean;
  /** 收信：真的收（否则只看） */
  fetch?: boolean;
  /** 导出目标目录 */
  out?: string;
}

export interface RunResult {
  loop: string;
  ran: boolean;
  result: LoopReceipt['result'];
  deduped?: boolean;
  output: string;
  counts?: Record<string, number>;
  produced?: string[];
  note?: string;
}

/** 去重窗口：同一窗口内重复触发只认第一次，避免平台定时器与外部 cron 撞车 */
export function dedupeWindowMinutes(def: LoopDef): number {
  if (def.trigger.kind === 'interval') return Math.max(0.5, def.trigger.minutes * 0.5);
  if (def.trigger.kind === 'daily') return 60;
  return 0;
}

function alreadyRan(def: LoopDef, last: LoopReceipt | undefined, now: number): boolean {
  if (!last || last.result === 'fail') return false;
  const win = dedupeWindowMinutes(def);
  if (win <= 0) return false;
  return now - Date.parse(last.at) < win * 60_000;
}

/** 判断类 / 人工确认类闭环的运行 = 出一张可执行的工单，不假装已经做完 */
async function workOrder(hab: Habitat, def: LoopDef, by: string): Promise<{ text: string; counts: Record<string, number>; produced: string[] }> {
  const produced: string[] = [];
  const lines: string[] = [`# 工单：${def.name}（${def.id}）`, '', `目标：${def.intent}`, ''];

  // 已经被别人认领的条目不再出现在工单里：两个 agent 做同一件事是最浪费的重复劳动。
  const claimed = await listClaims(hab, def.id);
  const blocked = new Set(claimed.filter((c) => c.by !== by).map((c) => c.target));
  if (blocked.size) lines.push(`（已被其他执行者认领 ${blocked.size} 条，本次略过；认领 ${process.env.HABITAT_CLAIM_MIN ?? 120} 分钟后过期）`, '');

  if (def.id === 'triage-inbox') {
    const all = hab.inbox();
    const items = all.filter((x) => !blocked.has(x.id)).slice(0, 12);
    produced.push(...items.map((x) => x.id));
    lines.push(`积压 ${all.length} 条（可接 ${Math.max(0, all.length - blocked.size)} 条），先看前 ${items.length} 条：`);
    for (const x of items) lines.push(`- ${x.title}  ${x.id}`);
    lines.push('', '动手前先 `habitat loops claim triage-inbox <id>` 占住；做完走 propose，最后 `loops beat` 交账。');
    return { text: lines.join('\n'), counts: { inbox: all.length, listed: items.length, claimed: blocked.size }, produced };
  }

  if (def.id === 'renew-due' || def.id === 'challenge-supersede' || def.id === 'review-interval') {
    const due = (await reviewQueue(hab)).filter((x) => !blocked.has(x.id));
    const take = due.slice(0, 5);
    produced.push(...take.map((x) => x.id));
    lines.push(`到期 ${due.length} 条，按「一次不超过 5 条」先看：`);
    for (const x of take) lines.push(`- ${x.title}（${x.idleDays} 天没碰）  ${x.id}`);
    lines.push('', '每条：`habitat renew <id>` 拿证据包 → 有冲突提 supersededBy，没有就 `review --ok`。');
    return { text: lines.join('\n'), counts: { due: due.length, listed: take.length, claimed: blocked.size }, produced };
  }

  if (def.id === 'repair-links') {
    const all = hab.store.unresolvedTargets();
    const targets = all.filter((t) => !blocked.has(t.target)).slice(0, 20);
    produced.push(...targets.map((t) => t.target));
    lines.push(`未解析目标 ${all.length} 个，先看前 ${targets.length} 个：`);
    for (const t of targets) lines.push(`- [[${t.target}]] 被引用 ${t.refs.length} 次`);
    lines.push('', '每个目标：补一篇、改指向、或明确删链接；走 propose。');
    return { text: lines.join('\n'), counts: { unresolved: all.length, listed: targets.length, claimed: blocked.size }, produced };
  }

  if (def.id === 'digest-source' || def.id === 'connect-notes') {
    const snap = await lifeSnapshot(hab);
    const ready = snap.agentReady.filter((x) => !blocked.has(x.id));
    produced.push(...ready.map((x) => x.id));
    lines.push(renderNext({ ...snap, agentReady: ready }));
    return { text: lines.join('\n'), counts: { agentReady: ready.length, claimed: blocked.size }, produced };
  }

  if (def.id === 'proposal-approve') {
    const raw = await hab.store.adapter.read('.habitat/state/proposals.jsonl').catch(() => '');
    const pending = raw.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) as { id?: string; title?: string; state?: string; risk?: string }; } catch { return null; }
    }).filter((x): x is { id?: string; title?: string; state?: string; risk?: string } => !!x && x.state === 'pending');
    produced.push(...pending.map((p) => p.id).filter((x): x is string => !!x));
    lines.push(`待确认提案 ${pending.length} 条：`);
    for (const p of pending.slice(0, 10)) lines.push(`- ${p.title ?? '(无标题)'}  ${p.id}  风险 ${p.risk ?? 'low'}`);
    lines.push('', '在「变更」页逐条看差异再确认；不要批量 apply。');
    return { text: lines.join('\n'), counts: { pending: pending.length }, produced };
  }

  if (def.id === 'job-advance') {
    const raw = await hab.store.adapter.read('.habitat/state/jobs.jsonl').catch(() => '');
    const open = raw.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) as { id?: string; name?: string; state?: string; checkpoint?: string }; } catch { return null; }
    }).filter((x): x is { id?: string; name?: string; state?: string; checkpoint?: string } => !!x && x.state !== 'done' && x.state !== 'failed');
    produced.push(...open.map((j) => j.id).filter((x): x is string => !!x));
    lines.push(`未完成作业 ${open.length} 个：`);
    for (const j of open.slice(0, 10)) lines.push(`- ${j.name ?? j.id}  ${j.state} @ ${j.checkpoint ?? '—'}`);
    lines.push('', '推进：POST /api/jobs/:id/advance；停在 waiting-approval 的先找人确认。');
    return { text: lines.join('\n'), counts: { open: open.length }, produced };
  }

  lines.push('这条闭环没有服务端执行器，按手册里的步骤由 Agent / 人执行。');
  return { text: lines.join('\n'), counts: {}, produced };
}

export async function runLoop(hab: Habitat, id: string, opts: RunOptions = {}): Promise<RunResult> {
  const def = loopById(id);
  if (!def) {
    return { loop: id, ran: false, result: 'skipped', output: `没有这条闭环：${id}\n可用：${LOOPS.map((x) => x.id).join(' / ')}` };
  }

  const receipts = await readReceipts(hab);
  const last = latestByLoop(receipts)[id];
  if (!opts.force && alreadyRan(def, last, Date.now())) {
    return {
      loop: id,
      ran: false,
      result: 'ok',
      deduped: true,
      output: `跳过：${def.name} 在去重窗口内已经跑过（上次 ${last!.at}，${last!.by}）。要强制重跑加 --force。`,
      counts: last!.counts,
      produced: last!.produced,
    };
  }

  const actor = opts.actor ?? 'system';

  // 跨进程租约：只有会写 / 会外发的闭环需要互斥。
  // 判断类只出工单（纯读），两个 agent 同时拿工单是安全的；条目冲突由 claim 解决。
  const needsLease = def.mode === 'auto' || def.mode === 'verify';
  let releaseLease = async () => {};
  if (needsLease) {
    const lease = await acquireLease(hab, id, actor);
    if (!lease.ok) {
      const until = lease.holder ? lease.holder.until.slice(11, 16) : '未知时间';
      return {
        loop: id,
        ran: false,
        result: 'ok',
        deduped: true,
        output: `跳过：${def.name} 正被 ${lease.holder?.owner ?? '另一个执行者'} 执行（租约到 ${until}）。`,
        note: 'lease',
      };
    }
    releaseLease = lease.release;
  }

  const started = Date.now();
  try {
  let result: LoopReceipt['result'] = 'ok';
  let output = '';
  let counts: Record<string, number> | undefined;
  let produced: string[] | undefined;
  let note: string | undefined;

  switch (id) {
    case 'watch-external':
    case 'index-rebuild': {
      const before = hab.stats();
      await hab.rescan();
      const after = hab.stats();
      counts = { objects: after.objects, links: after.links, unresolved: after.unresolved };
      produced = [];
      output = `已重扫：对象 ${before.objects} → ${after.objects}，链接解析率 ${(1 - after.unresolved / Math.max(1, after.links)).toFixed(3)}`;
      break;
    }
    case 'reconcile': {
      const r = await hab.doReconcile();
      counts = { checked: r.checked, added: r.added.length, removed: r.removed.length, changed: r.changed.length, unsigned: r.unsigned.length };
      produced = [];
      output = r.baseline
        ? `已建基线：${r.checked} 个文件`
        : `对账 ${r.checked} 个文件：新增 ${r.added.length} · 删除 ${r.removed.length} · 改动 ${r.changed.length} · 未署名 ${r.unsigned.length}`;
      break;
    }
    case 'metabolism': {
      const r = await runTidy(hab, { dryRun: opts.dryRun === true });
      counts = { archived: r.archived, candidates: r.candidates };
      produced = [];
      output = r.dryRun
        ? `候选 ${r.candidates} 条（dry-run，未落盘）`
        : `归档 ${r.archived} 条（候选 ${r.candidates}）${r.error ? `；${r.error}` : ''}`;
      if (r.error) result = 'fail';
      break;
    }
    case 'daily-brief': {
      const data = await collectBrief(hab);
      output = renderBrief(data);
      counts = { inbox: data.inbox.length, overdue: data.overdue.length, stuck: data.stuck.reduce((a, s) => a + s.n, 0) };
      produced = [];
      if (opts.mail && opts.dryRun !== true) {
        if (!loadMailConfig()) {
          result = 'skipped';
          note = '没有配置邮件通道';
          output += '\n\n---\n邮件：没有配置通道，未发送（简报本身已生成）';
        } else {
          const { sendDailyBrief } = await import('./tidy.ts');
          const r = await sendDailyBrief(hab);
          output += `\n\n---\n邮件：${r.sent ? '已发送' : `未发送（${r.reason ?? '未知原因'}）`}`;
          if (!r.sent && r.reason !== '今天已经发过') {
            result = 'fail';
            note = r.reason;
          }
        }
      }
      break;
    }
    case 'reminders': {
      const r = await runReminders(hab, { dryRun: opts.dryRun === true });
      counts = { sent: r.sent.length, skipped: r.skipped.length };
      produced = [];
      output = r.enabled ? `提醒：发送 ${r.sent.length} 条，跳过 ${r.skipped.length} 条${r.error ? `；${r.error}` : ''}` : '没有配置邮件通道，未发送';
      if (!r.enabled) { result = 'skipped'; note = '没有配置邮件通道'; }
      if (r.error) { result = 'fail'; note = r.error; }
      break;
    }
    case 'rules': {
      const r = await runRules(hab, { dryRun: opts.dryRun === true });
      counts = { rules: r.rules, evaluated: r.evaluated, fired: r.fired.length, skipped: r.skipped.length };
      produced = [];
      output = `规则：${r.rules} 条，求值 ${r.evaluated} 条，触发 ${r.fired.length} 条${r.skipped.length ? `，跳过 ${r.skipped.length} 条` : ''}`;
      for (const f of r.fired) output += `\n  · ${f.rule}：${f.title}`;
      break;
    }
    case 'mail-ingest': {
      const r = await ingestMail(hab, { dryRun: opts.fetch !== true });
      counts = { fetched: r.fetched, captured: r.captured.length, skipped: r.skipped.length };
      produced = r.captured.map((x) => x.id).filter((x): x is string => !!x);
      output = r.configured
        ? `${opts.fetch ? '' : '（只看不收）'}未读 ${r.fetched} 封，入库 ${r.captured.length}，跳过 ${r.skipped.length}`
        : `没有配置邮件通道：${r.error ?? ''}`;
      if (!r.configured) { result = 'skipped'; note = '没有配置邮件通道'; }
      else if (r.error) { result = 'fail'; note = r.error; }
      break;
    }
    case 'export-backup': {
      if (!opts.out) {
        result = 'prepared';
        output = '需要一个导出目录：`habitat loops run export-backup --out D:/backup/habitat`';
      } else {
        const r = await exportSpace(hab.store, opts.out);
        const v = await verifyExport(opts.out);
        counts = { files: r.files, bytes: r.bytes, bad: v.bad.length };
        produced = [];
        output = `导出 ${r.files} 个文件（${Math.round(r.bytes / 1024)} KB）到 ${opts.out}\n校验：${v.ok ? `通过（${v.checked} 项）` : `失败 ${v.bad.length} 项`}`;
        if (!v.ok) result = 'fail';
      }
      break;
    }
    case 'release-promote': {
      result = 'prepared';
      output = [
        '# 工单：发布到生产',
        '',
        '这条闭环不在服务进程里执行：它需要生产目录、Shell 和重启权限。',
        '',
        '```bash',
        'cd D:\\works\\habitat',
        'node scripts/promote.mjs vX.Y.Z --dry-run   # 先看它打算做什么',
        'node scripts/promote.mjs vX.Y.Z',
        '```',
        '',
        '三条判断标准：/healthz 返回 ok、对象数不减少、解析率不明显下降。任一项不过会自动回滚。',
      ].join('\n');
      break;
    }
    default: {
      const wo = await workOrder(hab, def, actor);
      result = 'prepared';
      output = wo.text;
      counts = wo.counts;
      produced = wo.produced;
      break;
    }
  }

  const receipt: LoopReceipt = {
    loop: id,
    at: nowISO(),
    by: actor,
    trigger: opts.force ? 'manual:force' : 'manual',
    result,
    durationMs: Date.now() - started,
    counts,
    produced: produced?.slice(0, 200),
    note,
    idem: `${id}:${nowISO().slice(0, 10)}`,
  };
  await appendReceipt(hab, receipt);

  return { loop: id, ran: true, result, output, counts, produced, note };
  } finally {
    await releaseLease();
  }
}

export async function beat(hab: Habitat, id: string, input: { ok?: boolean; note?: string; produced?: string[]; actor?: string; counts?: Record<string, number> }): Promise<LoopReceipt> {
  const receipt: LoopReceipt = {
    loop: id,
    at: nowISO(),
    by: input.actor ?? 'agent:external',
    trigger: 'harness',
    result: input.ok === false ? 'fail' : 'ok',
    counts: input.counts,
    produced: input.produced?.slice(0, 200),
    note: input.note,
  };
  await appendReceipt(hab, receipt);
  // 交账即释放：这个执行者名下的认领全部归还，没做完的条目下一轮还能被别人接。
  await releaseClaims(hab, id, receipt.by);
  return receipt;
}

/* ---------------- 告警：down 不能只靠人看 ---------------- */

export interface AlertReport {
  at: string;
  alerted: { id: string; name: string; reason: string }[];
  skipped: string[];
  mailed: boolean;
  mailError?: string;
}

/**
 * 把 down 的闭环推到通知列表（可选邮件）。
 * 每条每天最多一次：告警的价值在「第一次」，重复轰炸只会让人关掉通知。
 */
export async function runLoopAlerts(hab: Habitat, opts: { mail?: boolean } = {}): Promise<AlertReport> {
  const status = await computeStatuses(hab);
  const ntc = new Notifier(hab.store);
  const report: AlertReport = { at: nowISO(), alerted: [], skipped: [], mailed: false };

  for (const s of status.states) {
    if (s.state !== 'down') continue;
    const def = loopById(s.id);
    if (!def) continue;
    const ruleId = `loop:${s.id}`;
    if (await ntc.alreadyToday(ruleId)) {
      report.skipped.push(`${def.name}（今天已告警）`);
      continue;
    }
    await ntc.add({
      level: 'danger',
      title: `闭环「${def.name}」停了`,
      body: `${s.reason}。去「闭环」页看是修、停，还是明确接受降级。`,
      href: '#/loops',
      ruleId,
    });
    report.alerted.push({ id: s.id, name: def.name, reason: s.reason });
  }

  if (opts.mail && report.alerted.length && loadMailConfig()) {
    const text = [
      `${report.alerted.length} 条自动化闭环停了：`,
      '',
      ...report.alerted.map((x) => `- ${x.name}（${x.id}）：${x.reason}`),
      '',
      '打开 闭环 页：修、停、或明确接受降级。',
      '— Habitat',
    ].join('\n');
    const r = await sendMail({ subject: `⛔ ${report.alerted.length} 条闭环停了`, text });
    report.mailed = r.ok;
    if (!r.ok) report.mailError = r.error;
  }

  return report;
}

/* ---------------- 协商与自检 ---------------- */

export async function conformance(hab: Habitat, profile?: HarnessProfile): Promise<{ harness: HarnessProfile | null; fits: HarnessFit[] }> {
  const cfg = await loadAutomation(hab);
  const h = profile ?? cfg.harness ?? null;
  if (!h) return { harness: null, fits: [] };
  return { harness: h, fits: fitAll(h) };
}

export interface CheckReport {
  at: string;
  summary: Record<string, number>;
  /** 超过上限或失败：真正的空壳候选 */
  silent: { id: string; state: LoopState['state']; reason: string }[];
  /** 从未运行：新部署时正常，但要能看见 */
  never: string[];
  /** 没有任何 owner 声明，且服务端不跑 */
  unowned: string[];
  /** 十分钟内同一闭环有两条不同执行者的成功回执 */
  double: string[];
  /** 声明了 owner，但最近回执来自别人 */
  mismatch: { id: string; owner: string; lastBy: string }[];
  passed: boolean;
}

export async function checkAutomation(hab: Habitat): Promise<CheckReport> {
  const status = await computeStatuses(hab);
  const receipts = await readReceipts(hab);
  const latest = latestByLoop(receipts);
  const now = Date.now();

  const silent = status.states
    .filter((s) => s.state === 'down' || s.state === 'late')
    .map((s) => ({ id: s.id, state: s.state, reason: s.reason }));
  const never = status.states.filter((s) => s.state === 'never').map((s) => s.id);

  const unowned = LOOPS.filter((d) => {
    const ov = status.config.loops[d.id];
    if (ov?.enabled === false) return false;
    const owned = !!ov?.owner;
    return !owned && !d.executors.includes('server');
  }).map((d) => d.id);

  const recent = receipts.filter((r) => now - Date.parse(r.at) < 10 * 60_000 && r.result === 'ok');
  const byLoop = new Map<string, Set<string>>();
  for (const r of recent) {
    const set = byLoop.get(r.loop) ?? new Set<string>();
    set.add(r.by);
    byLoop.set(r.loop, set);
  }
  const double = [...byLoop.entries()].filter(([, by]) => by.size > 1).map(([id]) => id);

  const mismatch: CheckReport['mismatch'] = [];
  const sameOwner = (owner: string, by: string) =>
    owner === by || owner === by.replace(/^agent:/, '') || `agent:${owner}` === by;
  for (const d of LOOPS) {
    const ov = status.config.loops[d.id];
    if (!ov?.owner) continue;
    const last = latest[d.id];
    if (!last) continue;
    if (!sameOwner(ov.owner, last.by)) mismatch.push({ id: d.id, owner: ov.owner, lastBy: last.by });
  }

  return {
    at: status.at,
    summary: status.summary,
    silent,
    never,
    unowned,
    double,
    mismatch,
    // never 在新部署上是正常的（还没到第一次触发），所以只把 down 和重复执行判为不通过；
    // never / late 仍然列出来，让人自己决定要不要处理。
    passed: silent.filter((s) => s.state === 'down').length === 0 && double.length === 0,
  };
}

/** 给外部 harness 的一页纸：现在该做什么、别做什么 */
export async function agentBrief(hab: Habitat): Promise<string> {
  const status = await computeStatuses(hab);
  const lines: string[] = ['# 自动化闭环交接单', ''];
  lines.push(`生成：${status.at}`);
  lines.push(`状态：${Object.entries(status.summary).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ')}`, '');

  const actionable = status.states
    .filter((s) => s.state === 'down' || s.state === 'late' || s.state === 'never')
    .sort((a, b) => (b.backlog ?? 0) - (a.backlog ?? 0));

  lines.push('## 需要处理的闭环', '');
  if (!actionable.length) {
    lines.push('没有 down / late / never 的闭环。');
  } else {
    for (const s of actionable) {
      const def = loopById(s.id)!;
      lines.push(`- **${def.name}**（${s.id}）${s.state}：${s.reason}${s.backlog != null ? `；积压 ${s.backlog}` : ''}`);
      if (def.entry.cli) lines.push(`    跑：\`${def.entry.cli.split(' · ')[0]}\``);
      lines.push(`    跑完：\`habitat loops beat ${s.id} --ok --produced <id>\``);
    }
  }

  lines.push('', '## 积压（该做但没做）', '');
  for (const [k, v] of Object.entries(status.backlog)) lines.push(`- ${k}：${v}`);

  lines.push('', '## 规则', '');
  lines.push('1. 判断类（mode=assist）只提案，不 commit；改语义必须人确认。');
  lines.push('2. 跑完必须 beat，并在 produced 里写清产物 id；没有回执等于没跑。');
  lines.push('3. 同一闭环不要和平台定时器同时跑；不确定就先 `--dry-run`。');
  return lines.join('\n');
}

/** 状态表：CLI 与文档共用一种说法 */
export function renderStatuses(report: StatusReport): string {
  const lines: string[] = [];
  const mark: Record<LoopState['state'], string> = {
    ok: 'ok  ', late: 'LATE', down: 'DOWN', never: 'NEVR', paused: 'OFF ', blocked: 'BLK ', manual: 'MAN ',
  };
  lines.push(`闭环 ${report.states.length} 条 · ${Object.entries(report.summary).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  lines.push('');
  lines.push('状态  闭环                    最近回执        积压  说明');
  lines.push('────  ──────────────────────  ──────────────  ────  ────');
  for (const s of report.states) {
    const def = loopById(s.id)!;
    const name = def.id.padEnd(22).slice(0, 22);
    const last = s.lastAt ? s.lastAt.slice(5, 16).replace('T', ' ') : '—';
    const backlog = s.backlog == null ? '—' : String(s.backlog);
    lines.push(`${mark[s.state]}  ${name}  ${last.padEnd(14)}  ${backlog.padStart(4)}  ${s.reason}`);
  }
  lines.push('');
  lines.push('积压：' + Object.entries(report.backlog).map(([k, v]) => `${k} ${v}`).join(' · '));
  return lines.join('\n');
}

export function renderCheck(r: CheckReport): string {
  const lines: string[] = [];
  lines.push(`自检：${r.passed ? '通过' : '未通过'}（${r.at.slice(0, 16).replace('T', ' ')}）`);
  lines.push('');
  if (r.silent.length) {
    lines.push(`迟到 / 中断 ${r.silent.length} 条：`);
    for (const s of r.silent) lines.push(`  · ${s.id}  ${s.state}  ${s.reason}`);
  } else {
    lines.push('没有迟到或中断的闭环。');
  }
  if (r.never.length) {
    lines.push('');
    lines.push(`从未运行 ${r.never.length} 条（新部署正常；部署很久了就是没接）：`);
    lines.push(`  · ${r.never.join('、')}`);
  }
  if (r.unowned.length) {
    lines.push('');
    lines.push(`没有归属 ${r.unowned.length} 条（服务端不跑，也没声明谁跑）：`);
    for (const id of r.unowned) lines.push(`  · ${id}`);
  }
  if (r.double.length) {
    lines.push('');
    lines.push(`重复执行 ${r.double.length} 条（十分钟内两个执行者都留了成功回执）：`);
    for (const id of r.double) lines.push(`  · ${id}`);
  }
  if (r.mismatch.length) {
    lines.push('');
    lines.push(`归属与回执不符 ${r.mismatch.length} 条：`);
    for (const m of r.mismatch) lines.push(`  · ${m.id}  声明 ${m.owner}，实际 ${m.lastBy}`);
  }
  return lines.join('\n');
}
