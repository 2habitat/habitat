/**
 * 自动化闭环目录（Loop Catalog）—— 唯一事实源。
 *
 * 为什么要有它：
 *   这个系统里「会自动发生的事」散落在四处：进程内定时器、CLI、HTTP、MCP。
 *   它们各自能跑，但没人回答三个问题——谁该跑、跑没跑、跑出了什么。
 *   文档一多，就成了「写了但没人执行」的空壳。
 *
 * 所以闭环必须先是**可执行的数据**，再是文档：
 *   - 定义在代码里（随版本走，测试锁住入口存在）
 *   - 配置在空间里（启停 / 节奏 / 归属）
 *   - 回执在空间里（每次运行留下证据，缺席即告警）
 *   - 手册由这份目录生成（不手写，就不会漂移）
 *
 * 三条不可协商：
 *   1. 判断类闭环永远不允许服务端自动 commit——服务端只能准备证据。
 *   2. 每个闭环至少有一个非 UI 入口（否则外部 harness 永远接不上）。
 *   3. 每个闭环必须写清「缺模型 / 缺调度 / 缺邮件」时降级成什么，不允许静默。
 */

export type LoopFamily = 'maintain' | 'digest' | 'decide' | 'deliver';

/** auto：服务端能独立跑完；assist：服务端备料、模型判断；gate：必须人确认；verify：只验证不生产 */
export type LoopMode = 'auto' | 'assist' | 'gate' | 'verify';

/** 自主度：read 只读；derived 可写派生；propose 只能提案；commit 可落盘；external 有外发副作用 */
export type LoopAutonomy = 'read' | 'derived' | 'propose' | 'commit' | 'external';

export type LoopExecutor = 'server' | 'platform-agent' | 'external-harness' | 'human';

export type LoopCap =
  | 'clock'
  | 'invoke:cli'
  | 'invoke:http'
  | 'invoke:mcp'
  | 'fs:read'
  | 'fs:write'
  | 'model'
  | 'human:approve'
  | 'mail:smtp'
  | 'mail:imap'
  | 'shell';

export type LoopTrigger =
  | { kind: 'interval'; minutes: number; note?: string }
  | { kind: 'daily'; at: string; note?: string }
  | { kind: 'event'; on: string }
  | { kind: 'manual'; note?: string };

export type BacklogKey = 'inbox' | 'agentReady' | 'unresolved' | 'reviewDue' | 'proposal' | 'job';

export interface LoopEntry {
  cli?: string;
  api?: string;
  mcp?: string;
  ui?: string;
  /** 非 habitat 的命令（发布脚本这类） */
  command?: string;
}

export interface LoopDef {
  id: string;
  name: string;
  family: LoopFamily;
  /** 一句话目标：这个闭环收敛到什么状态 */
  intent: string;
  trigger: LoopTrigger;
  /** 超过这么久没有一次成功回执就算异常；0 = 不做存活判定（按需/事件型） */
  maxSilenceMinutes: number;
  mode: LoopMode;
  autonomy: LoopAutonomy;
  executors: LoopExecutor[];
  /** harness 要完整承担它，必须具备的能力（服务端自己跑不需要） */
  requires: LoopCap[];
  entry: LoopEntry;
  steps: string[];
  outputs: string[];
  /** 回执里应该留下什么证据，以及落在哪 */
  evidence: string[];
  idempotency: string;
  degrade: Partial<Record<'noModel' | 'noSchedule' | 'noMail' | 'noShell', string>>;
  /** 用哪个积压指标衡量「该做但没做」 */
  backlog?: BacklogKey;
  /** 谁最适合当默认 owner */
  ownerHint: string;
  /** 由 harness 定时执行时，建议附加的参数（例如 --mail / --fetch） */
  harnessArgs?: string;
  /** 只在服务进程内做才有意义（轮询这类），外部接管是重复劳动 */
  serverOnly?: boolean;
  note?: string;
}

export interface LoopReceipt {
  loop: string;
  at: string;
  by: string;
  trigger: string;
  result: 'ok' | 'fail' | 'skipped' | 'prepared';
  durationMs?: number;
  counts?: Record<string, number>;
  /** 这次运行产出的对象 / 变更集 / 事件 id，闭环的「产物」证据 */
  produced?: string[];
  note?: string;
  /** 幂等键：同一个窗口内重复触发应当被识别 */
  idem?: string;
}

export interface LoopState {
  id: string;
  state: 'ok' | 'late' | 'down' | 'never' | 'paused' | 'blocked' | 'manual';
  lastAt?: string;
  lastBy?: string;
  lastResult?: LoopReceipt['result'];
  silenceMinutes?: number;
  maxSilenceMinutes: number;
  backlog?: number;
  reason: string;
}

export interface HarnessProfile {
  name: string;
  scheduler: 'none' | 'cron' | 'interval';
  alwaysOn?: boolean;
  invoke: ('cli' | 'http' | 'mcp' | 'fs')[];
  model?: boolean;
  humanApproval?: boolean;
  mail?: 'none' | 'smtp' | 'imap' | 'both';
  shell?: boolean;
  timezone?: string;
}

export interface HarnessFit {
  loop: string;
  level: 'full' | 'partial' | 'none';
  missing: LoopCap[];
  why: string;
  cron: string | null;
  command?: string;
}

export const FAMILY_LABEL: Record<LoopFamily, string> = {
  maintain: '维持',
  digest: '消化',
  decide: '判断',
  deliver: '交付',
};

export const MODE_LABEL: Record<LoopMode, string> = {
  auto: '自动',
  assist: '备料 + 判断',
  gate: '人工确认',
  verify: '只验证',
};

export const AUTONOMY_LABEL: Record<LoopAutonomy, string> = {
  read: '只读',
  derived: '可写派生',
  propose: '只能提案',
  commit: '可落盘',
  external: '有外发',
};

export const CAP_LABEL: Record<LoopCap, string> = {
  clock: '定时器',
  'invoke:cli': '命令行',
  'invoke:http': 'HTTP',
  'invoke:mcp': 'MCP',
  'fs:read': '读文件',
  'fs:write': '写文件',
  model: '模型判断',
  'human:approve': '人工确认',
  'mail:smtp': '发信',
  'mail:imap': '收信',
  shell: 'Shell',
};

export const EXECUTOR_LABEL: Record<LoopExecutor, string> = {
  server: '服务端',
  'platform-agent': '平台 Agent',
  'external-harness': '外部 harness',
  human: '人',
};

/**
 * 闭环目录。顺序即手册顺序：先维持，再消化，再判断，最后交付。
 * 新增一条闭环时，必须同时给出：入口、证据、幂等、降级。缺一项测试会拦。
 */
