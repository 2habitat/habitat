/**
 * 生命周期模型：状态流 / 控制流 / 数据流 / AI 切入点，四条一起定义。
 *
 * 为什么要有这个文件：
 * 之前只有「读材料」一条五段闸门，碎片、笔记、任务、项目各自为政——
 * 结果是「东西在哪一步、下一步该干什么、AI 能在哪插手」全靠人记。
 * 记不住，就等于没有体系；没有体系，AI 就没有确定的切入点。
 *
 * 这里把三类对象的状态机写死成数据，任何界面、CLI、AI 都读同一份：
 *   - 状态：这个对象现在在哪
 *   - 出口：这个状态存在的意义（达成什么才算过）
 *   - 转移：谁能推、推到哪、推完产出什么
 *   - AI 钩子：这一步 AI 能做什么（没有钩子就是纯人工）
 */
import type { AnyObject } from './types.ts';

export type FlowKind = 'material' | 'knowledge' | 'action';

export interface StateDef {
  key: string;
  name: string;
  /** 这个状态存在的意义：达成什么才算过这一步 */
  goal: string;
  /** 允许的后继状态 */
  next: string[];
  /** 谁能推动：人 / Agent / 定时器 */
  actors: ('human' | 'agent' | 'timer')[];
  /** AI 在这一步能做什么；没有就是纯人工 */
  aiHook?: string;
  /** 推到下一步产出什么（数据流） */
  output: string;
}

export interface FlowDef {
  kind: FlowKind;
  name: string;
  types: string[];
  states: StateDef[];
}

/* ---------------- 三类对象的完整状态机 ---------------- */

export const FLOWS: FlowDef[] = [
  {
    kind: 'knowledge',
    name: '知识（碎片 → 笔记）',
    types: ['note'],
    states: [
      {
        key: 'captured',
        name: '已采集',
        goal: '东西进出得来，先不管质量',
        next: ['triaged'],
        actors: ['human', 'agent'],
        aiHook: '判断：这条值得留吗？该归到哪个主题？算不算重复？',
        output: '变更集（打标签 / 改归属）',
      },
      {
        key: 'triaged',
        name: '已判断',
        goal: '知道它是什么、值不值得留',
        next: ['developed', 'archived'],
        actors: ['human', 'agent'],
        aiHook: '提炼：把原文压成自己的话，指出它和已有哪条相关或冲突',
        output: '正文（自己写的）+ 至少一条出链',
      },
      {
        key: 'developed',
        name: '已成篇',
        goal: '能独立读懂，不依赖上下文',
        next: ['linked', 'settled'],
        actors: ['human'],
        aiHook: '连接：找相关条目、发现重复、建议双链方向',
        output: '双链（出链/入链）',
      },
      {
        key: 'linked',
        name: '已接入',
        goal: '它在知识网里，别人能顺着链找到它',
        next: ['settled', 'superseded'],
        actors: ['human'],
        aiHook: '质疑：有没有新证据推翻它？要不要标 superseded？',
        output: '状态改 evergreen / 标 supersededBy',
      },
      {
        key: 'settled',
        name: '已定稿',
        goal: '不再改，可以被引用',
        next: ['superseded'],
        actors: ['human', 'agent'],
        aiHook: '复查：定期看这条还成立吗',
        output: '要么保持，要么转 superseded',
      },
      {
        key: 'superseded',
        name: '被取代',
        goal: '保留旧结论，但明确它不再是当前答案',
        next: [],
        actors: ['human'],
        output: 'supersededBy 指向新结论；不删',
      },
    ],
  },
  {
    kind: 'action',
    name: '行动（任务 / 项目）',
    types: ['action', 'project'],
    states: [
      {
        key: 'open',
        name: '待办',
        goal: '写清楚要做什么',
        next: ['doing', 'done', 'archived'],
        actors: ['human', 'agent'],
        aiHook: '拆解：这件事能不能拆成三步？缺什么前置条件？',
        output: '补 due / projectId，或拆成子任务',
      },
      {
        key: 'doing',
        name: '进行中',
        goal: '有人在推它',
        next: ['done', 'archived'],
        actors: ['human'],
        output: '进展记录（事件）',
      },
      {
        key: 'done',
        name: '已完成',
        goal: '结果确认过',
        next: ['archived'],
        actors: ['human', 'timer'],
        output: '完成后 30 天由管家归档',
      },
      {
        key: 'archived',
        name: '已归档',
        goal: '不再占用日常视图，但记录还在',
        next: [],
        actors: ['human'],
        output: '[archived:: 时间] 写回文件',
      },
    ],
  },
  {
    kind: 'material',
    name: '材料（书 / 章节）',
    types: ['work', 'part', 'rep'],
    states: [
      {
        key: 'capture',
        name: '已入库',
        goal: '原件在、来源清',
        next: ['derive'],
        actors: ['human', 'agent'],
        aiHook: '整理：这份材料该归到哪部书？章节顺序对不对？',
        output: 'work.yaml / parts 结构',
      },
      {
        key: 'derive',
        name: '有衍生',
        goal: '不只是存着，至少有一条自己的话',
        next: ['digest'],
        actors: ['human', 'agent'],
        aiHook: '提炼：这一章讲了什么？挑出值得批注的段落',
        output: '批注 / 衍生笔记',
      },
      {
        key: 'digest',
        name: '已消化',
        goal: '读完且有输出',
        next: ['review'],
        actors: ['human', 'agent'],
        aiHook: '对照：这套说法和你已知的哪条一致/冲突？',
        output: '继续阅读进度到 99% + 衍生',
      },
      {
        key: 'review',
        name: '回顾过',
        goal: '隔一段时间再看，确认还成立',
        next: ['settle'],
        actors: ['human', 'timer'],
        aiHook: '出题：就这一章问你三个问题，答不上来说明没消化',
        output: 'review 事件',
      },
      {
        key: 'settle',
        name: '已沉淀',
        goal: '定稿且被引用，成为可复用的结论',
        next: [],
        actors: ['human'],
        aiHook: '串联：把这一章和另外几章串成一篇综述',
        output: 'evergreen + 被引用 ≥2 处',
      },
    ],
  },
];

