/**
 * 阅读进度上报规则的边界。
 * 锁的是「降频」和「不丢最远位置」之间的那条线，别让以后一个顺手改动
 * 又变回每 1.2 秒一条，或者相反地把最后 4% 的阅读抹掉。
 */
import { describe, it, expect } from 'vitest';
import {
  shouldReport, needsFlush, REPORT_MIN_DELTA, REPORT_MAX_GAP_MS, FLUSH_MIN_DELTA,
  type ReportBaseline,
} from '../../src/domains/reading/throttle.ts';

const NOW = 1_800_000_000_000;
const last = (pct: number, agoMs = 0): ReportBaseline => ({ pct, at: NOW - agoMs });

describe('shouldReport', () => {
  it('首次 / 换章第一条必写', () => {
    expect(shouldReport(0, null, NOW)).toBe(true);
    expect(shouldReport(0.83, null, NOW)).toBe(true);
  });

  it('短时间内的微小推进不写（这是原来 1.2 秒一条的根源）', () => {
    expect(shouldReport(0.412, last(0.41, 1_200), NOW)).toBe(false);
    expect(shouldReport(0.45, last(0.41, 10_000), NOW)).toBe(false);
  });

  it('推进 ≥5% 就写，不等满 60 秒', () => {
    expect(shouldReport(0.46, last(0.41, 1_200), NOW)).toBe(true);
    expect(shouldReport(0.36, last(0.41, 1_200), NOW)).toBe(true); // 往回读也算动过
    expect(shouldReport(0.41 + REPORT_MIN_DELTA, last(0.41, 0), NOW)).toBe(true);
  });

  it('一直停在 5% 以内，满 60 秒也要写一条「还在读」', () => {
    expect(shouldReport(0.415, last(0.41, REPORT_MAX_GAP_MS - 1), NOW)).toBe(false);
    expect(shouldReport(0.415, last(0.41, REPORT_MAX_GAP_MS), NOW)).toBe(true);
  });

  it('force 绕过节流，但 1 秒内完全重复仍不重复写', () => {
    expect(shouldReport(0.412, last(0.41, 200), NOW, { force: true })).toBe(true);
    expect(shouldReport(1, last(1, 200), NOW, { force: true }), '同一位置立刻重复').toBe(false);
    expect(shouldReport(1, last(1, 2_000), NOW, { force: true })).toBe(true);
  });
});

describe('needsFlush', () => {
  it('最后一段 ≥1% 要补，小于 1% 是抖动', () => {
    expect(needsFlush(0.42, 0.41)).toBe(true);
    expect(needsFlush(0.41 + FLUSH_MIN_DELTA, 0.41)).toBe(true);
    expect(needsFlush(0.414, 0.41)).toBe(false);
  });
});
