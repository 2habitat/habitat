/**
 * 一个空间的运行时：文件（事实源）→ 事件流（审计）→ SQLite（索引）
 * 所有写操作都经 ChangeService，React 只读不写。
 */
import type {
  Action, Annotation, AnyObject, Author, EventRec, Id, JournalEvent, Note,
  Part, Project, Rep, Work,
} from '../../shared/types.ts';
import { gatesOf, stageOf, nextAction, type LifeFacts } from '../../shared/lifecycle.ts';
import { newId, nowISO } from '../../shared/id.ts';
import { Journal } from './journal.ts';
import { Store } from './store.ts';
import { ChangeService } from './commit.ts';
import { touch } from './usage.ts';
import { SearchIndex } from './index.ts';
import { reconcile, takeSnapshot } from './reconcile.ts';
import * as path from 'node:path';
import { slugify } from './store.ts';

export interface WorkView {
  work: Work;
  parts: Part[];
  reps: Rep[];
  originals: number;
  annotations: number;
  derived: number;
  readPct: number;
  gates: ReturnType<typeof gatesOf>;
  stage: ReturnType<typeof stageOf>;
  next: ReturnType<typeof nextAction>;
  locked: boolean;
}

export class Habitat {
  journal!: Journal;
  changes!: ChangeService;
  index!: SearchIndex;

  private constructor(
    public store: Store,
    public dbPath: string,
  ) {}

  static async open(root: string, opts: { dbPath?: string; fresh?: boolean } = {}): Promise<Habitat> {
    const store = new Store(root);
    await store.open();
    await store.scan();
    const dbPath = opts.dbPath ?? path.join(root, '.habitat/state/habitat.db');
    const h = new Habitat(store, dbPath);
    h.journal = new Journal(store.adapter, store.space.id);
    h.index = new SearchIndex(opts.fresh ? ':memory:' : dbPath);
    // 提交后只同步动过的那几个对象，不整库重建。
    // 之前每次提交都 void h.reindex()，186 个对象的真实库要 242ms，而且完全没必要。
    h.changes = new ChangeService(store, h.journal, store.adapter, (ids) => {
      void h.syncIndex(ids);
    });
    await h.reindex();
    return h;
  }

  private closed = false;

  close(): void {
    this.closed = true;
    try {
      this.index.close();
    } catch {
      /* 已经关了就算了 */
    }
  }

  async reindex(): Promise<void> {
    if (this.closed) return; // 关闭后可能还有提交回调在飞，别往关掉的连接里写
    const evs = await this.journal.query({ limit: 100000 });
    if (this.closed || !this.index.db.open) return;
    await this.index.rebuild(this.store, evs);
  }

  private rescanChain: Promise<void> = Promise.resolve();

  /**
   * 重扫要串行：文件监听和「手动重建索引」可能同时触发，
   * 两个 scan 交错会互相清空对象表，SQLite 也会撞在一起——表现是请求直接断掉。
   */
  /**
   * 重扫。
   *
   * 传 ids 时走增量：只重插这几个对象的索引，事件也只追加最近的。
   * 不传就整库重建——外部改动、批量迁移这类"不知道改了什么"的场合用它。
   *
   * 为什么分两条路：整库重建要重读所有正文并重新分词，
   * 真实库 186 个对象实测 242ms；而一次提交只改一两个对象。
   */
  private indexChain: Promise<void> = Promise.resolve();

  /** 只同步指定对象的索引（提交后用）。串行执行，避免和重扫撞车。 */
  async syncIndex(ids: string[]): Promise<void> {
    if (this.closed || !ids.length) return;
    const run = this.indexChain.then(async () => {
      await this.index.syncObjects(this.store, ids);
      const recent = await this.journal.query({ limit: 50 });
      this.index.appendJournal(recent);
    });
    this.indexChain = run.catch(() => undefined);
    await run;
  }

