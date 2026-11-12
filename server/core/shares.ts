/**
 * 对外分享（抽印本）。
 *
 * 三条边界，写在这里是为了以后改的人不用猜：
 *  1. 公开范围只有 targetIds 这一个白名单。作品连带它的章节，专题连带它的成员；
 *     其它任何文件、对象、接口都不因为「有这个 token」而变得可读。
 *  2. 访问统计只追加到 .habitat/state/share-views.jsonl，不回写 Share 对象。
 *     否则每来一个访客就要走一次 ChangeService，只读页会变成写入源。
 *  3. token 是权限本身。换链接 = 换 token；暂停/归档 = 立即失效，不做缓存。
 */
import { randomBytes } from 'node:crypto';
import type {
  Author, Collection, Id, Note, Part, Share, Work, AnyObject,
} from '../../shared/types.ts';
import { newId, nowISO, todayISO } from '../../shared/id.ts';
import type { Habitat } from './space.ts';
import { STATE } from './store.ts';

export type ShareKind = 'work' | 'part' | 'collection' | 'note';
const SHAREABLE = new Set<ShareKind>(['work', 'part', 'collection', 'note']);

export interface ShareTarget {
  id: Id;
  kind: ShareKind;
  title: string;
  meta: string;
  /** 从专题展开来的成员，管理界面上标一下，避免「我没选它怎么公开了」 */
  via?: Id;
}

export interface ShareScope {
  works: Work[];
  collections: Collection[];
  notes: Note[];
  parts: Part[];
  /** 作品 → 可读章节（作品整体公开时是全部；只公开某章时只有那一章） */
  partsOf: Map<Id, Part[]>;
  workIds: Set<Id>;
  partIds: Set<Id>;
  noteIds: Set<Id>;
  collectionIds: Set<Id>;
}

export interface ShareViewRecord {
  at: string;
  share: Id;
  path: string;
  item?: Id;
  kind?: ShareKind;
  vid: string;
  ref?: string;
}

export interface ShareStats {
  total: number;
  unique: number;
  today: number;
  last7: number;
  last30: number;
  lastAt: string | null;
  /** 最近 N 天，含 0 的日子；画趋势线直接用它 */
  series: { d: string; views: number; unique: number }[];
  items: { id: Id; kind: ShareKind | ''; title: string; views: number; unique: number; lastAt: string | null }[];
  refs: { host: string; views: number }[];
}

export interface ShareCounts {
  works: number;
  chapters: number;
  collections: number;
  notes: number;
  /** 展开后的总项数：1 本书 + 1 个专题 + 3 篇笔记 = 5 */
  targets: number;
}

export interface ShareInput {
  title: string;
  intro?: string;
  targetIds: string[];
  expiresAt?: string | null;
  allowDownload?: boolean;
  byline?: string;
}

export type ShareState = 'ok' | 'missing' | 'paused' | 'expired';

const MAX_TARGETS = 500;

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, max);
}

/** 本地日历日 + 偏移。不用 toISOString，避免 UTC 把凌晨算成昨天。 */
function dayShift(days: number, from = todayISO()): string {
  const [y, m, d] = from.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1, 12);
  dt.setDate(dt.getDate() + days);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function refHost(ref: string | undefined): string {
  if (!ref) return '直接打开';
  try {
    const u = new URL(ref);
    return u.hostname.replace(/^www\./, '') || '直接打开';
  } catch {
    return '直接打开';
  }
}

function targetTitle(o: AnyObject): string {
  if (o.type === 'work') return (o as Work).title;
  if (o.type === 'part') return (o as Part).title;
  if (o.type === 'collection') return (o as Collection).title;
  if (o.type === 'note') return (o as Note).title;
  return o.id;
}

/**
 * 专题展开：把成员也放进白名单。
 *
 * 为什么在写入时展开而不是每次渲染时现算：分享是「我此刻同意的范围」。
 * 之后往专题里加了一篇私人笔记，不应该明天就自动出现在公网。
 * 想带上新成员，管理界面上点「同步专题成员」，那是一次明确的动作。
 */
