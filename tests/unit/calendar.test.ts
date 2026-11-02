import { describe, it, expect } from 'vitest';
import { buildMonth } from '../../shared/calendar.ts';
import type { Action, EventRec } from '../../shared/types.ts';

const ev = (id: string, start: string, over: Partial<EventRec> = {}): EventRec =>
  ({
    type: 'event', id, schema: 1, spaceId: 'space-test',
    createdAt: '2026-11-01T00:00:00+08:00', updatedAt: '2026-11-01T00:00:00+08:00',
    author: 'human', sensitivity: 'private', rev: 1,
    title: `事件 ${id}`, start, end: start, ...over,
  }) as unknown as EventRec;

const act = (id: string, over: Partial<Action> = {}): Action =>
  ({
    type: 'action', id, schema: 1, spaceId: 'space-test',
    createdAt: '2026-11-01T00:00:00+08:00', updatedAt: '2026-11-01T00:00:00+08:00',
    author: 'human', sensitivity: 'private', rev: 1,
    text: `任务 ${id}`, flow: 'next', state: 'open', ...over,
  }) as unknown as Action;

describe('日历分组：安排与到期分开', () => {
  it('日程进时间块，按开始时间排序', () => {
    const m = buildMonth('2026-11', [
      ev('e2', '2026-11-03T14:00'),
      ev('e1', '2026-11-03T09:00'),
    ], []);
    expect(m.get('2026-11-03')!.blocks.map((b) => b.start)).toEqual(['09:00', '14:00']);
    expect(m.get('2026-11-03')!.blocks.every((b) => b.kind === 'event')).toBe(true);
  });

  it('任务写了 [at::] 进时间块；只有 due 的进「仅到期」', () => {
    const m = buildMonth('2026-11', [], [
      act('a1', { due: '2026-11-04', scheduled: ['09:30', '10:30'] }),
      act('a2', { due: '2026-11-04' }),
      act('a3', { due: '2026-11-05', scheduled: ['16:00', '17:00'] }),
    ]);
    const day4 = m.get('2026-11-04')!;
    expect(day4.blocks).toHaveLength(1);
    expect(day4.blocks[0]).toMatchObject({ kind: 'task', start: '09:30', end: '10:30' });
    expect(day4.due.map((d) => d.id)).toEqual(['a2']);
    expect(m.get('2026-11-05')!.due).toHaveLength(0);
  });

  it('已完成 / 已归档 / 别的月份都不进日历', () => {
    const m = buildMonth('2026-11',
      [ev('e1', '2026-10-31T09:00'), ev('e2', '2026-11-02T09:00', { archivedAt: '2026-11-01T00:00:00+08:00' })],
      [act('a1', { due: '2026-11-02', state: 'done' }), act('a2', { due: '2026-11-02', archivedAt: '2026-11-01T00:00:00+08:00' })],
    );
    expect(m.size).toBe(0);
  });

  it('全天日程排在时间块最前，start 为空', () => {
    const m = buildMonth('2026-11', [
      ev('e1', '2026-11-06T09:00'),
      ev('e2', '2026-11-06T00:00', { allDay: true }),
    ], []);
    expect(m.get('2026-11-06')!.blocks[0]).toMatchObject({ id: 'e2', allDay: true, start: '' });
  });
});