  async rescan(ids?: string[]): Promise<void> {
    const run = this.rescanChain.then(async () => {
      // 外部改动的情况没人告诉我们是哪几个对象变了，扫完自己比对一次。
      // 通常只有一两个文件变，比对出来的变化集很小，就能走增量。
      const before = new Map<string, string>();
      for (const [id, o] of this.store.objects) before.set(id, `${o.rev}|${o.updatedAt}`);

      await this.store.scan();

      let changed = ids;
      if (!changed) {
        changed = [];
        for (const [id, o] of this.store.objects) {
          if (before.get(id) !== `${o.rev}|${o.updatedAt}`) changed.push(id);
        }
        // 有对象消失（外部删文件/改名）时对象图结构变了，老实整库重建
        const removed = [...before.keys()].filter((id) => !this.store.objects.has(id));
        if (removed.length) changed = [];
      }

      // 一个对象都没变（外部只是碰了下文件、或定时轮询）就不必重建索引
      if (!changed.length) {
        // no-op：索引与事件都没变化
      } else if (changed.length <= 200) {
        await this.index.syncObjects(this.store, changed);
        // 事件表用 INSERT OR REPLACE 追加，重复插不会出错，所以只取最近一批就够
        const recent = await this.journal.query({ limit: 50 });
        this.index.appendJournal(recent);
      } else {
        await this.reindex();
      }
    });
    // 即使这一次失败，链也要继续，否则后面所有重扫都会被卡死
    this.rescanChain = run.catch(() => undefined);
    await run;
  }

  /**
   * 外部改了文件就重扫。
   *
   * 为什么需要它：Agent 用 CLI（或直接写文件）进来的内容，正在跑的服务是不知道的，
   * 界面上就看不到——「AI 干了活，人看不见」正是这套系统要消灭的东西。
   * 只在没有写请求在飞的时候扫，避免和提交抢 store。
   */
  private lastFingerprint = '';
  private scanning = false;

  async pollExternal(writesInFlight: () => number): Promise<boolean> {
    if (this.closed || this.scanning || writesInFlight() > 0) return false;
    const fp = await this.store.fingerprint();
    if (!fp || fp === this.lastFingerprint) return false;
    this.lastFingerprint = fp;
    this.scanning = true;
    try {
      await this.rescan();
      return true;
    } catch {
      return false;
    } finally {
      this.scanning = false;
    }
  }

  /* ---------------- 生命周期 ---------------- */

  facts(id: Id): LifeFacts {
    const o = this.store.get(id);
    if (!o) return { exists: false, hasSource: false, derivedCount: 0, readPct: 0, reviewedAt: null, evergreen: false, inbound: 0 };
    // derivedOf 只数笔记，批注单独数——两者都是「从这里长出去的东西」，但不能重复计
    const derived = this.derivedOf(id).length + this.annotationsOf(id).length;
    return {
      exists: true,
      hasSource: !!this.store.sourceOf.get(id) || (o as Note).srcIds?.length > 0 || o.type === 'work' || o.type === 'part',
      derivedCount: derived,
      readPct: this.readPct(id),
      reviewedAt: this.lastEvent(id, 'review')?.at ?? null,
      evergreen: this.evergreen(id),
      inbound: this.inbound(id),
    };
  }

  gates(id: Id) {
    const f = this.facts(id);
    return { facts: f, gates: gatesOf(f), stage: stageOf(f), next: nextAction(f) };
  }

  private readPct(id: Id): number {
    const o = this.store.get(id);
    if (!o) return 0;
    if (o.type === 'work') {
      let best = 0;
      for (const r of this.store.all<Rep>('rep').filter((r) => r.workId === id)) {
        best = Math.max(best, this.store.cursors.get(r.id)?.furthest ?? 0);
      }
      return best;
    }
    if (o.type === 'rep') return this.store.cursors.get(id)?.furthest ?? 0;
    // 笔记：读过就算读过
    return this.lastEvent(id, 'read') ? 1 : 0;
  }

  private evergreen(id: Id): boolean {
    const o = this.store.get(id);
    if (!o) return false;
    if (o.type === 'note') return (o as Note).status === 'evergreen';
    if (this.store.statusOf.get(id) === 'evergreen') return true;
    return this.derivedOf(id).some((d) => (d as Note).status === 'evergreen');
  }