function expand(store: Habitat['store'], ids: string[]): { ids: Id[]; via: Map<Id, Id> } {
  const out: Id[] = [];
  const seen = new Set<string>();
  const via = new Map<Id, Id>();

  const add = (id: string, from?: Id): void => {
    if (!id || seen.has(id) || out.length >= MAX_TARGETS) return;
    const o = store.get(id);
    if (!o || o.archivedAt) return;
    if (!SHAREABLE.has(o.type as ShareKind)) return;
    seen.add(id);
    out.push(id);
    if (from) via.set(id, from);
    if (o.type === 'collection') {
      for (const m of (o as Collection).memberIds ?? []) add(m, id);
    }
  };

  for (const id of ids) add(id);
  return { ids: out, via };
}

export class ShareService {
  /** 每分钟每 IP 的公开请求上限；挡的是脚本扫链接，不是读者 */
  private hits = new Map<string, { n: number; at: number }>();

  constructor(
    private hab: Habitat,
    private baseUrl: () => string,
  ) {}

  /* ---------------- 读 ---------------- */

  list(): Share[] {
    return this.hab.store
      .all<Share>('share')
      .filter((s) => !s.archivedAt)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  byId(id: string): Share | undefined {
    const s = this.hab.store.get<Share>(id);
    return s && s.type === 'share' && !s.archivedAt ? s : undefined;
  }

  byToken(token: string): Share | undefined {
    if (!token || token.length < 8) return undefined;
    return this.list().find((s) => s.token === token);
  }

  stateOf(share: Share | undefined): ShareState {
    if (!share || share.archivedAt) return 'missing';
    if (share.state === 'paused') return 'paused';
    if (share.expiresAt) {
      const t = Date.parse(share.expiresAt);
      if (Number.isFinite(t) && t <= Date.now()) return 'expired';
    }
    return 'ok';
  }

  /** 白名单 → 可读范围。所有公开页都只从这里取标题与正文。 */
  scopeOf(share: Share): ShareScope {
    const store = this.hab.store;
    const works: Work[] = [];
    const collections: Collection[] = [];
    const notes: Note[] = [];
    const targetParts: Part[] = [];
    const partsOf = new Map<Id, Part[]>();
    const workIds = new Set<Id>();
    const partIds = new Set<Id>();
    const noteIds = new Set<Id>();
    const collectionIds = new Set<Id>();

    for (const id of share.targetIds) {
      const o = store.get(id);
      if (!o || o.archivedAt) continue;
      if (o.type === 'work') {
        works.push(o);
        workIds.add(o.id);
      } else if (o.type === 'part') {
        targetParts.push(o);
        partIds.add(o.id);
      } else if (o.type === 'collection') {
        collections.push(o);
        collectionIds.add(o.id);
      } else if (o.type === 'note') {
        notes.push(o);
        noteIds.add(o.id);
      }
    }

    // 作品整体公开 → 全部章节；只公开单章 → 只放那一章
    for (const w of works) {
      const list = store.all<Part>('part').filter((p) => p.workId === w.id).sort((a, b) => a.order - b.order);
      partsOf.set(w.id, list);
      for (const p of list) partIds.add(p.id);
    }
    for (const p of targetParts) {
      const list = partsOf.get(p.workId) ?? [];
      if (!list.some((x) => x.id === p.id)) list.push(p);
      list.sort((a, b) => a.order - b.order);
      partsOf.set(p.workId, list);
      // 只公开一章时，作品本身也作为「出处」可读（标题、目录里只出现这一章）
      const w = store.get<Work>(p.workId);
      if (w && !w.archivedAt && !workIds.has(w.id)) {
        workIds.add(w.id);
        works.push(w);
      }
    }

    return { works, collections, notes, parts: [...partsOf.values()].flat(), partsOf, workIds, partIds, noteIds, collectionIds };
  }

  /** 管理界面用：把白名单翻成人看得懂的项，并标出哪些是专题带进来的 */
  targetsOf(share: Share): ShareTarget[] {
    const store = this.hab.store;
    const expanded = expand(store, share.targetIds);
    const allowed = new Set(share.targetIds);
    // 只标记「存下来的白名单里确实包含」的成员，不能拿此刻的专题去现算：
    // 那会把刚加进专题、但还没同步的私人内容显示成已公开。
    const via = new Map<Id, Id>();
    for (const id of share.targetIds) {
      const c = store.get<Collection>(id);
      if (c?.type !== 'collection') continue;
      for (const m of c.memberIds ?? []) if (allowed.has(m)) via.set(m, id);
    }
    const out: ShareTarget[] = [];
    for (const id of expanded.ids) {
      if (!allowed.has(id)) continue;
      const o = store.get(id);
      if (!o) continue;
      if (o.type === 'part') continue; // 章节在作品里体现，不单列
      const from = via.get(id);
      if (o.type === 'work') {
        const chapters = store.all<Part>('part').filter((p) => p.workId === id).length;
        out.push({ id, kind: 'work', title: (o as Work).title, meta: `${chapters} 章`, via: from });
      } else if (o.type === 'collection') {
        out.push({
          id, kind: 'collection', title: (o as Collection).title,
          meta: `${(o as Collection).memberIds.length} 项`,
        });
      } else if (o.type === 'note') {
        out.push({ id, kind: 'note', title: (o as Note).title, meta: (o as Note).kind === 'report' ? '报告' : '笔记', via: from });
      }
    }
    return out;
  }

  countsOf(share: Share): ShareCounts {
    const scope = this.scopeOf(share);
    return {
      works: scope.works.length,
      chapters: scope.partIds.size,
      collections: scope.collections.length,
      notes: scope.notes.length,
      targets: share.targetIds.length,
    };
  }

  urlFor(token: string): string {
    const base = this.baseUrl().replace(/\/+$/, '');
    return `${base}/s/${token}`;
  }

  /* ---------------- 写 ---------------- */

  async create(input: ShareInput, actor: Author = 'human'): Promise<Share> {
    const title = cleanText(input.title, 120);
    if (!title) throw new Error('分享需要一个标题');
    const ids = this.cleanTargets(input.targetIds);
    if (!ids.length) throw new Error('至少要选一本书、一个专题或一篇笔记');

    const now = nowISO();
    const token = this.freshToken();
    const share: Share = {
      type: 'share',
      id: newId('share'),
      schema: 1,
      spaceId: this.hab.store.space.id,
      createdAt: now,
      updatedAt: now,
      author: actor,
      sensitivity: 'public',
      rev: 1,
      title,
      intro: cleanText(input.intro, 600),
      token,
      state: 'active',
      targetIds: ids,
      expiresAt: input.expiresAt ? String(input.expiresAt) : undefined,
      allowDownload: Boolean(input.allowDownload),
      byline: cleanText(input.byline, 60),
    };
    await this.hab.commitOps([{ t: 'create', obj: share as AnyObject }], actor, `新建分享：${title}`);
    return this.hab.store.get<Share>(share.id) ?? share;
  }

  async update(id: string, input: Partial<ShareInput> & { state?: 'active' | 'paused' }, actor: Author = 'human'): Promise<Share> {
    const share = this.byId(id);
    if (!share) throw new Error('分享不存在或已归档');
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) {
      const t = cleanText(input.title, 120);
      if (!t) throw new Error('标题不能为空');
      patch.title = t;
    }
    // 变更集是 JSONL，undefined 会在序列化时被丢掉；清除可选字段一律写 null，
    // 扫描时 null 会被还原成「没有这个字段」。
    if (input.intro !== undefined) patch.intro = cleanText(input.intro, 600) ?? null;
    if (input.byline !== undefined) patch.byline = cleanText(input.byline, 60) ?? null;
    if (input.targetIds !== undefined) {
      const ids = this.cleanTargets(input.targetIds);
      if (!ids.length) throw new Error('至少要保留一项内容');
      patch.targetIds = ids;
    }
    if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt ? String(input.expiresAt) : null;
    if (input.allowDownload !== undefined) patch.allowDownload = Boolean(input.allowDownload);
    if (input.state === 'active' || input.state === 'paused') patch.state = input.state;
    if (!Object.keys(patch).length) return share;

    await this.hab.commitOps([{ t: 'update', id, patch }], actor, `更新分享：${share.title}`);
    const next = this.hab.store.get<Share>(id);
    if (!next) throw new Error('更新后读不到分享');
    return next;
  }