export const LOOPS: LoopDef[] = [
  /* ---------------- 维持：不需要判断力，必须自己转 ---------------- */
  {
    id: 'watch-external',
    name: '外部改动入索引',
    family: 'maintain',
    intent: '文件被编辑器或脚本改过之后，索引和界面自己看见，不靠人手动刷新。',
    trigger: { kind: 'interval', minutes: 0.25, note: '服务内 15 秒轮询；有写在飞时跳过' },
    maxSilenceMinutes: 60,
    mode: 'auto',
    autonomy: 'derived',
    executors: ['server'],
    requires: ['clock'],
    entry: {
      cli: 'habitat reindex',
      api: 'POST /api/system/rescan',
      ui: '系统 · 健康恢复',
    },
    steps: ['比对 (mtime,size) 指纹', '只重解析变过的文件', '同步索引里动过的对象', '前端轮询自然看到'],
    outputs: ['索引更新（不产生内容变更）'],
    evidence: ['receipt.counts.objects/links', '/api/system → health.indexDocs'],
    idempotency: '天然幂等：按当前指纹重算，不依赖「上次跑到哪」',
    degrade: { noSchedule: '只在打开页面或手动 rescan 时同步，外部改动会晚一点出现' },
    ownerHint: '平台进程',
    serverOnly: true,
    note: '这是 level-triggered 的典型：漏掉一轮没关系，下一轮看的是当前状态。外部 harness 不需要接管它——起服务就够了。',
  },
  {
    id: 'reconcile',
    name: '对账',
    family: 'maintain',
    intent: '把「谁改的」说清楚：外部改动记成 external_edit，可认领，不覆盖。',
    trigger: { kind: 'daily', at: '03:30', note: '服务端不内置；由 harness 或人按天跑' },
    maxSilenceMinutes: 2880,
    mode: 'auto',
    autonomy: 'derived',
    executors: ['server', 'external-harness', 'human'],
    requires: ['clock'],
    entry: {
      cli: 'habitat agent reconcile',
      api: 'POST /api/agent/reconcile',
      ui: '接入 · 事件流',
    },
    steps: ['读基线快照 sha256', '逐文件比对', '未署名改动 → external_edit 事件', '首次运行只建基线'],
    outputs: ['external_edit / reconcile 事件'],
    evidence: ['receipt.counts.added/removed/changed/unsigned', 'journal'],
    idempotency: '按快照差分；同一改动不会重复记账',
    degrade: { noSchedule: '只能人工在接入页点一次' },
    ownerHint: 'harness 或平台',
  },
  {
    id: 'metabolism',
    name: '代谢归档',
    family: 'maintain',
    intent: '已完成超过 30 天的任务自动归档——不删文件，只打标记，可整批撤销。',
    trigger: { kind: 'interval', minutes: 360, note: '服务内每 6 小时；harness 也可以按天跑' },
    maxSilenceMinutes: 2880,
    mode: 'auto',
    autonomy: 'commit',
    executors: ['server', 'external-harness'],
    requires: ['clock'],
    entry: {
      cli: 'habitat tidy --apply',
      api: 'POST /api/maintenance/tidy',
      ui: '今天 · 管家',
    },
    steps: [
      '给「已完成但没有 [done::]」的老任务补写完成时间（用任务文件 mtime 保守近似，幂等）',
      '收集 doneAt ≥ 30 天的未归档任务',
      'propose 一批 archive',
      'commit（带反向操作）',
      '重扫',
    ],
    outputs: ['完成时间回填变更集（可撤销）', '归档变更集（可撤销）'],
    evidence: ['receipt.counts.archived', 'receipt.counts.backfilled', 'changeset id'],
    idempotency: '已归档的不再进候选；回填的 [done::] 落盘，重复执行是空操作',
    degrade: {
      noSchedule: '只在 CLI / 今天页手动触发',
      noModel: '不受影响：这一步本来就不需要判断',
    },
    ownerHint: '平台进程',
  },
  {
    id: 'daily-brief',
    name: '每日简报',
    family: 'maintain',
    intent: '每天一次，把今天 / 逾期 / 读一半 / 积压 / 欠账摆到人面前；陈述事实，不给建议。',
    trigger: { kind: 'daily', at: '08:00' },
    maxSilenceMinutes: 2160,
    mode: 'auto',
    autonomy: 'read',
    executors: ['server', 'external-harness'],
    requires: ['clock'],
    entry: {
      cli: 'habitat brief',
      api: 'GET /api/maintenance/brief',
      ui: '今天页',
    },
    steps: ['收集今天的日程与到期任务', '扫逾期 / 读一半 / 积压', '算生命周期欠账与活性分布', '渲染同一份文本（CLI / 邮件 / 页面一致）'],
    outputs: ['简报文本', '可选：一封邮件'],
    evidence: ['receipt.at', '.habitat/state/brief.json（当天已发标记）'],
    idempotency: '按天去重：同一天只发一次',
    degrade: {
      noMail: '只落 CLI / API，不发信；人打开今天页仍能看到同一份',
      noSchedule: '打开今天页时现算，不保证每天主动出现',
    },
    ownerHint: '平台进程',
    harnessArgs: '--mail',
  },
  {
    id: 'reminders',
    name: '到点提醒',
    family: 'maintain',
    intent: '快到点的日程提醒一次；逾期任务每天汇总一次，不逐条轰炸。',
    trigger: { kind: 'interval', minutes: 1 },
    maxSilenceMinutes: 120,
    mode: 'auto',
    autonomy: 'external',
    executors: ['server', 'external-harness'],
    requires: ['clock', 'mail:smtp'],
    entry: {
      cli: 'habitat notify --send',
      api: 'POST /api/notify/run',
      ui: '通知设置',
    },
    steps: ['找 30 分钟内开始的日程', '查 reminders.json 是否已提醒', '发信', '逾期任务每日汇总一次'],
    outputs: ['提醒邮件'],
    evidence: ['receipt.sent', '.habitat/state/reminders.json'],
    idempotency: '每条日程一次；逾期汇总每天一次',
    degrade: { noMail: '跳过并在回执里写 skipped，不假装发过', noSchedule: '只能手动 notify --send' },
    ownerHint: '平台进程',
  },
  {
    id: 'rules',
    name: '规则通知',
    family: 'maintain',
    intent: '结构化规则命中时落到站内通知；自由文本规则只登记、不执行。',
    trigger: { kind: 'interval', minutes: 5 },
    maxSilenceMinutes: 180,
    mode: 'auto',
    autonomy: 'read',
    executors: ['server', 'external-harness'],
    requires: ['clock'],
    entry: {
      cli: 'habitat rules run',
      api: 'POST /api/rules/run',
      ui: 'AI · 自动化',
    },
    steps: ['加载启用的规则', '按 kind 求值（收件箱溢出 / 逾期 / 读一半）', '同规则同日去重', '写通知'],
    outputs: ['站内通知'],
    evidence: ['receipt.fired', '.habitat/state/notifications.jsonl'],
    idempotency: '每规则每天一次（notifications.jsonl 反查）',
    degrade: {
      noSchedule: '只能在自动化页点「运行一次」',
      noModel: '不受影响：只支持结构化规则，自由文本永远不执行',
    },
    ownerHint: '平台进程',
    note: 'custom 类型规则会明确 skip，不允许「看起来配了其实没跑」。',
  },
  {
    id: 'index-rebuild',
    name: '索引重建',
    family: 'maintain',
    intent: '索引坏了或换了机器时，从文件重建一份可丢弃的索引。',
    trigger: { kind: 'manual', note: '修复动作，不参与存活判定' },
    maxSilenceMinutes: 0,
    mode: 'auto',
    autonomy: 'derived',
    executors: ['server', 'human'],
    requires: [],
    entry: {
      cli: 'habitat reindex',
      api: 'POST /api/system/reindex',
      ui: '系统 · 健康恢复',
    },
    steps: ['清空索引', '全量扫盘解析', '重建对象与倒排', '回报对象数与解析率'],
    outputs: ['新的 SQLite 索引'],
    evidence: ['/api/system → health.indexDocs'],
    idempotency: '幂等：删掉重来结果一致',
    degrade: {},
    ownerHint: '人',
    note: '这是修复手段，不是闭环；列出来是为了让「删库重建」这条路径有据可查。',
  },

  /* ---------------- 消化：AI 的四个切入点里的前三个 ---------------- */
  {
    id: 'day-reconcile',
    name: '当日对账（计划 vs 实际）',
    family: 'digest',
    intent: '把今天实际读了什么、改了什么，和今天的待办摆在一起：哪些可能已经被工作本身覆盖，哪些一整天没动，计划外又投入到了哪里。',
    trigger: { kind: 'daily', at: '21:30', note: '服务内 21:00 后第一次检查；同一天只跑一次（HABITAT_DAY_HOUR 可改）' },
    maxSilenceMinutes: 2880,
    mode: 'assist',
    autonomy: 'propose',
    executors: ['server', 'platform-agent', 'external-harness', 'human'],
    requires: ['clock'],
    entry: {
      cli: 'habitat day',
      api: 'GET /api/day/actual',
      ui: '今天页 · 管家',
    },
    steps: [
      '读当日 journal（read / annotate / derive / edit / commit / capture / ingest / review）',
      '按对象归并：rep 归到章、批注归到载体，阅读进度只保留最远位置',
      '任务只按 [refs::] 对齐；没挂资料时才用词面找弱线索，项目级只做汇总不下放到单条任务',
      '分成三堆：可能已完成 / 今天动过 / 整天没碰；计划外投入单独列',
      '写回执；勾掉仍由人确认，服务端不改任务状态',
    ],
    outputs: ['当日活动摘要', '待办覆盖候选（只提案）', '计划外投入清单'],
    evidence: ['receipt.counts.events/covered/touched/idle/unplanned', 'journal 窗口（day + 事件条数）'],
    idempotency: '同一对象同一天只归并一次；同一窗口重复运行结果一致，不重复提示已确认的任务',
    degrade: {
      noModel: '规则匹配照跑（[refs::] / 词面弱线索），只是不写语义化的措辞与建议',
      noSchedule: '打开今天页或手动 habitat day 时现算',
    },
    ownerHint: '平台或人（日终一眼）',
    note: '这是「计划没按计划走」的兜底：没碰的待办和计划外的投入都会被摆出来，不允许静默消失。',
  },
  {
    id: 'triage-inbox',
    name: '收件箱分流（判断）',
    family: 'digest',
    intent: '收进来的碎片，判断它是什么、值不值得留、该归到哪、和谁重复。',
    trigger: { kind: 'event', on: '新碎片进入收件箱，或每日一次' },
    maxSilenceMinutes: 4320,
    mode: 'assist',
    autonomy: 'propose',
    executors: ['platform-agent', 'external-harness', 'human'],
    requires: ['model', 'invoke:cli'],
    entry: {
      cli: 'habitat next',
      api: 'GET /api/inbox · GET /api/lifecycle',
      ui: '收件箱',
    },
    steps: ['读收件箱条目与标签分布', '用检索找相似条目（确定性）', '判断：留 / 归 / 并 / 弃', '产出提案或衍生笔记'],
    outputs: ['标签 / 归属建议', '去重建议', '衍生笔记'],
    evidence: ['receipt.produced（note / changeset id）', 'journal: propose'],
    idempotency: '同一条碎片不重复判：处理后在正文或提案里留痕',
    degrade: {
      noModel: '只给去重与相似候选（BM25），不做语义归类',
      noSchedule: '按需触发，积压数在 loops status 里可见',
    },
    backlog: 'inbox',
    ownerHint: '外部 harness 或平台 Agent',
  },
  {
    id: 'digest-source',
    name: '提炼（有衍生）',
    family: 'digest',
    intent: '把读过的章节压成自己的话，产出摘要 / 批注 / 衍生笔记，而不是收藏夹里多一条。',
    trigger: { kind: 'event', on: '章节读完或产生批注后' },
    maxSilenceMinutes: 10080,
    mode: 'assist',
    autonomy: 'propose',
    executors: ['platform-agent', 'external-harness', 'human'],
    requires: ['model', 'invoke:cli'],
    entry: {
      cli: 'habitat next',
      api: 'GET /api/lifecycle · POST /api/derive',
      ui: '阅读器 · 衍生笔记',
    },
    steps: ['找「已入库 / 有衍生」但缺结论的章节', '读正文与既有批注', '压成 3-5 条自己的判断', 'propose 衍生笔记'],
    outputs: ['衍生笔记', '批注'],
    evidence: ['receipt.produced', 'journal: derive / annotate'],
    idempotency: '同一章节已有衍生则不再重复生成；追加要指明目标',
    degrade: {
      noModel: '只列出「读完了但没有衍生」的清单',
      noSchedule: '按需触发',
    },
    backlog: 'agentReady',
    ownerHint: '外部 harness 或平台 Agent',
  },
  {
    id: 'connect-notes',
    name: '连接（双链建议）',
    family: 'digest',
    intent: '新写的笔记要和已有的连起来；没有入链的定稿等于埋在土里。',
    trigger: { kind: 'event', on: '笔记成篇后，或每周一次' },
    maxSilenceMinutes: 10080,
    mode: 'assist',
    autonomy: 'propose',
    executors: ['platform-agent', 'external-harness', 'human'],
    requires: ['model', 'invoke:cli'],
    entry: {
      cli: 'habitat stuck --ai',
      api: 'GET /api/lifecycle · GET /api/graph',
      ui: '关系图',
    },
    steps: ['找已成篇但入链为 0 的笔记', '检索候选（同标签 / 词面相近）', '判断哪条是真关系', 'propose 双链'],
    outputs: ['双链建议 / 变更集'],
    evidence: ['receipt.produced', 'journal: propose'],
    idempotency: '已建议过的组合不重复提；接受或拒绝都留痕',
    degrade: { noModel: '只给候选列表，不判断关系强弱', noSchedule: '按需触发' },
    backlog: 'agentReady',
    ownerHint: '外部 harness 或平台 Agent',
  },
  {
    id: 'repair-links',
    name: '断链修复',
    family: 'digest',
    intent: '解析不到的 [[链接]] 要么补目标、要么改指向、要么明确删掉，不能一直挂着。',
    trigger: { kind: 'event', on: '断链出现，或每周一次' },
    maxSilenceMinutes: 10080,
    mode: 'assist',
    autonomy: 'propose',
    executors: ['platform-agent', 'external-harness', 'human'],
    requires: ['invoke:cli'],
    entry: {
      cli: 'habitat links',
      api: 'GET /api/links/unresolved',
      ui: '系统 · 健康',
    },
    steps: ['列出未解析目标与引用位置', '按标题 / 别名 / 拼写找候选', '判断补目标还是改指向', 'propose 修正'],
    outputs: ['断链清单', '修正变更集'],
    evidence: ['receipt.counts.broken', 'journal'],
    idempotency: '同一目标同一轮只报一次',
    degrade: { noModel: '只给候选与位置，不做语义判断', noSchedule: '按需触发' },
    backlog: 'unresolved',
    ownerHint: '平台 Agent 或人',
  },

  /* ---------------- 判断：翻新、复核、质疑、确认 ---------------- */
  {
    id: 'renew-due',
    name: '翻新召回（该复核哪几条）',
    family: 'decide',
    intent: '把「该翻新了」变成「有证据可判」：服务端召回候选，agent 决定要不要推翻。',
    trigger: { kind: 'daily', at: '09:00' },
    maxSilenceMinutes: 2880,
    mode: 'assist',
    autonomy: 'propose',
    executors: ['server', 'platform-agent', 'external-harness'],
    requires: ['clock', 'model'],
    entry: {
      cli: 'habitat due',
      api: 'GET /api/renew/:id',
      ui: '复盘',
    },
    steps: ['按间隔阶梯算到期', 'BM25 + 词袋 Jaccard 召回候选', '打包「它主张什么 + 哪几条可能撞上」', 'agent 判定 superseded 或 review --ok'],
    outputs: ['证据包', 'superseded 提案或复核记录'],
    evidence: ['receipt.counts.due', '.habitat/state/review.json'],
    idempotency: '同一对象同一档间隔只出现一次；review 后重新排期',
    degrade: {
      noModel: '只出证据包，不下结论（这是设计：召回便宜、判定贵）',
      noSchedule: '按需跑 habitat due',
    },
    backlog: 'reviewDue',
    ownerHint: '服务端召回 + harness 判定',
    note: '刻意一次只给 5 条：一次给几百条，人会直接关掉。',
  },
  {
    id: 'review-interval',
    name: '复核节奏',
    family: 'decide',
    intent: '确认一条结论仍然成立后，把下次复核往后推一档；不成立就回到第一档。',
    trigger: { kind: 'event', on: '复核某条之后' },
    maxSilenceMinutes: 0,
    mode: 'gate',
    autonomy: 'derived',
    executors: ['human', 'platform-agent'],
    requires: ['model', 'human:approve'],
    entry: {
      cli: 'habitat review <id> --ok',
      api: 'POST /api/review/:id',
      ui: '复盘',
    },
    steps: ['读当前档位', 'ok → 进一档（1/3/7/21/60/180 天）', 'stale → 回第 0 档，明天再看', '写 review.json'],
    outputs: ['下次复核时间'],
    evidence: ['.habitat/state/review.json', 'journal: review'],
    idempotency: '每条每天最多记一次',
    degrade: { noModel: '人自己判断，系统只记节奏', noSchedule: '到期清单靠 habitat due 现算' },
    ownerHint: '人 / Agent',
    note: '不用 SM-2 的难度因子：固定阶梯更可预测，也不会掉进 ease hell。',
  },
  {
    id: 'challenge-supersede',
    name: '质疑与取代',
    family: 'decide',
    intent: '旧结论撞上新证据时，提一条 supersededBy，让「过时」有据可查，而不是悄悄改掉。',
    trigger: { kind: 'event', on: '翻新证据包显示真冲突' },
    maxSilenceMinutes: 0,
    mode: 'gate',
    autonomy: 'propose',
    executors: ['platform-agent', 'external-harness', 'human'],
    requires: ['model', 'human:approve'],
    entry: {
      cli: 'habitat renew <id>',
      api: 'POST /api/proposals',
      ui: '变更',
    },
    steps: ['读证据包', '判断是否真冲突（不是措辞不同）', '写 supersededBy 提案', '等人确认'],
    outputs: ['superseded 提案'],
    evidence: ['proposal id', 'changeset id'],
    idempotency: '同一对 (旧,新) 只提一次',
    degrade: { noModel: '只给候选，不提案', noSchedule: '事件驱动，无到期概念' },
    ownerHint: 'Agent 提案 + 人确认',
    note: '旧文永不删除；被取代是状态，不是消失。',
  },
  {
    id: 'proposal-approve',
    name: '提案确认',
    family: 'decide',
    intent: '改语义的变更必须逐条被人看见：提案 → 四项校验 → 人确认 → 落盘 + 反向操作。',
    trigger: { kind: 'event', on: '有 pending 提案' },
    maxSilenceMinutes: 0,
    mode: 'gate',
    autonomy: 'commit',
    executors: ['human', 'platform-agent'],
    requires: ['human:approve'],
    entry: {
      cli: 'habitat propose --ops …',
      api: 'POST /api/proposals/:id/apply',
      ui: '变更',
    },
    steps: ['propose（带 base / inverse / 事件）', 'validate 四项校验', '人逐条确认', 'commit 落盘并重建索引'],
    outputs: ['变更集', '事件', '反向操作'],
    evidence: ['changeset id', 'journal: propose/commit'],
    idempotency: '变更集只能提交一次；已提交的再 apply 返回冲突',
    degrade: { noModel: '不适用：这一步是人的判断', noSchedule: '事件驱动' },
    backlog: 'proposal',
    ownerHint: '人',
    note: 'CLI 的 --commit 是给受信 harness 的快捷方式，不是给模型的默认路径；平台侧必须在 UI 逐条确认。',
  },
  {
    id: 'job-advance',
    name: '作业推进',
    family: 'decide',
    intent: '多步目标带检查点：中断能续，等待不是失败，失败有退避和上限。',
    trigger: { kind: 'event', on: '有 queued / running 作业' },
    maxSilenceMinutes: 0,
    mode: 'gate',
    autonomy: 'commit',
    executors: ['server', 'platform-agent'],
    requires: ['invoke:http'],
    entry: {
      api: 'POST /api/jobs · POST /api/jobs/:id/advance',
      ui: 'AI · 作业',
    },
    steps: ['排队（幂等键去重）', '推进检查点', '第二步固定停在 waiting-approval', '失败按 30/60/120 秒退避，三次判永久失败'],
    outputs: ['作业状态与检查点'],
    evidence: ['.habitat/state/jobs.jsonl', 'journal'],
    idempotency: 'idempotencyKey 相同的作业不重复排队',
    degrade: { noSchedule: '只能由人或有 UI 的 Agent 推进', noModel: '作业本身不判断，判断在步骤实现里' },
    backlog: 'job',
    ownerHint: '平台 Agent',
    note: '当前没有 CLI / MCP 入口：外部 harness 只能走 HTTP。这是已知缺口，手册里标了。',
  },

  /* ---------------- 交付：进出与发布 ---------------- */
  {
    id: 'mail-ingest',
    name: '邮件入库',
    family: 'deliver',
    intent: '发给自己的材料（附件 / 正文）进收件箱，不靠手动复制。',
    trigger: { kind: 'interval', minutes: 15, note: '也可由系统 cron 调 CLI' },
    maxSilenceMinutes: 240,
    mode: 'auto',
    autonomy: 'derived',
    executors: ['server', 'external-harness'],
    requires: ['clock', 'mail:imap'],
    entry: {
      cli: 'habitat inbox-mail --fetch',
      api: 'POST /api/inbox/mail',
      ui: '收件箱 · 收信',
    },
    steps: ['IMAP 拉取未读', '按 allowFrom 过滤', '解析正文与附件', '落到 inbox/'],
    outputs: ['收件箱条目'],
    evidence: ['receipt.counts.ingested', 'journal: ingest'],
    idempotency: '按 Message-ID 去重（已入库的不再收）',
    degrade: { noMail: '跳过并记 skipped；不新建空条目', noSchedule: '手动 --fetch' },
    ownerHint: '平台进程或系统 cron',
    harnessArgs: '--fetch',
  },
  {
    id: 'export-backup',
    name: '导出校验',
    family: 'deliver',
    intent: '定期导出一份带哈希清单的副本并校验，确保「文件是事实源」不是一句口号。',
    trigger: { kind: 'daily', at: '04:00', note: '建议每周日；节奏由 harness 决定' },
    maxSilenceMinutes: 10080,
    mode: 'verify',
    autonomy: 'read',
    executors: ['external-harness', 'human'],
    requires: ['clock', 'invoke:cli', 'fs:write'],
    entry: {
      cli: 'habitat export --out ~/habitat-backup --verify',
    },
    steps: ['原样复制文件与目录结构', '生成哈希清单', '按清单逐项校验', '回报对象数与解析率'],
    outputs: ['导出目录 + manifest'],
    evidence: ['receipt.counts.files/objects', 'manifest.json'],
    idempotency: '导出到新目录；同目录重跑覆盖同名文件',
    degrade: { noSchedule: '手动导出；发布前必须做一次' },
    ownerHint: '外部 harness / 人',
    harnessArgs: '--out ~/habitat-backup',
  },
  {
    id: 'release-promote',
    name: '发布到生产',
    family: 'deliver',
    intent: 'tag → 构建 → 单测 → 重启 → 健康检查 → 对比对象数与解析率，任一项不过自动回滚。',
    trigger: { kind: 'event', on: '打完 tag 后' },
    maxSilenceMinutes: 0,
    mode: 'verify',
    autonomy: 'external',
    executors: ['human', 'external-harness'],
    requires: ['invoke:cli', 'shell', 'fs:read'],
    entry: {
      command: 'node scripts/promote.mjs vX.Y.Z [--dry-run]',
      ui: '无（命令行）',
    },
    steps: ['检查工作区干净', '记录基线', '切 tag / 装依赖 / 构建', '跑单测', '重启并探活', '对比对象数与解析率', '不过则回滚'],
    outputs: ['生产版本', '健康检查报告'],
    evidence: ['promote 输出', '/healthz', '对象数 / 解析率对比'],
    idempotency: '同一 tag 重复 promote 结果一致；失败自动回滚',
    degrade: { noShell: '按 docs/workflow.md 人工执行，不能省健康检查' },
    ownerHint: '人',
    note: '平台进程不能执行它：需要生产目录、Shell 和重启权限。这是「外部 harness 才能接」的闭环样本。',
  },
];

