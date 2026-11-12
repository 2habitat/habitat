/**
 * doneAt 闭环。
 *
 * 之前「已完成 30 天归档」永远 0 候选，根因不是漏传参数：
 * 行内任务写回时根本不落 [done::]，读回来也不认，连 CLI 传的 doneAt
 * 都会在重启后丢。这些断言锁住「写得出、读得回、重开清得掉、老数据补得上」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Habitat } from '../../server/core/space.ts';
import type { Action } from '../../shared/types.ts';
import { nowISO } from '../../shared/id.ts';
import { makeSpace, rmSpace } from '../helpers/space.ts';
import { collectBrief, runTidy } from '../../server/core/tidy.ts';

const TASKS = 'work/actions/tasks.md';
const OPEN = 'act-20261029-07';
const LEGACY_DONE = 'act-20261029-09';

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

function raw(): Promise<string> {
  return fs.readFile(path.join(dir, TASKS), 'utf8');
}

async function setDone(id: string, state: 'done' | 'open', extra: Record<string, unknown> = {}) {
  await hab.commitOps([{ t: 'update', id, patch: { state, ...extra } }], 'human', `改任务状态：${id}`);
  await hab.rescan();
}

describe('doneAt：写入与回读', () => {
  it('界面只传 state=done 时，服务端补完成时间并落到 [done::]，重扫不丢', async () => {
    await setDone(OPEN, 'done');
    const a = hab.store.get<Action>(OPEN)!;
    expect(a.state).toBe('done');
    expect(a.doneAt, '完成时间必须自动补上').toBeTruthy();
    expect(Number.isNaN(Date.parse(a.doneAt!))).toBe(false);
    expect(await raw()).toContain(`[done:: ${a.doneAt}]`);
  });

  it('重新打开时清掉完成时间，行里也不留旧标记', async () => {
    await setDone(OPEN, 'done');
    expect(await raw()).toContain('[done::');
    await setDone(OPEN, 'open');
    expect(hab.store.get<Action>(OPEN)!.doneAt).toBeFalsy();
    expect(await raw()).not.toContain('[done::');
  });

  it('调用方显式给了 doneAt 就尊重它（CLI / 迁移会用）', async () => {
    const at = '2026-01-02T03:04:05+08:00';
    await setDone(OPEN, 'done', { doneAt: at });
    expect(hab.store.get<Action>(OPEN)!.doneAt).toBe(at);
    expect(await raw()).toContain(`[done:: ${at}]`);
  });

  it('直接 create 一条已完成任务，也带完成时间', async () => {
    const obj: Action = {
      type: 'action',
      id: 'act-created-done',
      schema: 1,
      spaceId: hab.store.space.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      author: 'human',
      sensitivity: 'private',
      rev: 1,
      text: '新建即完成',
      flow: 'now',
      state: 'done',
    };
    await hab.commitOps([{ t: 'create', obj }], 'human', '新建已完成任务');
    await hab.rescan();
    expect(hab.store.get<Action>('act-created-done')!.doneAt).toBeTruthy();
    expect(await raw()).toContain('[done::');
  });

  it('完成时间够老时，真的会被收进归档候选', async () => {
    const md = await raw();
    await fs.writeFile(
      path.join(dir, TASKS),
      md.replace(`^${LEGACY_DONE}`, `[done:: 2026-01-01] ^${LEGACY_DONE}`),
      'utf8',
    );
    await hab.rescan();
    expect(hab.store.get<Action>(LEGACY_DONE)!.doneAt).toBe('2026-01-01');
    const b = await collectBrief(hab);
    expect(b.archiveCandidates.some((a) => a.id === LEGACY_DONE)).toBe(true);
  });
});

describe('doneAt：历史数据回填', () => {
  it('dry-run 只报数不落盘', async () => {
    const r = await runTidy(hab, { dryRun: true });
    expect(r.undated).toBe(1);
    expect(r.backfilled).toBe(0);
    expect(await raw()).not.toContain('[done::');
  });

  it('--apply 补写 [done::]，且第二次不再重复回填', async () => {
    const r = await runTidy(hab, { dryRun: false });
    expect(r.error).toBeUndefined();
    expect(r.backfilled).toBe(1);
    expect(hab.store.get<Action>(LEGACY_DONE)!.doneAt).toBeTruthy();
    expect(await raw()).toContain('[done::');

    const again = await runTidy(hab, { dryRun: true });
    expect(again.undated, '回填是幂等的').toBe(0);
    expect(again.backfilled).toBe(0);
  });

  it('回填之后新勾的任务仍会拿到自己的完成时间', async () => {
    await runTidy(hab, { dryRun: false });
    const backfilled = hab.store.get<Action>(LEGACY_DONE)!.doneAt;
    await setDone(OPEN, 'done');
    // 秒级时间戳可能撞在同一秒，所以比的是「有没有各自的完成时间」，不是先后
    expect(hab.store.get<Action>(OPEN)!.doneAt).toBeTruthy();
    expect(hab.store.get<Action>(LEGACY_DONE)!.doneAt, '老任务的时间不被新动作覆盖').toBe(backfilled);
  });
});
