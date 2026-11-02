/**
 * 行内语法：任务池 work/actions/tasks.md 与日程 work/events/*.md
 * 与现库 35-planning/tasks.md 的格式兼容：
 *   - [ ] 读《…》 [due:: 2026-11-02] [pri:: med] ^t-20261029-07
 * 新增的字段沿用同样的 [key:: value] 写法，未知 key 原样保留。
 */
import type { Action, EventRec } from '../../shared/types.ts';
import { parseScheduled } from '../../shared/time.ts';

export { parseScheduled };

export interface InlineBlock {
  kind: 'heading' | 'text' | 'task' | 'event';
  raw: string;
  level?: number;
  heading?: string;
  date?: string;
  id?: string;
  text?: string;
  done?: boolean;
  fields: Record<string, string>;
}

const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const EVENT_RE = /^(\s*)[-*+]\s+(?:(\d{1,2}:\d{2})\s*[–\-~—]\s*(\d{1,2}:\d{2})\s+)?(.*)$/;
const HEAD_RE = /^(#{1,6})\s+(.*)$/;
const DATE_HEAD_RE = /^###\s+(\d{4}-\d{2}-\d{2})\s*$/;
const FIELD_RE = /\[([a-zA-Z_][\w-]*)\s*::\s*([^\]]*)\]/g;
const ID_RE = /\^([A-Za-z0-9_-]+)\s*$/;

function takeFields(s: string): { text: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const text = s.replace(FIELD_RE, (_m, k: string, v: string) => {
    fields[k.trim()] = v.trim();
    return '';
  });
  return { text: text.replace(/\s{2,}/g, ' ').trim(), fields };
}

function takeId(s: string): { text: string; id?: string } {
  const m = ID_RE.exec(s);
  if (!m) return { text: s.trim() };
  return { text: s.slice(0, m.index).trim(), id: m[1] };
}

/* ---------------- 任务 ---------------- */

export function parseTasks(md: string): InlineBlock[] {
  return md.split('\n').map((raw) => {
    const h = HEAD_RE.exec(raw);
    if (h) return { kind: 'heading' as const, raw, level: h[1].length, heading: h[2].trim(), fields: {} };
    const t = TASK_RE.exec(raw);
    if (!t) return { kind: 'text' as const, raw, fields: {} };
    const inner = takeId(t[3]);
    const f = takeFields(inner.text);
    return {
      kind: 'task' as const,
      raw,
      done: t[2].toLowerCase() === 'x',
      text: f.text,
      id: inner.id,
      fields: f.fields,
    };
  });
}

export function blockToAction(b: InlineBlock, defaults: Omit<Action, 'text' | 'state' | 'flow' | 'id'>): Action {
  const f = b.fields ?? {};
  return {
    ...defaults,
    id: b.id ?? '',
    text: b.text ?? '',
    state: b.done ? 'done' : (f.state as Action['state']) ?? 'open',
    flow: (f.flow as Action['flow']) ?? (f.due ? 'next' : 'later'),
    due: f.due,
    // 可选时间块：老任务没有这一项，读出来是 undefined，不显示块
    scheduled: parseScheduled(f.at),
    projectId: f.project,
    // 归档标记必须能被读回来，否则「归档」重启后就失效了
    archivedAt: f.archived,
  };
}

function putFields(fields: Record<string, string>): string {
  return Object.entries(fields)
    .filter(([k, v]) => v !== '' && v !== undefined)
    .map(([k, v]) => `[${k}:: ${v}]`)
    .join(' ');
}

export function renderTask(a: Action, extra: Record<string, string> = {}): string {
  const fields: Record<string, string> = { ...extra };
  if (a.due) fields.due = a.due;
  if (a.scheduled) fields.at = `${a.scheduled[0]}-${a.scheduled[1]}`;
  if (a.projectId) fields.project = a.projectId;
  if (a.flow && a.flow !== 'next') fields.flow = a.flow;
  if (a.state !== 'open' && a.state !== 'done') fields.state = a.state;
  if (a.archivedAt) fields.archived = a.archivedAt;
  const f = putFields(fields);
  const id = a.id.startsWith('^') ? a.id : `^${a.id}`;
  return `- [${a.state === 'done' ? 'x' : ' '}] ${a.text}${f ? ` ${f}` : ''} ${id}`.trimEnd();
}

export function renderTasks(blocks: InlineBlock[], actions: Map<string, Action>): string {
  return blocks
    .map((b) => {
      if (b.kind !== 'task') return b.raw;
      const a = b.id ? actions.get(b.id) : undefined;
      return a ? renderTask(a, b.fields) : b.raw;
    })
    .join('\n');
}