/**
 * 归档是**跨流的终态**，不属于任何一条业务流。
 * 不显式补进去的话，知识流里搜不到 'archived'，就会兜底成「已采集」——
 * 界面上表现为「归档了又活过来」。
 */
export const ARCHIVED_STATE: StateDef = {
  key: 'archived',
  name: '已归档',
  goal: '不占日常视图，但记录还在',
  next: [],
  actors: ['human'],
  output: '[archived:: 时间] 写回文件',
};

for (const f of FLOWS) {
  if (!f.states.some((s) => s.key === 'archived')) f.states.push(ARCHIVED_STATE);
}

export function flowOf(type: string): FlowDef | undefined {
  return FLOWS.find((f) => f.types.includes(type));
}

export function stateDef(type: string, key: string): StateDef | undefined {
  return flowOf(type)?.states.find((s) => s.key === key);
}

/* ---------------- 判定：对象现在在哪一步 ---------------- */

export interface LifeFacts {
  type: string;
  archivedAt?: string;
  state?: string;
  evergreen?: boolean;
  supersededBy?: string;
  bodyLength?: number;
  inbound?: number;
  outbound?: number;
  derived?: number;
  readPct?: number;
  reviewedAt?: string | null;
  hasSource?: boolean;
}

export interface LifeView {
  type: string;
  flow: FlowKind;
  state: string;
  stateName: string;
  goal: string;
  /** 推到下一步缺什么 */
  blockers: string[];
  /** 下一步能做什么（人/AI 都看这份） */
  next: { key: string; name: string; actors: string[]; output: string; aiHook?: string }[];
  aiHook?: string;
}

export function lifeOf(f: LifeFacts): LifeView | null {
  const flow = flowOf(f.type);
  if (!flow) return null;

  const key = resolveState(f);
  const def = flow.states.find((s) => s.key === key) ?? flow.states[0];
  const nxt = def.next
    .map((k) => flow.states.find((s) => s.key === k))
    .filter((s): s is StateDef => !!s)
    .map((s) => ({ key: s.key, name: s.name, actors: s.actors as string[], output: s.output, aiHook: s.aiHook }));

  return {
    type: f.type,
    flow: flow.kind,
    state: def.key,
    stateName: def.name,
    goal: def.goal,
    blockers: blockersFor(f, def.key),
    next: nxt,
    aiHook: def.aiHook,
  };
}

function resolveState(f: LifeFacts): string {
  if (f.archivedAt) return 'archived';
  if (f.type === 'action' || f.type === 'project') {
    if (f.state === 'done') return 'done';
    if (f.state === 'doing') return 'doing';
    return 'open';
  }
  if (f.type === 'note') {
    if (f.supersededBy) return 'superseded';
    if (f.evergreen) return 'settled';
    if ((f.inbound ?? 0) > 0 || (f.outbound ?? 0) > 0) return 'linked';
    if ((f.bodyLength ?? 0) >= 200) return 'developed';
    return 'captured';
  }
  // material：沿用五段闸门，从高往低判
  if (f.evergreen && (f.inbound ?? 0) >= 2) return 'settle';
  if (f.reviewedAt) return 'review';
  if ((f.readPct ?? 0) >= 0.99 && (f.derived ?? 0) > 0) return 'digest';
  if ((f.derived ?? 0) > 0) return 'derive';
  return 'capture';
}

function blockersFor(f: LifeFacts, key: string): string[] {
  const out: string[] = [];
  if (key === 'captured') {
    if ((f.bodyLength ?? 0) < 200) out.push(`正文只有 ${f.bodyLength ?? 0} 字，还不足以成篇`);
  }
  if (key === 'developed') {
    if (!(f.inbound ?? 0) && !(f.outbound ?? 0)) out.push('还没有任何双链');
  }
  if (key === 'derive') {
    if (!(f.derived ?? 0)) out.push('没有批注也没有衍生笔记');
  }
  if (key === 'digest') {
    if ((f.readPct ?? 0) < 0.99) out.push(`读到 ${Math.round((f.readPct ?? 0) * 100)}%，还没读完`);
  }
  if (key === 'review') {
    if (!f.reviewedAt) out.push('没有回顾记录');
  }
  if (key === 'linked') {
    if (!f.evergreen) out.push('还没标记为定稿（evergreen）');
  }
  return out;
}

/* ---------------- 从对象还原事实 ---------------- */

export function factsOf(obj: AnyObject, extra: Partial<LifeFacts> = {}): LifeFacts {
  const o = obj as unknown as Record<string, unknown>;
  return {
    type: String(o.type ?? ''),
    state: o.state as string | undefined,
    archivedAt: o.archivedAt as string | undefined,
    evergreen: o.status === 'evergreen',
    supersededBy: o.supersededBy as string | undefined,
    bodyLength: typeof o.body === 'string' ? (o.body as string).length : undefined,
    ...extra,
  };
}
