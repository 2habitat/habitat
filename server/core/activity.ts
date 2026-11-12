/**
 * 当日对账 —— 把「计划」和「实际」摆在一起。
 *
 * 为什么要有它：
 *   简报原来只看对象状态（谁到期、谁读一半、谁积压），从不看**今天发生了什么**。
 *   于是两种真实情况都看不见：
 *     1. 今天没按计划走：计划里三条一条没碰，但读了三章、写完一节——简报里没有任何痕迹。
 *     2. 工作本身覆盖了待办：任务写着「写完第三章」，人今天确实在第三章里改了半天，
 *        任务还是 open，第二天照旧被当成没做的事提醒一遍。
 *   唯一的行为信号 cursors.json 只记「读到哪」，不记「今天读了什么、改了什么」。
 *
 * 所以这里只做一件事：从 journal 里把今天的事件按对象归并，再用**确定性规则**
 * 对齐到今天的待办上，分成三堆——可能已完成 / 今天动过 / 整天没碰。
 *
 * 三条边界：
 *   1. 只读 journal 与对象状态，不写任何文件；判断结果只是「提案」，勾掉仍然要人确认。
 *   2. 事件按对象归并，不按次数铺开：阅读进度 1.2 秒一条，原样列出来没人看得下去。
 *   3. 对不上任何待办的投入也要列出来——「计划外」不等于「没发生」。
 */
import type {
  Action, Annotation, AnyObject, Id, JournalEvent, JournalOp, Note, Part, Rep, Work,
} from '../../shared/types.ts';
import { nowISO } from '../../shared/id.ts';
import type { Habitat } from './space.ts';
import { OP_LABEL } from './journal.ts';

export type DayStatus = 'covered' | 'touched' | 'idle';

/** 一条「今天动过这个对象」的归并结果 */
export interface ActivityHit {
  id: Id;
  type: string;
  title: string;
  /** 去重后的操作类型，按出现次数排序 */
  ops: JournalOp[];
  /** 原始事件条数（阅读进度的重复也计入，用来看投入强度） */
  events: number;
  weight: number;
  /** 今天读到的最远位置（只有 rep 有） */
  readPct?: number;
  lastAt: string;
  /** 自己 + 所属章节 / 作品，用来和任务的 [refs::] 对齐 */
  family: Id[];
  actors: string[];
}

export interface DayActivity {
  day: string;
  at: string;
  /** 当天 journal 全部事件数（含提交汇总、提案这类不落到对象的） */
  events: number;
  /** 归并后真正算「动过某个对象」的事件数 */
  meaningful: number;
  hits: ActivityHit[];
  byOp: Partial<Record<JournalOp, number>>;
  byActor: { human: number; agent: number; external: number; system: number };
  /** 新建 / 勾掉 / 改期任务本身的动作数——这是「计划管理」，不是「工作产出」 */
  taskOps: number;
  /** 落到对象上但解析不到的事件数（例如对象已被归档或文件被移走） */
  orphan: number;
}

export interface DayEvidence {
  kind: 'ref' | 'lexical';
  objectId: Id;
  title: string;
  ops: JournalOp[];
  lastAt: string;
  /** 这条证据够不够撑起「可能已完成」 */
  substantive: boolean;
  detail: string;
}

export interface PlannedItem {
  id: Id;
  text: string;
  due?: string;
  flow: string;
  projectId?: Id;
  status: DayStatus;
  evidence: DayEvidence[];
}

export interface DayReconcile {
  day: string;
  at: string;
  activity: DayActivity;
  planned: PlannedItem[];
  /** 今天动过、但在今天任何待办里都找不到的对象 */
  unplanned: ActivityHit[];
  /**
   * 项目级投入：只做「这个项目今天被碰过」的汇总，不往具体待办上安。
   * 之前把项目关联当成单条任务的证据，结果同一项目下 5 条无关任务全被标成「今天动过」——
   * 这种噪声一旦出现，整块信息就会被学会忽略。
   */
  projects: { id: Id; title: string; n: number; titles: string[] }[];
  counts: {
    events: number;
    active: number;
    planned: number;
    covered: number;
    touched: number;
    idle: number;
    unplanned: number;
    taskOps: number;
  };
}

/** 阅读到这个位置，才算「读完了」——和 lifecycle 的 digest 判定保持一致 */
const READ_COMPLETE = 0.95;

/** 不落到对象、或不代表「今天做了什么」的事件 */
const SKIP_OPS = new Set<JournalOp>(['propose', 'commit', 'revert', 'reconcile']);