/** 在第一个「待办」小节末尾追加一条任务 */
export function appendTask(md: string, line: string): string {
  const lines = md.split('\n');
  let idx = lines.findIndex((l) => /^#{1,6}\s+待办/.test(l));
  if (idx < 0) idx = lines.findIndex((l) => TASK_RE.test(l)) - 1;
  if (idx < 0) {
    // 没有待办小节就建一个
    return `${md.replace(/\n+$/, '')}\n\n## 待办\n\n${line}\n`;
  }
  let end = idx + 1;
  while (end < lines.length && !/^#{1,6}\s+/.test(lines[end])) end += 1;
  while (end > idx + 1 && lines[end - 1].trim() === '') end -= 1;
  lines.splice(end, 0, line);
  return lines.join('\n');
}

/* ---------------- 日程 ---------------- */

/** 兜底：早期版本把完整 ISO 时间写进了行里（09:00 写成了 2026-10-01T09:00），老文件还得能读 */
const ISO_TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{1,2}:\d{2})\s*[–\-~—]\s*(?:(\d{4}-\d{2}-\d{2})T)?(\d{1,2}:\d{2})\s+(.*)$/;

export function parseEvents(md: string): InlineBlock[] {
  let date = '';
  return md.split('\n').map((raw) => {
    const dh = DATE_HEAD_RE.exec(raw);
    if (dh) {
      date = dh[1];
      return { kind: 'heading' as const, raw, level: 3, heading: raw.replace(/^###\s+/, ''), date, fields: {} };
    }
    const h = HEAD_RE.exec(raw);
    if (h) return { kind: 'heading' as const, raw, level: h[1].length, heading: h[2].trim(), date, fields: {} };
    if (!/^\s*[-*+]\s+/.test(raw)) return { kind: 'text' as const, raw, date, fields: {} };
    const e = EVENT_RE.exec(raw);
    if (!e) return { kind: 'text' as const, raw, date, fields: {} };

    let rest = e[4] ?? '';
    let start = e[2] ?? '';
    let end = e[3] ?? '';
    let lineDate = date;

    if (!start) {
      const iso = ISO_TIME_RE.exec(rest);
      if (iso) {
        lineDate = iso[1];
        start = iso[2];
        end = iso[4];
        rest = iso[5] ?? '';
      }
    }

    const inner = takeId(rest);
    const f = takeFields(inner.text);
    return {
      kind: 'event' as const,
      raw,
      date: lineDate,
      text: f.text,
      id: inner.id,
      fields: { ...f.fields, start, end },
    };
  });
}

export function renderEvent(ev: EventRec, extra: Record<string, string> = {}): string {
  const fields: Record<string, string> = { ...extra };
  if (ev.projectId) fields.project = ev.projectId;
  if (ev.archivedAt) fields.archived = ev.archivedAt;
  const f = putFields(fields);
  const id = ev.id.startsWith('^') ? ev.id : `^${ev.id}`;
  // 行里只写 HH:MM，日期由 ### YYYY-MM-DD 小标题给——和 EVENT_RE 必须对齐，
  // 否则回读时时间会被当成正文的一部分，日期直接丢掉。
  const time = ev.allDay ? '' : `${hhmm(ev.start)}–${hhmm(ev.end)} `;
  return `- ${time}${ev.title}${f ? ` ${f}` : ''} ${id}`.trimEnd();
}

function hhmm(iso: string): string {
  const m = /T(\d{1,2}:\d{2})/.exec(iso ?? '');
  return m ? m[1] : (iso ?? '').slice(11, 16) || '00:00';
}

export function renderEvents(blocks: InlineBlock[], events: Map<string, EventRec>): string {
  const out: string[] = [];
  let lastDate = '';
  for (const b of blocks) {
    if (b.kind === 'heading') {
      if (b.date) lastDate = b.date;
      out.push(b.raw);
      continue;
    }
    if (b.kind !== 'event') {
      out.push(b.raw);
      continue;
    }
    const e = b.id ? events.get(b.id) : undefined;
    if (!e) {
      out.push(b.raw);
      continue;
    }
    // 每条日程都必须挂在日期小标题下面，新加的也不例外
    const date = b.date || e.start.slice(0, 10);
    if (date && date !== lastDate) {
      if (out.length && out[out.length - 1].trim() !== '') out.push('');
      out.push(`### ${date}`);
      lastDate = date;
    }
    out.push(renderEvent(e, { ...b.fields }));
  }
  return out.join('\n');
}
