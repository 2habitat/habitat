/**
 * 作品内的 JSON 数据文件：列表 / 读 / 写。
 *
 * 只允许 knowledge/works/<slug>/data/ 下的 .json；写走原子替换，写完重新扫描，
 * 这样 JSON 编辑器和构建脚本看到的是同一份文件。
 */
import fsp from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { Author } from '../../shared/types.ts';
import type { Habitat } from './space.ts';

export interface WorkDataFile {
  path: string;
  name: string;
  bytes: number;
  updatedAt: string;
}

export interface WorkDataPayload {
  path: string;
  text: string;
  json: unknown;
  bytes: number;
  updatedAt: string;
}

const MAX_BYTES = 4 * 1024 * 1024;

function workDir(hab: Habitat, workId: string): string {
  const wv = hab.workView(workId);
  if (!wv) throw new Error(`作品不存在：${workId}`);
  if (!wv.work.path) throw new Error('作品缺少路径');
  return path.dirname(path.join(hab.store.root, wv.work.path));
}

function resolveData(workRoot: string, rel: string): string {
  const clean = String(rel ?? '').replace(/\\/g, '/');
  if (!clean.startsWith('data/') || !clean.toLowerCase().endsWith('.json')) {
    throw new Error('只允许 data/ 下的 .json');
  }
  const abs = path.resolve(workRoot, clean);
  const r = path.relative(workRoot, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('路径越出作品目录');
  return abs;
}

async function walk(dir: string, workRoot: string, out: WorkDataFile[], depth: number): Promise<void> {
  if (depth > 3 || out.length > 300) return;
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(abs, workRoot, out, depth + 1);
      continue;
    }
    if (!e.name.toLowerCase().endsWith('.json')) continue;
    try {
      const st = await fsp.stat(abs);
      out.push({
        path: path.relative(workRoot, abs).replace(/\\/g, '/'),
        name: e.name,
        bytes: st.size,
        updatedAt: st.mtime.toISOString(),
      });
    } catch {
      /* 文件刚好被删，跳过 */
    }
  }
}

export async function listWorkData(hab: Habitat, workId: string): Promise<WorkDataFile[]> {
  const root = workDir(hab, workId);
  const out: WorkDataFile[] = [];
  await walk(path.join(root, 'data'), root, out, 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readWorkData(hab: Habitat, workId: string, rel: string): Promise<WorkDataPayload> {
  const root = workDir(hab, workId);
  const abs = resolveData(root, rel);
  const st = await fsp.stat(abs);
  if (st.size > MAX_BYTES) throw new Error(`文件超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB`);
  const text = await fsp.readFile(abs, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 解析失败：${(e as Error).message}`);
  }
  return {
    path: path.relative(root, abs).replace(/\\/g, '/'),
    text,
    json,
    bytes: st.size,
    updatedAt: st.mtime.toISOString(),
  };
}

export async function writeWorkData(
  hab: Habitat,
  workId: string,
  rel: string,
  json: unknown,
  actor: Author,
): Promise<WorkDataPayload> {
  const root = workDir(hab, workId);
  const abs = resolveData(root, rel);
  const text = `${JSON.stringify(json, null, 2)}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BYTES) throw new Error(`文件超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB`);

  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, abs);

  await hab.journal.add({
    actor,
    op: 'edit',
    phase: 'done',
    target: path.relative(hab.store.root, abs).replace(/\\/g, '/'),
    summary: `编辑数据文件：${path.basename(abs)}（${(bytes / 1024).toFixed(0)} KB）`,
    payload: { bytes },
  });
  await hab.rescan();
  await hab.reindex();

  return {
    path: path.relative(root, abs).replace(/\\/g, '/'),
    text,
    json,
    bytes,
    updatedAt: new Date().toISOString(),
  };
}