/** 有这些操作，才敢说「这条待办可能已经被工作覆盖」 */
const SUBSTANTIVE_OPS = new Set<JournalOp>(['edit', 'derive', 'settle', 'build', 'import']);

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function actorBucket(actor: string): keyof DayActivity['byActor'] {
  if (actor === 'human') return 'human';
  if (actor.startsWith('agent:')) return 'agent';
  if (actor.startsWith('external')) return 'external';
  return 'system';
}

function opWeight(op: JournalOp, readPct: number): number {
  switch (op) {
    case 'edit':
    case 'derive':
    case 'settle':
      return 3;
    case 'annotate':
    case 'review':
    case 'build':
      return 2;
    case 'read':
      // 读到一半和读完不是一回事：权重按最远位置给
      return Math.max(1, Math.round(1 + readPct * 2));
    case 'capture':
    case 'ingest':
    case 'import':
    case 'unannotate':
      return 1;
    default:
      return 0;
  }
}

/** 对象在「对账」里的最小单位：章节优先，笔记单独一条 */
interface Unit {
  id: Id;
  type: string;
  title: string;
  family: Id[];
}

function unitFor(hab: Habitat, o: AnyObject): Unit | null {
  switch (o.type) {
    case 'rep': {
      const rep = o as Rep;
      const part = hab.store.get<Part>(rep.partId);
      const work = part ? hab.store.get<Work>(part.workId) : undefined;
      if (!part) return { id: rep.id, type: 'rep', title: rep.path || rep.id, family: [rep.id] };
      return {
        id: part.id,
        type: 'part',
        title: work?.title ? `${work.title} · ${part.title}` : part.title,
        family: [part.id, part.workId].filter(Boolean) as Id[],
      };
    }
    case 'part': {
      const part = o as Part;
      const work = hab.store.get<Work>(part.workId);
      return {
        id: part.id,
        type: 'part',
        title: work?.title ? `${work.title} · ${part.title}` : part.title,
        family: [part.id, part.workId].filter(Boolean) as Id[],
      };
    }
    case 'annotation': {
      // 批注落在载体上：归并到它批的那一章，而不是单独一条「批注」
      const rep = hab.store.get<Rep>((o as Annotation).targetRepId);
      return rep ? unitFor(hab, rep) : null;
    }
    case 'note':
      return { id: o.id, type: 'note', title: (o as Note).title, family: [o.id] };
    case 'work':
      return { id: o.id, type: 'work', title: (o as Work).title, family: [o.id] };
    default:
      // action / event / project / space 属于「计划」，不是「产出」
      return null;
  }
}

interface ObjectIndex {
  /** 一个文件可能挂多个对象：part 与它的 rep 共用同一份正文，tasks.md 挂着一整池任务 */
  byPath: Map<string, AnyObject[]>;
}

function buildIndex(hab: Habitat): ObjectIndex {
  const byPath = new Map<string, AnyObject[]>();
  for (const o of hab.store.objects.values()) {
    const rel = normalizePath(hab.store.file(o.id) ?? o.path ?? '');
    if (!rel) continue;
    const list = byPath.get(rel) ?? [];
    list.push(o);
    byPath.set(rel, list);
  }
  return { byPath };
}

/**
 * 事件里的 target 有三种写法：对象 id、文件相对路径、stem。
 * 依次尝试，最后才认「名字」——宁可少认一条，也不要认错一条。
 */
function resolveTarget(hab: Habitat, idx: ObjectIndex, target: string): AnyObject | undefined {
  if (!target) return undefined;
  const direct = hab.store.get(target);
  if (direct) return direct;

  const rel = normalizePath(target);
  const candidates = idx.byPath.get(rel);
  if (candidates) {
    // part 与 rep 共用一个文件，归并后是同一个 unit；认到哪个都行
    const unitables = candidates.map((o) => ({ o, u: unitFor(hab, o) })).filter((x) => x.u);
    if (unitables.length === 1) return unitables[0].o;
    if (unitables.length > 1) {
      const ids = new Set(unitables.map((x) => x.u!.id));
      if (ids.size === 1) return unitables[0].o;
    }
  }

  const base = rel.split('/').pop() ?? '';
  const stem = base.replace(/\.(md|html|pdf|epub|jsonl)$/i, '');
  if (!stem) return undefined;
  const byId = hab.store.get(stem);
  if (byId) return byId;
  return hab.store.byStem(stem);
}

