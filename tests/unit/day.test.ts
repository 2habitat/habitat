/**
 * 当日对账：计划 vs 实际。
 *
 * 这些断言锁的是三件容易退化的行为：
 *   1. 阅读 / 编辑事件确实会被归并到对象上（而不是只留一条 cursors.json）。
 *   2. 任务写了 [refs::] 时，今天动过那份材料能被判成「可能已完成」。
 *   3. 计划全没碰、但有计划外投入时，简报必须把这件事说出来。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Habitat } from '../../server/core/space.ts';
import type { Rep } from '../../shared/types.ts';
import { makeSpace, rmSpace, D_TODAY, R1, N1 } from '../helpers/space.ts';
import { collectDayActivity, reconcileDay, renderDayLines } from '../../server/core/activity.ts';
import { collectBrief, renderBrief } from '../../server/core/tidy.ts';
import { runLoop } from '../../server/core/loops.ts';

let dir: string;
let hab: Habitat;

beforeEach(async () => {
  dir = await makeSpace();
  hab = await Habitat.open(dir, { fresh: true });
});

afterEach(async () => {
  hab.close();
  await rmSpace(dir);
});

describe('当日对账：行为记录', () => {
  it('阅读进度归并到章，而不是按 1.2 秒一条铺开', async () => {
    await hab.setCursor(R1, 0.4);
    await hab.setCursor(R1, 1);

    const partId = hab.store.get<Rep>(R1)!.partId;
    const a = await collectDayActivity(hab, D_TODAY);
    const hit = a.hits.find((h) => h.id === partId);
    expect(hit, '读到的那一章应该出现在活动里').toBeTruthy();
    expect(hit!.ops).toContain('read');
    expect(hit!.readPct).toBe(1);
    // 两次进度只算一个对象，不是两条并列的活动
    expect(a.hits.filter((h) => h.id === partId)).toHaveLength(1);
    expect(hit!.events).toBe(2);
  });

  it('任务点名了材料：今天动过那份材料 → 可能已完成', async () => {
    const r = await hab.addAction({ text: '写完线性注意力这一节', due: D_TODAY, flow: 'now' });
    await hab.commitOps([{ t: 'update', id: r.id, patch: { refs: ['线性注意力'] } }], 'human', '挂上资料');
    await hab.rescan();
    await hab.setCursor(R1, 1);

    const day = await reconcileDay(hab, D_TODAY);
    const item = day.planned.find((p) => p.id === r.id)!;
    expect(item.status).toBe('covered');
    expect(item.evidence[0].kind).toBe('ref');
    expect(item.evidence[0].objectId).toBe(hab.store.get<Rep>(R1)!.partId);
  });

  it('没写 refs 但任务行和章节同名：只判「今天动过」，不越级说完成', async () => {
    await hab.setCursor(R1, 0.5);
    const day = await reconcileDay(hab, D_TODAY);
    // fixture 里今天那条是「读《AI Infra 进阶》第一遍」，没写 refs
    const item = day.planned.find((p) => p.text.includes('AI Infra'))!;
    expect(item.status).toBe('touched');
    expect(item.evidence.some((e) => e.kind === 'lexical')).toBe(true);
  });

  it('同一项目下的无关待办不会被项目级活动误标', async () => {
    const project = hab.store.all('project')[0];
    const hitTask = await hab.addAction({ text: '写完线性注意力这一节', due: D_TODAY, flow: 'now', projectId: project.id });
    await hab.commitOps([{ t: 'update', id: hitTask.id, patch: { refs: ['线性注意力'] } }], 'human', '挂上资料');
    const other = await hab.addAction({ text: '整理迁移脚本', due: D_TODAY, flow: 'now', projectId: project.id });
    await hab.rescan();
    await hab.setCursor(R1, 1);

    const day = await reconcileDay(hab, D_TODAY);
    expect(day.planned.find((p) => p.id === hitTask.id)!.status).toBe('covered');
    expect(day.planned.find((p) => p.id === other.id)!.status, '同一项目 ≠ 同一条任务').toBe('idle');
  });

  it('一整天没碰的任务和计划外投入都要被列出来', async () => {
    const idle = await hab.addAction({ text: '整理迁移脚本', due: D_TODAY, flow: 'now' });
    await hab.commitOps([{ t: 'setBody', id: N1, body: '今天补的一段。' }], 'human', '补笔记');
    await hab.rescan();

    const day = await reconcileDay(hab, D_TODAY);
    expect(day.planned.find((p) => p.id === idle.id)!.status).toBe('idle');
    expect(day.unplanned.some((h) => h.id === N1), '计划外改的笔记不能被丢掉').toBe(true);
    expect(day.unplanned.find((h) => h.id === N1)!.ops).toContain('edit');
  });

  it('简报里「实际」排在「待办」之后、且原样带证据', async () => {
    await hab.setCursor(R1, 1);
    const text = renderBrief(await collectBrief(hab));
    expect(text).toContain('## 今天实际');
    expect(text).toContain('## 待办对账');
    expect(text.indexOf('## 今天实际')).toBeLessThan(text.indexOf('## 待办对账'));
    expect(text).toContain('最远 100%');
  });

  it('计划全没碰但有计划外投入：明确说「今天没有按计划走」', async () => {
    // 只留下一条今天到期、且词面/材料都对不上的任务
    const r = await hab.addAction({ text: '整理迁移脚本', due: D_TODAY, flow: 'now' });
    await hab.commitOps([{ t: 'setBody', id: N1, body: '今天补的一段。' }], 'human', '补笔记');
    await hab.rescan();

    const day = await reconcileDay(hab, D_TODAY);
    const lines = renderDayLines(day).join('\n');
    // fixture 里那条「读 AI Infra」会被词面命中，所以这里只断言最该说的那句出现
    expect(day.planned.some((p) => p.id === r.id && p.status === 'idle')).toBe(true);
    expect(lines).toContain('今天没碰：整理迁移脚本');
    expect(lines).toContain('今天没有按计划走');
    expect(lines).toContain('## 计划外投入');
    expect(lines).toContain('状态就是记忆');
  });

  it('闭环跑完写回执，计数对得上', async () => {
    await hab.setCursor(R1, 1);
    const r = await runLoop(hab, 'day-reconcile', { actor: 'human' });
    expect(r.ran).toBe(true);
    expect(r.counts?.events).toBeGreaterThan(0);
    expect(r.counts?.active).toBeGreaterThan(0);
    expect(r.counts?.planned).toBeGreaterThan(0);
  });
});
