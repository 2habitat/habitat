/**
 * commit.ts —— 唯一的写入路径（设计方案 §4.1 / §8.3）
 *
 *   propose(ops, baseRevisions, reason) → ChangeSet(draft)
 *        └─ validate：schema · 原件只读 · 链接 · 版本
 *              └─ commit：条件写 → 重读核验 → 事件 → 索引失效
 *                    └─ revert：核验当前版本后再反向提交
 *
 * 两条硬约束：
 *  · 提交前不写内容文件
 *  · 冲突不接受 force，只给三方（基准 / 我的 / 当前）
 */
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type {
  Action, Annotation, AnyObject, Author, ChangeSet, CheckResult, EventRec, Id,
  JournalEvent, JournalOp, Note, Op, Rep,
} from '../../shared/types.ts';
import { newId, nowISO } from '../../shared/id.ts';
import { parseDoc, serializeDoc, patchFm, wikiLinks } from '../../shared/frontmatter.ts';
import { validateObject } from '../../shared/schema.ts';
import { sha256, ConflictError, type StorageAdapter } from './storage.ts';
import type { Journal } from './journal.ts';
import { LAYOUT, STATE, slugify, type Store } from './store.ts';
import { renderTasks, renderEvents, parseTasks, parseEvents, appendTask, type InlineBlock } from './inline.ts';

/**
 * 提出变更时「我所看到的基准」。
 *
 * 这是「不强制覆盖」的关键：基准必须由发起方给出，而不是服务端自己读盘取最新。
 * 否则外部在你打开编辑器之后改的文件，会在你点保存的那一刻被静默吞掉——
 * 因为服务端认为「最新就是你的基准」。
 */
export interface ClientBase {
  rev?: number;
  hash?: string;
  /** 我看到的那一份原文。给了它，冲突时才有真正的三方（基准/我的/对方的） */
  content?: string;
}

export interface ProposeInput {
  ops: Op[];
  baseRevisions?: Record<Id, number>;
  /** 客户端（人或 Agent）看到的基准，优先于服务端读盘结果 */
  base?: Record<Id, ClientBase>;
  reason?: string;
  actor: Author;
}

export interface CommitResult {
  ok: boolean;
  changeset: ChangeSet;
  conflict?: ChangeSet['conflict'];
  /** 被硬校验拦下（不是版本冲突，是这条变更本身不合法，比如改原件） */
  blocked?: CheckResult[];
  events: JournalEvent[];
}

type DraftKind = 'doc' | 'inline-tasks' | 'inline-events' | 'jsonl' | 'yaml';

interface Draft {
  rel: string;
  kind: DraftKind;
  hash: string; // 提出变更时看到的哈希（'new' 表示当时不存在）
  original: string;
  fm?: Record<string, unknown>;
  body?: string;
  blocks?: InlineBlock[];
  objs?: Map<string, AnyObject>;
  lines?: AnyObject[];
  obj?: AnyObject;
  touchedIds: Set<Id>;
}

const INLINE_TASKS = `${LAYOUT.actions}/tasks.md`;
const INLINE_EVENTS = (m: string) => `${LAYOUT.events}/${m}.md`;

export class ChangeService {
  constructor(
    private store: Store,
    private journal: Journal,
    private adapter: StorageAdapter,
    private onIndexed?: (ids: Id[]) => void,
  ) {}

  /* ---------------- propose ---------------- */