  private inbound(id: Id): number {
    let n = 0;
    for (const l of this.store.links) if (l.resolved === id) n += 1;
    for (const c of this.store.all('collection')) {
      if ((c as { memberIds?: string[] }).memberIds?.includes(id)) n += 1;
    }
    for (const nt of this.store.all<Note>('note')) {
      if (nt.srcIds?.includes(id)) n += 1;
    }
    return n;
  }

  /** 从 id 长出去的「笔记」。批注不算在这里，用 annotationsOf —— 两边分开数，别重复 */
  derivedOf(id: Id): AnyObject[] {
    const rel = new Set<string>([id]);
    const o = this.store.get(id);
    if (o?.type === 'work') {
      for (const p of this.store.all<Part>('part')) if (p.workId === id) rel.add(p.id);
      for (const r of this.store.all<Rep>('rep')) if (r.workId === id) rel.add(r.id);
    }
    const out: AnyObject[] = [];
    for (const n of this.store.all<Note>('note')) {
      if (n.srcIds?.some((s) => rel.has(s))) out.push(n);
    }
    return out;
  }

  annotationsOf(id: Id): Annotation[] {
    const o = this.store.get(id);
    if (!o) return [];
    if (o.type === 'rep') return this.store.all<Annotation>('annotation').filter((a) => a.targetRepId === id);
    if (o.type === 'work') {
      const reps = new Set(this.store.all<Rep>('rep').filter((r) => r.workId === id).map((r) => r.id));
      return this.store.all<Annotation>('annotation').filter((a) => reps.has(a.targetRepId));
    }
    if (o.type === 'part') {
      const reps = new Set(this.store.all<Rep>('rep').filter((r) => r.partId === id).map((r) => r.id));
      return this.store.all<Annotation>('annotation').filter((a) => reps.has(a.targetRepId));
    }
    return [];
  }

  private lastEvent(id: Id, op: string): JournalEvent | null {
    const rel = this.store.file(id);
    if (!rel) return null;
    return this.recentEvents.find((e) => e.op === op && (e.target === rel || e.target === id)) ?? null;
  }

  private _recent: JournalEvent[] = [];
  private _recentAt = 0;
  async loadRecent(): Promise<JournalEvent[]> {
    this._recent = await this.journal.query({ limit: 5000 });
    this._recentAt = Date.now();
    return this._recent;
  }
  private get recentEvents(): JournalEvent[] {
    if (Date.now() - this._recentAt > 2000) return []; // 过期就用空集，避免读到陈旧快照
    return this._recent;
  }

  /* ---------------- 视图 ---------------- */

  works(): WorkView[] {
    return this.store.all<Work>('work').map((w) => this.workView(w.id)).filter((v): v is WorkView => !!v);
  }

  workView(id: Id): WorkView | null {
    const work = this.store.get<Work>(id);
    if (!work) return null;
    const parts = this.store
      .all<Part>('part')
      .filter((p) => p.workId === id)
      .sort((a, b) => a.order - b.order);
    const reps = this.store.all<Rep>('rep').filter((r) => r.workId === id);
    const g = this.gates(id);
    return {
      work,
      parts,
      reps,
      originals: this.store.assets.filter((a) => a.kind === 'original' && a.workSlug === work.slug).length,
      annotations: this.annotationsOf(id).length,
      derived: this.derivedOf(id).filter((d) => d.type === 'note').length,
      readPct: g.facts.readPct,
      gates: g.gates,
      stage: g.stage,
      next: g.next,
      locked: reps.length > 0 && reps.every((r) => r.locked),
    };
  }

