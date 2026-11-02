/**
 * 文件浏览与受管操作。
 *
 * 为什么不是"资源管理器"：这套系统的三条铁律是「文件是事实源 / 写入必经变更集 /
 * 不删除只归档」。一个能随便删改的浏览器会直接推翻它们——删掉一个 .md，
 * 它引用的和被引用的链接就全断了，而且没有事件可查。
 *
 * 所以这里的能力边界是刻意画出来的：
 *   可以：浏览、预览、上传、新建目录、重命名/移动、归档（不是删除）
 *   不可以：直接删除、改已入库文件的内容（那要走编辑器 / 变更集）
 *
 * 重命名尤其危险：文件名是地址，wikilink 按文件名解析。所以改名接口会先算
 * 「有多少条引用会断」，让人看见代价再决定。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Habitat } from './space.ts';
import type { Author } from '../../shared/types.ts';
import { safeJoin } from './storage.ts';

/** 这些目录不进浏览视图：它们是运行时状态或版本库，改了会出事 */
const HIDDEN = new Set(['.git', '.habitat', 'node_modules', '.e2e-space', '.shots']);

const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv', 'ts', 'js', 'css', 'html', 'xml', 'log']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const ARCHIVE_DIR = 'archive/fs';

export type FileKind = 'markdown' | 'text' | 'image' | 'pdf' | 'dir' | 'other';

export interface FileEntry {
  name: string;
  path: string;
  kind: FileKind;
  bytes: number;
  mtime: string;
  /** 是否已被索引（有对应的对象） */
  indexed: boolean;
  /** 索引里的类型，比如 note / part / rep */
  objectType?: string;
  objectId?: string;
  /** 原件只读 */
  locked?: boolean;
  /** 被多少条链接引用（改名前必须让人看见） */
  inbound?: number;
}

export interface DirListing {
  path: string;
  crumbs: { name: string; path: string }[];
  dirs: FileEntry[];
  files: FileEntry[];
  totals: { files: number; dirs: number; bytes: number; unindexed: number };
  hiddenSkipped: number;
}