  /** 换链接：旧 token 从这一刻起 404，统计仍挂在同一个 share 上 */
  async rotate(id: string, actor: Author = 'human'): Promise<Share> {
    const share = this.byId(id);
    if (!share) throw new Error('分享不存在或已归档');
    await this.hab.commitOps(
      [{ t: 'update', id, patch: { token: this.freshToken(share.token) } }],
      actor,
      `更换分享链接：${share.title}`,
    );
    const next = this.hab.store.get<Share>(id);
    if (!next) throw new Error('更新后读不到分享');
    return next;
  }

  /** 归档代替删除：文件留在 shares/ 下，链接立即失效 */
  async archive(id: string, actor: Author = 'human'): Promise<void> {
    const share = this.byId(id);
    if (!share) throw new Error('分享不存在或已归档');
    await this.hab.commitOps([{ t: 'archive', id, archived: true }], actor, `归档分享：${share.title}`);
  }

  /** 专题成员变了以后，显式同步一次公开范围 */
  async sync(id: string, actor: Author = 'human'): Promise<Share> {
    const share = this.byId(id);
    if (!share) throw new Error('分享不存在或已归档');
    const ids = this.cleanTargets(share.targetIds);
    return this.update(id, { targetIds: ids }, actor);
  }

  private cleanTargets(ids: string[]): Id[] {
    if (!Array.isArray(ids)) return [];
    return expand(this.hab.store, ids.map(String)).ids;
  }

