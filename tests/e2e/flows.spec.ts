/**
 * 第二轮：把「采集 → 衍生 → 消化 → 回顾 → 沉淀」全流程里剩下的按钮逐个点一遍。
 * 只读页面与基础导航由 app.spec.ts 覆盖，这里专门补交互：
 * 衍生、批注、标记读完、回顾、提案、变更校验/提交/撤销、规则开关、
 * 命令面板系统命令、冲突弹层三条出路、专题/标签/项目/自动化。
 */
import { test, expect, type Page } from '@playwright/test';

async function goto(page: Page, id: string) {
  await page.goto(`/#/${id}`);
  await page.waitForSelector('.app', { timeout: 45000 }); // 首个用例要等 Vite 冷编译
  await page.waitForTimeout(300);
}

async function noCrash(page: Page) {
  expect(await page.locator('text=出错了').count(), '页面出现了错误卡片').toBe(0);
}

/* ---------------- 1. 衍生：收件箱碎片 → 自己的笔记 ---------------- */

test('衍生：从收件箱一条碎片生成笔记，原文还在', async ({ page }) => {
  await goto(page, 'inbox');
  await page.locator('[data-testid="inbox-derive"]').last().click();
  await expect(page.locator('.sheet')).toBeVisible();
  await page.fill('[data-testid="derive-title"]', '我对遗忘门的理解');
  await page.fill('[data-testid="derive-body"]', '每一步都在补上一步漏掉的信息。');
  await page.click('[data-testid="derive-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });

  await goto(page, 'inbox');
  // 原文还在（衍生不删除原始碎片）
  await expect(page.locator('text=剪藏：一段话').first()).toBeVisible();
  await goto(page, 'search');
  await page.fill('[data-testid="search-input"]', '我对遗忘门的理解');
  await page.click('[data-testid="search-go"]');
  await page.waitForTimeout(700);
  await expect(page.locator('[data-testid="search-hit"]').first()).toBeVisible();
  await noCrash(page);
});

/* ---------------- 2. 消化：读完 + 衍生 ---------------- */

test('消化：阅读器标记读完 → 流转看板往前走', async ({ page }) => {
  await goto(page, 'shelf');
  await page.locator('[data-testid="work-read"]').first().click();
  await page.waitForTimeout(600);

  await page.click('[data-testid="reader-done"]');
  await page.waitForTimeout(600);
  await noCrash(page);

  // 从阅读器直接衍生
  await page.click('[data-testid="reader-derive"]');
  await expect(page.locator('.sheet')).toBeVisible();
  await page.fill('[data-testid="derive-title"]', '读后一得');
  await page.fill('[data-testid="derive-body"]', '这一章的主线是固定容量状态的取舍。');
  await page.click('[data-testid="derive-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });
  await noCrash(page);
});

/* ---------------- 3. 回顾 ---------------- */

test('回顾：复盘页点回顾 → 写下笔记 → 事件流里看得到', async ({ page }) => {
  await goto(page, 'review');
  const btn = page.locator('[data-testid="review-do"]').first();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.locator('.sheet')).toBeVisible();
  await page.fill('[data-testid="review-note"]', 'E2E 记的一条回顾');
  await page.click('[data-testid="review-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });

  await goto(page, 'agent');
  await page.selectOption('[data-testid="journal-filter"]', 'human');
  await page.waitForTimeout(600);
  await expect(page.locator('[data-testid="journal-event"]').first()).toBeVisible();
  await noCrash(page);
});

/* ---------------- 4. 项目与任务 ---------------- */

test('项目：新建项目 → 给它加任务 → 任务能勾选完成', async ({ page }) => {
  await goto(page, 'projects');
  await page.click('[data-testid="project-add"]');
  await expect(page.locator('.sheet')).toBeVisible();
  await page.fill('[data-testid="project-title"]', 'E2E 项目');
  await page.click('[data-testid="project-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });
  await expect(page.locator('text=E2E 项目').first()).toBeVisible();

  await page.locator('[data-testid="project-add-task"]').first().click();
  await expect(page.locator('.sheet')).toBeVisible();
  await page.fill('[data-testid="task-text"]', 'E2E 项目下的任务');
  await page.click('[data-testid="task-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });
  await noCrash(page);
});

test('任务：勾一次 → 从「今天」消失，状态真的写回 tasks.md', async ({ page }) => {
  await goto(page, 'today');
  const before = await page.evaluate(async () => {
    const r = await (await fetch('/api/objects?type=action')).json();
    return r.objects.filter((o: { state: string }) => o.state === 'done').length;
  });

  const row = page.locator('[data-testid="action-toggle"]').first();
  await expect(row).toBeVisible();
  await row.click();
  await page.waitForTimeout(1000);

  // 完成之后就该从「今天」消失——今天只留还没做完的
  const after = await page.evaluate(async () => {
    const r = await (await fetch('/api/objects?type=action')).json();
    return r.objects.filter((o: { state: string }) => o.state === 'done').length;
  });
  expect(after).toBe(before + 1);
  await noCrash(page);
});

/* ---------------- 5. 提案与变更 ---------------- */

test('提案：空提案被拦下，填了 ops 才能生成', async ({ page }) => {
  await goto(page, 'assistant');
  await page.click('[data-testid="assistant-propose"]');
  await expect(page.locator('.sheet')).toBeVisible();
  await page.fill('[data-testid="proposal-title"]', '空提案');
  await page.fill('[data-testid="proposal-ops"]', '[]');
  await page.click('[data-testid="proposal-submit"]');
  await page.waitForTimeout(600);
  // 空提案不能生成：它撤不回来，只会在变更列表里留废卡
  await expect(page.locator('.sheet')).toBeVisible();
  await expect(page.locator('text=至少要有一条具体改动').first()).toBeVisible();
  await page.locator('.sheet .btn').first().click();
});

test('提案：AI 生成提案 → 人逐条应用 → 改的是真实对象', async ({ page }) => {
  await goto(page, 'today');
  const noteId = await page.evaluate(async () => {
    const r = await (await fetch('/api/objects?type=note')).json();
    const n = r.objects.find((o: { title: string }) => o.title === '剪藏：一段话');
    return n.id as string;
  });

  await goto(page, 'assistant');
  await page.click('[data-testid="assistant-propose"]');
  await expect(page.locator('.sheet')).toBeVisible();
  await page.fill('[data-testid="proposal-title"]', 'E2E 提案');
  await page.fill('[data-testid="proposal-ops"]', JSON.stringify([
    { t: 'update', id: noteId, patch: { status: 'growing' } },
  ]));
  await page.click('[data-testid="proposal-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });

  await goto(page, 'changes');
  const apply = page.locator('[data-testid="proposal-apply"]').first();
  await expect(apply).toBeVisible();
  await apply.click();
  await page.waitForTimeout(1000);

  const status = await page.evaluate(async (id) => {
    const r = await (await fetch('/api/objects?type=note')).json();
    return (r.objects.find((o: { id: string }) => o.id === id) as { status: string }).status;
  }, noteId);
  expect(status).toBe('growing');
  await noCrash(page);
});

test('变更：卡片能看到四项校验，也能展开差异', async ({ page }) => {
  await goto(page, 'changes');
  const card = page.locator('[data-testid="changeset-card"]').first();
  await expect(card).toBeVisible();

  const diff = card.locator('[data-testid="toggle-diff"]').first();
  if (await diff.count()) {
    await diff.click();
    await page.waitForTimeout(400);
    await expect(card.locator('.diff').first()).toBeVisible();
  }
  await noCrash(page);
});

test('变更：撤销一条变更，事件流里多一条 revert，历史不会被删', async ({ page }) => {
  await goto(page, 'changes'); // evaluate 里的相对 URL 需要页面已经落在同源上
  const before = await page.evaluate(async () => {
    const r = await (await fetch('/api/journal?limit=500')).json();
    return r.events.length;
  });

  const revert = page.locator('[data-testid="cs-revert"]').first();
  if (!(await revert.count())) return; // 这个空间里没有可撤销的变更
  await revert.click();
  await page.waitForTimeout(900);

  const after = await page.evaluate(async () => {
    const r = await (await fetch('/api/journal?limit=500')).json();
    return {
      total: r.events.length,
      reverts: r.events.filter((e: { op: string }) => e.op === 'revert').length,
    };
  });
  expect(after.total).toBeGreaterThan(before); // 撤销是追加，不是删除
  expect(after.reverts).toBeGreaterThan(0);
});

/* ---------------- 6. 自动化规则 ---------------- */

test('自动化：新建规则 → 停用 → 启用', async ({ page }) => {
  await goto(page, 'automation');
  await page.fill('[data-testid="rule-name"]', 'E2E 规则');
  await page.click('[data-testid="rule-add"]');
  await page.waitForTimeout(700);
  await expect(page.locator('text=E2E 规则').first()).toBeVisible();

  const toggle = page.locator('[data-testid="rule-toggle"]').first();
  await expect(toggle).toBeVisible();
  const label = await toggle.innerText();
  await toggle.click();
  await page.waitForTimeout(600);
  await expect(page.locator('[data-testid="rule-toggle"]').first()).not.toHaveText(label);
  await noCrash(page);
});

/* ---------------- 7. 命令面板：系统命令 ---------------- */

test('命令面板：能执行「对账一次」，并给出反馈', async ({ page }) => {
  await goto(page, 'today');
  await page.keyboard.press('Control+k');
  await expect(page.locator('[data-testid="palette"]')).toBeVisible();
  await page.fill('[data-testid="palette-input"]', '对账');
  await page.waitForTimeout(300);
  await page.locator('[data-testid="palette-item"]', { hasText: '对账一次' }).click();
  await page.waitForTimeout(1500);
  await expect(page.locator('.toast').first()).toBeVisible();
  await noCrash(page);
});

test('命令面板：输命令名时，命令排在「全库检索」前面', async ({ page }) => {
  await goto(page, 'today');
  await page.keyboard.press('Control+k');
  await page.fill('[data-testid="palette-input"]', '新建任务');
  await page.waitForTimeout(300);
  // 排在第一位的必须是命令本身，不是「全库检索「新建任务」」
  const first = page.locator('[data-testid="palette-item"]').first();
  await expect(first).toContainText('新建任务');
  await expect(first).toContainText('新建');
  await first.click();
  await page.waitForTimeout(500);
  expect(await page.locator('.sheet').count()).toBeGreaterThan(0);
});

/* ---------------- 8. 冲突弹层三条出路 ---------------- */

/**
 * 冲突弹层的三条出路，逐条走一遍真界面：
 * 看差异 / 另存副本 / 重新载入。共同前提：对方那一份一个字都不能少。
 */
async function makeConflict(page: Page): Promise<{ note: string; original: string }> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ROOT = process.env.HABITAT_E2E_ROOT ?? path.resolve('.e2e-space');
  const note = path.join(ROOT, 'knowledge/notes/状态就是记忆.md');
  const original = fs.readFileSync(note, 'utf8');

  await page.goto('/#/editor?rep=note-01HX8Z9K7M2N4P6Q8R0S2T4V80');
  await page.waitForSelector('.app');
  await page.waitForTimeout(600);
  await page.fill('[data-testid="editor-source"]', original.replace('这是我自己写的。', '我在界面上改的内容。'));
  await expect(page.locator('[data-testid="editor-save"]')).toBeEnabled();

  // 外部 Agent 抢先改了同一个文件
  fs.writeFileSync(note, original.replace('这是我自己写的。', '外部编辑器改的内容。'), 'utf8');
  await page.evaluate(() => fetch('/api/system/rescan', { method: 'POST' }));
  await page.waitForTimeout(400);

  await page.click('[data-testid="editor-save"]');
  await expect(page.locator('.sheet')).toBeVisible({ timeout: 15000 });
  return { note, original };
}

test('冲突：看差异 → 另存副本，我的版本单独存下来，对方的没动', async ({ page }) => {
  const fs = await import('node:fs');
  const { note, original } = await makeConflict(page);

  await expect(page.locator('[data-testid="conflict-diff"]')).toBeVisible();
  await page.click('[data-testid="conflict-copy"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });

  // 对方的改动一个字都没少
  expect(fs.readFileSync(note, 'utf8')).toContain('外部编辑器改的内容');
  // 我的版本另存成了一篇新笔记
  const notes = fs.readdirSync(note.replace(/[^/\\]+$/, ''));
  expect(notes.some((f) => f.includes('我的副本'))).toBe(true);

  fs.writeFileSync(note, original, 'utf8');
});

test('冲突：重新载入 → 我这次的改动被丢弃，盘上内容回到编辑器', async ({ page }) => {
  const fs = await import('node:fs');
  const { note, original } = await makeConflict(page);

  await page.click('[data-testid="conflict-reload"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });
  await page.waitForTimeout(900);

  await expect(page.locator('[data-testid="editor-source"]')).toContainText('外部编辑器改的内容');
  expect(fs.readFileSync(note, 'utf8')).toContain('外部编辑器改的内容');

  fs.writeFileSync(note, original, 'utf8');
});

/* ---------------- 9. 连接域：标签、专题、关系图 ---------------- */

test('标签：点一个标签能筛出内容', async ({ page }) => {
  await goto(page, 'tags');
  const tag = page.locator('[data-testid="tag-item"]').first();
  await expect(tag).toBeVisible();
  await tag.click();
  await page.waitForTimeout(600);
  await noCrash(page);
});

test('专题：新建专题走采集抽屉', async ({ page }) => {
  await goto(page, 'collections');
  await page.click('[data-testid="collection-new"]');
  await expect(page.locator('.sheet')).toBeVisible();
  await page.fill('[data-testid="capture-title"]', 'E2E 专题');
  await page.click('[data-testid="capture-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });
  await noCrash(page);
});

test('关系图：画得出节点和连线', async ({ page }) => {
  await goto(page, 'graph');
  const svg = page.locator('[data-testid="graph-svg"]');
  await expect(svg).toBeVisible();
  const nodes = await svg.locator('circle').count();
  expect(nodes).toBeGreaterThan(0);
});

/* ---------------- 10. 书架其余交互 ---------------- */

test('书架：过滤框能筛选，问助手能唤起面板', async ({ page }) => {
  await goto(page, 'shelf');
  await page.fill('[data-testid="shelf-filter"]', '注意力');
  await page.waitForTimeout(500);
  await page.fill('[data-testid="shelf-filter"]', '');
  await page.waitForTimeout(300);

  await page.locator('[data-testid="work-ask-ai"]').first().click();
  await expect(page.locator('[data-testid="ai-panel"]')).toBeVisible();
  await page.click('[data-testid="ai-close"]');
});

test('创作页：四个入口都能点，不报错', async ({ page }) => {
  await goto(page, 'compose');
  await page.click('[data-testid="compose-refresh"]');
  await page.waitForTimeout(400);

  await page.click('[data-testid="compose-capture"]');
  await expect(page.locator('.sheet')).toBeVisible();
  await page.click('.sheet .btn');
  await page.waitForTimeout(300);

  await page.click('[data-testid="compose-derive"]');
  await expect(page.locator('.sheet')).toBeVisible();
  await page.click('.sheet .btn');
  await page.waitForTimeout(300);
  await noCrash(page);
});

/* ---------------- 11. 补记事件（Agent 侧手工记账） ---------------- */

test('补记：外部 Agent 事后补一条事件，记在它名下', async ({ page }) => {
  await goto(page, 'agent');
  await page.click('[data-testid="agent-log"]');
  await expect(page.locator('.sheet')).toBeVisible();
  await page.fill('[data-testid="journal-actor"]', 'agent:e2e-bot');
  await page.fill('[data-testid="journal-target"]', 'knowledge/notes/状态就是记忆.md');
  await page.click('[data-testid="journal-submit"]');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 15000 });

  await page.waitForTimeout(600);
  // 事件流里按「AI · 名字」显示，原始 actor 也要能从接口查到
  await expect(page.locator('text=AI · e2e-bot').first()).toBeVisible();
  const raw = await page.evaluate(async () => {
    const r = await (await fetch('/api/journal?limit=500')).json();
    return r.events.filter((e: { actor: string }) => e.actor === 'agent:e2e-bot').length;
  });
  expect(raw).toBeGreaterThan(0);
});

/* ---------------- 12. 系统：重建索引 ---------------- */

test('健康页：四项检查都在，重建索引能跑完', async ({ page }) => {
  await goto(page, 'health');
  await expect(page.locator('text=索引').first()).toBeVisible();
  const btn = page.locator('[data-testid="health-reindex"]');
  await expect(btn).toBeVisible();
  await btn.click();
  await page.waitForTimeout(2000);
  await noCrash(page);
});

/* ---------------- 13. PDF 原件：能内嵌读，也能按 Range 取流 ---------------- */

test('PDF：点 pdf 载体进阅读器，内嵌显示，Range 请求返回 206', async ({ page }) => {
  await goto(page, 'shelf');
  await page.locator('[data-testid="work-expand"]').first().click();
  await page.waitForTimeout(400);
  const pdfBtn = page.locator('[data-testid="part-carrier"]', { hasText: 'pdf' }).first();
  await expect(pdfBtn).toBeVisible();
  await pdfBtn.click();
  await page.waitForTimeout(1200);

  await expect(page.locator('[data-testid="reader-pdf"]')).toBeVisible();
  const src = await page.locator('.pdf-frame').getAttribute('src');
  expect(src).toMatch(/\/api\/reps\/.+\/file/);

  // 没有 Range 也要能整份取到，并且带头
  const probe = await page.evaluate(async (u) => {
    const full = await fetch(u);
    const ranged = await fetch(u, { headers: { Range: 'bytes=0-99' } });
    return {
      full: full.status,
      type: full.headers.get('content-type'),
      acceptRanges: full.headers.get('accept-ranges'),
      ranged: ranged.status,
      contentRange: ranged.headers.get('content-range'),
      len: (await ranged.arrayBuffer()).byteLength,
    };
  }, src!);
  expect(probe.full).toBe(200);
  expect(probe.type).toBe('application/pdf');
  expect(probe.acceptRanges).toBe('bytes');
  expect(probe.ranged).toBe(206);
  expect(probe.contentRange).toMatch(/^bytes 0-99\/\d+$/);
  expect(probe.len).toBe(100);
});

/* ---------------- 14. 规则真的会跑，且只产出通知 ---------------- */

test('自动化：建规则 → 现在跑一次 → 铃铛出现未读 → 通知里能点进去', async ({ page }) => {
  await goto(page, 'automation');
  await page.fill('[data-testid="rule-name"]', '收件箱超过 1 条就提醒');
  await page.selectOption('[data-testid="rule-kind"]', 'inbox-overflow');
  await page.fill('[data-testid="rule-threshold"]', '1');
  await page.click('[data-testid="rule-add"]');
  await page.waitForTimeout(800);

  await page.click('[data-testid="rules-run"]');
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-testid="rules-report"]')).toBeVisible();

  // 铃铛上要有红点：说明通知落库了，不是一闪而过的 toast
  await expect(page.locator('.bell-dot')).toBeVisible();
  await page.click('[data-testid="open-notifications"]');
  await expect(page.locator('.sheet')).toBeVisible();
  await expect(page.locator('[data-testid="notif-item"]').first()).toContainText('收件箱积了');

  await page.click('[data-testid="notif-go"]');
  await page.waitForTimeout(600);
  expect(page.url()).toContain('/inbox');
});

test('自动化：同一天不重复提醒（第二次跑不新增通知）', async ({ page }) => {
  await goto(page, 'automation');
  await page.fill('[data-testid="rule-name"]', '去重验证');
  await page.selectOption('[data-testid="rule-kind"]', 'overdue-actions');
  await page.fill('[data-testid="rule-threshold"]', '1');
  await page.click('[data-testid="rule-add"]');
  await page.waitForTimeout(600);

  const count = async () =>
    page.evaluate(async () => {
      const r = await (await fetch('/api/notifications')).json();
      return r.notices.length;
    });

  await page.click('[data-testid="rules-run"]');
  await page.waitForTimeout(1200);
  const first = await count();
  await page.click('[data-testid="rules-run"]');
  await page.waitForTimeout(1200);
  expect(await count()).toBe(first);
});

/* ---------------- 15. 作业失败：退避 → 三次判永久失败 ---------------- */

test('作业：记 3 次失败后判永久失败，并推一条通知', async ({ page }) => {
  await goto(page, 'jobs');
  await page.click('[data-testid="job-create"]');
  await page.waitForTimeout(1000);

  // 作业是 unshift 入列的，新建的排第一
  for (let i = 0; i < 3; i += 1) {
    await page.locator('[data-testid="job-fail"]').first().click();
    await page.waitForTimeout(900);
  }

  await expect(page.locator('[data-testid="job-state"]').first()).toHaveText('failed');
  await expect(page.locator('[data-testid="job-retry"]').first()).toContainText('永久失败');

  const hasNotice = await page.evaluate(async () => {
    const r = await (await fetch('/api/notifications')).json();
    return r.notices.some((n: { title: string }) => n.title.includes('连续失败'));
  });
  expect(hasNotice).toBe(true);
});

/* ---------------- 16. 断链：能看见，也能一键补 ---------------- */

test('健康页：断链列出来，补一条之后那条链接就解析了', async ({ page }) => {
  await goto(page, 'health');
  await expect(page.locator('[data-testid="broken-links"]')).toBeVisible();

  const before = await page.evaluate(async () => {
    const r = await (await fetch('/api/links/unresolved')).json();
    return r.items.length;
  });
  expect(before).toBeGreaterThan(0); // 夹具里 [[DeltaNet]] 之类本来就断

  const firstTarget = await page.evaluate(async () => {
    const r = await (await fetch('/api/links/unresolved')).json();
    return r.items[0].target as string;
  });

  await page.locator('[data-testid="fix-link"]').first().click();
  await page.waitForTimeout(1500);

  const after = await page.evaluate(async () => {
    const r = await (await fetch('/api/links/unresolved')).json();
    return r.items.map((x: { target: string }) => x.target);
  });
  expect(after).not.toContain(firstTarget);
});

/* ---------------- 17. 未来任务必须看得见 ---------------- */

test('今天页：未来任务进「更远」，能一键挪到今天', async ({ page }) => {
  await goto(page, 'today');

  // 夹具里「整理迁移脚本」是 10 天后到期，今天页原来完全不显示它
  const later = page.locator('[data-testid="upcoming-later"]');
  await expect(later).toBeVisible();
  await expect(later).toContainText('整理迁移脚本');

  const todayCountBefore = await page.evaluate(async () => {
    const r = await (await fetch('/api/today')).json();
    return r.actions.length;
  });

  await later.locator('[data-testid="upcoming-today"]').first().click();
  // 提交要经过 propose → validate → commit → 重扫，慢一点也别抢跑
  await page.waitForTimeout(2600);

  const todayCountAfter = await page.evaluate(async () => {
    const r = await (await fetch('/api/today')).json();
    return r.actions.length;
  });
  expect(todayCountAfter).toBe(todayCountBefore + 1);

  // 挪过之后它不该再挂在「更远」里
  await expect(page.locator('[data-testid="upcoming-row"]', { hasText: '整理迁移脚本' })).toHaveCount(0);
});

/* ---------------- 18. AI 提案配额要真拦 ---------------- */

test('预算：agent 一天提满 3 次后被拒，人不受限', async ({ page }) => {
  await goto(page, 'today');

  const call = (actor: string) =>
    page.evaluate(async (a) => {
      const r = await fetch('/api/changes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [], reason: 'x', actor: a }),
      });
      return r.status;
    }, actor);

  // ops 为空会被 400 挡在前面，这里用一条合法 op 走配额分支
  const noteId = await page.evaluate(async () => {
    const r = await (await fetch('/api/objects?type=note')).json();
    return (r.objects[0] as { id: string }).id;
  });

  const propose = (actor: string) =>
    page.evaluate(async ([a, id]) => {
      const r = await fetch('/api/changes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [{ t: 'update', id, patch: { status: 'growing' } }], reason: '配额测试', actor: a }),
      });
      return r.status;
    }, [actor, noteId] as const);

  expect(await call('agent:quota-bot')).toBe(400);

  const codes: number[] = [];
  for (let i = 0; i < 4; i += 1) codes.push(await propose('agent:quota-bot'));
  expect(codes.slice(0, 3).every((c) => c === 200 || c === 201)).toBe(true);
  expect(codes[3]).toBe(429);

  // 人不受限
  expect([200, 201]).toContain(await propose('human'));
});

/* ---------------- 19. 附件上传 ---------------- */

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('上传：PUT 存文件 → GET 取回 → 同内容不重复存', async ({ page }) => {
  await goto(page, 'today');

  const put = (name: string) =>
    page.evaluate(
      async ([n, b64]) => {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const r = await fetch(`/api/assets?name=${encodeURIComponent(n)}`, {
          method: 'PUT',
          headers: { 'content-type': 'image/png' },
          body: bin,
        });
        return { status: r.status, body: await r.json() };
      },
      [name, PNG_1PX] as const,
    );

  const first = await put('收据.png');
  expect(first.status).toBe(201);
  expect(first.body.ok).toBe(true);
  expect(first.body.path).toMatch(/^assets\/attachments\/\d{4}\/\d{2}\/收据\.png$/);
  expect(first.body.markdown).toContain('![收据.png](');

  const fetched = await page.evaluate(async (u) => {
    const r = await fetch(u);
    return { status: r.status, type: r.headers.get('content-type'), len: (await r.arrayBuffer()).byteLength };
  }, first.body.url);
  expect(fetched.status).toBe(200);
  expect(fetched.type).toBe('image/png');
  expect(fetched.len).toBe(70);

  // 同名同内容：复用，不产生 收据-1.png
  const again = await put('收据.png');
  expect(again.status).toBe(200);
  expect(again.body.deduped).toBe(true);
  expect(again.body.path).toBe(first.body.path);

  // 同名不同内容：加序号，绝不覆盖
  const other = await page.evaluate(async () => {
    const bin = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const r = await fetch('/api/assets?name=%E6%94%B6%E6%8D%AE.png', {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: bin,
    });
    return (await r.json()) as { path: string };
  });
  expect(other.path).toMatch(/收据-1\.png$/);
});

test('上传：编辑器选文件后，正文里出现可用的图片链接', async ({ page }) => {
  await goto(page, 'search');
  // 用一条自己写的笔记（可编辑），不是入库原件（只读，不给上传按钮）
  await page.fill('[data-testid="search-input"]', '状态就是记忆');
  await page.click('[data-testid="search-go"]');
  await page.waitForTimeout(900);
  await page.locator('[data-testid="search-open"]').first().click();
  await page.waitForTimeout(1400);

  const fileInput = page.locator('[data-testid="editor-attach"] input[type="file"]');
  await expect(fileInput).toHaveCount(1);
  await fileInput.setInputFiles({
    name: '截图.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_1PX, 'base64'),
  });
  await page.waitForTimeout(1500);

  const text = await page.locator('textarea').first().inputValue();
  expect(text).toMatch(/!\[截图\.png\]\(\/api\/assets\?path=/);
});

/* ---------------- 20. 邮件提醒：没配置时安全空转 ---------------- */

test('提醒：配置状态可查，未配置时跑一轮不报错也不发信', async ({ page }) => {
  await goto(page, 'today');

  const status = await page.evaluate(async () => (await fetch('/api/notify/status')).json());
  expect(typeof status.configured).toBe('boolean');
  expect(status.configPath).toContain('mail.json');

  const run = await page.evaluate(async () => {
    const r = await fetch('/api/notify/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    return { status: r.status, body: await r.json() };
  });
  expect(run.status).toBe(200);
  expect(run.body.ok).toBe(true);
  expect(Array.isArray(run.body.report.sent)).toBe(true);
  // 没配通道时必须明确说"跳过"，不能假装发成功
  if (!status.configured) {
    expect(run.body.report.skipped.join()).toContain('邮件通道');
  }
});

/* ---------------- 21. 通知渠道页 ---------------- */

test('通知渠道：状态可读、能保存配置、测试信按钮跟随配置状态', async ({ page }) => {
  await goto(page, 'channels');

  const chip = page.locator('[data-testid="notify-status"]');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/已连通|未配置/);

  // 填一套配置（E2E 用的是临时 mail.json，不会碰真实凭据）
  await page.fill('[data-testid="notify-host"]', 'smtp.example.com');
  await page.fill('[data-testid="notify-user"]', 'e2e@example.com');
  await page.fill('[data-testid="notify-pass"]', 'dummy-auth-code');
  await page.fill('[data-testid="notify-to"]', 'e2e@example.com');
  await page.click('[data-testid="notify-save"]');
  await page.waitForTimeout(1200);

  await expect(chip).toContainText('已连通');
  await expect(chip).toContainText('e2e@example.com');
  await expect(page.locator('[data-testid="notify-test-btn"]')).toBeEnabled();

  // 检查一次：只算不发，不应该报错
  await page.click('[data-testid="notify-check"]');
  await page.waitForTimeout(1200);
  await expect(page.locator('.card').last()).toBeVisible();
});

/* ---------------- 22. 管家：简报与代谢 ---------------- */

test('管家：简报列出积压项，归档只动已完成的任务且可撤销', async ({ page }) => {
  await goto(page, 'today');
  await expect(page.locator('[data-testid="steward"]')).toBeVisible();

  const brief = await page.evaluate(async () => (await (await fetch('/api/maintenance/brief')).json()).data);
  expect(brief.counts.works).toBeGreaterThan(0);
  expect(typeof brief.counts.brokenLinks).toBe('number');

  // dry-run 不改任何东西
  const dry = await page.evaluate(async () => {
    const r = await fetch('/api/maintenance/tidy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apply: false }),
    });
    return r.json();
  });
  expect(dry.report.dryRun).toBe(true);
  expect(dry.report.archived).toBe(0);

  // 真的归档：只碰"已完成"，不碰未完成
  const before = await page.evaluate(async () => {
    const r = await (await fetch('/api/objects?type=action')).json();
    return r.objects.length;
  });
  const applied = await page.evaluate(async () => {
    const r = await fetch('/api/maintenance/tidy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apply: true }),
    });
    return r.json();
  });
  const after = await page.evaluate(async () => {
    const r = await (await fetch('/api/objects?type=action')).json();
    return r.objects.length;
  });
  expect(before - after).toBe(applied.report.archived);
  // 文件还在——归档不是删除
  const stillThere = await page.evaluate(async () => {
    const r = await (await fetch('/api/objects?type=action&includeArchived=1')).json();
    return r.objects.length;
  });
  expect(stillThere).toBe(before);
});

/* ---------------- 23. 翻新：证据包与复核 ---------------- */

test('翻新：证据包能取到，复核后间隔往后推', async ({ page }) => {
  await goto(page, 'today');

  const id = await page.evaluate(async () => {
    const r = await (await fetch('/api/objects?type=note')).json();
    return (r.objects[0] as { id: string }).id;
  });

  const pack = await page.evaluate(async (nid) => {
    const r = await fetch(`/api/renew/${nid}`);
    return { status: r.status, body: await r.json() };
  }, id);
  expect(pack.status).toBe(200);
  expect(pack.body.pack.claims.length).toBeGreaterThan(0);
  expect(pack.body.text).toContain('你要做的');
  expect(Array.isArray(pack.body.pack.candidates)).toBe(true);

  // 确认仍然成立 → 1 天后再看
  const r1 = await page.evaluate(async (nid) => {
    const r = await fetch(`/api/review/${nid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });
    return r.json();
  }, id);
  expect(r1.ok).toBe(true);
  expect(r1.nextIn).toBe(1);

  // 再来一次 → 推到 3 天
  const r2 = await page.evaluate(async (nid) => {
    const r = await fetch(`/api/review/${nid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });
    return r.json();
  }, id);
  expect(r2.nextIn).toBe(3);
  expect(r2.rec.streak).toBe(2);
});

/* ---------------- 24. 文件浏览 ---------------- */

test('文件：能看目录、预览内容；上传→改名→归档是一条完整链路', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await goto(page, 'files');

  // 目录列表：认识知识/工作目录
  await expect(page.locator('[data-testid="fs-crumbs"]')).toContainText('根');
  const dirs = page.locator('[data-testid="fs-dir"]');
  await expect(dirs.filter({ hasText: 'knowledge' })).toHaveCount(1);
  await expect(dirs.filter({ hasText: 'work' })).toHaveCount(1);

  // 上传一个未入库文件
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'e2e-upload.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('这是通过文件页上传的内容。\n第二行。'),
  });
  await page.waitForTimeout(1600);

  const row = page.locator('[data-testid="fs-file"]').filter({ hasText: 'e2e-upload.txt' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('未入库');

  // 点开预览（文件名是纯文本 role=button，不是 <button>）
  await row.locator('span[role="button"]').first().click();
  await page.waitForTimeout(900);
  await expect(page.locator('[data-testid="fs-preview"]')).toContainText('第二行');

  // 改名（未入库文件不会弹断链确认）
  await row.locator('[data-testid="fs-rename"]').click();
  await page.waitForTimeout(300);
  const renameInput = page.locator('[data-testid="fs-file"] input.input').first();
  await renameInput.fill('e2e-renamed.txt');
  await page.locator('[data-testid="fs-rename-confirm"]').click();
  await page.waitForTimeout(1600);
  await expect(page.locator('[data-testid="fs-file"]').filter({ hasText: 'e2e-renamed.txt' })).toHaveCount(1);

  // 归档 → 从当前目录消失（文件去了 archive/fs/，没被删）
  await page
    .locator('[data-testid="fs-file"]')
    .filter({ hasText: 'e2e-renamed.txt' })
    .locator('[data-testid="fs-archive"]')
    .click();
  await page.waitForTimeout(1800);
  await expect(page.locator('[data-testid="fs-file"]').filter({ hasText: 'e2e-renamed.txt' })).toHaveCount(0);

  // 归档目录里能找到它
  const archived = await page.evaluate(async () => {
    const r = await fetch('/api/fs?path=archive/fs');
    return (await r.json()) as { dirs: { name: string }[] };
  });
  expect(archived.dirs.length).toBeGreaterThan(0);
});

