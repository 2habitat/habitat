/** 链路验收：AI 侧、对账、规则、事件流 —— 都在真实数据上跑 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:8787';
const token = process.env.AUDIT_TOKEN ?? '';
if (!token) {
  console.error('用法：AUDIT_BASE=https://你的站 AUDIT_TOKEN=xxx npx tsx scripts/audit-chains.ts');
  process.exit(1);
}

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: 'kb_token', value: token, domain: new URL(BASE).hostname, path: '/', secure: true, httpOnly: true }]);
const p = await ctx.newPage();

// 1. 助手：问一个库里确实有的概念
await p.goto(`${BASE}/#/assistant`);
await p.waitForTimeout(1200);
await p.locator('.ai-fab').click().catch(() => {});
await p.waitForTimeout(700);
const box = p.locator('[data-testid="ai-input"]');
if (await box.count()) {
  await box.fill('上下文压缩有哪些做法');
  await box.press('Enter');
  await p.waitForTimeout(2500);
  const msgs = await p.locator('.ai-msg-ai').allInnerTexts();
  const last = msgs[msgs.length - 1] ?? '';
  const hasEvidence = /依据|命中|\[\[/.test(last);
  const actions = await p.locator('[data-testid="ai-action"]').count();
  console.log(`助手  回答长度=${last.length} 带依据=${hasEvidence} 可点动作≈${actions}`);
  console.log(`      回答片段：${last.replace(/\s+/g, ' ').slice(0, 110)}`);
} else {
  console.log('助手  找不到输入框');
}

// 2. 对账
const rec = await p.evaluate(async () => {
  const r = await (await fetch('/api/agent/reconcile', { method: 'POST' })).json();
  return r.report ?? r;
});
console.log('对账  ', JSON.stringify(rec).slice(0, 160));

// 3. 规则跑一轮（当前无规则，应安全空转）
const rules = await p.evaluate(async () => {
  const r = await (await fetch('/api/rules/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"dryRun":false}' })).json();
  return r.report;
});
console.log('规则  ', JSON.stringify(rules));

// 4. 事件流是否有真实记录
const jr = await p.evaluate(async () => (await (await fetch('/api/journal?limit=200')).json()).events.length);
console.log('事件流 最近 200 条内有', jr, '条');

// 5. 能力清单
const mf = await p.evaluate(async () => (await (await fetch('/api/agent/manifest')).json()).manifest.capabilities.length);
console.log('能力清单 条目', mf);

await b.close();
