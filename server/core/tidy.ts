/**
 * 管家：数据代谢 + 每日简报。
 *
 * 为什么要有它：平台上的 AI 助理是可选的，人的 agent harness 也不会 7×24 开着。
 * 如果「整理」这件事依赖某个 AI 在场，那没人开 AI 的那几天，数据就在腐烂。
 *
 * 所以这里只做**不需要判断力**的事：
 *   - 完成很久的任务归档（确定规则，可撤销）
 *   - 把「积压 / 断链 / 读一半 / 逾期」摆出来（陈述事实，不代替决定）
 *   - 每天生成一份简报（同一份数据，谁来看都一样）
 *
 * 判断类的事（这条碎片到底值不值得留、该归到哪）仍然留给人和 AI——
 * 但那是「按需」，不是「维持系统活着的前提」。
 */
import type { Habitat } from './space.ts';
import { nowISO, todayISO } from '../../shared/id.ts';
import { lifeSnapshot } from './lifecycle.ts';
import { reconcileDay, renderDayLines, type DayReconcile } from './activity.ts';

export interface BriefData {
  at: string;
  today: { id: string; text: string; due?: string; projectId?: string }[];
  overdue: { id: string; text: string; due?: string }[];
  upcoming: { id: string; text: string; due?: string }[];
  events: { id: string; title: string; start: string }[];
  reading: { repId: string; title: string; pct: number; staleDays: number }[];
  inbox: { id: string; title: string; days: number }[];
  counts: {
    links: number;
    brokenLinks: number;
    notes: number;
    parts: number;
    works: number;
    doneOld: number;
  };
  archiveCandidates: { id: string; text: string; doneAt?: string }[];
  stuck: { state: string; stateName: string; n: number; why: string }[];
  /** 内容完整、只差一次确认的篇数（不计入欠账） */
  stable: number;
  agentReady: { id: string; title: string }[];
  refresh: { id: string; title: string; idleDays: number; why: string }[];
  byVitality: { vitality: string; name: string; n: number }[];
  /**
   * 当日对账：今天实际读了什么、改了什么，和今天的待办对上了没有。
   * 简报只摆证据，不替人勾任务——「可能已完成」仍然要确认。
   */
  day: DayReconcile;
}

const DEFAULT_ARCHIVE_DONE_DAYS = Number(process.env.HABITAT_ARCHIVE_DONE_DAYS ?? 30);
const STALE_INBOX_DAYS = Number(process.env.HABITAT_STALE_INBOX_DAYS ?? 14);
const STALE_READING_DAYS = Number(process.env.HABITAT_STALE_READING_DAYS ?? 14);

function daysSince(iso?: string): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86400_000);
}

