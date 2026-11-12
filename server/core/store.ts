/**
 * Store —— 文件即事实源。把 §3.1 的目录布局映射成对象图。
 * SQLite 只是索引，随时可以删掉重建；这里的对象才是真相。
 */
import path from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type {
  AnyObject, Area, Action, Annotation, BaseObject, Carrier, Collection, CursorRec,
  EventRec, Id, Note, Part, Project, Rep, Space, Work, Author, Sensitivity, Share,
} from '../../shared/types.ts';
import { newId, nowISO } from '../../shared/id.ts';
import { parseDoc, serializeDoc, patchFm } from '../../shared/frontmatter.ts';
import { LocalDirAdapter, WpsSyncAdapter, sha256, type StorageAdapter } from './storage.ts';
import { parseTasks, parseEvents, renderTasks, renderEvents, blockToAction, type InlineBlock } from './inline.ts';

export const LAYOUT = {
  space: 'space.yaml',
  inbox: 'inbox',
  notes: 'knowledge/notes',
  reports: 'knowledge/reports',
  works: 'knowledge/works',
  collections: 'knowledge/collections',
  annotations: 'knowledge/annotations',
  /** 对外分享（抽印本）。放空间根而不是 knowledge/ 下：它不是知识，是知识的出口 */
  shares: 'shares',
  projects: 'work/projects',
  areas: 'work/areas',
  actions: 'work/actions',
  events: 'work/events',
  journals: 'work/journals',
  reviews: 'work/reviews',
  originals: 'assets/originals',
  attachments: 'assets/attachments',
  archive: 'archive',
} as const;

export const STATE = {
  ids: '.habitat/state/ids.json',
  cursors: '.habitat/state/cursors.json',
  changesets: '.habitat/state/changesets.jsonl',
  proposals: '.habitat/state/proposals.jsonl',
  jobs: '.habitat/state/jobs.jsonl',
  rules: '.habitat/state/rules.json',
  spaces: '.habitat/spaces.json',
  manifest: '.habitat/manifest.json',
  snapshot: '.habitat/state/snapshot.json',
  /** 分享访问流水：只追加，统计从它聚合；删了只丢统计，不影响分享本身 */
  shareViews: '.habitat/state/share-views.jsonl',
} as const;

const CARRIERS: Record<string, Carrier> = { md: 'md', markdown: 'md', html: 'html', htm: 'html', pdf: 'pdf', epub: 'epub' };
const META_KEYS = new Set(['id', 'schema', 'spaceId', 'createdAt', 'updatedAt', 'author', 'sensitivity', 'archivedAt', 'rev', 'type', 'path']);

export interface AssetEntry {
  path: string;
  bytes: number;
  kind: 'original' | 'attachment' | 'export';
  workSlug?: string;
  hash?: string;
}

export interface ScanReport {
  files: number;
  objects: number;
  works: number;
  parts: number;
  reps: number;
  notes: number;
  actions: number;
  events: number;
  annotations: number;
  assets: number;
  unresolvedLinks: number;
  links: number;
}

export interface InlineFile {
  blocks: InlineBlock[];
  kind: 'tasks' | 'events';
}

const SUPPLEMENTAL = /^(附录|x-|extra|zz|_)/i;

type FragOp =
  | { k: 'put'; obj: AnyObject; rel: string; inlineId?: string }
  | { k: 'stem'; stem: string; id: Id }
  | { k: 'link'; from: Id; to: string }
  | { k: 'res'; from: Id; to: string }
  | { k: 'asset'; entry: AssetEntry }
  | { k: 'inline'; rel: string; data: InlineFile }
  | { k: 'src'; id: Id; v: string }
  | { k: 'status'; id: Id; v: string };

export class Store {
  adapter: StorageAdapter;
  wps: WpsSyncAdapter;
  space!: Space;
  objects = new Map<Id, AnyObject>();
  fileOf = new Map<Id, string>();
  inlineOf = new Map<Id, string>();
  idsIn = new Map<string, Id[]>();
  inlineFiles = new Map<string, InlineFile>();
  assets: AssetEntry[] = [];
  cursors = new Map<string, CursorRec>();
  stems = new Map<string, Id>();
  links: { from: Id; to: string; resolved: Id | null }[] = [];
  /**
   * 正文里用反引号写的库内路径（`knowledge/works/x/parts/`）。
   *
   * 人写路径比写 [[链接]] 顺手得多——项目文件里「阅读材料」那一段就是路径。
   * 但这些路径以前只是文本，界面上点不动，所以「资料在哪」答不出来。
   * 路径在扫描结束、所有对象都建好之后才能解析（目录要反查下面挂了什么），
   * 所以这里先存原文，resolveLinks 时统一填 resolved。
   */
  resourceRefs: { from: Id; to: string; resolved: Id[] }[] = [];
  /**
   * 文件内容缓存，键是相对路径，值是 (mtime,size) 签名。
   *
   * 重扫时 73% 的时间花在把没改过的文件重新读一遍。内容没变就没必要读——
   * 这是最容易拿的一块性能，而且不改变任何语义。
   * 签名用 mtime+size：NTFS 的时间精度到 100ns，同一秒内两次改同大小的情况基本不存在；
   * 真出现了，下一次全量重建（外部改动、手动 reindex）会纠正。
   */
  private readCache = new Map<string, { sig: string; raw: string }>();

  /**
   * 每个文件产生的「解析副作用」缓存。
   *
   * 为什么不是缓存解析结果而是缓存副作用：scanDoc 不是一个纯函数——它会往
   * objects / links / stems / assets / inlineFiles 里写，还会分配 id。
   * 与其重写一遍解析逻辑，不如把「它对世界做了什么」记下来，
   * 下次签名没变就照着重放。顺序一致，结果就一致。
   */
  private fragments = new Map<string, { sig: string; ops: FragOp[] }>();
  /** 录制中：scan 期间收集副作用；null 表示不录 */
  private rec: FragOp[] | null = null;
  /** 本次扫描新建的片段表（扫描结束时替换旧的） */
  private nextFrags = new Map<string, { sig: string; ops: FragOp[] }>();
  /**
   * 结构性文件（work.yaml / space.yaml）的签名。
   * 它们不进主循环、没有片段，所以不能用 fragments 判断有没有变——
   * 之前就是这样：`fragments.get('space.yaml')` 永远是 undefined，
   * 于是「结构变了」恒为真，增量扫描一次都没生效。
   */
  private structuralSigs = new Map<string, string>();
  private fragPending: { rel: string; sig: string; from: number } | null = null;
  /** 本次扫描的签名表：rel → (mtime,size)，扫描开始时填充 */
  private sigIndex = new Map<string, string>();

