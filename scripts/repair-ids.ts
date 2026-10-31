/**
 * 一次性修复：edition 覆盖 work id 的历史 bug 会把 work.yaml 这个键的 id 写坏。
 * 只删「作品相关的 id 键」和「长度异常的值」，其余 id 保持不动——
 * 全删会让所有笔记/章节换 id，外部引用全断。
 */
import fs from 'node:fs';
import path from 'node:path';

const space = process.argv[2];
if (!space) {
  console.error('用法：repair-ids.ts <空间根>');
  process.exit(1);
}
const file = path.join(space, '.habitat/state/ids.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;

const before = Object.keys(raw).length;
const removed: string[] = [];
for (const [k, v] of Object.entries(raw)) {
  const workKey = /knowledge\/works\/[^/]+\/work\.yaml(#edition)?$/.test(k);
  const broken = typeof v === 'string' && (v.length > 80 || !/^[a-z]+-/.test(v));
  if (workKey || broken) {
    removed.push(`${k} → ${String(v).slice(0, 40)}${String(v).length > 40 ? '…' : ''}`);
    delete raw[k];
  }
}
fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
console.log(`原 ${before} 条，删除 ${removed.length} 条：`);
for (const r of removed) console.log('  -', r);