  async propose(input: ProposeInput): Promise<ChangeSet> {
    // 新建对象一律钉到本空间的 id 上。
    // 之前界面建项目时写死过 spaceId: 'space-local'，而真实空间叫 space-personal——
    // 这种脏字段落盘后没人会发现，直到哪天按 spaceId 过滤时数据凭空消失。
    for (const op of input.ops) {
      if (op.t === 'create') {
        const o = op.obj as unknown as { spaceId?: string };
        if (o.spaceId !== this.store.space.id) o.spaceId = this.store.space.id;
      }
    }
    const drafts = new Map<string, Draft>();
    const touched: Id[] = [];

    // 第一遍只装载草稿，不落改动
    for (const op of input.ops) {
      const targetId = op.t === 'create' ? String((op.obj as AnyObject).id) : op.id;
      touched.push(targetId);
      const rel = await this.relFor(op);
      if (!drafts.has(rel)) drafts.set(rel, await this.loadDraft(rel, op));
      drafts.get(rel)!.touchedIds.add(targetId);
    }

    // 反向操作必须在落改动之前算，否则读到的就已经是改后的值了（撤销会变成空操作）
    const before = new Map<string, Draft>();
    for (const [rel, d] of drafts) before.set(rel, cloneDraft(d));

    // 第二遍才把改动落到草稿上
    for (const op of input.ops) {
      const rel = await this.relFor(op);
      this.applyToDraft(drafts.get(rel)!, op);
    }

    const baseRevisions: Record<Id, number> = {};
    const baseHashes: Record<Id, string> = {};
    const snapshot: ChangeSet['snapshot'] = {};
    const inverse: Op[] = [];

    for (const d of drafts.values()) {
      for (const id of d.touchedIds) {
        const o = this.store.get(id);
        const cb = input.base?.[id];
        // 客户端给了基准就以客户端为准——它看到的才是它改的那一份
        baseRevisions[id] = cb?.rev ?? input.baseRevisions?.[id] ?? o?.rev ?? 0;
        baseHashes[id] = cb?.hash ?? d.hash;
      }
    }

    for (const op of input.ops) {
      const rel = await this.relFor(op);
      inverse.push(...(await this.inverseOf(op, before.get(rel)!)));
    }

    // 快照：base = 提交基准内容，mine = 我要写的内容
    for (const [rel, d] of drafts) {
      const mine = this.serialize(d);
      for (const id of d.touchedIds) {
        const cb = input.base?.[id];
        // 基准内容：客户端给的那份优先，否则就是当时盘上的内容
        const base = cb?.content ?? d.original;
        snapshot[id] = { baseRev: baseRevisions[id] ?? 0, base, mine, hash: d.hash };
      }
      void rel;
    }

    const cs: ChangeSet = {
      type: 'changeset',
      id: newId('cs'),
      schema: 1,
      spaceId: this.store.space.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      author: input.actor,
      sensitivity: 'private',
      rev: 1,
      baseRevisions,
      baseHashes,
      ops: input.ops,
      state: 'draft',
      reason: input.reason,
      inverse,
      snapshot,
    };
    await this.persist(cs);
    return cs;
  }

  /* ---------------- validate ---------------- */