  /** frontmatter 里的原样字段（不进对象模型，但生命周期与展示要用） */
  sourceOf = new Map<Id, string>();
  statusOf = new Map<Id, string>();
  wikilinkTargets = new Map<Id, string[]>();
  lockedNote = new Map<Id, boolean>();
  private idMap: Record<string, string> = {};
  private idMapDirty = false;

  constructor(root: string, public options: { wpsSync?: boolean } = {}) {
    const local = new LocalDirAdapter(root);
    this.adapter = local;
    this.wps = new WpsSyncAdapter(local);
  }

  get root(): string {
    return this.adapter.root;
  }

  /* ---------------- 打开与扫描 ---------------- */

  async open(): Promise<Space> {
    this.space = await this.loadSpace();
    await this.loadIds();
    await this.loadCursors();
    return this.space;
  }

  private async loadSpace(): Promise<Space> {
    let fm: Record<string, unknown> = {};
    try {
      fm = (yamlParse(await this.adapter.read(LAYOUT.space)) ?? {}) as Record<string, unknown>;
    } catch {
      fm = {};
    }
    const now = nowISO();
    const sp: Space = {
      type: 'space',
      id: String(fm.id ?? newId('space')),
      schema: Number(fm.schema ?? 1),
      spaceId: String(fm.id ?? 'space-self'),
      createdAt: String(fm.createdAt ?? now),
      updatedAt: now,
      author: (fm.author as Author) ?? 'system',
      sensitivity: (fm.sensitivity as Sensitivity) ?? 'private',
      rev: Number(fm.rev ?? 1),
      name: String(fm.name ?? path.basename(this.root)),
      root: this.root,
      tz: String(fm.tz ?? 'Asia/Shanghai'),
      layout: Number(fm.layout ?? 2),
      defaultSensitivity: (fm.defaultSensitivity as Sensitivity) ?? 'private',
      path: LAYOUT.space,
    };
    if (!fm.id) {
      await this.persistSpace(sp);
    }
    return sp;
  }

  async persistSpace(sp: Space): Promise<void> {
    const { path: _p, ...rest } = sp;
    await this.adapter.write(LAYOUT.space, yamlStringify(rest, { lineWidth: 0 }), { backup: false });
  }

  private async loadIds(): Promise<void> {
    try {
      this.idMap = JSON.parse(await this.adapter.read(STATE.ids)) as Record<string, string>;
    } catch {
      this.idMap = {};
    }
  }

  private async flushIds(): Promise<void> {
    if (!this.idMapDirty) return;
    await this.adapter.write(STATE.ids, JSON.stringify(this.idMap, null, 2), { backup: false });
    this.idMapDirty = false;
  }

  private async loadCursors(): Promise<void> {
    try {
      const m = JSON.parse(await this.adapter.read(STATE.cursors)) as Record<string, CursorRec>;
      for (const [k, v] of Object.entries(m)) this.cursors.set(k, v);
    } catch {
      this.cursors = new Map();
    }
  }

  async flushCursors(): Promise<void> {
    await this.adapter.write(
      STATE.cursors,
      JSON.stringify(Object.fromEntries(this.cursors), null, 2),
      { backup: false },
    );
  }

  async setCursor(repId: string, pct: number): Promise<CursorRec> {
    const prev = this.cursors.get(repId);
    const rec: CursorRec = {
      repId,
      current: Math.max(0, Math.min(1, pct)),
      furthest: Math.max(prev?.furthest ?? 0, Math.max(0, Math.min(1, pct))),
      updatedAt: nowISO(),
      readCount: (prev?.readCount ?? 0) + 1,
    };
    this.cursors.set(repId, rec);
    await this.flushCursors();
    return rec;
  }

  private assignId(key: string, kind: string, fmId?: unknown): Id {
    if (typeof fmId === 'string' && fmId.trim()) {
      const id = fmId.trim();
      if (this.idMap[key] !== id) {
        this.idMap[key] = id;
        this.idMapDirty = true;
      }
      return id;
    }
    let id: string | undefined = this.idMap[key];
    // 自愈：历史 bug 会把 id 越接越长（work-xxx-ed1-ed1-ed1…）。
    // 正常 id 是「前缀 + 26 位」，超过 80 一律当成坏值重建，否则它会一直躺在 ids.json 里。
    if (id && id.length > 80) {
      delete this.idMap[key];
      id = undefined;
      this.idMapDirty = true;
    }
    if (!id) {
      id = newId(kind);
      this.idMap[key] = id;
      this.idMapDirty = true;
    }
    return id;
  }

  /**
   * 便宜的「空间变了吗」指纹：文件数 + 最新 mtime。
   * 只用来决定要不要重扫，不参与任何一致性判断。
   */
  /** 未解析的 wikilink：按目标聚合，给出「谁在引用它」，方便判断值不值得补 */
  unresolvedTargets(): { target: string; refs: { id: Id; path: string }[] }[] {
    const byTarget = new Map<string, { id: Id; path: string }[]>();
    for (const l of this.links) {
      if (l.resolved) continue;
      const key = l.to.trim();
      if (!key) continue;
      const path = this.fileOf.get(l.from) ?? '';
      byTarget.set(key, [...(byTarget.get(key) ?? []), { id: l.from, path }]);
    }
    return [...byTarget.entries()]
      .map(([target, refs]) => ({ target, refs }))
      .sort((a, b) => b.refs.length - a.refs.length);
  }

  async fingerprint(): Promise<string> {
    const entries = await this.adapter.list();
    let max = '';
    for (const e of entries) if (e.mtime > max) max = e.mtime;
    return `${entries.length}:${max}`;
  }

