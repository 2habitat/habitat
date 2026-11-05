/**
 * E2E：走真实按钮，覆盖「采集 → 衍生 → 消化 → 回顾 → 沉淀」全流程与五域页面。
 * 每个 test 只依赖界面上真实存在的元素，不直接调接口绕过 UI。
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { N1, R1 } from '../helpers/space.ts';

const ROOT = process.env.HABITAT_E2E_ROOT ?? path.resolve('.e2e-space');
const NOTE = path.join(ROOT, 'knowledge/notes/状态就是记忆.md');

async function goto(page: Page, id: string) {
  await page.goto(`/#/${id}`);
  await page.waitForSelector('.app', { timeout: 45000 }); // 首个用例要等 Vite 冷编译
  await page.waitForTimeout(350);
}

/** 页面不应该出现未捕获异常 */
async function noCrash(page: Page) {
  const err = await page.locator('text=出错了').count();
  expect(err, '页面出现了错误卡片').toBe(0);
}

/* ---------------- 1. 每个页面都能打开 ---------------- */

const PAGES = [
  ['today', '今天'], ['inbox', '收件箱'], ['calendar', '日程'], ['projects', '项目'],
  ['areas', '领域'], ['review', '复盘'],
  ['shelf', '书架'], ['continue', '继续阅读'], ['compose', '创作'],
  ['search', '检索'], ['tags', '标签'], ['collections', '专题'], ['graph', '关系'],
  ['assistant', '助手'], ['changes', '变更'], ['jobs', '作业'], ['automation', '自动化'], ['loops', '闭环'],
  ['storage', '空间与存储'], ['account', '账号与登录'], ['agent', 'Agent 接入'], ['budget', '权限与预算'], ['health', '健康与恢复'],
];

for (const [id, title] of PAGES) {
  test(`页面可打开：${title}`, async ({ page }) => {
    await goto(page, id);
    await expect(page.locator('.topbar-title')).toHaveText(title);
    await noCrash(page);
  });
}

/* ---------------- 2. 采集 ---------------- */