  async validate(cs: ChangeSet): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];

    // 1. schema：改动后的对象是否还符合定义
    const bad: string[] = [];
    for (const op of cs.ops) {
      const targetId = op.t === 'create' ? String((op.obj as AnyObject).id) : op.id;
      const draftObj = this.previewObject(op, targetId);
      const r = validateObject(draftObj as unknown as Record<string, unknown>);
      if (!r.ok) bad.push(`${targetId}: ${r.errors.join('; ')}`);
    }
    checks.push({
      name: 'schema',
      label: '对象结构',
      ok: bad.length === 0,
      level: 'error',
      detail: bad.length ? bad.join(' | ') : `${cs.ops.length} 个对象都符合定义`,
    });

    // 2. 原件只读：locked 的载体一个字都不许改
    const lockedHits: string[] = [];
    for (const op of cs.ops) {
      if (op.t === 'create') continue;
      const o = this.store.get(op.id);
      if (!o) continue;
      if (o.type === 'rep' && (o as Rep).locked) lockedHits.push(`${op.id}（原件，只读）`);
      const rel = this.store.file(op.id);
      if (rel && rel.startsWith(LAYOUT.originals)) lockedHits.push(`${rel}（原件目录）`);
    }
    checks.push({
      name: 'readonly',
      label: '原件只读',
      ok: lockedHits.length === 0,
      level: 'error',
      detail: lockedHits.length
        ? `不能改原件：${lockedHits.join('、')}。要改就衍生一篇笔记`
        : '没有触碰任何入库原件',
    });

    // 3. 链接：新增的 [[]] 能否解析（历史遗留的断链只是提醒，不阻断）
    const snap = cs.snapshot ?? {};
    const unresolved = new Set<string>();
    for (const s of Object.values(snap)) {
      for (const l of wikiLinks(s.mine)) {
        if (!this.store.stems.has(l.toLowerCase())) unresolved.add(l);
      }
    }
    checks.push({
      name: 'links',
      label: '链接可解析',
      ok: true,
      level: unresolved.size ? 'warn' : 'error',
      detail: unresolved.size ? `${unresolved.size} 条新链接暂时解析不到：${[...unresolved].slice(0, 5).join('、')}` : '所有新链接都能解析到对象',
    });

    // 4. 版本：基准修订号是否与磁盘上的一致（不信任内存，外部改动可能先于 propose 发生）
    const stale: string[] = [];
    const disk = await this.diskRevs(Object.keys(cs.baseRevisions));
    for (const [id, rev] of Object.entries(cs.baseRevisions)) {
      const o = this.store.get(id);
      if (!o) {
        if (rev !== 0) stale.push(`${id} 已不存在`);
        continue;
      }
      const d = disk[id];
      if (d === null) continue; // 行内文件没有独立修订号，靠哈希兜
      if (d !== rev) stale.push(`${id}：基准 r${rev}，磁盘 r${d}`);
    }
    checks.push({
      name: 'version',
      label: '版本一致',
      ok: stale.length === 0,
      level: 'error',
      detail: stale.length ? `有改动发生：${stale.join('；')}` : '基准版本与当前一致',
    });

    cs.checks = checks;
    cs.state = checks.some((c) => !c.ok) ? 'conflict' : 'validated';
    await this.persist(cs);
    return checks;
  }

  /* ---------------- commit ---------------- */

  async commit(csId: string): Promise<CommitResult> {
    const cs = await this.load(csId);
    if (!cs) throw new Error(`变更不存在：${csId}`);
    if (cs.state === 'committed') {
      return { ok: true, changeset: cs, events: cs.events ?? [] };
    }

    // 硬校验在这里兜底：校验没过的变更一律不许落盘。
    // 原件只读这种约束不能只靠前端不给按钮——绕过界面直接调接口也要拦得住。
    // version 不在这里拦：版本不一致正是「冲突」，要交给 detectConflict 生成三方内容，
    // 界面才能提供「重新载入 / 看差异 / 另存副本」。这里只拦真正的非法变更。
    const checks = cs.checks ?? (await this.validate(cs));
    const blocking = checks.filter((c) => !c.ok && c.level === 'error' && c.name !== 'version');
    if (blocking.length) {
      cs.state = 'conflict';
      await this.persist(cs);
      return { ok: false, changeset: cs, blocked: blocking, events: [] };
    }

    // 重新核验版本与哈希：propose 之后可能已经有人（或外部 Agent）改过
    const conflict = await this.detectConflict(cs);
    if (conflict) {
      cs.state = 'conflict';
      cs.conflict = conflict;
      await this.persist(cs);
      return { ok: false, changeset: cs, conflict, events: [] };
    }

    const drafts = new Map<string, Draft>();
    for (const op of cs.ops) {
      const rel = await this.relFor(op);
      if (!drafts.has(rel)) drafts.set(rel, await this.loadDraft(rel, op));
      this.applyToDraft(drafts.get(rel)!, op);
    }

    const events: JournalEvent[] = [];
    for (const [rel, d] of drafts) {
      const content = this.serialize(d);
      try {
        await this.adapter.write(rel, content, { ifHash: d.hash });
      } catch (e) {
        if (e instanceof ConflictError) {
          const c = await this.detectConflict(cs);
          cs.state = 'conflict';
          cs.conflict = c ?? { id: rel, base: { rev: 0, content: d.original }, mine: { content }, theirs: { rev: 0, content: '', updatedAt: nowISO(), author: 'external:unknown' } };
          await this.persist(cs);
          return { ok: false, changeset: cs, conflict: cs.conflict, events: [] };
        }
        throw e;
      }
      for (const id of d.touchedIds) {
        const o = this.store.get(id);
        if (o) {
          o.rev += 1;
          o.updatedAt = nowISO();
        }
      }
    }

    // 每个写操作一条事件（保证「所有写路径 100% 有事件」）
    for (const op of cs.ops) {
      const targetId = op.t === 'create' ? String((op.obj as AnyObject).id) : op.id;
      // 新建的对象还没进 store，事件来源要用 op 自带的那份，否则 srcIds 读不到
      const o = this.store.get(targetId) ?? (op.t === 'create' ? (op.obj as AnyObject) : undefined);
      const jop = opToJournal(op, o);
      events.push(
        await this.journal.add({
          actor: cs.author,
          op: jop,
          phase: 'done',
          target: this.store.file(targetId) ?? targetId,
          summary: opSummary(op, o),
          payload: { changeset: cs.id, op: op.t },
        }),
      );
    }

    // 变更本身一条汇总事件
    events.push(
      await this.journal.add({
        actor: cs.author,
        op: 'commit',
        phase: 'done',
        target: `changeset:${cs.id}`,
        summary: cs.reason || `提交 ${cs.ops.length} 项变更`,
        payload: { ops: cs.ops.length, targets: Object.keys(cs.baseRevisions) },
      }),
    );

    cs.state = 'committed';
    cs.committedAt = nowISO();
    cs.events = events;
    await this.persist(cs);
    await this.store.refreshAll();
    this.onIndexed?.(Object.keys(cs.baseRevisions));
    return { ok: true, changeset: cs, events };
  }

  /* ---------------- revert ---------------- */

  async revert(csId: string): Promise<CommitResult> {
    const cs = await this.load(csId);
    if (!cs) throw new Error(`变更不存在：${csId}`);
    if (cs.state !== 'committed') throw new Error('只有已提交的变更可以撤销');
    if (!cs.inverse?.length) throw new Error('这条变更没有反向操作，无法自动撤销');

    const back: ChangeSet = {
      ...cs,
      id: newId('cs'),
      ops: cs.inverse,
      baseRevisions: {},
      baseHashes: {},
      snapshot: {},
      state: 'draft',
      reason: `撤销 ${cs.id}`,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      inverse: [],
      checks: undefined,
      conflict: undefined,
    };
    for (const op of back.ops) {
      const id = op.t === 'create' ? String((op.obj as AnyObject).id) : op.id;
      const o = this.store.get(id);
      back.baseRevisions[id] = o?.rev ?? 0;
    }
    await this.persist(back);
    const r = await this.commit(back.id);
    if (r.ok) {
      cs.state = 'reverted';
      cs.revertedAt = nowISO();
      await this.persist(cs);
      // 撤销本身也要留一条 revert 事件：光有反向操作的 settle/commit，
      // 事后翻事件流是看不出「这条是被撤回的」。
      await this.journal.add({
        actor: cs.author,
        op: 'revert',
        phase: 'done',
        target: `changeset:${cs.id}`,
        summary: `撤销：${cs.reason || cs.id}`,
        payload: { by: back.id, ops: back.ops.length, inverseOf: cs.id },
      });
    }
    return r;
  }

  /** 磁盘上的修订号：行内文件（tasks.md / 日程）没有独立修订号，返回 null */
  private async diskRevs(ids: Id[]): Promise<Record<Id, number | null>> {
    const out: Record<Id, number | null> = {};
    for (const id of ids) {
      const rel = this.store.file(id);
      if (!rel || this.store.isInline(rel) || !rel.endsWith('.md')) {
        out[id] = null;
        continue;
      }
      try {
        const raw = await this.adapter.read(rel);
        out[id] = Number(parseDoc(raw).fm.rev ?? 1) || 1;
      } catch {
        out[id] = null;
      }
    }
    return out;
  }

  private async detectConflict(cs: ChangeSet): Promise<ChangeSet['conflict'] | null> {
    const disk = await this.diskRevs(Object.keys(cs.baseRevisions));
    for (const [id, rev] of Object.entries(cs.baseRevisions)) {
      const o = this.store.get(id);
      const d = disk[id];
      const cur = d ?? o?.rev ?? 0;
      if (cur !== rev) {
        const rel = this.store.file(id);
        const current = rel ? await this.adapter.read(rel).catch(() => '') : '';
        const fm = rel && rel.endsWith('.md') ? parseDoc(current).fm : {};
        return {
          id,
          base: { rev, content: cs.snapshot?.[id]?.base ?? '' },
          mine: { content: cs.snapshot?.[id]?.mine ?? '' },
          theirs: {
            rev: cur,
            content: current,
            updatedAt: String(fm.updatedAt ?? nowISO()),
            author: (fm.author as Author) ?? 'external:unknown',
          },
        };
      }
    }
    for (const [id, h] of Object.entries(cs.baseHashes ?? {})) {
      const rel = this.store.file(id);
      if (!rel) continue;
      const st = await this.adapter.stat(rel);
      const curHash = st?.hash ?? 'new';
      if (curHash !== h) {
        const current = st ? await this.adapter.read(rel) : '';
        return {
          id,
          base: { rev: cs.baseRevisions[id] ?? 0, content: cs.snapshot?.[id]?.base ?? '' },
          mine: { content: cs.snapshot?.[id]?.mine ?? '' },
          theirs: {
            rev: this.store.get(id)?.rev ?? 0,
            content: current,
            updatedAt: nowISO(),
            author: 'external:unknown',
          },
        };
      }
    }
    return null;
  }

  /* ---------------- draft ---------------- */

  private async relFor(op: Op): Promise<string> {
    if (op.t === 'create') {
      const obj = op.obj as AnyObject;
      if (obj.type === 'action') return INLINE_TASKS;
      if (obj.type === 'event') return INLINE_EVENTS(String((obj as EventRec).start).slice(0, 7));
      if (obj.type === 'annotation') return `${LAYOUT.annotations}/${(obj as Annotation).targetRepId}.jsonl`;
      return this.store.pathFor(obj);
    }
    const rel = this.store.file(op.id);
    if (!rel) throw new Error(`对象没有文件：${op.id}`);
    // remove 是行式记录的专用操作（目前只有批注 .jsonl）；别让它落到 md/yaml 上变成空操作
    if (op.t === 'remove' && !rel.endsWith('.jsonl')) throw new Error(`remove 只能用于行式记录：${rel}`);
    return rel;
  }

  private async loadDraft(rel: string, op: Op): Promise<Draft> {
    const isNew = op.t === 'create' && !['action', 'event', 'annotation'].includes(String((op.obj as AnyObject).type));
    let original = '';
    let hash = 'new';
    const st = await this.adapter.stat(rel);
    if (st) {
      original = await this.adapter.read(rel);
      hash = st.hash;
    } else if (isNew) {
      original = '';
      hash = 'new';
    } else {
      // 行内文件第一次写入时还不存在，先给一份骨架
      original = '';
      hash = 'new';
    }

    const kind: DraftKind =
      rel.endsWith('.yaml') ? 'yaml'
        : rel.endsWith('.jsonl') ? 'jsonl'
          : rel.startsWith(LAYOUT.events) ? 'inline-events'
            : rel.startsWith(LAYOUT.actions) ? 'inline-tasks'
              : 'doc';

    const d: Draft = { rel, kind, hash, original, touchedIds: new Set() };

    if (kind === 'doc') {
      const p = parseDoc(original);
      d.fm = p.fm;
      d.body = p.body;
    } else if (kind === 'yaml') {
      d.obj = (yamlParse(original) ?? {}) as unknown as AnyObject;
    } else if (kind === 'jsonl') {
      d.lines = original
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as AnyObject;
          } catch {
            return null;
          }
        })
        .filter((x): x is AnyObject => !!x);
    } else if (kind === 'inline-tasks') {
      const p = parseDoc(original);
      d.fm = p.fm;
      d.blocks = parseTasks(p.body);
      d.objs = new Map();
      for (const id of this.store.idsIn.get(rel) ?? []) {
        const o = this.store.get<Action>(id);
        if (o) d.objs.set(this.store.inlineOf.get(id) ?? id, o);
      }
    } else {
      const p = parseDoc(original);
      d.fm = p.fm;
      d.blocks = parseEvents(p.body);
      d.objs = new Map();
      for (const id of this.store.idsIn.get(rel) ?? []) {
        const o = this.store.get<EventRec>(id);
        if (o) d.objs.set(this.store.inlineOf.get(id) ?? id, o);
      }
    }
    return d;
  }

  private applyToDraft(d: Draft, op: Op): void {
    if (op.t === 'create') {
      const obj = { ...(op.obj as AnyObject), updatedAt: nowISO(), rev: 1 } as AnyObject;
      if (d.kind === 'jsonl') {
        d.lines!.push(obj);
      } else if (d.kind === 'inline-tasks' || d.kind === 'inline-events') {
        const a = obj as Action;
        if (d.kind === 'inline-tasks') {
          d.blocks!.push({
            kind: 'task',
            raw: '',
            done: a.state === 'done',
            text: a.text,
            id: a.id,
            fields: {},
          });
        } else {
          const e = obj as EventRec;
          d.blocks!.push({
            kind: 'event',
            raw: '',
            date: e.start.slice(0, 10),
            text: e.title,
            id: e.id,
            fields: { start: e.start.slice(11, 16), end: e.end.slice(11, 16) },
          });
        }
        d.objs!.set(obj.id, obj);
      } else if (d.kind === 'doc') {
        const { body, path: _p, ...rest } = obj as Note & { body?: string; path?: string };
        void _p; // path 是内部字段，不进 frontmatter
        d.fm = { ...rest } as Record<string, unknown>;
        d.body = body ?? '';
      } else {
        d.obj = obj;
      }
      d.touchedIds.add(obj.id);
      return;
    }

    d.touchedIds.add(op.id);

    if (d.kind === 'jsonl') {
      const i = d.lines!.findIndex((x) => (x as AnyObject).id === op.id);
      if (i < 0) return;
      const cur = d.lines![i] as unknown as Record<string, unknown>;
      if (op.t === 'update') d.lines![i] = { ...cur, ...op.patch } as unknown as AnyObject;
      if (op.t === 'remove') d.lines!.splice(i, 1);
      return;
    }

    if (d.kind === 'inline-tasks' || d.kind === 'inline-events') {
      const key = this.store.inlineOf.get(op.id) ?? op.id;
      const cur = d.objs!.get(key);
      if (!cur) return;
      if (op.t === 'update') d.objs!.set(key, { ...cur, ...op.patch } as AnyObject);
      if (op.t === 'archive') d.objs!.set(key, { ...cur, archivedAt: op.archived ? nowISO() : undefined } as AnyObject);
      return;
    }

    if (d.kind === 'doc') {
      if (op.t === 'update') d.fm = patchFm(d.fm!, op.patch);
      if (op.t === 'setBody') d.body = op.body;
      if (op.t === 'append') {
        d.body = op.anchor === 'start' ? `${op.text}\n${d.body ?? ''}` : `${(d.body ?? '').replace(/\n*$/, '\n')}${op.text}\n`;
      }
      if (op.t === 'archive') d.fm = patchFm(d.fm!, { archivedAt: op.archived ? nowISO() : undefined });
      return;
    }

    if (d.kind === 'yaml') {
      if (op.t === 'update') d.obj = { ...d.obj, ...op.patch } as unknown as AnyObject;
      if (op.t === 'archive') d.obj = { ...d.obj, archivedAt: op.archived ? nowISO() : undefined } as unknown as AnyObject;
    }
    void sha256;
  }

  private serialize(d: Draft): string {
    if (d.kind === 'jsonl') return `${d.lines!.map((x) => JSON.stringify(x)).join('\n')}\n`;
    if (d.kind === 'yaml') {
      const { path: _p, ...rest } = (d.obj ?? {}) as Record<string, unknown>;
      void _p;
      return yamlStringify(rest, { lineWidth: 0 });
    }
    const fm = { ...(d.fm ?? {}) };
    if (d.kind === 'doc') {
      return serializeDoc(fmForFile(fm, { updatedAt: nowISO(), rev: (Number(fm.rev) || 0) + 1 }), d.body ?? '');
    }
    // 行内文件
    let body: string;
    if (d.kind === 'inline-tasks') {
      body = renderTasks(d.blocks!, d.objs as Map<string, Action>);
    } else {
      body = renderEvents(d.blocks!, d.objs as Map<string, EventRec>);
    }
    return serializeDoc(fmForFile(fm, { updatedAt: nowISO() }), body);
  }

  private async inverseOf(op: Op, before: Draft): Promise<Op[]> {
    if (op.t === 'create') {
      const id = String((op.obj as AnyObject).id);
      // 批注没有归档态：撤销「新建批注」就是从 jsonl 里摘掉这一行，
      // 否则 jsonl 里那行还在，重扫一遍高亮又长回来了。
      if ((op.obj as AnyObject).type === 'annotation') return [{ t: 'remove', id }];
      return [{ t: 'archive', id, archived: true }];
    }
    if (op.t === 'update') {
      const cur = this.currentOf(op.id, before);
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(op.patch)) patch[k] = cur?.[k];
      return [{ t: 'update', id: op.id, patch }];
    }
    if (op.t === 'setBody') {
      return [{ t: 'setBody', id: op.id, body: String(before.body ?? '') }];
    }
    if (op.t === 'append') {
      return [{ t: 'setBody', id: op.id, body: String(before.body ?? '') }];
    }
    if (op.t === 'archive') {
      return [{ t: 'archive', id: op.id, archived: !op.archived }];
    }
    if (op.t === 'move') {
      const cur = this.currentOf(op.id, before);
      return [{ t: 'move', id: op.id, to: String(cur?.path ?? '') }];
    }
    if (op.t === 'remove') {
      const cur = this.currentOf(op.id, before);
      return cur ? [{ t: 'create', obj: cur as unknown as AnyObject }] : [];
    }
    return [];
  }

  private currentOf(id: Id, before: Draft): Record<string, unknown> | undefined {
    if (before.kind === 'doc') return before.fm as Record<string, unknown>;
    if (before.kind === 'yaml') return before.obj as unknown as Record<string, unknown>;
    if (before.kind === 'jsonl') return before.lines?.find((x) => x.id === id) as unknown as Record<string, unknown>;
    const key = this.store.inlineOf.get(id) ?? id;
    return before.objs?.get(key) as unknown as Record<string, unknown>;
  }

  private previewObject(op: Op, id: Id): Record<string, unknown> {
    const cur = (this.store.get(id) ?? {}) as unknown as Record<string, unknown>;
    if (op.t === 'create') return { ...(op.obj as AnyObject), rev: 1 } as unknown as Record<string, unknown>;
    if (op.t === 'update') return { ...cur, ...op.patch };
    return cur;
  }

  /* ---------------- 持久化（.habitat/state/changesets.jsonl） ---------------- */

  private async persist(cs: ChangeSet): Promise<void> {
    const raw = await this.adapter.read(STATE.changesets).catch(() => '');
    const lines = raw.split('\n').filter(Boolean);
    const i = lines.findIndex((l) => {
      try {
        return (JSON.parse(l) as ChangeSet).id === cs.id;
      } catch {
        return false;
      }
    });
    const line = JSON.stringify(cs);
    if (i >= 0) lines[i] = line;
    else lines.push(line);
    await this.adapter.write(STATE.changesets, `${lines.join('\n')}\n`, { backup: false });
  }

  async load(id: string): Promise<ChangeSet | undefined> {
    return (await this.list()).find((c) => c.id === id);
  }

  async list(): Promise<ChangeSet[]> {
    const raw = await this.adapter.read(STATE.changesets).catch(() => '');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as ChangeSet;
        } catch {
          return null;
        }
      })
      .filter((x): x is ChangeSet => !!x)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}