export function loopById(id: string): LoopDef | undefined {
  return LOOPS.find((l) => l.id === id);
}

/** 期望节奏的中文说法 */
export function triggerLabel(t: LoopTrigger): string {
  switch (t.kind) {
    case 'interval':
      if (t.minutes < 1) return `每 ${Math.round(t.minutes * 60)} 秒`;
      if (t.minutes < 60) return `每 ${t.minutes} 分钟`;
      return `每 ${Math.round(t.minutes / 60)} 小时`;
    case 'daily':
      return `每天 ${t.at}`;
    case 'event':
      return `事件：${t.on}`;
    case 'manual':
      return t.note ?? '手动';
  }
}

/** 分钟数说成人话：90 → 1.5 小时；2880 → 2 天 */
export function humanMinutes(min: number): string {
  if (min <= 0) return '不判定';
  if (min < 60) return `${Math.round(min)} 分钟`;
  if (min < 1440) {
    const h = min / 60;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
  }
  const d = min / 1440;
  return `${Number.isInteger(d) ? d : d.toFixed(1)} 天`;
}

/** 给 harness 的 crontab 行；事件型 / 手动型返回 null */
export function cronOf(t: LoopTrigger): string | null {
  if (t.kind === 'daily') {
    const [h, m] = t.at.split(':').map((x) => Number(x));
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return `${m} ${h} * * *`;
  }
  if (t.kind === 'interval') {
    if (t.minutes < 1) return '* * * * *';
    if (t.minutes < 60) return `*/${Math.max(1, Math.round(t.minutes))} * * * *`;
    const hours = Math.round(t.minutes / 60);
    if (hours < 24) return `0 */${hours} * * *`;
    const days = Math.round(t.minutes / 1440);
    return days >= 1 ? `0 0 */${days} * *` : null;
  }
  return null;
}

