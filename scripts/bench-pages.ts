/**
 * 页面级基准：真浏览器打开每个路由，记录所有 /api 请求的体积与耗时。
 *
 * 为什么需要它：服务端单接口都是亚毫秒，但一个页面可能串行发十几个请求，
 * 或者拉一个 1MB 的列表。结论要看"整页要多久、多少字节"，不是单接口。
 *
 * 用法：
 *   HABITAT_TOKEN=xxx npx tsx scripts/bench-pages.ts
 *   HABITAT_TOKEN=xxx SHOT_BASE=http://127.0.0.1:8787 npx tsx scripts/bench-pages.ts
 */
import { chromium } from '@playwright/test';

const BASE = process.env.SHOT_BASE ?? 'https://work.poryoung.cn';
const TOKEN = process.env.HABITAT_TOKEN ?? '';

const ROUTES = [
  ['今天', 'today'],
  ['收件箱', 'inbox'],
  ['书架', 'shelf'],
  ['笔记', 'notes'],
  ['对象', 'objects'],
  ['变更', 'changes'],
  ['连接', 'graph'],
  ['文件', 'files'],
  ['健康', 'health'],
] as const;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
if (TOKEN) {
  await ctx.addCookies([
    { name: 'kb_token', value: TOKEN, domain: new URL(BASE).hostname, path: '/', httpOnly: true },
  ]);
}

type Res = { url: string; ms: number; bytes: number };
type Row = {
  name: string;
  total: number;
  api: number;
  bytes: number;
  count: number;
  bundle: number;
  top: Res[];
};
const table: Row[] = [];

for (const [label, route] of ROUTES) {
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`${BASE}/#/${route}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => undefined);
  const total = Date.now() - t0;

  // 用浏览器自己的 performance 数据：准确到每一条资源，不用我猜
  const res = (await page.evaluate(() => {
    const es = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return es.map((e) => ({
      url: e.name,
      ms: Math.round(e.duration),
      bytes: e.encodedBodySize || e.transferSize || 0,
      initiator: e.initiatorType,
    }));
  })) as { url: string; ms: number; bytes: number; initiator: string }[];
  await page.close();

  const api = res.filter((r) => r.url.includes('/api/'));
  const js = res.filter((r) => r.initiator === 'script' || r.url.endsWith('.js'));
  table.push({
    name: label,
    total,
    api: api.reduce((a, r) => a + r.ms, 0),
    bytes: api.reduce((a, r) => a + r.bytes, 0),
    count: api.length,
    bundle: js.reduce((a, r) => a + r.bytes, 0),
    top: api.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 3),
  });
}

const pad = (s: string, n: number) =>
  s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));

console.log(`\n站点：${BASE}\n`);
console.log(pad('页面', 10), pad('整页', 9), pad('API累计', 10), pad('请求', 6), pad('API体积', 10), 'JS');
console.log('-'.repeat(92));
let totalBytes = 0;
for (const r of table) {
  totalBytes += r.bytes;
  console.log(
    pad(r.name, 10),
    pad(`${r.total}ms`, 9),
    pad(`${r.api}ms`, 10),
    pad(String(r.count), 6),
    pad(`${(r.bytes / 1024).toFixed(0)} KB`, 10),
    `${(r.bundle / 1024).toFixed(0)} KB`,
  );
}
console.log('-'.repeat(92));
console.log(`${pad('合计', 12)} ${pad(`${(totalBytes / 1024).toFixed(0)} KB`, 12)}（每个页面都导航一次的累计量）\n`);