/* ---------------- 辅助 ---------------- */

/**
 * 日期字段沿用这篇文件原本的写法。
 * 老库写的是 `created: 2026-10-27` / `updated: 2026-10-29`，新对象写 `createdAt/updatedAt`；
 * 编辑老笔记时如果硬塞 camelCase，同一篇里就会并存两套日期——看着像被两个工具抢着改。
 */
function fmForFile(fm: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fm, ...patch };
  if ('created' in fm && !('createdAt' in fm) && 'createdAt' in out) {
    out.created = out.createdAt;
    delete out.createdAt;
  }
  if ('updated' in fm && !('updatedAt' in fm) && 'updatedAt' in out) {
    out.updated = String(out.updatedAt).slice(0, 10);
    delete out.updatedAt;
  }
  return out;
}

function cloneDraft(d: Draft): Draft {
  return {
    ...d,
    fm: d.fm ? { ...d.fm } : undefined,
    blocks: d.blocks?.map((b) => ({ ...b, fields: { ...b.fields } })),
    objs: d.objs ? new Map([...d.objs].map(([k, v]) => [k, { ...v }])) : undefined,
    lines: d.lines?.map((x) => ({ ...x })),
    obj: d.obj ? { ...d.obj } : undefined,
    touchedIds: new Set(d.touchedIds),
  };
}