/** 这个 target 落在哪个对象上；落不到时说明是「计划文件」还是「孤儿」 */
function resolveEventTarget(
  hab: Habitat,
  idx: ObjectIndex,
  target: string,
): { object?: AnyObject; planFile: boolean } {
  const rel = normalizePath(target);
  const candidates = idx.byPath.get(rel);
  if (candidates) {
    const unitables = candidates.map((o) => ({ o, u: unitFor(hab, o) })).filter((x) => x.u);
    if (unitables.length) {
      const uniq = new Map<Id, AnyObject>();
      for (const x of unitables) if (!uniq.has(x.u!.id)) uniq.set(x.u!.id, x.o);
      if (uniq.size === 1) return { object: [...uniq.values()][0], planFile: false };
      return { planFile: false };
    }
    if (candidates.some((o) => o.type === 'action' || o.type === 'event')) {
      return { planFile: true };
    }
  }
  const o = resolveTarget(hab, idx, target);
  return { object: o, planFile: false };
}

function describeHit(h: ActivityHit): string {
  const parts: string[] = [];
  const ordered = [...h.ops].sort((a, b) => opWeight(b, h.readPct ?? 0) - opWeight(a, h.readPct ?? 0));
  for (const op of ordered) {
    const n = h.events;
    parts.push(`${OP_LABEL[op]}${n > 1 && ordered.length === 1 ? ` ${n} 次` : ''}`);
  }
  if (h.readPct !== undefined) parts.push(`最远 ${Math.round(h.readPct * 100)}%`);
  return parts.join('、');
}

/** 今天有没有「实质动作」——只读了一点点不算 */
function isSubstantive(h: ActivityHit): boolean {
  if (h.ops.some((op) => SUBSTANTIVE_OPS.has(op))) return true;
  return h.ops.includes('read') && (h.readPct ?? 0) >= READ_COMPLETE;
}

/**
 * 词面兜底：任务行里常常只有一个标题，没写 [refs::]。
 *
 * 只认两种足够强的信号，宁可不匹配也不乱匹配：
 *   1. 任务行里写了整部作品名（≥4 字），今天动过这部作品里的章节；
 *   2. 和对象标题共享一段 ≥4 字的连续汉字（英文词不算——「harness / report」这类
 *      在标题里到处都是，拿它当证据会让一个项目下所有任务都「今天动过」）。
 */
function sharedCjkPhrase(a: string, b: string, min = 4): boolean {
  const cjk = (s: string) => (s.match(/[\u4e00-\u9fa5]+/g) ?? []).join('');
  const x = cjk(a);
  const y = cjk(b);
  if (x.length < min || y.length < min) return false;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  for (let i = 0; i + min <= short.length; i += 1) {
    if (long.includes(short.slice(i, i + min))) return true;
  }
  return false;
}

/** 命中同一条任务时，优先取「实质动作」而不是「读了两眼」的那一条 */
function lexicalRelated(hits: ActivityHit[], text: string): ActivityHit | undefined {
  const ordered = [...hits].sort(
    (a, b) => Number(isSubstantive(b)) - Number(isSubstantive(a)) || b.weight - a.weight,
  );
  for (const h of ordered) {
    const workTitle = h.title.split(' · ')[0].trim();
    if (workTitle.length >= 4 && text.includes(workTitle)) return h;
    if (sharedCjkPhrase(text, h.title)) return h;
  }
  return undefined;
}

function hasIntersection(a: Id[], b: Set<Id>): boolean {
  return a.some((id) => b.has(id));
}

