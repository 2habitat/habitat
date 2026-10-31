/**
 * 截图小工具：把几个主页面截到 .shots/，用来写文档 / 看回归。
 *
 * 用法：先起服务（默认 8787），再
 *   HABITAT_TOKEN=你的令牌 npx tsx scripts/shot-real.ts
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import nodePath from 'node:path';

const BASE = process.env.SHOT_BASE ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.HABITAT_TOKEN ?? '';
const OUT = nodePath.resolve('.shots');
fs.mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
if (TOKEN) {
  await ctx.addCookies([
    { name: 'kb_token', value: TOKEN, domain: new URL(BASE).hostname, path: '/', httpOnly: true },
  ]);
}
const p = await ctx.newPage();

for (const [id, name] of [['shelf', 'shelf'], ['graph', 'graph']] as const) {
  await p.goto(`${BASE}/#/${id}`);
  await p.waitForSelector('.app');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: nodePath.join(OUT, `${name}.png`) });
  console.log('✓', name);
}

// 打开第一部作品的第一章，确认正文真的渲染出来了
await p.goto(`${BASE}/#/shelf`);
await p.waitForSelector('[data-testid="work-read"]');
await p.locator('[data-testid="work-read"]').first().click();
await p.waitForTimeout(1600);
await p.screenshot({ path: nodePath.join(OUT, 'reader.png') });
const body = await p.locator('[data-testid="reader-body"]').innerText().catch(() => '');
console.log('reader chars:', body.length);

await b.close();