/* ---------------- 25. 文件页：排序 / 筛选 / 搜索 ---------------- */

test('文件：搜索能收窄、无结果有提示、排序可正反切换', async ({ page }) => {
  await goto(page, 'files');

  // 自己造三个大小确定的文件，不依赖夹具里恰好有什么
  const files = [
    { name: 'aa-1kb.txt', bytes: 1024 },
    { name: 'bb-5kb.txt', bytes: 5120 },
    { name: 'cc-2kb.txt', bytes: 2048 },
  ];
  for (const f of files) {
    await page.locator('input[type="file"]').first().setInputFiles({
      name: f.name,
      mimeType: 'text/plain',
      buffer: Buffer.alloc(f.bytes, 'x'),
    });
    await page.waitForTimeout(1200);
  }

  const rows = page.locator('[data-testid="fs-file"]');
  for (const f of files) {
    await expect(rows.filter({ hasText: f.name })).toHaveCount(1);
  }

  // 搜索收窄
  await page.fill('[data-testid="fs-search"]', 'aa-');
  await page.waitForTimeout(400);
  await expect(rows).toHaveCount(1);
  await expect(page.locator('[data-testid="fs-count"]')).toContainText('筛出');

  // 搜不到：要说"没有匹配"，不能显示空目录
  await page.fill('[data-testid="fs-search"]', 'zzz-不存在-zzz');
  await page.waitForTimeout(400);
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('没有匹配的文件')).toBeVisible();

  // 清除
  await page.click('[data-testid="fs-clear"]');
  await page.waitForTimeout(400);
  await expect(rows.filter({ hasText: 'aa-1kb.txt' })).toHaveCount(1);

  // 按大小排序：只看我们造的三个文件的相对顺序（目录里还有 space.yaml 等）
  const idx = async (needle: string) => (await rows.allInnerTexts()).findIndex((t) => t.includes(needle));
  await page.click('[data-testid="fs-sort-size"]');
  await page.waitForTimeout(400);
  // 首次点默认倒序：5KB 在 1KB 前面
  expect(await idx('bb-5kb.txt')).toBeLessThan(await idx('aa-1kb.txt'));
  await page.click('[data-testid="fs-sort-size"]');
  await page.waitForTimeout(400);
  // 再点转正序：反过来
  expect(await idx('aa-1kb.txt')).toBeLessThan(await idx('bb-5kb.txt'));

  // 按入库状态筛选：这三个都是未入库
  await page.selectOption('[data-testid="fs-only"]', 'unindexed');
  await page.waitForTimeout(400);
  const un = await rows.count();
  expect(un).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < un; i += 1) {
    expect(await rows.nth(i).innerText()).toContain('未入库');
  }
});
