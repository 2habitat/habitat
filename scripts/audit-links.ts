/**
 * 链路验收：把每个路由在真实数据上打开一遍，记录
 *   - 渲染结果（有没有报错 / 空态）
 *   - 控制台与页面异常
 *   - 关键计数（用于判断「有数据但没显示」）
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.AUDIT_TOKEN ?? '';
if (!TOKEN) {
  console.error('用法：AUDIT_BASE=https://你的站 AUDIT_TOKEN=xxx npx tsx scripts/audit-links.ts');
  process.exit(1);
}

const ROUTES = [
  'today', 'inbox', 'calendar', 'projects', 'areas', 'review',
  'shelf', 'continue', 'compose', 'search', 'tags', 'collections', 'graph',
  'assistant', 'changes', 'jobs', 'automation',
  'storage', 'agent', 'budget', 'health',
] as const;

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: 'kb_token', value: TOKEN, domain: new URL(BASE).hostname, path: '/', secure: true, httpOnly: true }]);
const page = await ctx.newPage();

const rows: string[] = [];
for (const r of ROUTES) {
  const errs: string[] = [];
  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
  page.on('pageerror', (e) => errs.push(`PAGEERROR ${e.message.slice(0, 120)}`));

  await page.goto(`${BASE}/#/${r}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);

  const info = await page.evaluate(() => {
    const main = document.querySelector('.main') as HTMLElement | null;
    const body = (main?.innerText ?? document.body.innerText).replace(/\s+/g, ' ').slice(0, 240);
    const cards = document.querySelectorAll('.card').length;
    const rowsN = document.querySelectorAll('.check-row, [data-testid$="-row"], tr').length;
    const emptyish = /没有|还没有|暂时|空的|没有命/.test(body);
    return { body, cards, rowsN, emptyish };
  });

  rows.push(
    `${r.padEnd(11)} cards=${String(info.cards).padStart(2)} rows=${String(info.rowsN).padStart(2)} ` +
      `empty=${info.emptyish ? 'Y' : 'N'} err=${errs.length} | ${info.body.slice(0, 90)}`,
  );
  if (errs.length) rows.push(`            ! ${errs.slice(0, 3).join(' ／ ')}`);
}

// 阅读器：进第一部作品的第一章
await page.goto(`${BASE}/#/shelf`);
await page.waitForTimeout(1200);
const readBtn = page.locator('[data-testid="work-read"]').first();
rows.push(`shelf 上 work-read 按钮数=${await page.locator('[data-testid="work-read"]').count()}`);
if (await readBtn.count()) {
  await readBtn.click();
  await page.waitForTimeout(2000);
  const url = page.url();
  const ok = await page.locator('[data-testid="reader-body"]').count();
  const pdf = await page.locator('[data-testid="reader-pdf"]').count();
  const len = ok ? (await page.locator('[data-testid="reader-body"]').innerText()).length : 0;
  const errBox = await page.locator('.error, [data-testid="error-box"]').count();
  const mainText = await page.evaluate(() => (document.querySelector('.main') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').slice(0, 200) ?? '');
  rows.push(`reader       url=${url.split('#')[1] ?? ''} 正文=${ok} pdf=${pdf} 字数=${len} errBox=${errBox}`);
  rows.push(`             ${mainText}`);
}

console.log(rows.join('\n'));
await b.close();
