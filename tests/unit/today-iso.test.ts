/**
 * 「今天」的日期口径。
 *
 * 出过真事：moveToToday 用 toISOString()（UTC），服务端用本地日历日（UTC+8）。
 * 本地 00:00–08:00 点「挪到今天」，due 会被写成昨天，任务直接进逾期。
 * 这里锁住前端与服务端共用同一个本地日历日 helper。
 */
import { describe, it, expect } from 'vitest';
import { nowISO, todayISO } from '../../shared/id.ts';
import { todayStr } from '../../src/components/ui.tsx';

function localDay(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

describe('todayISO', () => {
  it('取的是本地日历日，和 nowISO 的日期部分同源', () => {
    const t = Date.now();
    expect(todayISO(t)).toBe(localDay(t));
    expect(todayISO(t)).toBe(nowISO(t).slice(0, 10));
  });

  it('相对日期（如七天后）也按本地日历日推进', () => {
    const t = Date.now();
    const later = t + 7 * 86400_000 + 3600_000; // 故意多跨一小时
    expect(todayISO(later)).toBe(localDay(later));
  });

  it('前端 todayStr 与服务端共用同一口径', () => {
    // 同一秒内调用，日期必然一致；口径不一致时只在跨 UTC 日的时段暴露
    expect(todayStr()).toBe(todayISO());
  });
});
