/**
 * 对象模型 —— 前后端共用的唯一定义（设计方案 §2）
 *
 * 三条不可协商的约束：
 *  1. 原件不可变：Rep.locked = true 的载体只读，校注与改写产生 Note，不改 Rep。
 *  2. 版本是对象的一部分：ChangeSet.baseRevisions 记录提交时的修订号，冲突不接受 force。
 *  3. 事件独立于对象：对象可被覆盖，事件只追加。
 */

export type Id = string; // <kind>-<ulid>，改名不变
export type Author = 'human' | `agent:${string}` | 'system' | 'external:unknown';
export type Sensitivity = 'private' | 'work' | 'public';
export type Carrier = 'md' | 'html' | 'pdf' | 'epub';
export type ISO = string;

export interface BaseObject {
  id: Id;
  schema: number;
  spaceId: Id;
  createdAt: ISO;
  updatedAt: ISO;
  author: Author;
  sensitivity: Sensitivity;
  archivedAt?: ISO;
  /** 修订号：每次提交 +1，用于乐观并发控制 */
  rev: number;
  /** 文件相对空间根的路径（由 store 维护，不写进 frontmatter） */
  path?: string;
}

export interface Space extends BaseObject {
  type: 'space';
  name: string;
  root: string;
  tz: string;
  layout: number;
  defaultSensitivity: Sensitivity;
}

export interface Work extends BaseObject {
  type: 'work';
  title: string;
  kind: 'book' | 'dossier' | 'article';
  desc?: string;
  slug: string;
}

export interface Edition extends BaseObject {
  type: 'edition';
  workId: Id;
  label: string;
  language?: string;
}

export interface Part extends BaseObject {
  type: 'part';
  editionId: Id;
  workId: Id;
  order: number;
  title: string;
  /** 附录与研究底稿折叠为「补充材料」，不进正文顺序 */
  supplemental?: boolean;
}

export interface Rep extends BaseObject {
  type: 'rep';
  partId: Id;
  workId: Id;
  carrier: Carrier;
  path: string;
  hash: string;
  bytes: number;
  /** true = 入库原件，只读；界面不给保存按钮，而不是保存后报错 */
  locked: boolean;
}

/** 批注定位：offset 失效时靠 prefix/suffix 上下文重新定位 */
export interface Locator {
  kind: 'char' | 'page' | 'block';
  from: number;
  to: number;
  prefix?: string;
  suffix?: string;
  page?: number;
  blockId?: string;
}

export interface Annotation extends BaseObject {
  type: 'annotation';
  targetRepId: Id;
  revision: number;
  locator: Locator;
  quote: string;
  note?: string;
  color: string;
  /** 由批注衍生的笔记（血缘向下） */
  derivedIds?: Id[];
}

export interface Note extends BaseObject {
  type: 'note';
  title: string;
  body: string;
  status: 'seedling' | 'growing' | 'evergreen';
  srcIds: Id[]; // 上游来源（血缘）
  /** report = 调研报告（问题→证据→建议），其余是笔记 */
  kind: 'point' | 'summary' | 'outline' | 'question' | 'report';
  tags?: string[];
}

export interface Collection extends BaseObject {
  type: 'collection';
  title: string;
  desc?: string;
  /** 人工清单（显式 id） */
  memberIds: Id[];
  /** 动态查询（与 memberIds 并集） */
  query?: string;
}

export interface Action extends BaseObject {
  type: 'action';
  text: string;
  /** 承诺：什么时候到期 */
  due?: string;
  /** 安排：计划在什么时间做（[开始, 结束]） */
  scheduled?: [string, string];
  /** 推进：现在做 / 接着做 / 以后做 */
  flow: 'now' | 'next' | 'later';
  state: 'open' | 'doing' | 'blocked' | 'done';
  projectId?: Id;
  doneAt?: ISO;
}

export interface Project extends BaseObject {
  type: 'project';
  title: string;
  desc?: string;
  areaId?: Id;
  state: 'active' | 'someday' | 'done' | 'dropped';
}

export interface Area extends BaseObject {
  type: 'area';
  title: string;
  standard?: string; // 维护标准
}

export interface EventRec extends BaseObject {
  type: 'event';
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  projectId?: Id;
}

/* ---------------- 变更 ---------------- */

export type Op =
  | { t: 'create'; obj: AnyObject }
  | { t: 'update'; id: Id; patch: Record<string, unknown> }
  | { t: 'setBody'; id: Id; body: string }
  | { t: 'append'; id: Id; text: string; anchor?: 'end' | 'start' }
  | { t: 'move'; id: Id; to: string }
  | { t: 'archive'; id: Id; archived: boolean };

