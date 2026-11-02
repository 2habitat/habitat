/**
 * StorageAdapter —— 设计方案 §9
 * 条件写（ifHash）是「并发写冲突 100% 被拦」的地基：写之前比对当前哈希，不一致就拒绝，不接受 force。
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class ConflictError extends Error {
  constructor(
    public rel: string,
    public expected: string,
    public actual: string,
  ) {
    super(`条件写失败：${rel} 已被改动（期望 ${expected.slice(0, 8)}，实际 ${actual.slice(0, 8)}）`);
    this.name = 'ConflictError';
  }
}

export interface Stat {
  hash: string;
  mtime: string;
  bytes: number;
}

export interface Entry {
  path: string; // 相对空间根，正斜杠
  bytes: number;
  mtime: string;
}

export interface WriteOpts {
  /** 存在时要求当前哈希一致；文件不存在时传 'new' */
  ifHash?: string;
  /** 覆盖前把旧版本留一份到 .habitat/backup */
  backup?: boolean;
  mkdirp?: boolean;
}

export interface StorageAdapter {
  readonly name: string;
  readonly root: string;
  readonly capabilities: {
    conditionalWrite: boolean;
    versioning: boolean;
    watch: boolean;
    rangeRead: boolean;
  };
  stat(rel: string): Promise<Stat | null>;
  read(rel: string): Promise<string>;
  readBytes(rel: string): Promise<Uint8Array>;
  write(rel: string, data: string | Uint8Array, opts?: WriteOpts): Promise<{ hash: string }>;
  remove(rel: string): Promise<void>;
  list(prefix?: string): Promise<Entry[]>;
  /** 只追加（事件流用），不存在则创建 */
  append(rel: string, line: string): Promise<void>;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

export function safeJoin(root: string, rel: string): string {
  const p = path.resolve(root, rel);
  const r = path.resolve(root);
  if (p !== r && !p.startsWith(r + path.sep)) throw new Error(`路径越界：${rel}`);
  return p;
}

function toRel(p: string): string {
  return p.split(path.sep).join('/');
}

const SKIP = new Set(['node_modules', '.git', '.DS_Store']);

export class LocalDirAdapter implements StorageAdapter {
  readonly name = 'local-dir';
  readonly capabilities = { conditionalWrite: true, versioning: true, watch: false, rangeRead: true };

  constructor(public readonly root: string) {}

  private abs(rel: string): string {
    return safeJoin(this.root, rel);
  }

  async stat(rel: string): Promise<Stat | null> {
    try {
      const st = await fsp.stat(this.abs(rel));
      if (st.isDirectory()) return null;
      const buf = await fsp.readFile(this.abs(rel));
      return { hash: sha256(buf), mtime: st.mtime.toISOString(), bytes: st.size };
    } catch {
      return null;
    }
  }

  async read(rel: string): Promise<string> {
    return fsp.readFile(this.abs(rel), 'utf8');
  }

  async readBytes(rel: string): Promise<Uint8Array> {
    return new Uint8Array(await fsp.readFile(this.abs(rel)));
  }

  async write(rel: string, data: string | Uint8Array, opts: WriteOpts = {}): Promise<{ hash: string }> {
    const abs = this.abs(rel);
    if (opts.mkdirp !== false) await fsp.mkdir(path.dirname(abs), { recursive: true });
    let actual = 'new';
    try {
      const cur = await fsp.readFile(abs);
      actual = sha256(cur);
    } catch {
      actual = 'new';
    }
    if (opts.ifHash !== undefined && opts.ifHash !== actual) {
      throw new ConflictError(rel, opts.ifHash, actual);
    }
    if (actual !== 'new' && opts.backup !== false) {
      await this.backup(rel);
    }
    // 原子替换：先写临时文件再 rename，避免中途断电留下半截文件
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${randomBytes(4).toString('hex')}`;
    await fsp.writeFile(tmp, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    await fsp.rename(tmp, abs);
    return { hash: sha256(typeof data === 'string' ? Buffer.from(data, 'utf8') : data) };
  }

  async backup(rel: string): Promise<void> {
    try {
      const abs = this.abs(rel);
      const buf = await fsp.readFile(abs);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = safeJoin(this.root, `.habitat/backup/${rel}.${ts}.bak`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
    } catch {
      // 备份失败不应该阻断写入，但要能被健康检查发现
    }
  }

  async remove(rel: string): Promise<void> {
    await fsp.rm(this.abs(rel), { force: true });
  }

  async list(prefix = ''): Promise<Entry[]> {
    const base = this.abs(prefix || '.');
    const out: Entry[] = [];
    const walk = async (dir: string) => {
      let items: fs.Dirent[];
      try {
        items = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        if (SKIP.has(it.name)) continue;
        const full = path.join(dir, it.name);
        const rel = toRel(path.relative(this.root, full));
        if (it.isDirectory()) {
          if (rel === '.habitat/backup') continue; // 备份不参与扫描，避免指数膨胀
          await walk(full);
        } else if (it.isFile()) {
          // 写入是「临时文件 + rename」，readdir 和 stat 之间文件完全可能已经不在了。
          // 这里不容错的话，一次并发写入就能让整次扫描抛 ENOENT 而中止。
          const st = await fsp.stat(full).catch(() => null);
          if (!st) continue; // 刚被换掉的，下次扫描自然会有新条目
          out.push({ path: rel, bytes: st.size, mtime: st.mtime.toISOString() });
        }
      }
    };
    await walk(base);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async append(rel: string, line: string): Promise<void> {
    const abs = this.abs(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.appendFile(abs, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
  }
}

/** WPS 同步盘：能力降级 + 明确「本地成功 ≠ 云端确认」 */
export class WpsSyncAdapter implements StorageAdapter {
  readonly name = 'wps-sync';
  readonly capabilities = { conditionalWrite: true, versioning: false, watch: false, rangeRead: true };
  readonly notice = '本地写入成功不等于云端已确认；同步冲突以云端副本为准，需重新对账';

  constructor(private inner: LocalDirAdapter) {}

  get root(): string {
    return this.inner.root;
  }

  stat(rel: string) {
    return this.inner.stat(rel);
  }
  read(rel: string) {
    return this.inner.read(rel);
  }
  readBytes(rel: string) {
    return this.inner.readBytes(rel);
  }
  async write(rel: string, data: string | Uint8Array, opts?: WriteOpts) {
    const r = await this.inner.write(rel, data, opts);
    return { ...r, cloudConfirmed: false } as { hash: string };
  }
  remove(rel: string) {
    return this.inner.remove(rel);
  }
  list(prefix?: string) {
    return this.inner.list(prefix);
  }
  append(rel: string, line: string) {
    return this.inner.append(rel, line);
  }
}