  private freshToken(except?: string): string {
    for (let i = 0; i < 8; i += 1) {
      const t = randomBytes(9).toString('base64url'); // 12 字符，72 位
      if (t !== except && !this.list().some((s) => s.token === t)) return t;
    }
    return randomBytes(12).toString('base64url');
  }

  /* ---------------- 访问统计 ---------------- */

  allow(ip: string): boolean {
    const key = ip || 'unknown';
    const now = Date.now();
    if (this.hits.size > 5000) this.hits.clear();
    const cur = this.hits.get(key);
    if (!cur || now - cur.at > 60_000) {
      this.hits.set(key, { n: 1, at: now });
      return true;
    }
    cur.n += 1;
    return cur.n <= 240;
  }

  async recordView(input: {
    share: Share;
    path: string;
    item?: Id;
    kind?: ShareKind;
    vid: string;
    ref?: string;
  }): Promise<void> {
    const rec: ShareViewRecord = {
      at: nowISO(),
      share: input.share.id,
      path: input.path.slice(0, 300),
      item: input.item,
      kind: input.kind,
      vid: input.vid,
      ref: refHost(input.ref),
    };
    try {
      await this.hab.store.adapter.append(STATE.shareViews, JSON.stringify(rec));
    } catch {
      // 统计写不进去不该让读者看到 500：页面已经渲染好了
    }
  }