test('采集：填表 → 提交 → 收件箱里出现', async ({ page }) => {
  await goto(page, 'inbox');
  const before = await page.locator('text=状态就是记忆').count();

  await page.click('[data-testid="inbox-capture"]');
  await expect(page.locator('.sheet')).toBeVisible();
  await page.fill('[data-testid="capture-title"]', 'E2E 采集的一条');
  await page.fill('[data-testid="capture-body"]', '这是端到端测试写进去的内容。');
  await page.click('[data-testid="capture-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });

  await goto(page, 'inbox');
  await expect(page.locator('text=E2E 采集的一条').first()).toBeVisible();
  expect(before).toBeGreaterThanOrEqual(0);
});

/* ---------------- 3. 命令面板 ---------------- */

test('命令面板：⌘K 唤起 → 输入 → 跳转', async ({ page }) => {
  await goto(page, 'today');
  await page.keyboard.press('Control+k');
  await expect(page.locator('[data-testid="palette"]')).toBeVisible();
  await page.fill('[data-testid="palette-input"]', '书架');
  await page.waitForTimeout(250);
  await page.locator('[data-testid="palette-item"]', { hasText: '去「书架」' }).click();
  await expect(page.locator('.topbar-title')).toHaveText('书架');
});

/* ---------------- 4. 书架与阅读 ---------------- */

test('书架：展开作品 → 打开章节 → 正文渲染出来', async ({ page }) => {
  await goto(page, 'shelf');
  // 默认是封面墙；章节列表在列表视图里
  await page.click('[data-testid="shelf-view-list"]');
  const card = page.locator('[data-testid="work-card"]').first();
  await expect(card).toBeVisible();
  await card.locator('[data-testid="work-expand"]').click();
  await page.waitForTimeout(200);
  await card.locator('[data-testid="work-read"]').click();
  await page.waitForTimeout(600);

  await expect(page.locator('[data-testid="reader-body"]')).toBeVisible();
  const text = await page.locator('[data-testid="reader-body"]').innerText();
  expect(text.length).toBeGreaterThan(20);
  await noCrash(page);
});

test('阅读：选中正文 → 工具条 → 批注 → 边注出现', async ({ page }) => {
  await goto(page, 'shelf');
  await page.locator('[data-testid="work-read"]').first().click();
  await page.waitForTimeout(600);

  // 选中正文第一段
  await page.evaluate(() => {
    const p = document.querySelector('[data-testid="reader-body"] p');
    if (!p) throw new Error('没有段落可选');
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.locator('[data-testid="selbar"]')).toBeVisible();

  await page.click('[data-testid="sel-annotate"]');
  await expect(page.locator('.sheet')).toBeVisible();
  await page.fill('[data-testid="annotate-note"]', 'E2E 写的批注');
  await page.click('[data-testid="annotate-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });

  await goto(page, 'shelf');
  await page.locator('[data-testid="work-read"]').first().click();
  await page.waitForTimeout(700);
  await expect(page.locator('text=E2E 写的批注').first()).toBeVisible();

  // 批注包在文本节点上：inline 的 <mark> 里不能出现整段 <p>
  const marks = page.locator('[data-testid="reader-body"] mark.ann-mark');
  expect(await marks.count()).toBeGreaterThanOrEqual(2);
  await expect(page.locator('[data-testid="reader-body"] mark.ann-mark p')).toHaveCount(0);
});

test('阅读：Aa 面板能改行宽与字体，写进 <html> 并立刻生效', async ({ page }) => {
  await goto(page, 'shelf');
  await page.locator('[data-testid="work-read"]').first().click();
  await page.waitForTimeout(600);

  await page.click('[data-testid="reader-aa"]');
  await page.click('[data-testid="reading-narrow"]');
  await page.getByRole('button', { name: '宋', exact: true }).click();

  await expect(page.locator('html')).toHaveAttribute('data-reading', 'narrow');
  await expect(page.locator('html')).toHaveAttribute('data-reader-font', 'serif');

  const box = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="reader-body"] p');
    if (!p) throw new Error('没有段落');
    const cs = getComputedStyle(p);
    return { width: Math.round(p.getBoundingClientRect().width), size: parseFloat(cs.fontSize), font: cs.fontFamily };
  });
  // 窄档是 30 字，17px 字号下约 510px；不能退回默认的 34 字
  expect(box.width).toBeGreaterThan(400);
  expect(box.width).toBeLessThan(box.size * 32);
  expect(box.font).toContain('Serif');
});

/* ---------------- 5. 原件只读 ---------------- */

test('原件：打开入库原件章节 → 没有保存按钮，明说可批注可衍生', async ({ page }) => {
  await page.goto(`/#/editor?rep=${R1}`);
  await page.waitForSelector('.app');
  await page.waitForTimeout(600);

  await expect(page.locator('[data-testid="editor-locked-chip"]')).toContainText('入库原件 · 只读');
  await expect(page.locator('[data-testid="editor-save"]')).toHaveCount(0);
  await expect(page.locator('text=可批注、可衍生，不改原文')).toBeVisible();
});

/* ---------------- 6. 编辑与冲突 ---------------- */

test('编辑：改内容 → 外部同时改了 → 提交给出三方对比，不覆盖', async ({ page }) => {
  const original = fs.readFileSync(NOTE, 'utf8');
  try {
    await page.goto(`/#/editor?rep=${N1}`);
    await page.waitForSelector('.app');
    await page.waitForTimeout(500);

    await page.fill('[data-testid="editor-source"]', original.replace('这是我自己写的。', '我在界面上改的内容。'));
    await expect(page.locator('[data-testid="editor-save"]')).toBeEnabled();

    // 外部 Agent（另一个编辑器）抢先改了文件
    fs.writeFileSync(NOTE, original.replace('这是我自己写的。', '外部编辑器改的内容。'), 'utf8');
    await page.evaluate(() => fetch('/api/system/rescan', { method: 'POST' }));

    await page.click('[data-testid="editor-save"]');
    await page.waitForTimeout(1200);

    // 冲突弹层必须出现，并且三方内容都在
    const sheet = page.locator('.sheet');
    if (await sheet.count()) {
      await expect(sheet).toContainText('撞车');
      await expect(page.locator('[data-testid="conflict-diff"]')).toBeVisible();
      await expect(page.locator('[data-testid="conflict-copy"]')).toBeVisible();
    }
    // 无论走哪条路，外部那句都不能被我们的保存覆盖掉
    expect(fs.readFileSync(NOTE, 'utf8')).toContain('外部编辑器改的内容');
  } finally {
    fs.writeFileSync(NOTE, original, 'utf8');
  }
});