/** 一条闭环的核心结论（用于 CLI / 手册首行） */
export function loopHeadline(d: LoopDef): string {
  return `${d.name}：${d.intent}`;
}

export function evaluateLoop(
  def: LoopDef,
  last: LoopReceipt | undefined,
  ctx: { now: number; enabled: boolean; blocked?: string[]; backlog?: number; pausedReason?: string },
): LoopState {
  const base = {
    id: def.id,
    maxSilenceMinutes: def.maxSilenceMinutes,
    backlog: ctx.backlog,
    lastAt: last?.at,
    lastBy: last?.by,
    lastResult: last?.result,
  };

  if (!ctx.enabled) return { ...base, state: 'paused', reason: ctx.pausedReason ?? '已停用' };
  if (def.maxSilenceMinutes === 0) {
    return { ...base, state: 'manual', reason: '按需 / 事件触发，不做存活判定' };
  }
  if (ctx.blocked?.length) {
    return { ...base, state: 'blocked', reason: `缺依赖：${ctx.blocked.join('、')}` };
  }
  if (!last) {
    return { ...base, state: 'never', reason: '从未留下回执（可能没人跑，也可能刚部署）' };
  }

  const silence = Math.max(0, Math.round((ctx.now - Date.parse(last.at)) / 60000));
  if (last.result === 'fail') {
    return { ...base, state: 'down', silenceMinutes: silence, reason: `上次失败：${last.note ?? '未写原因'}` };
  }
  if (silence > def.maxSilenceMinutes * 2) {
    return { ...base, state: 'down', silenceMinutes: silence, reason: `已 ${silence} 分钟没有回执（上限 ${def.maxSilenceMinutes}）` };
  }
  if (silence > def.maxSilenceMinutes) {
    return { ...base, state: 'late', silenceMinutes: silence, reason: `已 ${silence} 分钟没有回执（上限 ${def.maxSilenceMinutes}）` };
  }
  return {
    ...base,
    state: 'ok',
    silenceMinutes: silence,
    reason: last.result === 'skipped' ? `上次跳过：${last.note ?? '未写原因'}` : '最近一次运行正常',
  };
}