/** 归并当天事件：一个对象一天只出现一次 */
export async function collectDayActivity(hab: Habitat, day = nowISO().slice(0, 10)): Promise<DayActivity> {
  const evs = await hab.journal.query({ since: day, limit: 100000 });
  const inDay = evs.filter((e) => e.at.slice(0, 10) === day);
  const idx = buildIndex(hab);

  const acc = new Map<Id, ActivityHit>();
  const byOp: Partial<Record<JournalOp, number>> = {};
  const byActor = { human: 0, agent: 0, external: 0, system: 0 };
  let taskOps = 0;
  let orphan = 0;
  let meaningful = 0;

  for (const ev of inDay as JournalEvent[]) {
    byActor[actorBucket(ev.actor)] += 1;
    if (ev.phase !== 'done' || SKIP_OPS.has(ev.op)) continue;
    byOp[ev.op] = (byOp[ev.op] ?? 0) + 1;

    const target = ev.target ?? '';
    if (!target || target.startsWith('changeset:')) continue;
    const resolved = resolveEventTarget(hab, idx, target);
    if (resolved.planFile) {
      // tasks.md / events.md 这类合集：能认出来，但不知道具体是哪一条
      taskOps += 1;
      continue;
    }
    const o = resolved.object;
    const unit = o ? unitFor(hab, o) : null;
    if (!unit) {
      orphan += 1;
      continue;
    }
    const pct = typeof ev.payload?.pct === 'number' ? ev.payload.pct : 0;
    const cur = acc.get(unit.id);
    if (cur) {
      cur.events += 1;
      cur.weight += opWeight(ev.op, pct);
      if (!cur.ops.includes(ev.op)) cur.ops.push(ev.op);
      if (ev.op === 'read' && pct > (cur.readPct ?? 0)) cur.readPct = pct;
      if (ev.at > cur.lastAt) cur.lastAt = ev.at;
      if (!cur.actors.includes(ev.actor)) cur.actors.push(ev.actor);
    } else {
      acc.set(unit.id, {
        id: unit.id,
        type: unit.type,
        title: unit.title,
        ops: [ev.op],
        events: 1,
        weight: opWeight(ev.op, pct),
        readPct: ev.op === 'read' ? pct : undefined,
        lastAt: ev.at,
        family: unit.family,
        actors: [ev.actor],
      });
    }
    meaningful += 1;
  }

  const hits = [...acc.values()].sort((a, b) => b.weight - a.weight || (a.lastAt < b.lastAt ? 1 : -1));
  return {
    day,
    at: nowISO(),
    events: inDay.length,
    meaningful,
    hits,
    byOp,
    byActor,
    taskOps,
    orphan,
  };
}

function plannedFor(hab: Habitat, day: string): Action[] {
  const t = hab.today(day);
  const seen = new Set<Id>();
  const out: Action[] = [];
  const push = (a: Action) => {
    if (seen.has(a.id) || a.archivedAt) return;
    seen.add(a.id);
    out.push(a);
  };
  for (const a of t.actions) push(a);
  for (const a of t.overdue) push(a);
  // 只写了时间块、没写 due 的任务也在「今天」里，不能因为 due 空着就当没排
  for (const a of hab.store.all<Action>('action')) {
    if (a.state === 'done' || a.archivedAt) continue;
    if (a.scheduled?.[0]?.slice(0, 10) === day) push(a);
  }
  return out;
}

/**
 * 当日对账。纯只读：返回的是「证据 + 提案」，不写变更集，也不改任务状态。
 */
export async function reconcileDay(hab: Habitat, day = nowISO().slice(0, 10)): Promise<DayReconcile> {
  const activity = await collectDayActivity(hab, day);
  const idx = buildIndex(hab);
  const actions = plannedFor(hab, day);
  const hits = activity.hits;
  const claimed = new Set<Id>();

  const planned: PlannedItem[] = actions.map((a) => {
    const refIds = new Set<Id>();
    let refStrong = false;
    for (const ref of a.refs ?? []) {
      const o = resolveTarget(hab, idx, ref);
      if (!o) continue;
      const u = unitFor(hab, o);
      if (u) {
        u.family.forEach((id) => refIds.add(id));
        // 材料挂到「整部作品」时只能算弱证据：动了一章不等于整本书做完
        if (u.type === 'part' || u.type === 'note') refStrong = true;
      } else {
        refIds.add(o.id);
      }
    }

    const evidence: DayEvidence[] = [];
    for (const h of hits) {
      if (refIds.size === 0 || !hasIntersection(h.family, refIds)) continue;
      claimed.add(h.id);
      evidence.push({
        kind: 'ref',
        objectId: h.id,
        title: h.title,
        ops: h.ops,
        lastAt: h.lastAt,
        // 改 work.yaml（元数据）不等于写完了这部作品的某一章，最多算「今天动过」
        substantive: isSubstantive(h) && h.type !== 'work',
        detail: `今天动过「${h.title}」（${describeHit(h)}）`,
      });
    }

    // 没有点名材料时，才用词面找一个「可能相关」的线索；
    // 它只把任务标成 touched，永远不会替人判定完成。
    if (!evidence.length) {
      const loose = lexicalRelated(hits, a.text);
      if (loose) {
        claimed.add(loose.id);
        evidence.push({
          kind: 'lexical',
          objectId: loose.id,
          title: loose.title,
          ops: loose.ops,
          lastAt: loose.lastAt,
          substantive: isSubstantive(loose) && loose.type !== 'work',
          detail: `今天动过「${loose.title}」（${describeHit(loose)}）；这条任务没挂资料，词面对上了`,
        });
      }
    }

    const direct = evidence.filter((e) => e.kind === 'ref');
    const status: DayStatus = refStrong && direct.some((e) => e.substantive)
      ? 'covered'
      : evidence.length
        ? 'touched'
        : 'idle';

    return {
      id: a.id,
      text: a.text,
      due: a.due,
      flow: a.flow,
      projectId: a.projectId,
      status,
      evidence: evidence.slice(0, 3),
    };
  });

  // 计划外：今天确实投入了，但不属于今天任何一条待办
  const unplanned = hits
    .filter((h) => h.weight >= 2 && !claimed.has(h.id))
    .slice(0, 8);

  // 项目级只做汇总：哪个项目今天被碰过、碰了几个对象。
  // 不往下拆成「某条任务动过」——同一个项目下的任务互不相干，拆了就是编。
  const projects: DayReconcile['projects'] = [];
  for (const p of hab.store.all('project')) {
    const ids = new Set<Id>([p.id]);
    for (const l of hab.store.outbound(p.id)) ids.add(l.id);
    for (const l of hab.store.backlinks(p.id)) ids.add(l.id);
    const touched = hits.filter((h) => hasIntersection(h.family, ids));
    if (touched.length) {
      projects.push({
        id: p.id,
        title: 'title' in p ? String((p as { title: string }).title) : p.id,
        n: touched.length,
        titles: touched.slice(0, 3).map((h) => h.title),
      });
    }
  }
  projects.sort((a, b) => b.n - a.n);

  const counts = {
    events: activity.events,
    active: activity.hits.length,
    planned: planned.length,
    covered: planned.filter((p) => p.status === 'covered').length,
    touched: planned.filter((p) => p.status === 'touched').length,
    idle: planned.filter((p) => p.status === 'idle').length,
    unplanned: unplanned.length,
    taskOps: activity.taskOps,
  };

  return { day, at: nowISO(), activity, planned, unplanned, projects, counts };
}