export interface Change {
  op: Op;
  target: Id;
  label: string;
  /** 人类可读差异，提交前即可展示 */
  diff?: string;
}

export type ChangeSetState = 'draft' | 'validated' | 'committed' | 'reverted' | 'conflict';

export interface ChangeSet extends BaseObject {
  type: 'changeset';
  baseRevisions: Record<Id, number>;
  ops: Op[];
  changes?: Change[];
  state: ChangeSetState;
  reason?: string;
  committedAt?: ISO;
  revertedAt?: ISO;
  /** 冲突时的三方内容：base / mine / theirs */
  conflict?: ConflictTriple;
  events?: JournalEvent[];
  /** 反向操作，用于撤销 */
  inverse?: Op[];
  /** 提交基准的文件哈希，双保险：版本号之外再拦一层外部改动 */
  baseHashes?: Record<Id, string>;
  /** 提出变更时的三方内容快照：base=基准，mine=我要写的 */
  snapshot?: Record<Id, { baseRev: number; base: string; mine: string; hash: string }>;
  /** 四项校验结果，界面上直接展示 */
  checks?: CheckResult[];
}

/** 变更卡片上的四项校验 */
export interface CheckResult {
  name: 'schema' | 'readonly' | 'links' | 'version';
  label: string;
  ok: boolean;
  level: 'error' | 'warn';
  detail: string;
}

export interface ConflictTriple {
  id: Id;
  base: { rev: number; content: string };
  mine: { content: string };
  theirs: { rev: number; content: string; updatedAt: ISO; author: Author };
}

export interface Proposal extends BaseObject {
  type: 'proposal';
  kind: 'group' | 'link' | 'rewrite' | 'derive';
  changes: Change[];
  evidence: Id[];
  scope: string;
  budgetCny: number;
  risk: 'low' | 'med' | 'high';
  state: 'pending' | 'applied' | 'rejected';
  changesetId?: Id;
  title: string;
  rationale?: string;
}

export type JobState =
  | 'queued'
  | 'running'
  | 'waiting-approval'
  | 'waiting-device'
  | 'done'
  | 'failed';

export interface Job extends BaseObject {
  type: 'job';
  name: string;
  trigger: string;
  state: JobState;
  checkpoint: string;
  leaseUntil?: ISO;
  /** 幂等键：恢复时不重复副作用 */
  idempotencyKey: string;
  steps: { name: string; state: 'pending' | 'done' | 'skipped' }[];
  waitingReason?: string;
  error?: string;
}

export type AnyObject =
  | Space
  | Work
  | Edition
  | Part
  | Rep
  | Annotation
  | Note
  | Collection
  | Action
  | Project
  | Area
  | EventRec
  | ChangeSet
  | Proposal
  | Job;

export type ObjectType = AnyObject['type'];

/* ---------------- 事件 ---------------- */

export type JournalOp =
  | 'capture'
  | 'ingest'
  | 'read'
  | 'annotate'
  | 'derive'
  | 'edit'
  | 'propose'
  | 'review'
  | 'settle'
  | 'commit'
  | 'build'
  | 'import'
  | 'revert'
  | 'external_edit'
  | 'reconcile';

export type JournalPhase = 'intent' | 'done' | 'detected';

export interface JournalEvent {
  id: string;
  at: ISO;
  actor: Author;
  op: JournalOp;
  phase: JournalPhase;
  target: string;
  summary: string;
  payload?: Record<string, unknown>;
  /** 未署名改动被认领后回填 */
  claimedBy?: string;
  claimedAt?: ISO;
  spaceId?: Id;
}

/* ---------------- 生命周期 ---------------- */

export type StageKey = 'capture' | 'derive' | 'digest' | 'review' | 'settle';

export interface StageDef {
  key: StageKey;
  name: string;
  hint: string;
}

export const STAGES: StageDef[] = [
  { key: 'capture', name: '采集', hint: '已入库且有来源' },
  { key: 'derive', name: '衍生', hint: '产生了批注或衍生笔记' },
  { key: 'digest', name: '消化', hint: '读过 99% 且至少 1 条衍生' },
  { key: 'review', name: '回顾', hint: '有过一次回顾事件' },
  { key: 'settle', name: '沉淀', hint: '已定稿且被引用 ≥2 处' },
];

export interface GateResult {
  key: StageKey;
  pass: boolean;
  detail: string;
}

export interface CursorRec {
  repId: Id;
  current: number; // 当前阅读位置 0..1
  furthest: number; // 最远位置，回看不覆盖
  updatedAt: ISO;
  readCount?: number;
}
