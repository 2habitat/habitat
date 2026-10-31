/**
 * 提醒：把「快到点的日程」和「逾期任务」推到邮件。
 *
 * 边界（先说清楚）：
 *   - 只在本机服务活着时跑，关机/休眠就停，不做「一定送达」的承诺；
 *   - 同一条日程只提醒一次（记在 .habitat/state/reminders.json）；
 *   - 逾期任务每天上午汇总一次，不逐条轰炸。
 */
import type { Habitat } from './space.ts';
import type { Store } from './store.ts';
import { sendMail, loadMailConfig } from './mailer.ts';
import { nowISO } from '../../shared/id.ts';

const STATE_FILE = '.habitat/state/reminders.json';

interface ReminderState {
  /** 已提醒过的日程：eventId → 发送时间 */
  events: Record<string, string>;
  /** 逾期汇总上次发送的日期 */
  overdueLastDay?: string;
}

async function readState(store: Store): Promise<ReminderState> {
  const raw = await store.adapter.read(STATE_FILE).catch(() => '');
  try {
    const s = JSON.parse(raw) as ReminderState;
    return { events: s.events ?? {}, overdueLastDay: s.overdueLastDay };
  } catch {
    return { events: {} };
  }
}

async function writeState(store: Store, s: ReminderState): Promise<void> {
  await store.adapter.write(STATE_FILE, JSON.stringify(s, null, 2), { backup: false });
}

export interface ReminderReport {
  at: string;
  enabled: boolean;
  sent: { kind: string; title: string }[];
  skipped: string[];
  error?: string;
}

/** 一轮检查。`dryRun` 只算不发，给 CLI 自检用。 */
export async function runReminders(hab: Habitat, opts: { dryRun?: boolean; windowMin?: number } = {}): Promise<ReminderReport> {
  const win = opts.windowMin ?? Number(process.env.HABITAT_REMIND_WINDOW_MIN ?? 30);
  const cfg = loadMailConfig();
  const report: ReminderReport = { at: nowISO(), enabled: !!cfg, sent: [], skipped: [] };
  if (!cfg) {
    report.skipped.push('没有配置邮件通道，跳过');
    return report;
  }

  const st = await readState(hab.store);
  const now = Date.now();
  const today = nowISO().slice(0, 10);

  // 1. 快到点的日程
  const events = hab.store.all('event') as unknown as { id: string; title: string; start: string; end?: string }[];
  for (const e of events) {
    const at = Date.parse(e.start);
    if (Number.isNaN(at)) continue;
    const diffMin = (at - now) / 60000;
    if (diffMin < 0 || diffMin > win) continue;
    if (st.events[e.id]) {
      report.skipped.push(`${e.title}（已提醒过）`);
      continue;
    }
    const when = e.start.slice(5, 16).replace('T', ' ');
    const body = [`${when} 开始`, e.end ? `到 ${e.end.slice(11, 16)}` : '', e.title].filter(Boolean).join(' · ');
    if (opts.dryRun) {
      report.sent.push({ kind: '日程', title: body });
      continue;
    }
    const r = await sendMail({
      subject: `⏰ ${diffMin <= 1 ? '马上' : `${Math.round(diffMin)} 分钟后`}：${e.title}`,
      text: `${body}\n\n— Habitat 提醒`,
      html: `<p style="font-size:16px"><b>${escapeHtml(e.title)}</b></p><p>${escapeHtml(body)}</p><p style="color:#888;font-size:12px">— Habitat 提醒</p>`,
    });
    if (r.ok) {
      st.events[e.id] = nowISO();
      report.sent.push({ kind: '日程', title: body });
    } else {
      report.error = r.error;
      report.skipped.push(`${e.title}（发送失败：${r.error}）`);
    }
  }

  // 2. 逾期任务：每天一次汇总
  const overdue = hab.today().overdue;
  if (overdue.length && st.overdueLastDay !== today) {
    const lines = overdue.map((a) => `- ${a.due} ${a.text}`).join('\n');
    if (opts.dryRun) {
      report.sent.push({ kind: '逾期汇总', title: `${overdue.length} 条` });
    } else {
      const r = await sendMail({
        subject: `📌 ${overdue.length} 条任务已逾期`,
        text: `${lines}\n\n一天只发一次；处理完就不会再出现。\n\n— Habitat`,
        html: `<p><b>${overdue.length} 条任务已逾期</b></p><ul>${overdue
          .map((a) => `<li>${escapeHtml(a.due ?? '')} ${escapeHtml(a.text)}</li>`)
          .join('')}</ul><p style="color:#888;font-size:12px">一天只发一次 — Habitat</p>`,
      });
      if (r.ok) {
        st.overdueLastDay = today;
        report.sent.push({ kind: '逾期汇总', title: `${overdue.length} 条` });
      } else {
        report.error = r.error;
      }
    }
  }

  if (!opts.dryRun && report.sent.length) await writeState(hab.store, st);
  return report;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