/** 一条闭环实际暴露了哪些调用通道（以 entry 为准，requires 只用于文档） */
export function entryChannels(def: LoopDef): ('cli' | 'http' | 'mcp')[] {
  const out: ('cli' | 'http' | 'mcp')[] = [];
  if (def.entry.cli || def.entry.command) out.push('cli');
  if (def.entry.api) out.push('http');
  if (def.entry.mcp) out.push('mcp');
  return out;
}

/** 一条闭环在给定 harness 上的可承担程度 */
export function fitLoop(def: LoopDef, h: HarnessProfile): HarnessFit {
  const missing: LoopCap[] = [];
  const hasClock = h.scheduler !== 'none' || h.alwaysOn === true;

  if (def.serverOnly) {
    return {
      loop: def.id,
      level: 'none',
      missing: [],
      why: '进程内行为，外部接管是重复劳动：起服务就够了',
      cron: null,
      command: def.entry.cli,
    };
  }

  // 调用通道按 entry 算：闭环只暴露 HTTP，harness 只有 CLI，就是接不上，
  // 不能因为「它好歹有个调用方式」就判成部分可承担。
  const channels = entryChannels(def);
  const usable = channels.filter((c) => h.invoke.includes(c));
  if (!usable.length) {
    return {
      loop: def.id,
      level: 'none',
      missing: channels.map((c) => `invoke:${c}` as LoopCap),
      why: channels.length ? `它只暴露 ${channels.map((c) => CAP_LABEL[`invoke:${c}` as LoopCap]).join(' / ')}，harness 没有对应通道` : '没有任何调用通道',
      cron: cronOf(def.trigger),
      command: def.entry.cli ?? def.entry.command,
    };
  }

  for (const cap of def.requires) {
    // 调用通道已按 entry 判过，这里只判环境能力
    if (cap.startsWith('invoke:')) continue;
    if (cap === 'clock') {
      if (!hasClock) missing.push(cap);
      continue;
    }
    if (cap === 'fs:read' && !h.invoke.includes('fs')) missing.push(cap);
    else if (cap === 'fs:write' && !h.invoke.includes('fs')) missing.push(cap);
    else if (cap === 'model' && !h.model) missing.push(cap);
    else if (cap === 'human:approve' && !h.humanApproval) missing.push(cap);
    else if (cap === 'mail:smtp' && h.mail !== 'smtp' && h.mail !== 'both') missing.push(cap);
    else if (cap === 'mail:imap' && h.mail !== 'imap' && h.mail !== 'both') missing.push(cap);
    else if (cap === 'shell' && !h.shell) missing.push(cap);
  }

  const command = def.entry.cli ?? def.entry.command;
  const cron = cronOf(def.trigger);
  const base = { loop: def.id, missing, cron, command };

  // 写文件 / Shell 缺失是硬缺口：能调起来也完不成
  const fatal = missing.filter((c) => c === 'fs:write' || c === 'shell');
  if (fatal.length) {
    return { ...base, level: 'none', why: `缺 ${fatal.map((c) => CAP_LABEL[c]).join('、')}，能调起来也完不成` };
  }

  if (missing.length === 0) {
    return { ...base, level: 'full', why: h.scheduler === 'none' ? '可完整承担，但只能按需触发' : '可完整承担' };
  }
  if (missing.length === 1 && missing[0] === 'clock') {
    return { ...base, level: 'partial', why: '能执行，但没有定时能力：只能按需或由别的调度器唤醒' };
  }
  if (missing.length === 1 && missing[0] === 'model') {
    return { ...base, level: 'partial', why: '能取到证据包，但不能做语义判断：会停在「备料完成」' };
  }
  if (missing.length === 1 && missing[0] === 'human:approve') {
    return { ...base, level: 'partial', why: '会停在人工确认，需要有人接手点那一下' };
  }
  return {
    ...base,
    level: 'partial',
    why: `缺 ${missing.map((c) => CAP_LABEL[c]).join('、')}，闭环会在缺口处断开`,
  };
}

