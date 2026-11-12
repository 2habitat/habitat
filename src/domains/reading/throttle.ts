/**
 * 阅读进度上报的节流规则（纯函数，单独测）。
 *
 * 之前阅读器每 1.2 秒写一条 read 事件，真实空间里 2355 条事件有 1552 条
 * 是「读到 41%」这类进度刷屏。规则：推进 5% 或间隔 60 秒才记一条；
 * 停稳 / 换章 / 离开时另补一次最终位置，保证「读到哪」不被记少。
 */
export const REPORT_MIN_DELTA = 0.05;
export const REPORT_MAX_GAP_MS = 60_000;
export const REPORT_SETTLE_MS = 1500;
/** 最终位置差到 1% 就值得补一条，再小就是抖动 */
export const FLUSH_MIN_DELTA = 0.01;

export interface ReportBaseline {
  at: number;
  pct: number;
}

/** 浮点容差：0.41 - 0.36 在 JS 里是 0.049999…，正好 5% 不能被判成「没动」 */
const EPS = 1e-9;

/** 这一帧的进度要不要真的发到服务端 */
export function shouldReport(
  pct: number,
  last: ReportBaseline | null,
  now: number,
  opts: { force?: boolean } = {},
): boolean {
  if (!last) return true; // 首次 / 换章后的第一条必写
  const delta = Math.abs(pct - last.pct);
  // effect 重跑、严格模式、重复 flush 会在极短时间内发同一个位置
  if (delta < 0.001 && now - last.at < 1000) return false;
  if (opts.force) return true; // 标记读完 / 停稳补记
  if (delta + EPS >= REPORT_MIN_DELTA) return true;
  return now - last.at >= REPORT_MAX_GAP_MS;
}

/** 停稳 / 换章 / 切走时，剩余这段还值不值得补记 */
export function needsFlush(pct: number, lastPct: number): boolean {
  return Math.abs(pct - lastPct) + EPS >= FLUSH_MIN_DELTA;
}
