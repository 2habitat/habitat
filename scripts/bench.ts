/**
 * 性能基准：给关键路径打表，避免"优化"变成拍脑袋。
 *
 * 用法：
 *   npx tsx scripts/bench.ts            # 默认 1000 篇
 *   npx tsx scripts/bench.ts 5000       # 5000 篇
 *   npx tsx scripts/bench.ts 1000 --http  # 额外测 HTTP 接口
 *
 * 关注三件事：
 *   1. 冷启动（扫盘 + 建索引）——决定重启后多久能用
 *   2. 写入后的重扫——决定"每次提交要等多久"
 *   3. 首屏几个接口——决定打开页面卡不卡
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Habitat } from '../server/core/space.ts';

// 压测时关掉访问日志，否则打表的输出会被淹掉
process.env.HABITAT_LOG ??= 'warn';

const N = Number(process.argv[2] ?? 1000);
const WITH_HTTP = process.argv.includes('--http');
const dir = path.join(os.tmpdir(), `habitat-bench-${N}-${Date.now()}`);

/* ---------------- 造数据 ---------------- */

function build() {
  fs.mkdirSync(path.join(dir, 'knowledge/notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets/attachments'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'space.yaml'),
    'id: space-bench\nname: 压测空间\ntz: Asia/Shanghai\ndefault_sensitivity: private\nschema: 1\n',
  );

  for (let i = 0; i < N; i += 1) {
    const tag = ['方言层', '权限沙箱', '上下文压缩', '线性注意力', '可观测性'][i % 5];
    const body =
      `# 压测笔记 ${i}\n\n` +
      `第 ${i} 篇的正文。核心概念是${tag}，它和 [[压测笔记 ${(i + 1) % N}]]、[[压测笔记 ${(i + 7) % N}]] 相关。\n\n` +
      `## 结论\n\n第 ${i} 条的结论：${i % 7 === 0 ? '先做可观测性' : '先把写入路径收敛成一条'}。\n\n` +
      `## 依据\n\n` +
      Array.from({ length: 8 }, (_, k) => `- 依据 ${k}：${tag} 在第 ${i} 篇里的第 ${k} 条观察。`).join('\n') +
      '\n';
    fs.writeFileSync(
      path.join(dir, 'knowledge/notes', `2026-01-01-压测笔记-${String(i).padStart(4, '0')}.md`),
      `---\ntitle: 压测笔记 ${i}\ntype: note\nstatus: seedling\ntags: [bench, ${tag}]\nsummary: 第 ${i} 篇，用于测规模\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n${body}`,
    );
  }

  // 一个大目录：测文件浏览的 stat 开销
  for (let i = 0; i < Math.min(N, 500); i += 1) {
    fs.writeFileSync(path.join(dir, 'assets/attachments', `img-${String(i).padStart(3, '0')}.txt`), 'x'.repeat(200));
  }
}

/* ---------------- 计时工具 ---------------- */

type Row = { label: string; ms: number; note?: string };
const rows: Row[] = [];

async function time(label: string, fn: () => Promise<unknown> | unknown, note?: string) {
  const s = process.hrtime.bigint();
  await fn();
  const ms = Number(process.hrtime.bigint() - s) / 1e6;
  rows.push({ label, ms, note });
  return ms;
}

/** 重复多次取中位数，避免单次抖动骗人 */
async function median(label: string, times: number, fn: () => Promise<unknown> | unknown) {
  const samples: number[] = [];
  for (let i = 0; i < times; i += 1) {
    const s = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(samples.length / 2)];
  rows.push({ label, ms: med, note: `中位数 / ${times} 次` });
  return med;
}

/* ---------------- 跑 ---------------- */

build();
const t0 = Date.now();
const hab = await Habitat.open(dir, { fresh: true });
const cold = Date.now() - t0;
rows.push({ label: `冷启动（${N} 篇）`, ms: cold, note: '扫盘 + 建索引' });

await median('重扫（无改动）', 5, () => hab.rescan());

// 写入一次，测"提交后要等多久"
const first = hab.store.all('note')[0] as unknown as { id: string };
await median('重扫（提交后）', 3, async () => {
  await hab.changes.propose({
    ops: [{ t: 'update', id: first.id, patch: { summary: `改于 ${Date.now()}` } }],
    reason: 'bench',
    actor: 'human',
  } as never);
  const cs = (await hab.changes.list({ limit: 1 }))[0];
  await hab.changes.commit(cs.id);
});

await median('检索（中文 2-gram）', 20, () => hab.index.search('上下文压缩 方言层', { limit: 20 }));
await median('读正文', 20, () => hab.store.body(first.id));

if (WITH_HTTP) {
  const { buildServer } = await import('../server/index.ts');
  const app = await buildServer({ root: dir });
  const hit = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    if (r.statusCode !== 200) throw new Error(`${url} → ${r.statusCode} ${r.body.slice(0, 120)}`);
    return r;
  };
  await median('/api/today', 10, () => hit('/api/today'));
  await median('/api/objects?type=note', 10, () => hit('/api/objects?type=note'));
  await median('/api/search', 10, () => hit('/api/search?q=%E6%96%B9%E8%A8%80%E5%B1%82'));
  await median('/api/fs（大目录）', 10, () => hit('/api/fs?path=assets%2Fattachments'));
  await median('/api/lifecycle', 5, () => hit('/api/lifecycle'));
  await median('/api/maintenance/brief', 5, () => hit('/api/maintenance/brief'));
  // buildServer 有自己的一份 Habitat，两个都要关，否则 SQLite 还锁着
  await app.close();
  app.habitat.close();
}

hab.close();

/* ---------------- 打表 ---------------- */

console.log(`\n空间：${N} 篇笔记 + ${Math.min(N, 500)} 个附件\n`);
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
console.log(pad('指标', 26), pad('毫秒', 10), '说明');
console.log('-'.repeat(72));
for (const r of rows) {
  const warn = r.ms > 500 ? '  ⚠' : '';
  console.log(pad(r.label, 26), pad(r.ms.toFixed(1), 10), (r.note ?? '') + warn);
}
console.log('');

// Windows 上 SQLite 释放文件有延迟，删不掉就算了（临时目录）
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  console.log(`（临时目录没删掉：${dir}）`);
}
