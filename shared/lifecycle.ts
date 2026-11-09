/**
 * 生命周期五阶段闸门 —— 计算得出，不是标签（设计方案 §0 与 v5 原型约定）
 * 采集(入库且有来源) → 衍生(有批注或衍生笔记) → 消化(读过 ≥99% 且 ≥1 条衍生)
 *   → 回顾(有过一次回顾事件) → 沉淀(已定稿且被引用 ≥2 处)
 */
import type { GateResult, StageKey } from './types.ts';
import { STAGES } from './types.ts';

export const DIGEST_PCT = 0.99;
export const SETTLE_INBOUND = 2;
/**
 * 单章「读完」的判定线：章节内最远位置过了这条线就算这一章读完。
 * 留 2% 的余量，因为章末还有「读到这里」和血缘区，正文并没有到卷底。
 */
export const CHAPTER_DONE_PCT = 0.98;

export interface LifeFacts {
  exists: boolean;
  hasSource: boolean;
  derivedCount: number;
  /**
   * 0..1。作品是「读完的章数 ÷ 正文章数」（章节覆盖率），
   * 单章 / 载体才是章内最远位置——一章滚到底只该算一章，不该算整本。
   */
  readPct: number;
  reviewedAt?: string | null;
  evergreen: boolean;
  /** 被多少条笔记 / 专题引用 */
  inbound: number;
}

export function gatesOf(f: LifeFacts): GateResult[] {
  return [
    {
      key: 'capture',
      pass: f.exists && f.hasSource,
      detail: f.exists ? (f.hasSource ? '已入库且有来源' : '缺少来源，补一个 source 字段') : '尚未入库',
    },
    {
      key: 'derive',
      pass: f.derivedCount > 0,
      detail: f.derivedCount > 0 ? `已产生 ${f.derivedCount} 条衍生` : '还没有批注或衍生笔记',
    },
    {
      key: 'digest',
      pass: f.readPct >= DIGEST_PCT && f.derivedCount > 0,
      detail:
        f.readPct >= DIGEST_PCT
          ? f.derivedCount > 0
            ? '读完且有衍生'
            : `已读 ${Math.round(f.readPct * 100)}%，但还没有衍生`
          : `已读 ${Math.round(f.readPct * 100)}%，还差 ${Math.ceil((DIGEST_PCT - f.readPct) * 100)}%`,
    },
    {
      key: 'review',
      pass: !!f.reviewedAt,
      detail: f.reviewedAt ? `最近回顾 ${f.reviewedAt.slice(0, 10)}` : '还没有回顾过',
    },
    {
      key: 'settle',
      pass: f.evergreen && f.inbound >= SETTLE_INBOUND,
      detail: f.evergreen
        ? `已定稿，被引用 ${f.inbound} 处${f.inbound >= SETTLE_INBOUND ? '' : `，还差 ${SETTLE_INBOUND - f.inbound} 处`}`
        : '尚未标记为 evergreen',
    },
  ];
}

/** 最高通过的阶段；一个都没过返回 null */
export function stageOf(f: LifeFacts): StageKey | null {
  const g = gatesOf(f);
  let cur: StageKey | null = null;
  for (const x of g) if (x.pass) cur = x.key;
  return cur;
}

/** 卡在哪：第一个没过的闸门 */
export function stuckAt(f: LifeFacts): GateResult | null {
  return gatesOf(f).find((g) => !g.pass) ?? null;
}

export function stageName(k: StageKey | null): string {
  if (!k) return '未开始';
  return STAGES.find((s) => s.key === k)?.name ?? k;
}

/** 让某阶段通过的下一步动作（供「流转看板 → 推进」按钮使用） */
export function nextAction(f: LifeFacts): { key: StageKey; text: string } | null {
  const g = stuckAt(f);
  if (!g) return null;
  switch (g.key) {
    case 'capture':
      return { key: 'capture', text: '补齐来源字段后入库' };
    case 'derive':
      return { key: 'derive', text: '选中正文做一条批注，或衍生一篇笔记' };
    case 'digest':
      return f.readPct >= DIGEST_PCT
        ? { key: 'digest', text: '补一条衍生：批注或笔记' }
        : { key: 'digest', text: '继续读到 99%' };
    case 'review':
      return { key: 'review', text: '加到复盘清单，做一次回顾' };
    case 'settle':
      return f.evergreen
        ? { key: 'settle', text: `再被引用 ${Math.max(0, SETTLE_INBOUND - f.inbound)} 处` }
        : { key: 'settle', text: '把笔记状态改为 evergreen' };
    default:
      return null;
  }
}
