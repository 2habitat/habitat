/**
 * 事件流 —— 只追加，按月分文件（设计方案 §4.2）
 * 事件独立于对象：对象可以被覆盖，事件只追加。所有写路径必须产出事件。
 */
import type { JournalEvent, JournalOp, JournalPhase, Author } from '../../shared/types.ts';
import { newId, nowISO } from '../../shared/id.ts';
import type { StorageAdapter } from './storage.ts';

export interface JournalQuery {
  actor?: string; // 前缀匹配：agent: 匹配所有 agent
  op?: string;
  phase?: string;
  since?: string;
  until?: string;
  target?: string;
  limit?: number;
  offset?: number;
}

function monthFile(at: string): string {
  return `.habitat/journal/${at.slice(0, 7)}.jsonl`;
}

export class Journal {
  constructor(
    private adapter: StorageAdapter,
    private spaceId: string,
  ) {}

  async add(input: {
    actor: Author;
    op: JournalOp;
    phase: JournalPhase;
    target: string;
    summary: string;
    payload?: Record<string, unknown>;
    at?: string;
  }): Promise<JournalEvent> {
    const at = input.at ?? nowISO();
    const ev: JournalEvent = {
      id: newId('ev'),
      at,
      actor: input.actor,
      op: input.op,
      phase: input.phase,
      target: input.target,
      summary: input.summary,
      payload: input.payload,
      spaceId: this.spaceId,
    };
    await this.adapter.append(monthFile(at), JSON.stringify(ev));
    return ev;
  }

  private async files(): Promise<string[]> {
    const all = await this.adapter.list('.habitat/journal').catch(() => []);
    return all.filter((e) => e.path.endsWith('.jsonl')).map((e) => e.path).sort();
  }

  async query(q: JournalQuery = {}): Promise<JournalEvent[]> {
    const files = await this.files();
    const sinceMonth = q.since ? q.since.slice(0, 7) : null;
    const untilMonth = q.until ? q.until.slice(0, 7) : null;
    let out: JournalEvent[] = [];
    for (const f of files) {
      const m = f.slice(-11, -6); // YYYY-MM
      if (sinceMonth && m < sinceMonth) continue;
      if (untilMonth && m > untilMonth) continue;
      let raw: string;
      try {
        raw = await this.adapter.read(f);
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as JournalEvent);
        } catch {
          // 坏行跳过，不因一行坏数据丢掉整月
        }
      }
    }
    if (q.actor) out = out.filter((e) => e.actor.startsWith(q.actor!));
    if (q.op) out = out.filter((e) => e.op === q.op);
    if (q.phase) out = out.filter((e) => e.phase === q.phase);
    if (q.target) out = out.filter((e) => e.target.includes(q.target!));
    if (q.since) out = out.filter((e) => e.at >= q.since!);
    if (q.until) out = out.filter((e) => e.at <= q.until!);
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); // 最新在前
    const off = q.offset ?? 0;
    const lim = q.limit ?? 500;
    return out.slice(off, off + lim);
  }

  async count(): Promise<number> {
    return (await this.query({ limit: 100000 })).length;
  }

  /** 未署名改动认领：两条都保留，只回填 claimedBy */
  async claim(id: string, actor: string): Promise<JournalEvent | null> {
    const files = await this.files();
    for (const f of files) {
      const raw = await this.adapter.read(f);
      const lines = raw.split('\n');
      let hit = -1;
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].trim()) continue;
        try {
          const ev = JSON.parse(lines[i]) as JournalEvent;
          if (ev.id === id) {
            hit = i;
            break;
          }
        } catch {
          /* skip */
        }
      }
      if (hit < 0) continue;
      const ev = JSON.parse(lines[hit]) as JournalEvent;
      ev.claimedBy = actor;
      ev.claimedAt = nowISO();
      lines[hit] = JSON.stringify(ev);
      // 认领是对历史行的原地修正，不走条件写（事件文件本身只追加行）
      await this.adapter.write(f, lines.join('\n'), { backup: false });
      return ev;
    }
    return null;
  }

  /** 某目标最近一次某类事件 */
  async last(target: string, op?: JournalOp): Promise<JournalEvent | null> {
    const r = await this.query({ target, op, limit: 1 });
    return r[0] ?? null;
  }
}

/** 每个 JournalOp 对应界面上的中文标签 */
export const OP_LABEL: Record<JournalOp, string> = {
  capture: '采集',
  ingest: '入库',
  read: '阅读',
  annotate: '批注',
  derive: '衍生',
  edit: '编辑',
  propose: '提案',
  review: '回顾',
  settle: '沉淀',
  commit: '提交',
  build: '构建',
  import: '导入',
  revert: '撤销',
  external_edit: '未署名改动',
  reconcile: '对账',
};

export const PHASE_LABEL: Record<JournalPhase, string> = {
  intent: '意图',
  done: '完成',
  detected: '检测到',
};

export function actorLabel(a: Author | string): string {
  if (a === 'human') return '我';
  if (a === 'system') return '系统';
  if (a === 'external:unknown') return '未署名';
  if (a.startsWith('agent:')) return `AI · ${a.slice(6)}`;
  return a;
}
