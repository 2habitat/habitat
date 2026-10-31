/**
 * 对账 —— 承认「有人不走接口」。
 * 用 sha256 快照比对发现未留痕的改动，记为 external_edit；事后可认领，两条记录都保留。
 */
import type { JournalEvent } from '../../shared/types.ts';
import { nowISO } from '../../shared/id.ts';
import type { Journal } from './journal.ts';
import { STATE, type Store } from './store.ts';
import { sha256 } from './storage.ts';

interface SnapEntry {
  hash: string;
  bytes: number;
  mtime: string;
}

export interface ReconcileReport {
  at: string;
  checked: number;
  /** 第一次对账只是建基线，没有「改动」可言——别把 20 个文件报成「新增 20」 */
  baseline: boolean;
  added: string[];
  removed: string[];
  changed: { path: string; from: string; to: string }[];
  unsigned: { path: string; from: string; to: string }[];
  signed: { path: string; event: string }[];
  events: JournalEvent[];
}

export async function takeSnapshot(store: Store): Promise<Record<string, SnapEntry>> {
  const out: Record<string, SnapEntry> = {};
  const entries = await store.adapter.list();
  for (const e of entries) {
    if (e.path.startsWith('.habitat/')) continue;
    const st = await store.adapter.stat(e.path);
    out[e.path] = { hash: st?.hash ?? '', bytes: e.bytes, mtime: e.mtime };
  }
  await store.adapter.write(
    STATE.snapshot,
    JSON.stringify({ at: nowISO(), files: out }, null, 2),
    { backup: false },
  );
  return out;
}

export async function reconcile(store: Store, journal: Journal): Promise<ReconcileReport> {
  const prevRaw = await store.adapter.read(STATE.snapshot).catch(() => '');
  const baseline = !prevRaw.trim();
  let prevAt = '1970-01-01T00:00:00+00:00';
  let prev: Record<string, SnapEntry> = {};
  if (prevRaw.trim()) {
    try {
      const p = JSON.parse(prevRaw) as { at: string; files: Record<string, SnapEntry> };
      prev = p.files ?? {};
      prevAt = p.at ?? prevAt;
    } catch {
      prev = {};
    }
  }

  const now = await takeSnapshot(store);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: { path: string; from: string; to: string }[] = [];

  if (!baseline) {
    for (const [p, s] of Object.entries(now)) {
      if (!prev[p]) added.push(p);
      else if (prev[p].hash !== s.hash) changed.push({ path: p, from: prev[p].hash, to: s.hash });
    }
    for (const p of Object.keys(prev)) if (!now[p]) removed.push(p);
  }

  // 有事件留痕的算署名改动，没留痕的记未署名
  const events = await journal.query({ since: prevAt, limit: 100000 });
  const signed: { path: string; event: string }[] = [];
  const unsigned: { path: string; from: string; to: string }[] = [];
  for (const c of changed) {
    const ev = events.find((e) => e.target === c.path || e.target.endsWith(`/${c.path}`));
    if (ev) signed.push({ path: c.path, event: ev.id });
    else unsigned.push(c);
  }

  const written: JournalEvent[] = [];
  for (const u of unsigned) {
    written.push(
      await journal.add({
        actor: 'external:unknown',
        op: 'external_edit',
        phase: 'detected',
        target: u.path,
        summary: `检测到未署名改动`,
        payload: { from: u.from.slice(0, 12), to: u.to.slice(0, 12) },
      }),
    );
  }
  const checked = Object.keys(now).length;
  await journal.add({
    actor: 'system',
    op: 'reconcile',
    phase: 'done',
    target: '.habitat/state/snapshot.json',
    summary: baseline
      ? `建基线：${checked} 个文件（从下一次开始才能对账）`
      : `对账：${checked} 个文件，未署名改动 ${unsigned.length} 处`,
    payload: { checked, baseline, added: added.length, removed: removed.length, unsigned: unsigned.length },
  });

  return { at: nowISO(), checked, baseline, added, removed, changed, unsigned, signed, events: written };
}

/** 供外部 Agent 直接记账时的哈希自证 */
export async function hashOf(store: Store, rel: string): Promise<string> {
  const st = await store.adapter.stat(rel);
  if (st) return st.hash;
  return sha256('');
}