export function fitAll(h: HarnessProfile): HarnessFit[] {
  return LOOPS.map((d) => fitLoop(d, h));
}

/** 给 CLI / API 的一行摘要 */
export function summarizeStates(states: LoopState[]): Record<string, number> {
  const out: Record<string, number> = { ok: 0, late: 0, down: 0, never: 0, paused: 0, blocked: 0, manual: 0 };
  for (const s of states) out[s.state] = (out[s.state] ?? 0) + 1;
  return out;
}

/**
 * 空间级 AGENTS.md —— 外部 harness 进入一个空间时先读这一页。
 *
 * 为什么写在空间里而不是仓库里：harness 通常只拿到数据目录，
 * 不一定知道工具源码在哪。把「怎么用、怎么交账、别做什么」放在数据旁边，
 * 比让它去翻 README 可靠。
 */
export function renderSpaceGuide(opts: { space: string; generatedAt: string }): string {
  const lines: string[] = [];
  const push = (...xs: string[]) => lines.push(...xs);
  push('# 这个空间怎么用（给 Agent 的操作手册）', '');
  push(`空间：${opts.space}`);
  push(`生成：${opts.generatedAt}`);
  push('由 `habitat loops init` 生成；改工具版本后重新生成，不要手改。', '');

  push('## 0. 三条硬规矩', '');
  push('1. **不要直接改文件**。所有内容变更走 `habitat propose` → 校验 → `commit`；判断类只能提案。');
  push('2. **不要删除**。不用的东西用 `habitat archive`；归档是可撤销的。');
  push('3. **跑完必须交账**。任何闭环执行完，都要 `habitat loops beat <id>`，并在 `produced` 里写清产物 id。没有回执等于没跑。', '');

  push('## 1. 进来先看什么', '');
  push('```bash');
  push('npx habitat status            # 连的是哪个空间、有多少东西');
  push(`npx habitat loops status      # ${LOOPS.length} 条闭环：谁 ok、谁迟到、谁从没跑过、积压多少`);
  push('npx habitat loops brief       # 交接单：现在该做什么、别做什么');
  push('```', '');
  push('如果 `status` 里出现 `down`，先修它或明确停用，不要假装没看见。', '');

  push('## 2. 闭环怎么接', '');
  push('| 模式 | 你能做什么 | 你不能做什么 |');
  push('|---|---|---|');
  push('| `auto` | 直接 `loops run <id>`；确定性步骤服务端会做完 | 改语义 |');
  push('| `assist` | `loops run` 拿工单 → 逐条处理 → `beat` 交账 | 让服务端替你做判断、自动 commit |');
  push('| `gate` | 准备提案、等人确认 | 替人点头 |');
  push('| `verify` | 跑检查、出报告 | 改内容 |', '');
  push('判断类工单里的每一条，动手前先认领，避免和别的 agent 重复：', '');
  push('```bash');
  push('npx habitat loops claim triage-inbox <对象 id> --ttl 120');
  push('npx habitat loops release triage-inbox        # 没做完也要还回去');
  push('```', '');
  push('`beat` 会自动释放你名下该闭环的全部认领，所以「交账」也是「释放」。', '');

  push('## 3. 定时任务怎么配（外部 harness）', '');
  push('```bash');
  push('npx habitat loops bind --harness harness.yaml --cron');
  push('```', '');
  push('它会输出三档：`✓ 能完整承担`（附 crontab）、`~ 只能承担一半`（写明缺什么）、`✗ 接不上`。');
  push('统一用 `loops run` 触发，不要直接调底层命令：它负责去重、租约、回执。', '');
  push('```cron');
  push('0 8 * * *   npx habitat loops run daily-brief --mail --actor agent:your-name');
  push('0 9 * * *   npx habitat loops run renew-due --actor agent:your-name');
  push('```', '');

  push('## 4. 怎么证明你干过活', '');
  push('```bash');
  push('npx habitat loops beat triage-inbox --ok --produced note-xxx,note-yyy --note "处理了 2 条"');
  push('npx habitat loops beat reminders --fail --note "SMTP 超时"');
  push('npx habitat loops status --json      # 你的回执会出现在 lastAt / lastBy');
  push('```', '');
  push('`produced` 为空会被当成「跑了但什么也没发生」，不要这么交账。', '');

  push('## 5. 自检', '');
  push('```bash');
  push('npx habitat loops check      # down / late / 从未运行 / 无归属 / 重复执行');
  push('```', '');
  push('`down` 必须处理；`never` 先确认是刚部署还是根本没接；`double` 说明两个执行者撞车了，只留一个。', '');

  push('## 6. 状态文件在哪（只读优先）', '');
  push('| 文件 | 内容 |');
  push('|---|---|');
  push('| `.habitat/state/loop-runs.jsonl` | 回执，只追加；最后一行可能是半截，忽略即可 |');
  push('| `.habitat/state/automation.json` | 启停、归属、harness 能力声明 |');
  push('| `.habitat/state/loop-claims.json` | 认领（有 TTL，过期自动失效） |');
  push('| `.habitat/state/loop-leases.json` | 执行租约（正常跑完会删掉） |', '');
  push('> 需要写这些文件时优先用 CLI/API，不要手改：手改会绕过条件写和去重。', '');
  return `${lines.join('\n')}\n`;
}

