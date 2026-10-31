/**
 * 导出：把整个空间原样搬出来，带一份可校验的清单。
 *
 * 用途是「换工具不丢东西」和「离线备份」——不是给别的软件做格式转换。
 * 所以这里只做两件事：原字节复制 + 逐文件哈希清单，别的都不加工。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './storage.ts';
import type { Store } from './store.ts';

export interface ExportItem {
  path: string;
  bytes: number;
  hash: string;
}

export interface ExportReport {
  at: string;
  from: string;
  to: string;
  files: number;
  bytes: number;
  skipped: string[];
  manifest: string;
}

/** 这些不进导出：可重建的索引、写前备份、缩略图缓存 */
const SKIP = [/^\.habitat\/state\/habitat\.db/, /^\.habitat\/backup\//, /^\.habitat\/\.cache\//];

export async function exportSpace(store: Store, outDir: string): Promise<ExportReport> {
  const entries = await store.adapter.list();
  const items: ExportItem[] = [];
  const skipped: string[] = [];
  let bytes = 0;

  await fsp.mkdir(outDir, { recursive: true });

  for (const e of entries) {
    if (SKIP.some((re) => re.test(e.path))) {
      skipped.push(e.path);
      continue;
    }
    const src = path.join(store.root, e.path);
    const dst = path.join(outDir, e.path);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    const buf = await fsp.readFile(src);
    await fsp.writeFile(dst, buf);
    const hash = sha256(buf);
    items.push({ path: e.path, bytes: buf.byteLength, hash });
    bytes += buf.byteLength;
  }

  const manifestPath = path.join(outDir, 'EXPORT-MANIFEST.json');
  const report: ExportReport = {
    at: new Date().toISOString(),
    from: store.root,
    to: outDir,
    files: items.length,
    bytes,
    skipped,
    manifest: manifestPath,
  };
  await fsp.writeFile(
    manifestPath,
    JSON.stringify({ ...report, items }, null, 2),
    'utf8',
  );
  return report;
}

/** 校验一份导出：逐文件重算哈希，和清单比。任何一处不同都算失败。 */
export async function verifyExport(outDir: string): Promise<{ ok: boolean; checked: number; bad: string[] }> {
  const raw = await fsp.readFile(path.join(outDir, 'EXPORT-MANIFEST.json'), 'utf8');
  const man = JSON.parse(raw) as { items: ExportItem[] };
  const bad: string[] = [];
  for (const it of man.items) {
    const p = path.join(outDir, it.path);
    if (!fs.existsSync(p)) {
      bad.push(`${it.path}（缺失）`);
      continue;
    }
    const buf = await fsp.readFile(p);
    if (sha256(buf) !== it.hash) bad.push(`${it.path}（内容变了）`);
  }
  return { ok: bad.length === 0, checked: man.items.length, bad: bad.slice(0, 20) };
}