function opToJournal(op: Op, o?: AnyObject): JournalOp {
  if (op.t === 'create') {
    switch (o?.type ?? (op.obj as AnyObject).type) {
      case 'annotation':
        return 'annotate';
      case 'note':
        return ((o as Note | undefined)?.srcIds ?? []).length > 0 ? 'derive' : 'capture';
      case 'action':
      case 'event':
      case 'project':
      case 'area':
      case 'collection':
        return 'capture';
      case 'proposal':
        return 'propose';
      default:
        return 'capture';
    }
  }
  if (op.t === 'archive' && op.archived) return 'settle';
  if (op.t === 'remove') return o?.type === 'annotation' ? 'unannotate' : 'edit';
  if (op.t === 'update') {
    const p = op.patch as Record<string, unknown>;
    if (p.status === 'evergreen') return 'settle';
    return 'edit';
  }
  return 'edit';
}

function opSummary(op: Op, o?: AnyObject): string {
  const oid = op.t === 'create' ? String((op.obj as AnyObject).id) : op.id;
  const name = (o?.type === 'note' ? (o as Note).title : undefined) ?? oid;
  switch (op.t) {
    case 'create':
      return `新建${typeLabel((op.obj as AnyObject).type)}：${(op.obj as { title?: string; text?: string }).title ?? (op.obj as { text?: string }).text ?? oid}`;
    case 'update':
      return `更新${typeLabel(o?.type)}：${name}（${Object.keys(op.patch).join('、')}）`;
    case 'setBody':
      return `改写正文：${name}`;
    case 'append':
      return `追加内容：${name}`;
    case 'archive':
      return op.archived ? `归档：${name}` : `取消归档：${name}`;
    case 'move':
      return `移动：${name} → ${op.to}`;
    case 'remove': {
      const quote = (o as { quote?: string } | undefined)?.quote;
      return `删除${typeLabel(o?.type)}：${quote ? quote.slice(0, 20) : name}`;
    }
    default:
      return `改动：${name}`;
  }
}

function typeLabel(t?: string): string {
  return (
    {
      work: '作品', part: '章节', rep: '载体', note: '笔记', annotation: '批注',
      action: '任务', event: '日程', project: '项目', area: '领域', collection: '专题',
      proposal: '提案', job: '作业', changeset: '变更',
    } as Record<string, string>
  )[t ?? ''] ?? '对象';
}

export { appendTask, slugify };
