/**
 * 日历的数据组装：把「安排」和「到期」装进同一个月视图。
 *
 * 为什么单独一个文件：这是唯一需要判断「什么算安排在日历上」的地方，
 * 组件只负责画。纯函数，前后端与单测都能直接用。
 *
 * 三条规则：
 *   1. event 一定有明确时间块 → 进 blocks
 *   2. 任务写了 [at:: 14:00-15:30] → 进 blocks（这就是「把任务排进日程」）
 *   3. 任务只有 due → 进 due，标在日期格里但不占时间轴
 *
 * 已完成 / 已归档的不进日历：日历是拿来排期的，不是流水账。
 */
import type { Action, EventRec } from './types.ts';

export interface DayBlock {
  kind: 'event' | 'task';
  id: string;
  title: string;
  /** HH:MM */
  start: string;
  /** HH:MM，可选 */
  end?: string;
  /** 没有具体时间的日程（全天） */
  allDay?: boolean;
}

export interface DayDue {
  id: string;
  title: string;
}

export interface DayItems {
  /** 占时间块的事，按开始时间排好 */
  blocks: DayBlock[];
  /** 只标了到期、还没排时段的任务 */
  due: DayDue[];
}

export function buildMonth(
  month: string,
  events: EventRec[],
  actions: Action[],
): Map<string, DayItems> {
  const map = new Map<string, DayItems>();
  const bucket = (day: string): DayItems => {
    const cur = map.get(day);
    if (cur) return cur;
    const next: DayItems = { blocks: [], due: [] };
    map.set(day, next);
    return next;
  };

  for (const e of events) {
    if (e.archivedAt) continue;
    const day = (e.start ?? '').slice(0, 10);
    if (!day.startsWith(month)) continue;
    bucket(day).blocks.push({
      kind: 'event',
      id: e.id,
      title: e.title,
      start: e.allDay ? '' : e.start.slice(11, 16),
      end: e.allDay ? undefined : e.end?.slice(11, 16),
      allDay: e.allDay,
    });
  }

  for (const a of actions) {
    if (a.archivedAt || a.state === 'done') continue;
    const day = (a.due ?? '').slice(0, 10);
    if (!day.startsWith(month)) continue;
    if (a.scheduled) {
      bucket(day).blocks.push({
        kind: 'task',
        id: a.id,
        title: a.text,
        start: a.scheduled[0],
        end: a.scheduled[1],
      });
    } else {
      bucket(day).due.push({ id: a.id, title: a.text });
    }
  }

  for (const v of map.values()) {
    // 全天日程排最前（start 为空串），其余按开始时间
    v.blocks.sort((x, y) => x.start.localeCompare(y.start));
  }
  return map;
}
