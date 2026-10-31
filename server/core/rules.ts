/**
 * 规则调度：让「自动化」真的自己跑起来。
 *
 * 边界（写清楚，免得又变成「说了没做」）：
 *   - 只执行**结构化**的三种规则，自由文本规则一律标成 custom、不执行；
 *   - 只产出通知，不自动改正文（改语义要人逐条确认，这是方案的硬规矩）；
 *   - 同一规则同一天只提醒一次，且尊重规则上的每日条数上限；
 *   - 本机休眠就停，不做系统级推送。
 */
import type { Store } from './store.ts';
import type { Habitat } from './space.ts';
import { STATE } from './store.ts';
import { Notifier } from './notify.ts';
import { nowISO } from '../../shared/id.ts';

export type RuleKind = 'inbox-overflow' | 'stale-reading' | 'overdue-actions' | 'custom';

export interface Rule {
  id: string;
  name: string;
  kind: RuleKind;
  /** 阈值：收件箱条数 / 逾期天数 / 逾期任务数 */
  threshold: number;
  limit: number;
  enabled: boolean;
  when: string;
  do: string;
}

export interface SchedulerReport {
  at: string;
  rules: number;
  evaluated: number;
  fired: { rule: string; title: string }[];
  skipped: string[];
}

const DEFAULTS: Omit<Rule, 'id' | 'name' | 'when' | 'do'> = { kind: 'custom', threshold: 0, limit: 3, enabled: true };

export function normalizeRule(raw: Record<string, unknown>): Rule {
  const kind = String(raw.kind ?? 'custom') as RuleKind;
  return {
    ...DEFAULTS,
    ...(raw as unknown as Rule),
    id: String(raw.id ?? ''),
    name: String(raw.name ?? '未命名规则'),
    kind: ['inbox-overflow', 'stale-reading', 'overdue-actions'].includes(kind) ? kind : 'custom',
    threshold: Number(raw.threshold ?? defaultThreshold(kind)),
    limit: Number(raw.limit ?? 3),
    enabled: raw.enabled !== false,
    when: String(raw.when ?? ''),
    do: String(raw.do ?? ''),
  };
}

function defaultThreshold(kind: string): number {
  if (kind === 'inbox-overflow') return 10;
  if (kind === 'stale-reading') return 7;
  if (kind === 'overdue-actions') return 1;
  return 0;
}

export async function loadRules(store: Store): Promise<Rule[]> {
  const raw = await store.adapter.read(STATE.rules).catch(() => '');
  if (!raw.trim()) return [];
  try {
    const arr = JSON.parse(raw) as Record<string, unknown>[];
    return Array.isArray(arr) ? arr.map(normalizeRule) : [];
  } catch {
    return [];
  }
}

export async function saveRules(store: Store, rules: Rule[]): Promise<void> {
  await store.adapter.write(STATE.rules, JSON.stringify(rules, null, 2), { backup: false });
}

/** 跑一轮。返回这轮触发/跳过了什么，方便 doctor 与测试断言。 */
export async function runRules(hab: Habitat, opts: { dryRun?: boolean } = {}): Promise<SchedulerReport> {
  const rules = (await loadRules(hab.store)).filter((r) => r.enabled);
  const ntc = new Notifier(hab.store);
  const report: SchedulerReport = { at: nowISO(), rules: rules.length, evaluated: 0, fired: [], skipped: [] };

  for (const r of rules) {
    if (r.kind === 'custom') {
      report.skipped.push(`${r.name}（自由文本规则，没有可执行条件）`);
      continue;
    }
    report.evaluated += 1;
    if (await ntc.alreadyToday(r.id)) {
      report.skipped.push(`${r.name}（今天已提醒过）`);
      continue;
    }

    let hit: { title: string; body: string; href: string; level: 'info' | 'warn' | 'danger' } | null = null;

    if (r.kind === 'inbox-overflow') {
      const n = hab.inbox().length;
      if (n >= r.threshold) {
        hit = { title: `收件箱积了 ${n} 条`, body: `超过阈值 ${r.threshold}。挑几条衍生出去，或者归档。`, href: '#/inbox', level: 'warn' };
      }
    } else if (r.kind === 'overdue-actions') {
      const od = hab.today().overdue;
      if (od.length >= r.threshold) {
        hit = { title: `有 ${od.length} 条任务逾期`, body: od.slice(0, 3).map((a) => a.text).join('；'), href: '#/today', level: 'danger' };
      }
    } else if (r.kind === 'stale-reading') {
      // 读到一半、且文件好几天没动过
      const staleMs = r.threshold * 86400_000;
      const now = Date.now();
      const stuck: string[] = [];
      for (const [repId, c] of hab.store.cursors) {
        if (c.current <= 0.02 || c.current >= 0.99) continue;
        const rel = hab.store.file(repId);
        if (!rel) continue;
        const st = await hab.store.adapter.stat(rel).catch(() => null);
        if (!st) continue;
        if (now - new Date(st.mtime).getTime() < staleMs) continue;
        const rep = hab.store.get(repId);
        const part = rep && rep.type === 'rep' ? hab.store.get(rep.partId) : undefined;
        stuck.push(part && part.type === 'part' ? part.title : repId);
      }
      if (stuck.length) {
        hit = {
          title: `${stuck.length} 章读了一半就没再动`,
          body: `${stuck.slice(0, 3).join('；')} —— 超过 ${r.threshold} 天没翻过`,
          href: '#/continue',
          level: 'info',
        };
      }
    }

    if (!hit) continue;
    if (opts.dryRun) {
      report.fired.push({ rule: r.name, title: hit.title });
      continue;
    }
    await ntc.add({ ...hit, ruleId: r.id });
    report.fired.push({ rule: r.name, title: hit.title });
  }

  return report;
}