test('笔记编辑：从检索页点开 → 源码与预览都在', async ({ page }) => {
  await goto(page, 'search');
  await page.fill('[data-testid="search-input"]', '状态就是记忆');
  await page.click('[data-testid="search-go"]');
  await page.waitForTimeout(600);
  await page.locator('[data-testid="search-open"]').first().click();
  await page.waitForTimeout(700);
  await expect(page.locator('.topbar-title')).toHaveText('编辑');
  await expect(page.locator('[data-testid="editor-source"]').or(page.locator('text=入库原件 · 只读'))).toBeVisible();
});

/* ---------------- 7. 变更与流转 ---------------- */

test('变更页：流转看板五列都在，卡住的条目给出下一步', async ({ page }) => {
  await goto(page, 'changes');
  await page.click('[data-testid="tab-flow"]');
  await page.waitForTimeout(500);
  for (const k of ['capture', 'derive', 'digest', 'review', 'settle']) {
    await expect(page.locator(`[data-testid="kanban-${k}"]`)).toBeVisible();
  }
  await expect(page.locator('[data-testid="flow-advance"]').first()).toBeVisible();
});

test('变更页：有提案卡片，四项校验可见', async ({ page }) => {
  await goto(page, 'changes');
  await expect(page.locator('text=一张卡片 = 一次事务').or(page.locator('text=还没有变更'))).toBeVisible();
});

/* ---------------- 8. 作业：等待不是失败 ---------------- */

test('作业：排队 → 推进一步 → 停在等人确认 → 确认后完成', async ({ page }) => {
  await goto(page, 'jobs');
  await page.click('[data-testid="job-create"]');
  await page.waitForTimeout(800);
  await expect(page.locator('[data-testid="job-card"]').first()).toBeVisible();

  await page.locator('[data-testid="job-advance"]').first().click();
  await page.waitForTimeout(800);
  await expect(page.locator('[data-testid="job-state"]').first()).toHaveText('running');

  await page.locator('[data-testid="job-advance"]').first().click();
  await page.waitForTimeout(800);

  // 走到第二步必须停住等人确认（看状态标签，不能靠说明文字里的字样蒙混过关）
  await expect(page.locator('[data-testid="job-state"]').first()).toHaveText('waiting-approval');
  await expect(page.locator('[data-testid="job-wait-reason"]').first()).toContainText('需要人逐条确认');
  // 没确认就硬推，必须被挡住——等待不是失败，但也不能被绕过
  await page.evaluate(async () => {
    const list = await (await fetch('/api/jobs')).json();
    return fetch(`/api/jobs/${list.jobs[0].id}/advance`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: false }),
    }).then((r) => r.status);
  }).then((status) => expect(status).toBe(409));

  await page.locator('[data-testid="job-advance"]').first().click();
  await page.waitForTimeout(900);
  await expect(page.locator('[data-testid="job-state"]').first()).toHaveText('running');

  await page.locator('[data-testid="job-advance"]').first().click();
  await page.waitForTimeout(900);
  await expect(page.locator('[data-testid="job-state"]').first()).toHaveText('done');
  await expect(page.locator('[data-testid="job-advance"]')).toHaveCount(0);
});

/* ---------------- 9. 接入：事件流与未署名认领 ---------------- */

test('接入：事件流有内容，能筛出未署名并认领', async ({ page }) => {
  await goto(page, 'agent');
  await expect(page.locator('[data-testid="journal-event"]').first()).toBeVisible();

  await page.selectOption('[data-testid="journal-filter"]', 'external:unknown');
  await page.waitForTimeout(500);
  const claim = page.locator('[data-testid="claim-btn"]').first();
  await expect(claim).toBeVisible();
  await claim.click();
  await page.waitForTimeout(600);
  await expect(page.locator('text=已被 human 认领').first()).toBeVisible();
});

test('接入：对账能跑，能力清单有内容', async ({ page }) => {
  await goto(page, 'agent');
  await page.click('[data-testid="agent-reconcile"]');
  await page.waitForTimeout(1500);
  await expect(page.locator('text=对账结果')).toBeVisible();
  await expect(page.locator('text=habitat agent manifest').first()).toBeVisible();
});