  async scan(): Promise<ScanReport> {
    this.objects.clear();
    this.fileOf.clear();
    this.inlineOf.clear();
    this.idsIn.clear();
    this.inlineFiles.clear();
    this.assets = [];
    this.stems.clear();
    this.links = [];
    this.resourceRefs = [];

    const entries = await this.adapter.list();
    // 签名表：内容是文件的 (mtime,size)，用来判断「这文件上次读过之后变没变」
    this.sigIndex.clear();
    for (const e of entries) this.sigIndex.set(e.path, `${e.mtime}|${e.bytes}`);
    await this.prefetch(entries);
    const worksBySlug = new Map<string, Work>();
    const partFiles: { rel: string; slug: string; bytes: number }[] = [];

    // 先扫一遍：哪些目录是「作品」。判据是它下面有 parts/，
    // 而不是「必须有 work.yaml」——真实库是先把章节放进来的，
    // 硬要求一个自己发明出来的 yaml，会让四本书一夜之间变成 0 个作品。
    const partsFromByDir = new Map<string, string>();
    const workSlugs = new Set<string>();
    for (const e of entries) {
      // 有 parts/ 或是写了 work.yaml，都算作品——空书也该在书架上，只是 0 章
      const m = new RegExp(`^${LAYOUT.works}/([^/]+)/(parts/|work\.yaml$)`).exec(e.path);
      if (m) workSlugs.add(m[1]);
    }

    // 先把作品全部建出来，再扫章节与散篇：否则散篇挂血缘时作品还不存在
    for (const slug of workSlugs) {
      const yamlRel = `${LAYOUT.works}/${slug}/work.yaml`;
      const readmeRel = `${LAYOUT.works}/${slug}/README.md`;
      const rawYaml = await this.adapter.read(yamlRel).catch(() => '');
      const rawReadme = rawYaml ? '' : await this.adapter.read(readmeRel).catch(() => '');
      let fm: Record<string, unknown> = {};
      let desc: string | undefined;
      if (rawYaml) {
        fm = safeYaml(rawYaml);
        desc = fm.desc ? String(fm.desc) : undefined;
      } else if (rawReadme) {
        // README 是一篇笔记，它的 title 往往是「整本目录与知识矩阵」这种，
        // 拿它当书名会把书架搞得很难看。只借它的 summary 当简介。
        const rfm = parseDoc(rawReadme).fm;
        desc = rfm.summary ? String(rfm.summary) : undefined;
      }
      // 作品的定义位置始终是 work.yaml；暂时没有就先借用这个位置，首次编辑会把它写出来
      const work: Work = {
        ...this.baseFrom(fm, 'work', yamlRel, 'work'),
        title: String(fm.title ?? slug),
        kind: (fm.kind as Work['kind']) ?? 'book',
        desc,
        slug,
      } as Work;
      this.put(work, yamlRel);
      this.noteExtra(work.id, fm);
      worksBySlug.set(slug, work);
      this.addStem(slug, work.id);
      // 作品可以声明「我的章节在这个目录里」——迁移评审明确说不要搬文件，
      // 所以归组靠声明，不靠移动。
      const from = fm.partsFrom ? String(fm.partsFrom).replace(/^\/+|\/+$/g, '') : '';
      if (from) partsFromByDir.set(`${from}/`, slug);
    }

    /*
     * 增量扫描：签名没变的文件不再解析，直接重放上次的副作用。
     *
     * 但只要 work.yaml / space.yaml 变了就得全量——它们决定「哪些目录算一部作品的章节」，
     * 一个文件的分组方式变了，它自己没变也得重新解析。
     */
    const structuralEntries = entries.filter((e) => /work\.yaml$/.test(e.path) || e.path === LAYOUT.space);
    const structuralChanged = structuralEntries.some(
      (e) => this.structuralSigs.get(e.path) !== this.sigIndex.get(e.path),
    );

    this.rec = [];
    this.nextFrags = new Map();
    this.fragPending = null;

    for (const e of entries) {
      this.fragClose();
      const rel = e.path;
      if (rel.startsWith('.habitat/')) continue;
      if (rel === LAYOUT.space) continue;
      // 旧版生成物：索引与计划视图。新设计里它们不存在（索引在 SQLite，视图在前端），
      // 但迁移会在根目录留一份，不排除的话它一条就贡献上百个假链接。
      if (/(^|\/)(INDEX|PLAN|_INDEX)\.md$/i.test(rel)) continue;

      // 1. 作品定义已在上面统一处理
      if (new RegExp(`^${LAYOUT.works}/([^/]+)/work\\.yaml$`).test(rel)) continue;

      // 签名没变就重放上次的副作用，不读盘也不解析
      const sig = this.sigIndex.get(rel) ?? '';
      if (!structuralChanged && this.fragTryReplay(rel, sig)) continue;
      this.fragStart(rel, sig);

      // 2. 分享定义：一个 yaml 一条，id 稳定，token 可换
      if (rel.startsWith(`${LAYOUT.shares}/`) && /\.ya?ml$/i.test(rel)) {
        await this.scanShare(rel);
        continue;
      }

      // 3. 笔记 / 报告 / 收件箱 / 日志 / 复盘 / 专题 / 项目 / 领域 / 作品下的散篇
      if (rel.endsWith('.md')) {
        const declared = [...partsFromByDir.entries()].find(([dir]) => rel.startsWith(dir));
        if (declared) {
          partFiles.push({ rel, slug: declared[1], bytes: e.bytes });
          this.addStem(stemOf(rel), '');
          continue;
        }
        if (rel.startsWith(`${LAYOUT.works}/`)) {
          const pm = new RegExp(`^${LAYOUT.works}/([^/]+)/parts/(.+)$`).exec(rel);
          if (pm) {
            partFiles.push({ rel, slug: pm[1], bytes: e.bytes });
            this.addStem(stemOf(pm[2]), ''); // 占位，稍后回填真实 id
            continue;
          }
          // 作品根目录的 README、drafts/ 里的取证笔记，都是真内容，是笔记不是附件。
          // 挂上作品 id 当来源，血缘才连得回去。
          const slug = rel.split('/')[2];
          await this.scanDoc(rel, e.bytes, workSlugs.has(slug) ? slug : undefined);
          continue;
        }
        await this.scanDoc(rel, e.bytes);
        continue;
      }

      // 3. 非 md：原件 / 附件 / 导出（批注是数据，不是资产，不进文件清单）
      if (rel.startsWith(LAYOUT.annotations)) continue;
      const carrier = CARRIERS[extOf(rel)];
      if (rel.startsWith(LAYOUT.originals)) {
        const seg = rel.slice(LAYOUT.originals.length + 1).split('/');
        this.pushAsset({ path: rel, bytes: e.bytes, kind: 'original', workSlug: seg.length > 1 ? seg[0] : undefined });
      } else if (rel.startsWith(LAYOUT.attachments)) {
        this.pushAsset({ path: rel, bytes: e.bytes, kind: 'attachment' });
      } else if (carrier) {
        this.pushAsset({ path: rel, bytes: e.bytes, kind: 'export' });
      } else {
        this.pushAsset({ path: rel, bytes: e.bytes, kind: 'attachment' });
      }
    }

    this.fragClose();

    // 4. 章节与载体（作品目录要等 work.yaml 都读完才能建）
    await this.scanParts(partFiles, worksBySlug, structuralChanged);
    // 5. 原件若能从目录名匹配到作品，作为 locked 载体挂上去
    await this.linkOriginals(worksBySlug);
    // 6. 批注
    await this.scanAnnotations();
    // 7. wikilink 解析
    this.resolveLinks();
    // 8. 路径引用解析：必须在 4/5 之后，目录要反查已经建好的章节
    this.resolveResources();
    await this.flushIds();

    // 片段表换代：本次没出现过的文件（已删/已改名）自然被丢掉
    this.fragments = this.nextFrags;
    for (const e of structuralEntries) {
      const sig = this.sigIndex.get(e.path);
      if (sig) this.structuralSigs.set(e.path, sig);
    }
    this.rec = null;

    return this.report(entries.length);
  }