export async function collectBrief(hab: Habitat): Promise<BriefData> {
  const today = todayISO();
  const in7 = todayISO(Date.now() + 7 * 86400_000);
  const t = hab.today(today);

  type A = { id: string; text: string; state: string; due?: string; doneAt?: string; projectId?: string; archivedAt?: string };
  const all = hab.store.all('action') as unknown as A[];
  const live = all.filter((a) => !a.archivedAt);

  const doneOld = live.filter((a) => a.state === 'done' && daysSince(a.doneAt) >= DEFAULT_ARCHIVE_DONE_DAYS);

  const reading: BriefData['reading'] = [];
  for (const [repId, c] of hab.store.cursors) {
    if (c.current <= 0.02 || c.current >= 0.99) continue;
    const rep = hab.store.get(repId);
    if (!rep) continue;
    const rel = hab.store.file(repId);
    const st = rel ? await hab.store.adapter.stat(rel).catch(() => null) : null;
    const stale = st ? daysSince(st.mtime) : 0;
    const part = 'partId' in rep ? hab.store.get(String((rep as { partId: string }).partId)) : undefined;
    const partTitle = part && 'title' in part ? String((part as { title: string }).title) : repId;
    reading.push({ repId, title: partTitle, pct: c.current, staleDays: stale });
  }
  reading.sort((a, b) => b.staleDays - a.staleDays);

  const inbox = hab.inbox().map((n) => ({ id: n.id, title: n.title, days: daysSince(n.updatedAt) }));

  const targets = hab.store.unresolvedTargets();
  const brokenLinks = targets.reduce((a, x) => a + x.refs.length, 0);

  const events = (hab.store.all('event') as unknown as { id: string; title: string; start: string; archivedAt?: string }[])
    .filter((e) => !e.archivedAt && e.start.slice(0, 10) === today)
    .sort((a, b) => a.start.localeCompare(b.start));

  const snap = await lifeSnapshot(hab);
  // 行为侧的证据：没有它，简报只能看到「什么还没做」，看不到「今天做了什么」。
  // 两件事都要摆出来，人才不用靠回忆去判断「这条待办是不是其实已经做完了」。
  const day = await reconcileDay(hab, today);

  return {
    at: nowISO(),
    today: t.actions.map((a) => ({ id: a.id, text: a.text, due: a.due, projectId: a.projectId })),
    overdue: t.overdue.map((a) => ({ id: a.id, text: a.text, due: a.due })),
    upcoming: live
      .filter((a) => a.state !== 'done' && a.due && a.due > today && a.due <= in7)
      .sort((a, b) => String(a.due).localeCompare(String(b.due)))
      .map((a) => ({ id: a.id, text: a.text, due: a.due })),
    events: events.map((e) => ({ id: e.id, title: e.title, start: e.start })),
    reading: reading.slice(0, 8),
    inbox,
    counts: {
      links: hab.store.links.length,
      brokenLinks,
      notes: hab.store.all('note').length,
      parts: hab.store.all('part').length,
      works: hab.works().length,
      doneOld: doneOld.length,
    },
    archiveCandidates: doneOld.slice(0, 50).map((a) => ({ id: a.id, text: a.text, doneAt: a.doneAt })),
    // 只聚合「真欠账」。之前这里直接把状态分布当卡点报，
    // 于是 52 篇写着完整结论的 growing 笔记也被算成「卡住」——数字虚高，
    // 看三天就学会忽略了。状态分布另有 byState，别混用。
    stuck: aggregateStuck(snap.stuck),
    stable: snap.stable.length,
    agentReady: snap.agentReady.map((x) => ({ id: x.id, title: x.title })),
    refresh: snap.refresh.map((x) => ({ id: x.id, title: x.title, idleDays: x.idleDays, why: x.why })),
    byVitality: snap.byVitality.map((x) => ({ vitality: x.vitality, name: x.name, n: x.n })),
    day,
  };
}

