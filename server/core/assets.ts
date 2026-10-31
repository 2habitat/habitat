/**
 * 附件入库：一份逻辑，三个入口共用（HTTP / CLI / MCP 将来）。
 *
 * 放在 core 里而不是各写一遍，是因为「同名不覆盖 + 目录白名单 + 去重」
 * 这三条只要有一处走偏，就会变成「文件悄悄被覆盖」或者「路径越狱」。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Store } from './store.ts';

export interface AssetResult {
  rel: string;
  bytes: number;
  deduped: boolean;
}

/** 只允许落在这三个目录 */
export const ASSET_DIRS = ['assets/attachments', 'assets/originals', 'assets/export'] as const;
export type AssetDir = (typeof ASSET_DIRS)[number];

/** 附件访问地址：前端 <img> 和 markdown 都用它 */
export function assetUrl(rel: string): string {
  return `/api/assets?path=${encodeURIComponent(rel)}`;
}

/** 文件名的 markdown 片段：图片用 ![]，其它用 [] */
export function assetMarkdown(rel: string, name: string): string {
  const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(rel);
  return `${isImg ? '!' : ''}[${name}](${assetUrl(rel)})`;
}

function safeName(raw: string): string {
  // 抹掉路径分隔符与控制字符：文件名是地址，不能让人用 ../ 越狱
  const cleaned = raw
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  return cleaned.slice(0, 120) || `file-${Date.now()}`;
}

export async function saveAsset(
  store: Store,
  buf: Buffer,
  opts: { name: string; dir?: string; now?: Date },
): Promise<AssetResult> {
  if (!buf.byteLength) throw new Error('文件是空的');

  const dir: AssetDir = (ASSET_DIRS as readonly string[]).includes(opts.dir ?? '')
    ? (opts.dir as AssetDir)
    : 'assets/attachments';

  const name = safeName(opts.name);
  const now = opts.now ?? new Date();
  const sub = dir === 'assets/attachments' ? `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}` : '';
  const base = sub ? `${dir}/${sub}` : dir;

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  for (let i = 0; i < 50; i += 1) {
    const rel = i === 0 ? `${base}/${name}` : `${base}/${stem}-${i}${ext}`;
    const st = await store.adapter.stat(rel).catch(() => null);
    if (!st) {
      await store.adapter.write(rel, new Uint8Array(buf), { backup: false });
      return { rel, bytes: buf.byteLength, deduped: false };
    }
    // 同名同内容 = 重复上传，直接复用，不产生副本。
    // 注意必须按字节读：adapter.read 返回的是 utf8 字符串，二进制会比出假不等，
    // 于是同一张图会被反复存成 -1、-2……
    const same = await fsp
      .readFile(path.join(store.root, rel))
      .then((b) => b.equals(buf))
      .catch(() => false);
    if (same) return { rel, bytes: buf.byteLength, deduped: true };
  }
  throw new Error('同名文件太多，换个名字再传');
}
