/** 1000 篇规模的冷启动与首屏耗时实测（方案 G1 验收条款） */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Habitat } from '../server/core/space.ts';

const dir = path.join(os.tmpdir(), `habitat-bench-${Date.now()}`);
fs.mkdirSync(path.join(dir, 'knowledge/notes'), { recursive: true });
fs.writeFileSync(path.join(dir, 'space.yaml'), 'id: space-bench\nname: 压测空间\ntz: Asia/Shanghai\ndefault_sensitivity: private\n');

const N = 1000;
for (let i = 0; i < N; i += 1) {
  const body = `# 压测笔记 ${i}\n\n这是第 ${i} 篇笔记的正文，用来凑规模。关键概念：上下文压缩、线性注意力、方言层、权限沙箱。\n\n` +
    `## 结论\n\n第 ${i} 条的结论是：${i % 7 === 0 ? '先做可观测性' : '先把写入路径收敛成一条'}。\n\n` +
    `## 依据\n\n见 [[压测笔记 ${(i + 1) % N}]] 与 [[压测笔记 ${(i + 5) % N}]]。\n`;
  fs.writeFileSync(
    path.join(dir, 'knowledge/notes', `2026-01-01-压测笔记-${String(i).padStart(4, '0')}.md`),
    `---\ntitle: 压测笔记 ${i}\ntype: note\nstatus: seedling\ntags: [bench]\nsummary: 第 ${i} 篇，用于测规模\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n${body}`,
  );
}

const t0 = Date.now();
const hab = await Habitat.open(dir, { fresh: true });
const tOpen = Date.now() - t0;

// 首屏要的几个接口
const bench = (label: string, fn: () => unknown) => {
  const s = process.hrtime.bigint();
  const r = fn();
  const ms = Number(process.hrtime.bigint() - s) / 1e6;
  console.log(`${label.padEnd(26)} ${ms.toFixed(1)} ms`);
  return r;
};

console.log(`\n空间规模：${N} 篇笔记 · 冷启动（扫描+建索引）${tOpen} ms\n`);
bench('store.all("note")', () => hab.store.all('note').length);
bench('works()', () => hab.works());
bench('today()', () => hab.today());
bench('tags 聚合（同 /api/tags）', () => {
  const m = new Map<string, string[]>();
  for (const o of hab.store.objects.values()) {
    for (const t of ((o as { tags?: string[] }).tags ?? [])) m.set(t, [...(m.get(t) ?? []), o.id]);
  }
  return m.size;
});
bench('index.search("上下文压缩")', () => hab.index.search('上下文压缩').length);
bench('graph 取 200 节点（同 /api/graph）', () =>
  hab.store.all().filter((o) => ['work', 'note', 'project', 'area', 'collection'].includes(o.type)).slice(0, 200).length,
);
bench('stats()', () => hab.stats());

hab.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('\n（索引与数据已清理）');