/** 一屏能看完的简报：陈述事实，不给建议（建议留给人和 AI） */
/** 把欠账按状态聚合，顺带带上「为什么算欠账」——只报数字等于没报 */
function aggregateStuck(items: { state: string; stateName: string; blockers: string[] }[]) {
  const m = new Map<string, { state: string; stateName: string; n: number; why: string }>();
  for (const x of items) {
    const cur = m.get(x.state) ?? { state: x.state, stateName: x.stateName, n: 0, why: x.blockers[0] ?? '' };
    cur.n += 1;
    if (!cur.why && x.blockers[0]) cur.why = x.blockers[0];
    m.set(x.state, cur);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

export function renderBrief(b: BriefData): string {
  const lines: string[] = [];
  const day = b.at.slice(0, 10);
  lines.push(`# ${day} 简报`);
  lines.push('');

  lines.push('## 今天');
  if (!b.events.length && !b.today.length && !b.overdue.length) lines.push('- 没有安排，也没有到期的事。');
  for (const e of b.events) lines.push(`- ${e.start.slice(11, 16)} ${e.title}`);
  for (const a of b.today) lines.push(`- [ ] ${a.text}${a.due ? `（${a.due}）` : ''}`);
  for (const a of b.overdue) lines.push(`- ⚠ 逾期 ${a.due ?? ''} ${a.text}`);

  // 计划之后紧接着摆「实际」：先看做了什么，再看计划还剩什么，顺序不能反过来。
  // 反过来读的人会先被待办吓一遍，然后发现「其实今天做了别的事」。
  lines.push('');
  lines.push(...renderDayLines(b.day));

  if (b.upcoming.length) {
    lines.push('');
    lines.push('## 接下来 7 天');
    for (const a of b.upcoming) lines.push(`- ${a.due} ${a.text}`);
  }

  if (b.reading.length) {
    lines.push('');
    lines.push('## 读到一半');
    for (const r of b.reading) lines.push(`- ${r.title} ${Math.round(r.pct * 100)}%${r.staleDays >= STALE_READING_DAYS ? `（${r.staleDays} 天没动）` : ''}`);
  }

  if (b.inbox.length) {
    lines.push('');
    lines.push(`## 收件箱 ${b.inbox.length} 条`);
    const stale = b.inbox.filter((x) => x.days >= STALE_INBOX_DAYS);
    for (const x of b.inbox.slice(0, 10)) lines.push(`- ${x.title}${x.days >= STALE_INBOX_DAYS ? `（压了 ${x.days} 天）` : ''}`);
    if (stale.length) lines.push(`- 其中 ${stale.length} 条超过 ${STALE_INBOX_DAYS} 天没动`);
  }

  lines.push('');
  if (b.refresh.length) {
    lines.push('');
    lines.push(`## 该翻新 ${b.refresh.length} 个`);
    for (const x of b.refresh.slice(0, 6)) lines.push(`- ${x.title}（${x.idleDays} 天没碰）${x.why}`);
    if (b.refresh.length > 6) lines.push(`- 还有 ${b.refresh.length - 6} 个，\`habitat refresh\` 看全部`);
  }

  if (b.stuck.length) {
    lines.push('');
    lines.push(`## 真欠账（${b.stuck.reduce((a, s) => a + s.n, 0)} 条）`);
    for (const s of b.stuck.slice(0, 5)) lines.push(`- ${s.stateName}：${s.n} 个 —— ${s.why}`);
    if (b.agentReady.length) lines.push(`- 其中 ${b.agentReady.length} 个有明确的 AI 切入点（\`habitat next\`）`);
  }

  if (b.stable) {
    lines.push('');
    lines.push(`## 稳定态 ${b.stable} 篇`);
    lines.push('内容已写成完整判断，只差「确认它仍成立」。每周抽几篇过一遍即可，不必每天看。');
  }

  lines.push('');
  lines.push('## 库的状态');
  lines.push(`- ${b.counts.works} 部作品 / ${b.counts.parts} 章 / ${b.counts.notes} 篇笔记`);
  lines.push(`- ${b.counts.links} 条链接，${b.counts.brokenLinks} 条解析不到`);
  if (b.counts.doneOld) lines.push(`- ${b.counts.doneOld} 条已完成任务超过 ${DEFAULT_ARCHIVE_DONE_DAYS} 天，可以归档`);

  return lines.join('\n');
}

export interface TidyReport {
  at: string;
  dryRun: boolean;
  archived: number;
  candidates: number;
  /** 已完成但没有完成时间的老任务数（修 doneAt 之前勾掉的，都缺这个字段） */
  undated: number;
  /** 本次补写 [done::] 的条数 */
  backfilled: number;
  brief: string;
  error?: string;
}

/**
 * 跑一轮代谢。
 * 默认 dryRun：整理会改文件，第一次先让人看见要动什么。
 * 真正归档时走 ChangeService——所以能整批撤销，不是不可逆操作。
 */
export async function runTidy(hab: Habitat, opts: { dryRun?: boolean } = {}): Promise<TidyReport> {
  const dryRun = opts.dryRun !== false;
  const brief = await collectBrief(hab);
  type Legacy = { id: string; state: string; doneAt?: string; archivedAt?: string };
  // 老任务只有 [x]，没有 [done::]。不回填就永远算不出「完成超过 N 天」，
  // 代谢闭环会一直空转。真实完成时间已经不可考，用任务文件的最后写入时间作
  // 保守近似：宁可晚归档，也不要凭空猜一个更早的日期。
  const undated = (hab.store.all('action') as unknown as Legacy[])
    .filter((a) => a.state === 'done' && !a.doneAt && !a.archivedAt);
  const report: TidyReport = {
    at: brief.at,
    dryRun,
    archived: 0,
    candidates: brief.archiveCandidates.length,
    undated: undated.length,
    backfilled: 0,
    brief: renderBrief(brief),
  };

  if (dryRun) return report;

  try {
    if (undated.length) {
      const mtimes = new Map<string, string>();
      for (const a of undated) {
        const rel = hab.store.file(a.id) ?? '';
        if (!rel || mtimes.has(rel)) continue;
        const st = await hab.store.adapter.stat(rel).catch(() => null);
        mtimes.set(rel, st?.mtime && !Number.isNaN(Date.parse(st.mtime)) ? st.mtime : nowISO());
      }
      const ops = undated.map((a) => ({
        t: 'update' as const,
        id: a.id,
        patch: { doneAt: mtimes.get(hab.store.file(a.id) ?? '') ?? nowISO() },
      }));
      const cs = await hab.changes.propose({
        ops,
        reason: `管家：为 ${ops.length} 条历史已完成任务补写完成时间`,
        actor: 'system',
      } as never);
      const r = await hab.changes.commit(cs.id);
      if (!r.ok) {
        report.error = '回填完成时间时撞车，未改动';
        return report;
      }
      report.backfilled = ops.length;
      await hab.rescan();
    }

    // 回填可能立刻造出新的归档候选（老文件的 updatedAt 本来就在 30 天前），
    // 所以归档必须基于回填之后的快照，不能复用上面的 brief。
    const fresh = report.backfilled ? await collectBrief(hab) : brief;
    report.candidates = fresh.archiveCandidates.length;
    report.brief = renderBrief(fresh);
    if (!fresh.archiveCandidates.length) return report;

    const ops = fresh.archiveCandidates.map((a) => ({ t: 'archive' as const, id: a.id, archived: true }));
    const cs = await hab.changes.propose({
      ops,
      reason: `管家：归档 ${ops.length} 条已完成超 ${DEFAULT_ARCHIVE_DONE_DAYS} 天的任务`,
      actor: 'system',
    } as never);
    const r = await hab.changes.commit(cs.id);
    if (!r.ok) {
      report.error = '归档时撞车，未改动';
      return report;
    }
    report.archived = ops.length;
    await hab.rescan();
  } catch (e) {
    report.error = (e as Error).message;
  }
  return report;
}

/** 每天一条简报信：只在配了邮件通道时发；同一天不重复发 */
export async function sendDailyBrief(hab: Habitat): Promise<{ sent: boolean; reason?: string }> {
  const stateFile = '.habitat/state/brief.json';
  const raw = await hab.store.adapter.read(stateFile).catch(() => '');
  let last: { day?: string } = {};
  try {
    last = JSON.parse(raw) as { day?: string };
  } catch {
    last = {};
  }
  const today = nowISO().slice(0, 10);
  if (last.day === today) return { sent: false, reason: '今天已经发过' };

  const data = await collectBrief(hab);
  const text = renderBrief(data);
  const { sendMail } = await import('./mailer.ts');
  const r = await sendMail({ subject: `📋 ${today} 简报`, text, html: `<pre style="font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)}</pre>` });
  if (!r.ok) return { sent: false, reason: r.error ?? '发送失败' };
  await hab.store.adapter.write(stateFile, JSON.stringify({ day: today, at: nowISO() }, null, 2), { backup: false });
  return { sent: true };
}