function kindOf(name: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

/** 路径 → 对象：fileOf 是 id→path，这里翻过来 */
function indexOf(hab: Habitat): Map<string, { id: string; type: string; locked?: boolean }> {
  const m = new Map<string, { id: string; type: string; locked?: boolean }>();
  const store = hab.store as unknown as { fileOf: Map<string, string> };
  for (const [id, rel] of store.fileOf) {
    const o = hab.store.get(id) as unknown as { type?: string; locked?: boolean } | undefined;
    m.set(rel, { id, type: String(o?.type ?? ''), locked: o?.locked });
  }
  return m;
}

function inboundOf(hab: Habitat, id: string): number {
  const links = (hab.store as unknown as { links: { resolved: string | null }[] }).links;
  return links.filter((l) => l.resolved === id).length;
}

export async function listDir(hab: Habitat, rel = '', opts: { showHidden?: boolean } = {}): Promise<DirListing> {
  const abs = safeJoin(hab.store.root, rel);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const idx = indexOf(hab);

  const dirs: FileEntry[] = [];
  const files: FileEntry[] = [];
  let hiddenSkipped = 0;

  // 先并发 stat：几百个文件时串行 stat 会成为主要开销（实测 500 个文件 14ms）
  const stats = await Promise.all(
    entries.map((e) => fsp.stat(path.join(abs, e.name)).catch(() => null)),
  );

  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (!opts.showHidden && HIDDEN.has(e.name)) {
      // .habitat 是运行时状态，.git 是版本库：默认藏起来，但告诉用户藏了几个
      hiddenSkipped += 1;
      continue;
    }
    const st = stats[i];
    if (!st) continue;
    const hit = idx.get(childRel);
    if (e.isDirectory()) {
      dirs.push({
        name: e.name,
        path: childRel,
        kind: 'dir',
        bytes: 0,
        mtime: st.mtime.toISOString(),
        indexed: false,
      });
      continue;
    }
    files.push({
      name: e.name,
      path: childRel,
      kind: kindOf(e.name),
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      indexed: !!hit,
      objectType: hit?.type,
      objectId: hit?.id,
      locked: hit?.locked,
      inbound: hit ? inboundOf(hab, hit.id) : 0,
    });
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const crumbs = [{ name: '根', path: '' }];
  if (rel) {
    let acc = '';
    for (const seg of rel.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      crumbs.push({ name: seg, path: acc });
    }
  }

  return {
    path: rel,
    crumbs,
    dirs,
    files,
    totals: {
      files: files.length,
      dirs: dirs.length,
      bytes: files.reduce((a, f) => a + f.bytes, 0),
      unindexed: files.filter((f) => !f.indexed).length,
    },
    hiddenSkipped,
  };
}

export interface Preview {
  path: string;
  kind: FileKind;
  bytes: number;
  /** 文本类才给 */
  text?: string;
  truncated?: boolean;
  /** 图片 / PDF 给访问地址 */
  url?: string;
  objectId?: string;
}

const PREVIEW_LIMIT = 200 * 1024;

export async function preview(hab: Habitat, rel: string): Promise<Preview> {
  const abs = safeJoin(hab.store.root, rel);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new Error('不是一个文件');
  const kind = kindOf(rel);
  const idx = indexOf(hab);
  const hit = idx.get(rel);

  if (kind === 'image' || kind === 'pdf') {
    return {
      path: rel,
      kind,
      bytes: st.size,
      url: `/api/assets?path=${encodeURIComponent(rel)}`,
      objectId: hit?.id,
    };
  }
  if (kind === 'markdown' || kind === 'text') {
    const raw = await fsp.readFile(abs);
    const slice = raw.subarray(0, PREVIEW_LIMIT);
    return {
      path: rel,
      kind,
      bytes: st.size,
      text: slice.toString('utf8'),
      truncated: raw.byteLength > PREVIEW_LIMIT,
      objectId: hit?.id,
    };
  }
  return { path: rel, kind, bytes: st.size, objectId: hit?.id };
}

/* ---------------- 写操作 ---------------- */

export interface MoveResult {
  ok: boolean;
  from: string;
  to: string;
  /** 改名会导致多少条链接解析不到 */
  brokenLinks: number;
  /** 需要 force 才能继续的原因 */
  needConfirm?: string;
}

/**
 * 重命名 / 移动。
 *
 * 已入库的文件改名 = 断链：文件名是地址，wikilink 按名字解析。
 * 所以这里不阻拦，但把代价算出来；调用方必须显式 force 才真正执行。
 */
export async function moveFile(
  hab: Habitat,
  from: string,
  to: string,
  opts: { force?: boolean; actor?: Author } = {},
): Promise<MoveResult> {
  if (!from || !to) throw new Error('缺少源或目标路径');
  if (from === to) throw new Error('源和目标是同一个');

  const fromAbs = safeJoin(hab.store.root, from);
  const toAbs = safeJoin(hab.store.root, to);

  const st = await fsp.stat(fromAbs).catch(() => null);
  if (!st) throw new Error(`源不存在：${from}`);
  const exists = await fsp.stat(toAbs).catch(() => null);
  if (exists) throw new Error(`目标已存在：${to}`);

  const hit = indexOf(hab).get(from);
  const broken = hit ? inboundOf(hab, hit.id) : 0;

  if (hit && broken > 0 && !opts.force) {
    return {
      ok: false,
      from,
      to,
      brokenLinks: broken,
      needConfirm: `「${from}」已被索引，且有 ${broken} 条链接指向它。改名后这些链接会解析不到（文件还在，不会丢内容）。确认要继续吗？`,
    };
  }

  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  await fsp.rename(fromAbs, toAbs);

  await hab.journal.add({
    actor: opts.actor ?? 'human',
    op: 'edit',
    phase: 'done',
    target: to,
    summary: `移动：${from} → ${to}${broken ? `（${broken} 条链接待修复）` : ''}`,
    payload: { from, to, brokenLinks: broken },
  });
  await hab.rescan();

  return { ok: true, from, to, brokenLinks: broken };
}

export async function makeDir(hab: Habitat, rel: string, actor: Author = 'human'): Promise<{ ok: true; path: string }> {
  if (!rel || rel === '/') throw new Error('目录名不能为空');
  const abs = safeJoin(hab.store.root, rel);
  const exists = await fsp.stat(abs).catch(() => null);
  if (exists) throw new Error(`已存在：${rel}`);
  await fsp.mkdir(abs, { recursive: true });
  await hab.journal.add({
    actor,
    op: 'import',
    phase: 'done',
    target: rel,
    summary: `新建目录：${rel}`,
  });
  return { ok: true, path: rel };
}

/**
 * 归档：移到 archive/fs/<日期>/<原路径>。
 *
 * 这是"删除"的替代品——铁律是不删除只归档。文件还在盘上，路径可追溯，
 * 而且有事件记录。真要物理删除，请自己在文件管理器里做（我们不提供这个按钮）。
 */
export async function archiveFiles(
  hab: Habitat,
  paths: string[],
  actor: Author = 'human',
): Promise<{ moved: { from: string; to: string }[] }> {
  if (!paths.length) throw new Error('没有要归档的文件');
  const day = new Date().toISOString().slice(0, 10);
  const moved: { from: string; to: string }[] = [];

  for (const rel of paths) {
    if (rel.startsWith(`${ARCHIVE_DIR}/`)) throw new Error(`已经在归档目录里：${rel}`);
    const fromAbs = safeJoin(hab.store.root, rel);
    const st = await fsp.stat(fromAbs).catch(() => null);
    if (!st) continue;
    const to = `${ARCHIVE_DIR}/${day}/${rel}`;
    const toAbs = safeJoin(hab.store.root, to);
    await fsp.mkdir(path.dirname(toAbs), { recursive: true });
    await fsp.rename(fromAbs, toAbs);
    moved.push({ from: rel, to });
  }

  if (moved.length) {
    await hab.journal.add({
      actor,
      op: 'edit',
      phase: 'done',
      target: ARCHIVE_DIR,
      summary: `归档 ${moved.length} 个文件`,
      payload: { moved },
    });
    await hab.rescan();
  }
  return { moved };
}