  private async readViews(): Promise<ShareViewRecord[]> {
    let raw = await this.hab.store.adapter.read(STATE.shareViews).catch(() => '');
    // 只追加的文件会一直长；超过 8MB 只留尾部，统计是趋势不是账本
    if (raw.length > 8_000_000) {
      raw = raw.slice(-8_000_000);
      raw = raw.slice(raw.indexOf('\n') + 1);
    }
    const out: ShareViewRecord[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as ShareViewRecord;
        if (r && typeof r.share === 'string' && typeof r.at === 'string') out.push(r);
      } catch {
        // 坏行跳过
      }
    }
    return out;
  }

  async stats(share: Share, days = 30): Promise<ShareStats> {
    const all = (await this.readViews()).filter((r) => r.share === share.id);
    return this.aggregate(share, all, days);
  }

  /** 列表页一次读盘、一次聚合，别对每条分享各读一遍 8MB 日志 */
  async statsAll(shares: Share[], days = 14): Promise<Map<Id, ShareStats>> {
    const all = await this.readViews();
    const map = new Map<Id, ShareStats>();
    for (const s of shares) map.set(s.id, this.aggregate(s, all.filter((r) => r.share === s.id), days));
    return map;
  }

  /** 顶部四个数字：进行中、近 7 日访问、近 7 日独立访客、最近一次访问 */
  async overview(shares: Share[]): Promise<{ active: number; views7: number; visitors7: number; lastAt: string | null }> {
    const ids = new Set(shares.map((s) => s.id));
    const cut = dayShift(-6);
    const all = (await this.readViews()).filter((r) => ids.has(r.share) && r.at.slice(0, 10) >= cut);
    const vids = new Set(all.map((r) => r.vid).filter(Boolean));
    return {
      active: shares.filter((s) => this.stateOf(s) === 'ok').length,
      views7: all.length,
      visitors7: vids.size,
      lastAt: all.reduce<string | null>((m, r) => (!m || r.at > m ? r.at : m), null),
    };
  }

  private aggregate(share: Share, recs: ShareViewRecord[], days: number): ShareStats {
    const span = Math.min(90, Math.max(7, Math.floor(days) || 30));
    const dayList: string[] = [];
    for (let i = span - 1; i >= 0; i -= 1) dayList.push(dayShift(-i));
    const first = dayList[0];

    const dayViews = new Map<string, number>();
    const dayVids = new Map<string, Set<string>>();
    const items = new Map<string, { kind: ShareKind | ''; views: number; vids: Set<string>; lastAt: string | null }>();
    const refs = new Map<string, number>();
    const allVids = new Set<string>();
    let today = 0;
    let lastAt: string | null = null;

    const todayStr = todayISO();
    for (const r of recs) {
      const d = r.at.slice(0, 10);
      if (d >= first) {
        dayViews.set(d, (dayViews.get(d) ?? 0) + 1);
        const set = dayVids.get(d) ?? new Set<string>();
        set.add(r.vid || 'anon');
        dayVids.set(d, set);
      }
      if (d === todayStr) today += 1;
      if (!lastAt || r.at > lastAt) lastAt = r.at;
      if (r.item) {
        const cur = items.get(r.item) ?? { kind: r.kind ?? '', views: 0, vids: new Set<string>(), lastAt: null };
        cur.views += 1;
        cur.vids.add(r.vid || 'anon');
        if (!cur.lastAt || r.at > cur.lastAt) cur.lastAt = r.at;
        items.set(r.item, cur);
      }
      refs.set(r.ref || '直接打开', (refs.get(r.ref || '直接打开') ?? 0) + 1);
      allVids.add(r.vid || 'anon');
    }

    const cut7 = dayShift(-6);
    const cut30 = dayShift(-29);
    const last7 = recs.filter((r) => r.at.slice(0, 10) >= cut7).length;
    const last30 = recs.filter((r) => r.at.slice(0, 10) >= cut30).length;

    return {
      total: recs.length,
      unique: allVids.size,
      today,
      last7,
      last30,
      lastAt,
      series: dayList.map((d) => ({ d, views: dayViews.get(d) ?? 0, unique: dayVids.get(d)?.size ?? 0 })),
      items: [...items.entries()]
        .map(([id, v]) => ({
          id,
          kind: v.kind,
          title: this.titleOf(id),
          views: v.views,
          unique: v.vids.size,
          lastAt: v.lastAt,
        }))
        .sort((a, b) => b.views - a.views),
      refs: [...refs.entries()]
        .map(([host, views]) => ({ host, views }))
        .sort((a, b) => b.views - a.views)
        .slice(0, 6),
    };
  }

  private titleOf(id: Id): string {
    const o = this.hab.store.get(id);
    if (!o) return '已移除的内容';
    if (o.type === 'part') {
      const w = this.hab.store.get<Work>((o as Part).workId);
      return w ? `${w.title} · ${(o as Part).title}` : (o as Part).title;
    }
    if (o.type === 'work' || o.type === 'note' || o.type === 'collection') return targetTitle(o);
    return id;
  }
}