  private addStem(stem: string, id: Id): void {
    if (!stem) return;
    this.rec?.push({ k: 'stem', stem, id });
    const k = stem.toLowerCase();
    // 章节先按文件名登记空 id 占位（那时 part 还没建出来）。回填真 id 时如果被 has() 挡住，
    // 「[[书名-·-第3章-…]]」这种按文件名写的链接就永远解析不到——所以空 id 必须允许覆盖。
    if (!this.stems.get(k)) this.stems.set(k, id);
  }

  private baseFrom(
    fm: Record<string, unknown>,
    kind: string,
    rel: string,
    idKind: string,
  ): BaseObject & { type: string } {
    const now = nowISO();
    const id = this.assignId(rel, idKind, fm.id);
    return {
      type: kind,
      id,
      schema: Number(fm.schema ?? 1),
      spaceId: this.space.id,
      createdAt: String(fm.createdAt ?? now),
      updatedAt: String(fm.updatedAt ?? now),
      author: (fm.author as Author) ?? 'human',
      sensitivity: (fm.sensitivity as Sensitivity) ?? this.space.defaultSensitivity,
      archivedAt: fm.archivedAt ? String(fm.archivedAt) : rel.startsWith(`${LAYOUT.archive}/`) ? now : undefined,
      rev: Number(fm.rev ?? 1),
      path: rel,
    };
  }

  private put(obj: AnyObject, rel: string, inlineId?: string): void {
    this.rec?.push({ k: 'put', obj, rel, inlineId });
    this.objects.set(obj.id, obj);
    this.fileOf.set(obj.id, rel);
    if (inlineId) this.inlineOf.set(obj.id, inlineId);
    const arr = this.idsIn.get(rel) ?? [];
    arr.push(obj.id);
    this.idsIn.set(rel, arr);
  }

  /** 顺手记下 frontmatter 里模型之外但有用的原样字段 */
  /* ---------------- 增量扫描的片段录制 ---------------- */

  /**
   * 收尾要在「下一个文件开始时」调用，不能写在循环末尾——
   * 循环体里有 continue，写在末尾会被跳过，上一段录制就漏记了。
   */
  private fragClose(): void {
    if (!this.fragPending || !this.rec) return;
    this.nextFrags.set(this.fragPending.rel, {
      sig: this.fragPending.sig,
      ops: this.rec.slice(this.fragPending.from),
    });
    this.fragPending = null;
  }

  private fragStart(rel: string, sig: string): void {
    if (!this.rec) return;
    this.fragPending = { rel, sig, from: this.rec.length };
  }

  /** 签名没变就重放，返回 true 表示已处理完毕，调用方应跳过解析 */
  private fragTryReplay(rel: string, sig: string): boolean {
    const cached = this.fragments.get(rel);
    if (!cached || cached.sig !== sig || !this.rec) return false;
    // 重放时 rec 仍在录：录下来的就是同一批操作，缓存下一轮继续有效
    for (const op of cached.ops) {
      switch (op.k) {
        case 'put': this.put(op.obj, op.rel, op.inlineId); break;
        case 'stem': this.addStem(op.stem, op.id); break;
        case 'link': this.links.push({ from: op.from, to: op.to, resolved: null }); break;
        case 'res': this.resourceRefs.push({ from: op.from, to: op.to, resolved: [] }); break;
        case 'asset': this.assets.push(op.entry); break;
        case 'inline': this.inlineFiles.set(op.rel, op.data); break;
        case 'src': this.sourceOf.set(op.id, op.v); break;
        case 'status': this.statusOf.set(op.id, op.v); break;
      }
    }
    this.nextFrags.set(rel, cached);
    return true;
  }

  private pushAsset(entry: AssetEntry): void {
    this.rec?.push({ k: 'asset', entry });
    this.assets.push(entry);
  }

  private setInline(rel: string, data: InlineFile): void {
    this.rec?.push({ k: 'inline', rel, data });
    this.inlineFiles.set(rel, data);
  }

  private noteExtra(id: Id, fm: Record<string, unknown>): void {
    // source 是一条真实的血缘关系，也要进链接表，否则对账时「来源指向了不存在的条目」看不出来
    if (fm.source !== undefined) {
      this.rec?.push({ k: 'src', id, v: String(fm.source) });
      this.sourceOf.set(id, String(fm.source));
      this.collectLinks(id, String(fm.source));
    }
    if (typeof fm.status === 'string') {
      this.rec?.push({ k: 'status', id, v: fm.status });
      this.statusOf.set(id, fm.status);
    }
    if (typeof fm.locked === 'boolean') this.lockedNote.set(id, fm.locked);
    // related 是 frontmatter 里的关系，写在正文之外，以前根本没进链接表——
    // 于是「项目在 frontmatter 里挂了三份材料」，界面上一条都看不到。
    const related = fm.related;
    if (Array.isArray(related)) this.collectLinks(id, related.map(String).join('\n'));
    else if (typeof related === 'string') this.collectLinks(id, related);
  }

  /**
   * 并发预读：把这次扫描要用的文件先并行读进缓存。
   *
   * 原来的循环是 `for (const e of entries) await read(e)`——5000 个文件就是 5000 次串行 IO，
   * 冷启动实测 1.5 秒，其中 1 秒以上都花在等磁盘。文件内容之间没有依赖，
   * 完全可以并行读、再按原顺序解析（顺序不影响结果，id 是按路径分配的）。
   */
  private async prefetch(entries: { path: string; bytes: number; mtime: string }[]): Promise<void> {
    const todo = entries.filter((e) => {
      if (e.path.startsWith('.habitat/')) return false;
      if (e.path === LAYOUT.space) return false;
      if (/(^|\/)(INDEX|PLAN|_INDEX)\.md$/i.test(e.path)) return false;
      // 只需要文本：正文、frontmatter、jsonl 批注都要解析
      const ext = extOf(e.path).toLowerCase();
      return ext === 'md' || ext === 'markdown' || ext === 'yaml' || ext === 'yml' || ext === 'jsonl';
    });
    if (!todo.length) return;

    const CONCURRENCY = 16;
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < todo.length) {
        const e = todo[i];
        i += 1;
        const sig = this.sigIndex.get(e.path);
        const hit = this.readCache.get(e.path);
        if (hit?.sig === sig) continue; // 上次读过且没变
        const raw = await this.adapter.read(e.path).catch(() => null);
        if (raw !== null && sig) this.readCache.set(e.path, { sig, raw });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  }

