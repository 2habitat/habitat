/**
 * 使用记录：谁在什么时候碰过它。
 *
 * 为什么单独存一份，不写 journal：
 * 打开一次阅读器就写一条事件，一天能写几百条，事件流会被噪音淹掉，
 * 真正重要的「谁改了什么」反而看不见。所以使用信号走轻量计数，
 * 只保留「最近一次 + 各通道次数」，定期落盘，有上限。
 *
 * 记录哪些通道（这就是「使用」的可观测定义）：
 *   open   平台打开（阅读器 / 编辑器）
 *   read   读到多少（阅读进度事件）
 *   search 检索命中（被找到过一次）
 *   edit   处置操作（提交过变更）
 *   ai     AI 读取（CLI / MCP 取正文）
 */
import type { Store } from './store.ts';

const FILE = '.habitat/state/usage.json';
const MAX_ENTRIES = 5000;

export interface UsageRec {
  /** 最近一次被碰到的时间 */
  last: string;
  open: number;
  read: number;
  search: number;
  edit: number;
  ai: number;
}

export type UsageChannel = 'open' | 'read' | 'search' | 'edit' | 'ai';

let cache: Record<string, UsageRec> | null = null;
let dirty = false;
let timer: NodeJS.Timeout | null = null;
/** 记住上次读过统计的那个 store：落盘时不用再重新打开整个空间 */
let lastStore: Store | null = null;

async function load(store: Store): Promise<Record<string, UsageRec>> {
  lastStore = store;
  if (cache) return cache;
  const raw = await store.adapter.read(FILE).catch(() => '');
  try {
    cache = (JSON.parse(raw) as Record<string, UsageRec>) ?? {};
  } catch {
    cache = {};
  }
  return cache;
}

/** 待并入的计数：同步入队，避免「进程退出时还没轮到 then」把使用记录丢了 */
let pendingHits: { ids: string[]; channel: UsageChannel; at: string }[] = [];

/** 记一次使用。同步入队、不 await、不阻塞请求——统计不该拖慢干活。 */
export function touch(store: Store, ids: string | string[], channel: UsageChannel): void {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return;
  lastStore = store;
  pendingHits.push({ ids: list, channel, at: new Date().toISOString() });
  dirty = true;
  schedule(store);
}

function applyPending(m: Record<string, UsageRec>): void {
  for (const hit of pendingHits) {
    for (const id of hit.ids) {
      const cur = m[id] ?? { last: hit.at, open: 0, read: 0, search: 0, edit: 0, ai: 0 };
      cur[hit.channel] += 1;
      cur.last = hit.at;
      m[id] = cur;
    }
  }
  pendingHits = [];
}

function schedule(store: Store): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush(store);
  }, 30_000);
  timer.unref?.();
}

export async function flush(store?: Store): Promise<void> {
  const s = store ?? lastStore;
  if (!s || !dirty) return;
  const m = await load(s);
  applyPending(m);
  dirty = false;
  const entries = Object.entries(m);
  // 超上限时丢最久没碰的：使用统计不是审计，不需要全量保留
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => a[1].last.localeCompare(b[1].last));
    const keep = entries.slice(entries.length - MAX_ENTRIES);
    cache = Object.fromEntries(keep);
    Object.assign(m, cache);
  }
  await s.adapter.write(FILE, JSON.stringify(m, null, 0), { backup: false }).catch(() => undefined);
}

/** 清掉进程内缓存：测试里换了空间、或外部改了 usage.json 时需要 */
export function resetUsageCache(): void {
  cache = null;
  dirty = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export async function usageOf(store: Store): Promise<Record<string, UsageRec>> {
  const m = await load(store);
  applyPending(m);
  return { ...m };
}

export function daysSince(iso?: string): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return Math.floor((Date.now() - t) / 86400_000);
}