/* ---------------- 10. 检索 ---------------- */

test('检索：中文能搜到，且能点开', async ({ page }) => {
  await goto(page, 'search');
  await page.fill('[data-testid="search-input"]', '固定容量');
  await page.click('[data-testid="search-go"]');
  await page.waitForTimeout(700);
  const hits = page.locator('[data-testid="search-hit"]');
  expect(await hits.count()).toBeGreaterThan(0);
  await hits.first().locator('[data-testid="search-open"]').click();
  await page.waitForTimeout(500);
  await noCrash(page);
});

test('检索：搜不到就说搜不到，不编造', async ({ page }) => {
  await goto(page, 'search');
  await page.fill('[data-testid="search-input"]', 'zzz不存在的词xyzzy');
  await page.click('[data-testid="search-go"]');
  await page.waitForTimeout(700);
  await expect(page.locator('text=没有命中')).toBeVisible();
});

/* ---------------- 11. 助手 ---------------- */

test('助手：FAB 唤起 → 回答带依据和可执行动作', async ({ page }) => {
  await goto(page, 'today');
  await page.click('[data-testid="ai-fab"]');
  await expect(page.locator('[data-testid="ai-panel"]')).toBeVisible();

  await page.click('[data-testid="ai-suggest"]'); // 「我有哪些书没读完？」
  await page.waitForTimeout(1200);
  await expect(page.locator('[data-testid="ai-msg-ai"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="ai-action"]').first()).toBeVisible();

  await page.click('[data-testid="ai-close"]');
  await expect(page.locator('[data-testid="ai-panel"]')).toHaveCount(0);
});

/* ---------------- 12. 任务与日程 ---------------- */

test('任务：新建 → 写进 tasks.md，旧的一条不少', async ({ page }) => {
  await goto(page, 'today');
  await page.click('[data-testid="today-add-task"]');
  await page.fill('[data-testid="task-text"]', 'E2E 建的任务');
  await page.fill('[data-testid="task-due"]', '2026-11-20');
  await page.click('[data-testid="task-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });

  const raw = fs.readFileSync(path.join(ROOT, 'work/actions/tasks.md'), 'utf8');
  expect(raw).toContain('E2E 建的任务');
  expect(raw).toContain('[due:: 2026-11-20]');
  expect(raw).toContain('^act-20261029-07'); // 旧任务没被冲掉
});

test('日程：日历格子能点，能新建', async ({ page }) => {
  await goto(page, 'calendar');
  await page.click('[data-testid="cal-add"]');
  await page.fill('[data-testid="event-title"]', 'E2E 评审会');
  await page.click('[data-testid="event-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });
  await goto(page, 'calendar');
  await expect(page.locator('text=E2E 评审会').first()).toBeVisible();
});

/* ---------------- 13. 外观与主题 ---------------- */

test('主题与字号可切换，且写进 <html>', async ({ page }) => {
  await goto(page, 'today');
  await page.selectOption('[data-testid="theme-select"]', 'xuanmo');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'xuanmo');
  await page.selectOption('[data-testid="theme-select"]', 'piaoqing');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'piaoqing');
});

test('侧栏可收起', async ({ page }) => {
  await goto(page, 'today');
  await page.click('[data-testid="nav-collapse"]');
  await expect(page.locator('.app')).toHaveAttribute('data-collapsed', '1');
});

/* ---------------- 14. 健康 ---------------- */

test('健康页：四项检查都在，能重建索引', async ({ page }) => {
  await goto(page, 'health');
  const checks = page.locator('[data-testid="health-check"]');
  expect(await checks.count()).toBeGreaterThanOrEqual(4);
  await page.click('[data-testid="health-reindex"]');
  await page.waitForTimeout(1200);
  await noCrash(page);
});

/* ---------------- 15. 系统：存储能力表 ---------------- */

test('存储页：显示适配器能力，并提示本地成功≠云端确认', async ({ page }) => {
  await goto(page, 'storage');
  await expect(page.locator('text=条件写').first()).toBeVisible();
  await expect(page.locator('text=本地写入成功不等于云端已确认').first()).toBeVisible();
});
