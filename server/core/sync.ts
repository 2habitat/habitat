/**
 * 增量同步：把旧布局里「新空间还没有」的文件补进来。
 *
 * 只做三件事，且只做加法：
 *   add      旧有新无 → 复制过去（md 复制后补一条 import 事件，账面才干净）
 *   same     两边哈希一致 → 跳过
 *   differ   两边都有但内容不同 → **只报告，不覆盖**（谁改的、哪份为准，得人来定）
 *
 * 不做删除、不做改名。新空间独有的文件一律忽略——那是新布局自己长出来的东西。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './storage.ts';
import type { Journal } from './journal.ts';

export interface SyncItem {
  from: string;
  to: string;
  status: 'add' | 'same' | 'differ';
  bytes: number;
}

export interface SyncReport {
  from: string;
  to: string;
  scanned: number;
  skipped: number;
  add: SyncItem[];
  differ: SyncItem[];
  same: number;
  applied: number;
  errors: { path: string; error: string }[];
}

/** 旧布局 → 新布局。顺序有意义：更具体的规则要排在前面 */
const MAP: [string, string][] = [
  ['35-planning/tasks.md', 'work/actions/tasks.md'],
  ['35-planning/calendar/', 'work/events/'],
  ['35-planning/', 'work/'],
  ['00-inbox/', 'inbox/'],
  ['10-notes/', 'knowledge/notes/'],
  ['15-reports/', 'knowledge/reports/'],
  ['20-sources/', 'knowledge/sources/'],
  ['30-projects/', 'work/projects/'],
  ['40-areas/', 'work/areas/'],
  ['50-archive/', 'archive/'],
  ['90-assets/', 'assets/attachments/'],
];

/** 生成物与同步噪音：不参与同步 */
const SKIP_PREFIX = ['.kb/', '.habitat/', '.git/', '.claude/', '.cursor/', '.workbuddy/', 'MySpace/', 'legacy-v1/'];
const SKIP_FILE = [
  /^(INDEX|PLAN)\.md$/i,
  /_INDEX\.md$/i,
  /-副本\./,
  /-冲突-/,
  /\.wpsonline$/i,
  /^~\$/,
  /\.tmp$/i,
  /\.bak$/i,
  /\.DS_Store$/i,
];

export function mapPath(rel: string): string | null {
  for (const p of SKIP_PREFIX) if (rel.startsWith(p)) return null;
  const name = path.basename(rel);
  for (const re of SKIP_FILE) if (re.test(name)) return null;
  for (const [a, b] of MAP) {
    if (rel === a) return b.endsWith('/') ? b + path.basename(rel) : b;
    if (rel.startsWith(a)) return b + rel.slice(a.length);
  }
  // 根目录下的散装 md（README 之类）不搬：新空间的根只放 space.yaml / AGENTS.md / README.md
  return null;
}

const TEXT_EXT = /\.(md|markdown|txt|json|jsonl|ya?ml|csv|tsv|html?|css|js|ts)$/i;

/**
 * 比内容时要按行尾归一。
 * 迁移把 CRLF 统一成了 LF，如果按原字节比，43 个「只是换行符不同」的文件会被报成冲突，
 * 报几次假警之后人就再也不看这个清单了。
 */
function hashFile(p: string): string {
  const buf = fs.readFileSync(p);
  if (!TEXT_EXT.test(p)) return sha256(buf);
  return sha256(buf.toString('utf8').replace(/\r\n/g, '\n'));
}

async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  const dir = path.join(root, rel);
  let items: fs.Dirent[];
  try {
    items = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const r = rel ? `${rel}/${it.name}` : it.name;
    if (it.isDirectory()) out.push(...(await walk(root, r)));
    else if (it.isFile()) out.push(r);
  }
  return out;
}

/** 迁移脚本产出的 plan.json 里有精确映射；前缀表只是没有计划时的兜底 */
export type ExactMap = Record<string, string>;

export function loadExactMap(file: string): ExactMap {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { map?: Record<string, { to?: string } | string> };
  const out: ExactMap = {};
  for (const [k, v] of Object.entries(raw.map ?? {})) {
    const to = typeof v === 'string' ? v : v?.to;
    if (to) out[k] = to;
  }
  return out;
}

export async function planSync(fromRoot: string, toRoot: string, exact?: ExactMap): Promise<SyncItem[]> {
  const items: SyncItem[] = [];
  for (const rel of await walk(fromRoot)) {
    // 精确映射优先：20-sources 里的章节到底属于「来源」还是「作品某个章节」，
    // 只有迁移时的那份映射说得清，前缀猜会造出重复副本。
    const to = exact?.[rel] ?? mapPath(rel);
    if (!to) continue;
    const src = path.join(fromRoot, rel);
    const dst = path.join(toRoot, to);
    let bytes = 0;
    try {
      bytes = (await fsp.stat(src)).size;
    } catch {
      continue;
    }
    if (!fs.existsSync(dst)) {
      items.push({ from: rel, to, status: 'add', bytes });
      continue;
    }
    const [a, b] = [hashFile(src), hashFile(dst)];
    items.push({ from: rel, to, status: a === b ? 'same' : 'differ', bytes });
  }
  return items;
}

export async function runSync(
  fromRoot: string,
  toRoot: string,
  journal: Journal,
  apply: boolean,
  exact?: ExactMap,
): Promise<SyncReport> {
  const all = await planSync(fromRoot, toRoot, exact);
  const report: SyncReport = {
    from: fromRoot,
    to: toRoot,
    scanned: all.length,
    skipped: 0,
    add: all.filter((i) => i.status === 'add'),
    differ: all.filter((i) => i.status === 'differ'),
    same: all.filter((i) => i.status === 'same').length,
    applied: 0,
    errors: [],
  };

  if (!apply) return report;

  for (const item of report.add) {
    try {
      const src = path.join(fromRoot, item.from);
      const dst = path.join(toRoot, item.to);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      if (TEXT_EXT.test(src)) {
        // 统一 LF：这套库的约定是 UTF-8 + LF，别把 CRLF 再带回来
        const text = (await fsp.readFile(src)).toString('utf8').replace(/\r\n/g, '\n');
        await fsp.writeFile(dst, text, 'utf8');
      } else {
        await fsp.copyFile(src, dst);
      }
      report.applied += 1;
      // 直接复制绕过了变更接口，所以要补账；否则对账会把它们记成未署名改动
      await journal.add({
        actor: 'system',
        op: 'import',
        phase: 'done',
        target: item.to,
        summary: `从旧布局同步：${item.from}`,
        payload: { from: fromRoot, source: item.from },
      });
    } catch (e) {
      report.errors.push({ path: item.from, error: (e as Error).message });
    }
  }
  return report;
}