  /** 带签名的读：签名没变就吃缓存，省掉一次磁盘 IO */
  private async readCached(rel: string, sig?: string): Promise<string> {
    if (sig) {
      const hit = this.readCache.get(rel);
      if (hit?.sig === sig) return hit.raw;
    }
    const raw = await this.adapter.read(rel);
    if (sig) this.readCache.set(rel, { sig, raw });
    return raw;
  }

  /**
   * 一条分享 = 一个 yaml。
   *
   * 为什么不做成 state 里的配置：链接能不能用、公开了哪些东西，
   * 是用户要能直接翻文件确认的事实，不该只活在数据库或内存里。
   */
  private async scanShare(rel: string): Promise<void> {
    const raw = await this.readCached(rel);
    const fm = safeYaml(raw) as Record<string, unknown>;
    const targetIds = Array.isArray(fm.targetIds) ? (fm.targetIds as unknown[]).map(String) : [];
    const share: Share = {
      ...(this.baseFrom(fm, 'share', rel, 'share') as any),
      title: String(fm.title ?? '未命名分享'),
      intro: fm.intro ? String(fm.intro) : undefined,
      token: String(fm.token ?? ''),
      state: fm.state === 'paused' ? 'paused' : 'active',
      targetIds,
      expiresAt: fm.expiresAt ? String(fm.expiresAt) : undefined,
      allowDownload: Boolean(fm.allowDownload),
      byline: fm.byline ? String(fm.byline) : undefined,
    };
    this.put(share, rel);
    this.addStem(stemOf(rel), share.id);
  }

  private async scanDoc(rel: string, bytes: number, workSlug?: string): Promise<void> {
    const raw = await this.readCached(rel, this.sigIndex.get(rel));
    const { fm, body } = parseDoc(raw);

    if (rel.startsWith(LAYOUT.actions) && /tasks?\.md$/i.test(rel)) {
      const blocks = parseTasks(body);
      this.setInline(rel, { blocks, kind: 'tasks' });
      const base = this.baseFrom({}, 'action', rel, 'file');
      let n = 0;
      for (const b of blocks) {
        if (b.kind !== 'task') continue;
        n += 1;
        const key = `${rel}#${b.id ?? n}`;
        const id = this.assignId(key, 'action', b.id);
        b.id = id;
        const a = blockToAction(b, {
          ...base,
          id,
          schema: 1,
        } as unknown as Omit<Action, 'text' | 'state' | 'flow' | 'id'>);
        this.put(a as AnyObject, rel, id);
      }
      this.addStem(stemOf(rel), '');
      return;
    }

    if (rel.startsWith(LAYOUT.events)) {
      const blocks = parseEvents(body);
      this.setInline(rel, { blocks, kind: 'events' });
      const base = this.baseFrom({}, 'event', rel, 'file');
      let n = 0;
      for (const b of blocks) {
        if (b.kind !== 'event') continue;
        n += 1;
        const key = `${rel}#${b.id ?? n}`;
        const id = this.assignId(key, 'event', b.id);
        b.id = id;
        const start = b.fields.start || '00:00';
        const end = b.fields.end || start;
        // 日期优先取 ### 小标题；真丢了就退到「这个月的第一天」，别落成 1970 年
        const day = b.date || `${String(fm.month ?? stemOf(rel))}-01`;
        const ev: EventRec = {
          ...base,
          id,
          type: 'event',
          title: b.text ?? '',
          start: `${day}T${start}`,
          end: `${day}T${end}`,
          allDay: !b.fields.start,
          projectId: b.fields.project,
          archivedAt: b.fields.archived,
        };
        this.put(ev as AnyObject, rel, id);
      }
      this.addStem(stemOf(rel), '');
      return;
    }

    if (rel.startsWith(LAYOUT.projects)) {
      const p: Project = {
        ...(this.baseFrom(fm, 'project', rel, 'project') as any),
        title: String(fm.title ?? stemOf(rel)),
        desc: fm.desc ? String(fm.desc) : undefined,
        areaId: fm.areaId ? String(fm.areaId) : undefined,
        state: (fm.state as Project['state']) ?? 'active',
      };
      this.put(p, rel);
      this.noteExtra(p.id, fm);
      this.addStem(stemOf(rel), p.id);
      this.collectLinks(p.id, body);
      return;
    }

    if (rel.startsWith(LAYOUT.areas)) {
      const a: Area = {
        ...(this.baseFrom(fm, 'area', rel, 'area') as any),
        title: String(fm.title ?? stemOf(rel)),
        standard: fm.standard ? String(fm.standard) : undefined,
      };
      this.put(a, rel);
      this.noteExtra(a.id, fm);
      this.addStem(stemOf(rel), a.id);
      this.collectLinks(a.id, body);
      return;
    }

    if (rel.startsWith(LAYOUT.collections)) {
      const fm2 = fm as Record<string, unknown>;
      const c: Collection = {
        ...(this.baseFrom(fm2, 'collection', rel, 'collection') as any),
        title: String(fm2.title ?? stemOf(rel)),
        desc: fm2.desc ? String(fm2.desc) : undefined,
        memberIds: Array.isArray(fm2.memberIds) ? (fm2.memberIds as string[]) : parseList(body),
        query: fm2.query ? String(fm2.query) : undefined,
      };
      this.put(c, rel);
      this.noteExtra(c.id, fm);
      this.addStem(stemOf(rel), c.id);
      this.collectLinks(c.id, body);
      return;
    }

    // 其余一律是笔记（notes / reports / inbox / journals / reviews / archive / 作品下的散篇）
    const isReport = rel.startsWith(LAYOUT.reports) || /\/README\.md$/i.test(rel);
    const srcIds = Array.isArray(fm.srcIds) ? (fm.srcIds as string[]) : fm.source ? [String(fm.source)] : [];
    if (workSlug) {
      // 作品下的 README / 草稿：血缘指回作品，书架与关系图才连得上
      const w = this.objects.get(this.stems.get(workSlug.toLowerCase()) ?? '');
      if (w && !srcIds.includes(w.id)) srcIds.push(w.id);
    }
    const note: Note = {
      ...(this.baseFrom(fm, 'note', rel, 'note') as any),
      title: String(fm.title ?? firstH1(body) ?? stemOf(rel)),
      body,
      status: (fm.status as Note['status']) ?? 'seedling',
      srcIds,
      // 外链形态的 source 进不了 id 图（它本来就不是对象），但它是「原文在哪」的答案
      sourceUrl: typeof fm.source === 'string' && /^https?:\/\//i.test(fm.source.trim()) ? fm.source.trim() : undefined,
      kind: (fm.kind as Note['kind']) ?? (isReport ? 'report' : 'point'),
      tags: Array.isArray(fm.tags) ? (fm.tags as string[]).map(String) : undefined,
    };
    this.put(note, rel);
    this.noteExtra(note.id, fm);
    this.addStem(stemOf(rel), note.id);
    // 人写 [[标题]] 比写 [[文件名]] 多得多；不认标题，补建同名条目也解析不上
    this.addStem(note.title, note.id);
    this.collectLinks(note.id, body);
    void bytes;
  }