  inbox(): Note[] {
    return this.store
      .all<Note>('note')
      // 收件箱只列「还没消化」的：已经 archivedAt 的碎片清了但没删（不删除只归档），
      // 留在 inbox/ 目录里继续出现在列表，就会变成永远消化不掉的一条。
      .filter((n) => (this.store.file(n.id) ?? '').startsWith('inbox/') && !n.archivedAt)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  today(today = nowISO().slice(0, 10)): {
    actions: Action[];
    events: EventRec[];
    overdue: Action[];
    reading: { rep: Rep; title: string; pct: number }[];
  } {
    const actions = this.store
      .all<Action>('action')
      .filter((a) => a.state !== 'done' && !a.archivedAt && (a.due === today || a.flow === 'now'))
      .sort((a, b) => a.flow.localeCompare(b.flow));
    const events = this.store
      .all<EventRec>('event')
      .filter((e) => e.start.slice(0, 10) === today && !e.archivedAt);
    const overdue = this.store
      .all<Action>('action')
      .filter((a) => a.state !== 'done' && !a.archivedAt && !!a.due && a.due < today)
      .sort((a, b) => (a.due! < b.due! ? -1 : 1));
    const reading: { rep: Rep; title: string; pct: number }[] = [];
    for (const [repId, c] of this.store.cursors) {
      if (c.current >= 0.999) continue;
      const rep = this.store.get<Rep>(repId);
      if (!rep) continue;
      const part = this.store.get<Part>(rep.partId);
      const work = part ? this.store.get<Work>(part.workId) : undefined;
      reading.push({ rep, title: `${work?.title ?? '未归类'} · ${part?.title ?? ''}`, pct: c.current });
    }
    reading.sort((a, b) => b.pct - a.pct);
    return { actions, events, overdue, reading: reading.slice(0, 8) };
  }

  projects(): (Project & { actions: Action[]; done: number })[] {
    return this.store.all<Project>('project').map((p) => {
      const actions = this.store.all<Action>('action').filter((a) => a.projectId === p.id);
      return { ...p, actions, done: actions.filter((a) => a.state === 'done').length };
    });
  }

  stats() {
    const s = this.store.all('work').length;
    return {
      works: s,
      parts: this.store.all('part').length,
      reps: this.store.all('rep').length,
      notes: this.store.all('note').length,
      annotations: this.store.all('annotation').length,
      actions: this.store.all('action').length,
      events: this.store.all('event').length,
      assets: this.store.assets.length,
      assetBytes: this.store.assets.reduce((a, b) => a + b.bytes, 0),
      unresolved: this.store.links.filter((l) => !l.resolved).length,
      links: this.store.links.length,
      objects: this.store.objects.size,
    };
  }

  /* ---------------- 便捷写操作（全部走 ChangeService） ---------------- */

  async capture(input: {
    title: string;
    body: string;
    kind?: Note['kind'];
    srcIds?: Id[];
    target?: 'inbox' | 'notes';
    actor?: Author;
  }): Promise<{ id: Id; events: JournalEvent[] }> {
    const note: Note = {
      type: 'note',
      id: newId('note'),
      schema: 1,
      spaceId: this.store.space.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      author: input.actor ?? 'human',
      sensitivity: this.store.space.defaultSensitivity,
      rev: 1,
      title: input.title,
      body: input.body,
      status: 'seedling',
      srcIds: input.srcIds ?? [],
      kind: input.kind ?? 'point',
    };
    // 「落到哪」是界面上给了的选项，不能默默忽略：收件箱是未消化区，笔记是成型区
    if ((input.target ?? 'inbox') === 'inbox') {
      note.path = `inbox/${slugify(input.title)}.md`;
    }
    return this.commitOps([{ t: 'create', obj: note as AnyObject }], input.actor ?? 'human', `采集：${input.title}`);
  }

  async derive(input: {
    srcId: Id;
    title: string;
    body: string;
    kind?: Note['kind'];
    quote?: string;
    actor?: Author;
  }): Promise<{ id: Id; events: JournalEvent[] }> {
    const note: Note = {
      type: 'note',
      id: newId('note'),
      schema: 1,
      spaceId: this.store.space.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      author: input.actor ?? 'human',
      sensitivity: this.store.space.defaultSensitivity,
      rev: 1,
      title: input.title,
      body: input.body,
      status: 'seedling',
      srcIds: [input.srcId],
      kind: input.kind ?? 'point',
    };
    return this.commitOps([{ t: 'create', obj: note as AnyObject }], input.actor ?? 'human', `衍生：${input.title}`);
  }

  async annotate(input: {
    repId: Id;
    quote: string;
    note?: string;
    color?: string;
    from: number;
    to: number;
    prefix?: string;
    suffix?: string;
    actor?: Author;
  }): Promise<{ id: Id; events: JournalEvent[] }> {
    const rep = this.store.get<Rep>(input.repId);
    if (!rep) throw new Error(`载体不存在：${input.repId}`);
    const a: Annotation = {
      type: 'annotation',
      id: newId('ann'),
      schema: 1,
      spaceId: this.store.space.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      author: input.actor ?? 'human',
      sensitivity: this.store.space.defaultSensitivity,
      rev: 1,
      targetRepId: input.repId,
      revision: rep.rev,
      locator: {
        kind: 'char',
        from: input.from,
        to: input.to,
        prefix: input.prefix,
        suffix: input.suffix,
      },
      quote: input.quote,
      note: input.note,
      color: input.color ?? 'yellow',
    };
    return this.commitOps([{ t: 'create', obj: a as AnyObject }], input.actor ?? 'human', `批注：${input.quote.slice(0, 20)}`);
  }

  async addAction(input: {
    text: string;
    due?: string;
    flow?: Action['flow'];
    projectId?: Id;
    actor?: Author;
  }): Promise<{ id: Id; events: JournalEvent[] }> {
    const a: Action = {
      type: 'action',
      id: newId('act'),
      schema: 1,
      spaceId: this.store.space.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      author: input.actor ?? 'human',
      sensitivity: this.store.space.defaultSensitivity,
      rev: 1,
      text: input.text,
      due: input.due,
      flow: input.flow ?? (input.due ? 'next' : 'later'),
      state: 'open',
      projectId: input.projectId,
    };
    return this.commitOps([{ t: 'create', obj: a as AnyObject }], input.actor ?? 'human', `新建任务：${input.text}`);
  }

  async addEvent(input: {
    title: string;
    date: string;
    start: string;
    end?: string;
    projectId?: Id;
    actor?: Author;
  }): Promise<{ id: Id; events: JournalEvent[] }> {
    const e: EventRec = {
      type: 'event',
      id: newId('evt'),
      schema: 1,
      spaceId: this.store.space.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      author: input.actor ?? 'human',
      sensitivity: this.store.space.defaultSensitivity,
      rev: 1,
      title: input.title,
      start: `${input.date}T${input.start}`,
      end: `${input.date}T${input.end ?? input.start}`,
      projectId: input.projectId,
    };
    return this.commitOps([{ t: 'create', obj: e as AnyObject }], input.actor ?? 'human', `新建日程：${input.title}`);
  }

  async setCursor(repId: Id, pct: number, actor: Author = 'human'): Promise<CursorResult> {
    const rec = await this.store.setCursor(repId, pct);
    touch(this.store, repId, 'read');
    const ev = await this.journal.add({
      actor,
      op: 'read',
      phase: 'done',
      target: this.store.get<Rep>(repId)?.path ?? repId,
      summary: `读到 ${Math.round(pct * 100)}%（最远 ${Math.round(rec.furthest * 100)}%）`,
      payload: { repId, pct, furthest: rec.furthest },
    });
    return { cursor: rec, event: ev };
  }

  async review(id: Id, note: string, actor: Author = 'human'): Promise<JournalEvent> {
    return this.journal.add({
      actor,
      op: 'review',
      phase: 'done',
      target: this.store.file(id) ?? id,
      summary: note || '回顾了一次',
      payload: { id },
    });
  }

  async commitOps(ops: Parameters<ChangeService['propose']>[0]['ops'], actor: Author, reason: string) {
    const cs = await this.changes.propose({ ops, actor, reason });
    await this.changes.validate(cs);
    const r = await this.changes.commit(cs.id);
    if (!r.ok) {
      const err = new Error('提交冲突') as Error & { statusCode?: number; conflict?: unknown };
      err.statusCode = 409;
      err.conflict = r.conflict;
      throw err;
    }
    const created = ops.find((o) => o.t === 'create');
    return {
      id: created && created.t === 'create' ? String((created.obj as AnyObject).id) : cs.id,
      events: r.events,
      changeset: r.changeset,
    };
  }

  async doReconcile() {
    return reconcile(this.store, this.journal);
  }

  async snapshot() {
    return takeSnapshot(this.store);
  }
}

export interface CursorResult {
  cursor: { repId: string; current: number; furthest: number; updatedAt: string };
  event: JournalEvent;
}