/** 参考手册：从目录生成，不手写 */
export function renderManual(opts: { generatedAt: string; version?: string } = { generatedAt: '' }): string {
  const lines: string[] = [];
  const push = (...xs: string[]) => lines.push(...xs);

  push('# 自动化闭环参考手册', '');
  push('> 这份手册由 `habitat loops manual` 从闭环目录生成。不要手改；改 `shared/loops.ts` 后重新生成。', '');
  push(`生成时间：${opts.generatedAt || '—'}${opts.version ? ` · 版本 ${opts.version}` : ''}`, '');

  push('## 0. 先读这一页', '');
  push('一个闭环要成立，必须同时有六样东西：**触发、入口、步骤、产物、证据、降级**。');
  push('缺任何一样，它就会变成「文档里写了、实际没人跑」的空壳。这份手册逐条列出来，就是为了让缺口看得见。', '');
  push('三种角色，三条读法：', '');
  push('| 角色 | 先看 | 然后 |');
  push('|---|---|---|');
  push('| 人 | `habitat loops status` | 只看 `down` / `blocked` / 积压最大的三条 |');
  push('| 平台 Agent | `GET /api/loops` | 按 `owner` 跑，跑完 `beat`，产物写进 `produced` |');
  push('| 外部 harness | `habitat loops list --json` | `bind --harness profile.yaml` 看能接哪些 → 生成 cron → `run` → `claim` → `beat` |', '');

  push('## 1. 状态怎么判', '');
  push('| 状态 | 含义 | 该做什么 |');
  push('|---|---|---|');
  push('| `ok` | 最近一次回执在上限内 | 不用管 |');
  push('| `late` | 超过上限但不到两倍 | 看一眼是不是调度器漏了一轮 |');
  push('| `down` | 超过两倍，或上次失败 | 立刻处理：这是真正的空壳 |');
  push('| `never` | 从未留下回执 | 先确认是「刚部署」还是「根本没接」 |');
  push('| `blocked` | 缺依赖（邮件 / IMAP） | 补配置，或明确接受降级 |');
  push('| `paused` | 被显式停用 | 确认是谁停的、为什么 |');
  push('| `manual` | 按需 / 事件型，不做存活判定 | 看 backlog |', '');
  push('`maxSilenceMinutes` 是容忍上限，默认按「两倍」判 down，留了一次漏跑的余量。', '');

  push('### 1.1 租约、认领与告警', '');
  push('| 机制 | 解决什么 | 怎么用 |');
  push('|---|---|---|');
  push('| 租约 | 平台定时器和外部 cron 同时到点，只让一个真正执行 | 自动；`habitat loops leases` 看谁在执行 |');
  push('| 认领 | 两个 agent 不重复处理同一条工单 | `loops claim <id> <target>`；`beat` 自动释放 |');
  push('| 告警 | down 不再只靠人打开页面 | 服务每 10 分钟检查；`loops alerts` 手动推一次 |', '');
  push('租约默认 10 分钟（`HABITAT_LOOP_LEASE_MIN`），认领默认 120 分钟（`HABITAT_CLAIM_MIN`）。');
  push('进程崩了不会留死锁：租约/认领都有过期时间，过期后可被接管。', '');

  const families: LoopFamily[] = ['maintain', 'digest', 'decide', 'deliver'];
  const familyIntro: Record<LoopFamily, string> = {
    maintain: '不需要判断力，必须自己转。人不在、模型不在，它们也应该照常工作。',
    digest: 'AI 的「判断 / 提炼 / 连接」三个切入点。服务端只备料，判断交给模型或人。',
    decide: '翻新、复核、质疑、确认。共同点是**不允许自动改语义**，最多提案。',
    deliver: '进出与发布。前两个决定材料怎么进来、怎么备份；最后一个决定代码怎么上线。',
  };

  let idx = 0;
  for (const fam of families) {
    const list = LOOPS.filter((l) => l.family === fam);
    if (!list.length) continue;
    push(`## 2.${families.indexOf(fam) + 1} ${FAMILY_LABEL[fam]}（${list.length} 条）`, '');
    push(familyIntro[fam], '');
    for (const d of list) {
      idx += 1;
      push(`### ${idx}. \`${d.id}\` ${d.name}`, '');
      push(`**目标**：${d.intent}`, '');
      push(`| 项 | 值 |`);
      push(`|---|---|`);
      push(`| 触发 | ${triggerLabel(d.trigger)} |`);
      push(`| 模式 | ${MODE_LABEL[d.mode]} · 自主度 ${AUTONOMY_LABEL[d.autonomy]} |`);
      push(`| 执行者 | ${d.executors.map((e) => EXECUTOR_LABEL[e]).join(' / ')} |`);
      push(`| 存活上限 | ${d.maxSilenceMinutes ? humanMinutes(d.maxSilenceMinutes) : '不做存活判定'} |`);
      if (d.backlog) push(`| 积压指标 | ${backlogLabel(d.backlog)} |`);
      push('');
      const entries: string[] = [];
      if (d.entry.cli) entries.push(`\`${d.entry.cli}\``);
      if (d.entry.api) entries.push(`\`${d.entry.api}\``);
      if (d.entry.mcp) entries.push(`MCP \`${d.entry.mcp}\``);
      if (d.entry.command) entries.push(`\`${d.entry.command}\``);
      if (d.entry.ui) entries.push(`UI：${d.entry.ui}`);
      push(`**入口**：${entries.length ? entries.join(' ｜ ') : '⚠ 没有非 UI 入口'}`, '');
      if (d.serverOnly) push('**接管**：仅进程内，外部 harness 不需要接管', '');
      if (d.harnessArgs) push(`**harness 定时**：\`habitat loops run ${d.id} ${d.harnessArgs}\``, '');
      push('**步骤**：');
      d.steps.forEach((s, i) => push(`${i + 1}. ${s}`));
      push('');
      push(`**产物**：${d.outputs.join('；')}`, '');
      push(`**证据**：${d.evidence.join('；')}`, '');
      push(`**幂等**：${d.idempotency}`, '');
      const deg = Object.entries(d.degrade);
      if (deg.length) {
        push('**降级**：');
        for (const [k, v] of deg) push(`- ${degradeLabel(k)} → ${v}`);
      } else {
        push('**降级**：无（不依赖外部条件）');
      }
      push('');
      push(`**默认归属**：${d.ownerHint}`, '');
      if (d.note) push(`> ${d.note}`, '');
      push('');
    }
  }

  push('## 3. 外部 harness 接入清单', '');
  push('按顺序回答七个问题，答不上来的那一项就是闭环会断的地方：', '');
  push('1. **它什么时候该跑？** 时区明确吗？存储用 UTC、显示用本地时间。');
  push('2. **它跑得完吗？** 单次超时多少？超过预算要大声失败，不能静默挂着。');
  push('3. **重复跑会怎样？** 每条闭环的「幂等」一栏写了答案；写不出来的不允许接。');
  push('4. **产物写在哪？** 产物必须是可指认的 id，不是「我改好了」。');
  push('5. **怎么证明它跑过？** 跑完必须 `habitat loops beat <id> --ok --produced …`；没有回执等于没跑。');
  push('6. **会不会和别人抢同一条？** 判断类先 `claim`；确定性任务靠租约，不用你操心。');
  push('7. **失败了谁接手？** 连续失败三次就停下来通知人，不要无限重试。');
  push('8. **它不能做什么？** 判断类闭环只许提案，不许 commit；外发类必须先过人。', '');

  push('### 一个最小可用的 cron 组合', '');
  push('```cron');
  push('# 每 15 分钟：把外部改动收进索引 + 收一次邮件');
  push('*/15 * * * * cd /path/to/habitat && npx habitat loops run watch-external --actor agent:cron');
  push('*/15 * * * * cd /path/to/habitat && npx habitat loops run mail-ingest --fetch --actor agent:cron');
  push('');
  push('# 每天 08:00：简报（--mail 才会发信）；09:00：翻新队列');
  push('0 8 * * *  cd /path/to/habitat && npx habitat loops run daily-brief --mail --actor agent:cron');
  push('0 9 * * *  cd /path/to/habitat && npx habitat loops run renew-due --actor agent:cron');
  push('');
  push('# 每周日 04:00：导出校验');
  push('0 4 * * 0  cd /path/to/habitat && npx habitat loops run export-backup --out ~/habitat-backup --actor agent:cron');
  push('```', '');
  push('统一走 `loops run`：它会去重、写回执；判断类会出工单而不是假装完成。');
  push('`--actor` 会写进回执，用来回答「这次是谁跑的」。没有它，回执只能记成 `human`。', '');

  push('## 4. 故障排查', '');
  push('| 现象 | 先查 | 常见原因 |');
  push('|---|---|---|');
  push('| `down` 但进程活着 | `habitat loops status --json` 的 `lastAt` | 定时器被 `HABITAT_*_MS=0` 关了；或 harness 的 cron 被删了 |');
  push('| 两个执行器都跑了 | `habitat loops leases` + `loop-runs.jsonl` | 租约应该拦住；若确实双跑，检查两边是否用了不同的空间根 |');
  push('| 跑完没有产物 | 回执的 `produced` 为空 | 闭环只做了「扫描」，没做「落盘」；回到步骤表看断在哪一步 |');
  push('| `blocked` 一直是邮件 | `habitat notify` 看缺哪个字段 | 没配 SMTP；补配置或把闭环标成 paused |');
  push('| 回执很多但没人看 | `backlog` 持续变大 | 闭环在「生产」，但没有人消费产物——这比不跑更糟 |', '');

  push('## 5. 怎么改这份手册', '');
  push('1. 改 `shared/loops.ts` 里的目录（新增 / 删除 / 改字段）。');
  push('2. `npm run test:unit`：契约测试会检查每条闭环都有入口、证据、幂等、降级。');
  push('3. `habitat loops manual --out docs/automation-manual.md` 重新生成。');
  push('4. 空间级操作手册：`habitat loops init` 在空间根写 `AGENTS.md`（外部 harness 的入口）。');
  push('4. 手册与代码在同一个 commit 里，评审时一起看。', '');
  push('> 反模式：直接手改这份 Markdown。下一次生成就会覆盖，且没人知道哪份是真的。');

  return `${lines.join('\n')}\n`;
}

function backlogLabel(k: BacklogKey): string {
  return {
    inbox: '收件箱条数',
    agentReady: '有 AI 切入点的欠账数',
    unresolved: '未解析链接数',
    reviewDue: '到期复核数',
    proposal: '待确认提案数',
    job: '未完成作业数',
  }[k];
}

function degradeLabel(k: string): string {
  return {
    noModel: '没有模型',
    noSchedule: '没有调度器',
    noMail: '没有邮件通道',
    noShell: '没有 Shell / 生产目录',
  }[k] ?? k;
}