/**
 * 简报里的两节：今天实际 / 待办对账。
 * 陈述事实，不写「你应该……」。确认动作仍然由人（或带审批的 agent）发起。
 */
export function renderDayLines(r: DayReconcile): string[] {
  const lines: string[] = [];
  lines.push('## 今天实际');
  if (!r.activity.events) {
    lines.push('- 今天 journal 里没有事件：不是「什么都没做」，是「没被记下来」。');
  } else if (!r.activity.hits.length) {
    lines.push(
      r.activity.taskOps
        ? `- ${r.activity.events} 条事件都落在计划管理上（新建 / 勾掉 / 改期 ${r.activity.taskOps} 次），没有对象产出。`
        : `- ${r.activity.events} 条事件都没有落到具体对象（提案 / 撤销 / 提交汇总）。`,
    );
  } else {
    for (const h of r.activity.hits.slice(0, 6)) lines.push(`- ${h.title}：${describeHit(h)}`);
    if (r.activity.hits.length > 6) {
      lines.push(`- 还有 ${r.activity.hits.length - 6} 个对象今天动过（\`habitat day\` 看全部）`);
    }
  }
  if (r.activity.taskOps) lines.push(`- 任务本身：新建 / 勾掉 / 改期 ${r.activity.taskOps} 次`);
  for (const p of r.projects.slice(0, 3)) {
    lines.push(`- 项目「${p.title}」今天动了 ${p.n} 个对象：${p.titles.join('、')}`);
  }

  if (r.counts.planned) {
    lines.push('');
    lines.push('## 待办对账');
    if (!r.counts.covered && r.counts.unplanned) {
      const untouched = r.counts.idle ? `；其中 ${r.counts.idle} 条一整天没碰` : '';
      lines.push(`> 今天没有按计划走：没有一条待办被实际工作覆盖${untouched}。实际投入见上。`);
    }
    for (const p of r.planned.filter((x) => x.status === 'covered').slice(0, 5)) {
      lines.push(`- 可能已完成：${p.text} —— ${p.evidence[0]?.detail ?? ''}（确认后 \`habitat done ${p.id}\`）`);
    }
    for (const p of r.planned.filter((x) => x.status === 'touched').slice(0, 5)) {
      lines.push(`- 今天动过：${p.text} —— ${p.evidence[0]?.detail ?? ''}`);
    }
    for (const p of r.planned.filter((x) => x.status === 'idle').slice(0, 5)) {
      lines.push(`- 今天没碰：${p.text}${p.due ? `（${p.due} 到期）` : ''}`);
    }
  }

  if (r.unplanned.length) {
    lines.push('');
    lines.push(`## 计划外投入 ${r.unplanned.length} 个`);
    for (const h of r.unplanned.slice(0, 5)) lines.push(`- ${h.title}：${describeHit(h)}`);
    lines.push('- 这些不在今天任何待办里。要么补一条任务，要么把它们挂到对应的待办上。');
  }
  return lines;
}
