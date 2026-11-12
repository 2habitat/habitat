/**
 * 阅读进度事件节流。
 *
 * 游标状态必须每次都准，但 journal 不该被「读到 41.1% / 41.2%」刷屏。
 * 这些断言锁住：重复抖动不写事件、真的推进了要写、明确动作能绕过、换章互不影响。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Habitat } from '../../server/core/space.ts';
import { makeSpace, rmSpace, R1 } from '../helpers/space.ts';
import { nowISO } from '../../shared/id.ts';

const OTHER = 'rep-throttle-other';

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

function reads(repId: string): Promise<number> {
  return hab.journal
    .query({ since: nowISO().slice(0, 10), limit: 200 })
    .then((rows) => rows.filter((e) => e.op === 'read' && e.payload?.repId === repId).length);
}

describe('read 事件去重', () => {
  it('几秒内进度几乎没动：只更新游标，不再写一条事件', async () => {
    const first = await hab.setCursor(R1, 0.4);
    expect(first.event, '第一次必须写').toBeTruthy();
    const second = await hab.setCursor(R1, 0.403);
    expect(second.event).toBeUndefined();
    expect(second.cursor.current).toBeCloseTo(0.403);
    expect(await reads(R1)).toBe(1);
  });

  it('真的推进了就写，不被上一条的窗口吃掉', async () => {
    await hab.setCursor(R1, 0.4);
    const moved = await hab.setCursor(R1, 0.75);
    expect(moved.event).toBeTruthy();
    expect(await reads(R1)).toBe(2);
  });

  it('force（标记读完 / 停稳补记）绕过去重', async () => {
    await hab.setCursor(R1, 0.99);
    const forced = await hab.setCursor(R1, 1, 'human', { force: true });
    expect(forced.event).toBeTruthy();
    expect(await reads(R1)).toBe(2);
  });

  it('去重按章隔离：别把另一章的首次阅读也吃掉', async () => {
    await hab.setCursor(R1, 0.4);
    const other = await hab.setCursor(OTHER, 0.4);
    expect(other.event).toBeTruthy();
    expect(await reads(OTHER)).toBe(1);
  });

  it('重新打开空间后首次上报照写（内存去重不是持久闸门）', async () => {
    await hab.setCursor(R1, 0.4);
    hab.close();
    hab = await Habitat.open(dir, { fresh: true });
    const again = await hab.setCursor(R1, 0.4);
    expect(again.event).toBeTruthy();
    expect(await reads(R1)).toBe(2);
  });
});