  private collectLinks(id: Id, body: string): void {
    // 代码围栏和行内代码里的 [[…]] 是写法示例，不是链接。契约文档里全是 `[[文件名]]`
    // 这类示例；不剥掉的话，每改一次 AGENTS.md 就凭空多出 6 条「断链」。
    const text = body
      .replace(/^[ \t]{0,3}(```+|~~~+)[^\n]*\n[\s\S]*?^[ \t]{0,3}\1[^\n]*$/gm, '')
      .replace(/`[^`\n]*`/g, '');
    const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
    let m: RegExpExecArray | null;
    const found: string[] = [];
    while ((m = re.exec(text))) {
      this.rec?.push({ k: 'link', from: id, to: m[1].trim() });
      this.links.push({ from: id, to: m[1].trim(), resolved: null });
      found.push(m[1].trim());
    }
    if (found.length) this.wikilinkTargets.set(id, [...(this.wikilinkTargets.get(id) ?? []), ...found]);
    this.collectResources(id, body);
  }

  /**
   * 反引号里的库内路径也是资料引用。
   *
   * 只认「库根目录开头 + 以 / 结尾或是带扩展名的文件」这两种形状：
   * 文档里同样用反引号包着命令、字段名、语法示例，靠猜会把一整段噪音变成断链。
   */
  private collectResources(id: Id, body: string): void {
    // 围栏里的代码是示例（契约文档里全是要人照抄的命令），不构成引用；
    // 行内代码必须保留——路径就是这么写的。
    const text = body.replace(/^[ \t]{0,3}(```+|~~~+)[^\n]*\n[\s\S]*?^[ \t]{0,3}\1[^\n]*$/gm, '');
    const ROOTS = ['knowledge/', 'work/', 'assets/', 'archive/', 'inbox/', 'space/'];
    const re = /`([^`\n]{2,200})`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const p = m[1].trim().replace(/^\.?\//, '');
      if (!ROOTS.some((r) => p.startsWith(r))) continue;
      if (!p.endsWith('/') && !/\.[a-z0-9]{1,5}$/i.test(p)) continue;
      /*
       * 契约文档里的路径是「形状」不是「指向」：`knowledge/works/<slug>/parts/`、
       * `work/events/YYYY-MM.md`、`work/events/*.md`。
       * 不过滤的话，改一次 AGENTS.md 就往链接表里灌二十条永远解析不了的引用。
       */
      if (/[<>*]|YYYY|MM-DD/.test(p)) continue;
      this.rec?.push({ k: 'res', from: id, to: p });
      this.resourceRefs.push({ from: id, to: p, resolved: [] });
    }
  }

  /**
   * 路径引用的解析。目录形态按前缀反查「挂在下面、且是能读的东西」，
   * 文件形态按 rel 精确匹配。解析不到的直接空着——路径写错不该让整页报错。
   */
  private resolveResources(): void {
    // 只有知识侧对象才算「一份材料」。路径也可能指向 tasks.md 这种行内文件，
    // 那里面是 100 条任务，不是资料——不解出来才不会被当成关联倒进 Peek。
    const READABLE = new Set(['note', 'part', 'work']);
    const keep = (id: Id) => READABLE.has(this.objects.get(id)?.type ?? '');
    for (const r of this.resourceRefs) {
      if (r.to.endsWith('/')) {
        const hits: Id[] = [];
        for (const [id, rel] of this.fileOf) {
          if (!rel.startsWith(r.to) || !keep(id)) continue;
          hits.push(id);
        }
        hits.sort((a, b) => (this.fileOf.get(a) ?? '').localeCompare(this.fileOf.get(b) ?? ''));
        r.resolved = hits.slice(0, 24);
      } else {
        r.resolved = (this.idsIn.get(r.to) ?? []).filter(keep).slice(0, 4);
      }
    }
  }

  /** 出链：这条对象引用了谁（`[[链接]]` 与库内路径都算） */
  outbound(id: Id): { id: Id; via: 'link' | 'path' }[] {
    const out: { id: Id; via: 'link' | 'path' }[] = [];
    for (const l of this.links) if (l.from === id && l.resolved) out.push({ id: l.resolved, via: 'link' });
    for (const r of this.resourceRefs) if (r.from === id) for (const t of r.resolved) out.push({ id: t, via: 'path' });
    return out;
  }

  /** 入链：谁引用了它。断链只在 unresolvedTargets 里出现，这里只给能点的 */
  backlinks(id: Id): { id: Id; via: 'link' | 'path' }[] {
    const out: { id: Id; via: 'link' | 'path' }[] = [];
    for (const l of this.links) if (l.resolved === id && l.from !== id) out.push({ id: l.from, via: 'link' });
    for (const r of this.resourceRefs) if (r.from !== id && r.resolved.includes(id)) out.push({ id: r.from, via: 'path' });
    return out;
  }

  /** 按 stem / 标题找对象：链接和 `[refs::]` 都按名字写，不按 id 写 */
  byStem(s: string): AnyObject | undefined {
    const k = s.trim().toLowerCase();
    if (!k) return undefined;
    return this.objects.get(this.stems.get(k) ?? '');
  }

  private resolveLinks(): void {
    for (const l of this.links) {
      l.resolved = this.stems.get(l.to.toLowerCase()) ?? null;
    }
  }

  private async scanParts(
    files: { rel: string; slug: string; bytes: number }[],
    worksBySlug: Map<string, Work>,
    structuralChanged = true,
  ): Promise<void> {
    const editions = new Map<string, Id>();
    for (const { rel, slug, bytes } of files) {
      this.fragClose();
      const sig = this.sigIndex.get(rel) ?? '';
      if (!structuralChanged && this.fragTryReplay(rel, sig)) continue;
      this.fragStart(rel, sig);

      const work = worksBySlug.get(slug);
      if (!work) {
        this.pushAsset({ path: rel, bytes, kind: 'export' });
        continue;
      }
      let editionId = editions.get(slug);
      if (!editionId) {
        // 版本必须用自己的 id 键。
        // 之前这里用 work.yaml 同一个 rel 当键、又把派生值当「显式 id」传进 baseFrom，
        // 而 baseFrom 会把传入 id 回写到 idMap[rel]——于是每一轮扫描都在改写 work 的 id，
        // 两个对象最终共用同一个 id，work 被 edition 顶掉（书架上 0 部作品、阅读器打不开）。
        const yamlRel = `${LAYOUT.works}/${slug}/work.yaml`;
        const edKey = `${yamlRel}#edition`;
        const ed = {
          ...this.baseFrom({}, 'edition', edKey, 'edition'),
          path: yamlRel,
          workId: work.id,
          label: 'v1',
        } as unknown as import('../../shared/types.ts').Edition;
        editionId = ed.id;
        this.put(ed, yamlRel);
        editions.set(slug, editionId);
      }
      const raw = await this.readCached(rel, this.sigIndex.get(rel));
      const { fm, body } = parseDoc(raw);
      const file = path.basename(rel);
      const stem = file.replace(/\.[^.]+$/, '');
      // 排序号优先取文件名前缀（01-xxx），其次取正文里的「第3章」；
      // 都没有也不代表它是补充材料——真实库的章节文件名是「书名-·-第1章-…」，一个数字都不在前缀里。
      const num = /^(\d+)[-_.、 ]/.exec(stem) ?? /第\s*(\d+)\s*[章节篇回讲]/.exec(stem);
      const supplemental = SUPPLEMENTAL.test(file);
      const frontLike = /^(序|前言|导读|引言|总目录|README)/i.test(stem.replace(/^.*?-·-/, ''));
      const order = num ? Number(num[1]) : frontLike ? 0 : 900 + files.findIndex((f) => f.rel === rel);
      const title = String(fm.title ?? stem.replace(/^.*?-·-/, ''));

      const partId = this.assignId(`${rel}#part`, 'part', fm.partId);
      const part: Part = {
        ...(this.baseFrom({ ...fm, id: partId }, 'part', rel, 'part') as any),
        type: 'part',
        editionId,
        workId: work.id,
        order,
        title,
        supplemental,
      };
      this.put(part, rel);
      this.noteExtra(part.id, fm);
      this.addStem(title, part.id);
      this.addStem(file.replace(/\.[^.]+$/, ''), part.id);
      this.collectLinks(part.id, body);

      const carrier = CARRIERS[extOf(rel)] ?? 'md';
      // 有 source 说明这是「收进来的原文」，默认只读——这是硬规矩。
      // 但作者自己的书也常常写 source（标注出发点文章），所以允许用 locked: false 明确解锁。
      const locked = fm.locked === true || (fm.locked !== false && !!fm.source && carrier === 'md');
      const repId = this.assignId(`${rel}#rep`, 'rep', fm.repId);
      const rep: Rep = {
        ...(this.baseFrom({ ...fm, id: repId }, 'rep', rel, 'rep') as any),
        type: 'rep',
        partId: part.id,
        workId: work.id,
        carrier,
        path: rel,
        hash: sha256(raw),
        bytes,
        locked,
      };
      this.put(rep, rel);
    }
  }

  private async linkOriginals(worksBySlug: Map<string, Work>): Promise<void> {
    for (const a of this.assets) {
      if (a.kind !== 'original' || !a.workSlug) continue;
      const work = worksBySlug.get(a.workSlug);
      if (!work) continue;
      const carrier = CARRIERS[extOf(a.path)];
      if (!carrier || carrier === 'md') continue;
      const parts = this.all<Part>('part').filter((p) => p.workId === work.id);
      if (parts.length === 0) continue;
      const name = path.basename(a.path).replace(/\.[^.]+$/, '');
      const match = parts.find((p) => name.includes(p.title) || p.title.includes(name));
      const part = match ?? parts[0];
      const repId = this.assignId(`${a.path}#rep`, 'rep');
      const rep: Rep = {
        ...(this.baseFrom({ id: repId }, 'rep', a.path, 'rep') as any),
        type: 'rep',
        partId: part.id,
        workId: work.id,
        carrier,
        path: a.path,
        hash: a.hash ?? '',
        bytes: a.bytes,
        locked: true,
      };
      this.put(rep, a.path);
    }
  }

  private async scanAnnotations(): Promise<void> {
    this.fragClose();
    const files = await this.adapter.list(LAYOUT.annotations);
    for (const f of files) {
      if (!f.path.endsWith('.jsonl')) continue;
      const raw = await this.adapter.read(f.path);
      let n = 0;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        n += 1;
        try {
          const o = JSON.parse(line) as Annotation;
          this.objects.set(o.id, o);
          this.fileOf.set(o.id, f.path);
          const arr = this.idsIn.get(f.path) ?? [];
          arr.push(o.id);
          this.idsIn.set(f.path, arr);
        } catch {
          /* 坏行跳过 */
        }
        void n;
      }
    }
  }

  private report(fileCount: number): ScanReport {
    const c = (t: string) => this.all(t as never).length;
    return {
      files: fileCount,
      objects: this.objects.size,
      works: c('work'),
      parts: c('part'),
      reps: c('rep'),
      notes: c('note'),
      actions: c('action'),
      events: c('event'),
      annotations: c('annotation'),
      assets: this.assets.length,
      links: this.links.length,
      unresolvedLinks: this.links.filter((l) => !l.resolved).length,
    };
  }

  /* ---------------- 查询 ---------------- */

  all<T extends AnyObject = AnyObject>(type?: T['type']): T[] {
    const out: T[] = [];
    for (const o of this.objects.values()) if (!type || o.type === type) out.push(o as T);
    return out;
  }

  get<T extends AnyObject = AnyObject>(id: Id): T | undefined {
    return this.objects.get(id) as T | undefined;
  }

  file(id: Id): string | undefined {
    return this.fileOf.get(id);
  }

  async body(id: Id): Promise<string> {
    const o = this.objects.get(id);
    if (!o) throw new Error(`对象不存在：${id}`);
    if (o.type === 'note') return (o as Note).body;
    if (o.type === 'rep') return this.adapter.read((o as Rep).path);
    const rel = this.fileOf.get(id);
    if (!rel) return '';
    const raw = await this.adapter.read(rel);
    return parseDoc(raw).body;
  }

  async raw(id: Id): Promise<string> {
    const rel = this.fileOf.get(id);
    if (!rel) throw new Error(`对象没有文件：${id}`);
    return this.adapter.read(rel);
  }

  /* ---------------- 写入 ---------------- */

  /** 读出一个对象的「文件级」表示，供 commit 计算差异与冲突 */
  async snapshot(id: Id): Promise<{ rel: string; content: string; hash: string; rev: number }> {
    const rel = this.fileOf.get(id);
    if (!rel) throw new Error(`对象没有文件：${id}`);
    const content = await this.adapter.read(rel);
    const o = this.objects.get(id);
    return { rel, content, hash: sha256(content), rev: o?.rev ?? 0 };
  }

  /** 生成一个新对象的落盘内容 */
  renderNew(obj: AnyObject, body = ''): { rel: string; content: string } {
    const rel = this.pathFor(obj, body);
    return { rel, content: this.render(obj, body) };
  }

  pathFor(obj: AnyObject, body = ''): string {
    // 显式给了落盘路径就照办（采集时「落到收件箱」靠这个）
    if (obj.path) return obj.path;
    switch (obj.type) {
      case 'note': {
        const n = obj as Note;
        const dir = n.kind === 'report' ? LAYOUT.reports : LAYOUT.notes;
        return `${dir}/${slugify(n.title)}.md`;
      }
      case 'annotation':
        return `${LAYOUT.annotations}/${(obj as Annotation).targetRepId}.jsonl`;
      case 'collection':
        return `${LAYOUT.collections}/${slugify((obj as Collection).title)}.md`;
      case 'share':
        // 按 id 落盘而不是按标题：改标题不该让文件改名，换 token 也不该丢统计
        return `${LAYOUT.shares}/${obj.id}.yaml`;
      case 'project':
        return `${LAYOUT.projects}/${slugify((obj as Project).title)}.md`;
      case 'area':
        return `${LAYOUT.areas}/${slugify((obj as Area).title)}.md`;
      default:
        return `${LAYOUT.notes}/${slugify((obj as { title?: string }).title ?? obj.id)}.md`;
    }
    void body;
  }

  render(obj: AnyObject, body = ''): string {
    if (obj.type === 'annotation') return `${JSON.stringify(obj)}\n`;
    if (obj.type === 'work' || obj.type === 'space') {
      const { path: _p, ...rest } = obj;
      return yamlStringify(rest, { lineWidth: 0 });
    }
    const { path: _p, body: _b, ...rest } = obj as Note & { path?: string };
    if (obj.type === 'note') return serializeDoc(rest as Record<string, unknown>, body);
    return serializeDoc(rest as Record<string, unknown>, body);
  }

  /** 更新一个既有对象：打补丁到 frontmatter（未知字段保留）+ 可选改正文 */
  async renderUpdate(
    id: Id,
    patch: Record<string, unknown>,
    body?: string,
  ): Promise<{ rel: string; content: string }> {
    const rel = this.fileOf.get(id);
    if (!rel) throw new Error(`对象没有文件：${id}`);
    const o = this.objects.get(id);
    if (!o) throw new Error(`对象不存在：${id}`);

    if (o.type === 'annotation') {
      const next = { ...o, ...patch, updatedAt: nowISO(), rev: o.rev + 1 };
      return { rel, content: await this.renderAnnotationLine(next as Annotation, rel) };
    }
    // 分享是纯 YAML 文件，不能套 frontmatter 文档格式
    if (o.type === 'share') {
      const { path: _p, ...rest } = { ...(o as unknown as Record<string, unknown>), ...patch } as Record<string, unknown>;
      void _p;
      return { rel, content: yamlStringify({ ...rest, updatedAt: nowISO(), rev: o.rev + 1 }, { lineWidth: 0 }) };
    }
    const raw = await this.adapter.read(rel);
    const parsed = parseDoc(raw);
    const nextBody = body ?? parsed.body;
    const nextFm = patchFm(parsed.fm, {
      ...patch,
      id,
      updatedAt: nowISO(),
      rev: (Number(parsed.fm.rev ?? o.rev ?? 0) || 0) + 1,
    });
    return { rel, content: serializeDoc(nextFm, nextBody) };
  }

  private async renderAnnotationLine(a: Annotation, rel: string): Promise<string> {
    const raw = await this.adapter.read(rel).catch(() => '');
    const lines = raw.split('\n').filter(Boolean);
    const idx = lines.findIndex((l) => {
      try {
        return (JSON.parse(l) as Annotation).id === a.id;
      } catch {
        return false;
      }
    });
    if (idx >= 0) lines[idx] = JSON.stringify(a);
    else lines.push(JSON.stringify(a));
    return `${lines.join('\n')}\n`;
  }

  /** 行内文件（任务/日程）整体重排 */
  async renderInline(rel: string): Promise<string> {
    const inf = this.inlineFiles.get(rel);
    if (!inf) throw new Error(`不是行内文件：${rel}`);
    const raw = await this.adapter.read(rel);
    const { fm } = parseDoc(raw);
    if (inf.kind === 'tasks') {
      const m = new Map<string, Action>();
      for (const id of this.idsIn.get(rel) ?? []) m.set(this.inlineOf.get(id) ?? id, this.get<Action>(id)!);
      const body = renderTasks(inf.blocks, m);
      return serializeDoc({ ...fm, updatedAt: nowISO() }, body);
    }
    const m = new Map<string, EventRec>();
    for (const id of this.idsIn.get(rel) ?? []) m.set(this.inlineOf.get(id) ?? id, this.get<EventRec>(id)!);
    const body = renderEvents(inf.blocks, m);
    return serializeDoc({ ...fm, updatedAt: nowISO() }, body);
  }

  isInline(rel: string): boolean {
    return this.inlineFiles.has(rel);
  }

  /** 写完之后把对象图同步一遍（不重扫全库） */
  async refresh(rel: string): Promise<void> {
    await this.scanDoc(rel, 0);
  }

  async refreshAll(): Promise<void> {
    await this.scan();
  }
}

/* ---------------- 小工具 ---------------- */

function safeYaml(s: string): Record<string, unknown> {
  try {
    const v = yamlParse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function extOf(rel: string): string {
  return path.extname(rel).slice(1).toLowerCase();
}

export function stemOf(rel: string): string {
  return path.basename(rel).replace(/\.[^.]+$/, '');
}

export function slugify(s: string): string {
  const t = s
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return t || `untitled-${Date.now().toString(36)}`;
}

export function firstH1(body: string): string | null {
  const m = /^\s*#\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

function parseList(body: string): string[] {
  return body
    .split('\n')
    .map((l) => /^\s*[-*+]\s+\[\[?([^\]|]+)/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x);
}

export { META_KEYS };
