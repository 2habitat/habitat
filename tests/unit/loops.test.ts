/**
 * 闭环契约测试。
 *
 * 这些断言的目的不是「代码覆盖率」，而是防止文档再次变成空壳：
 *   每条闭环必须有非 UI 入口、有证据、有幂等、有降级；
 *   判断类必须写清「没有模型时怎么办」，且永远不许自动 commit。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { Habitat } from '../../server/core/space.ts';
import { makeSpace, rmSpace } from '../helpers/space.ts';
import {
  LOOPS, loopById, evaluateLoop, cronOf, fitLoop, renderManual,
  type HarnessProfile, type LoopReceipt,
} from '../../shared/loops.ts';
import {
  appendReceipt, readReceipts, latestByLoop, runLoop, beat, checkAutomation, computeStatuses,
  agentBrief, LOOP_RUNS, AUTOMATION_CONFIG, loadAutomation, saveAutomation,
} from '../../server/core/loops.ts';

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

const NOW = Date.parse('2026-11-04T12:00:00+08:00');

function receipt(over: Partial<LoopReceipt> = {}): LoopReceipt {
  return { loop: 'daily-brief', at: '2026-11-04T08:00:00+08:00', by: 'system', trigger: 'timer', result: 'ok', ...over };
}

/* ---------------- 目录契约 ---------------- */

describe('闭环目录：写不全就不许存在', () => {
  it('id 唯一，且每条都能被查到', () => {
    const ids = LOOPS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(loopById(id)?.id).toBe(id);
  });

  it('每条闭环至少有一个非 UI 入口（否则外部 harness 永远接不上）', () => {
    for (const d of LOOPS) {
      const entry = d.entry.cli ?? d.entry.api ?? d.entry.command;
      expect(entry, `${d.id} 没有非 UI 入口`).toBeTruthy();
    }
  });

  it('每条闭环都写了步骤、产物、证据、幂等、归属', () => {
    for (const d of LOOPS) {
      expect(d.steps.length, `${d.id} 步骤太少`).toBeGreaterThanOrEqual(3);
      expect(d.outputs.length, `${d.id} 没写产物`).toBeGreaterThan(0);
      expect(d.evidence.length, `${d.id} 没写证据`).toBeGreaterThan(0);
      expect(d.idempotency.trim().length, `${d.id} 没写幂等`).toBeGreaterThan(8);
      expect(d.ownerHint.trim().length, `${d.id} 没写默认归属`).toBeGreaterThan(0);
    }
  });

  it('判断类必须写「没有模型时怎么办」，且绝不允许自动 commit', () => {
    for (const d of LOOPS.filter((x) => x.mode === 'assist')) {
      expect(d.degrade.noModel, `${d.id} 是判断类，却没写没有模型时怎么办`).toBeTruthy();
      expect(['read', 'derived', 'propose'], `${d.id} 是判断类，自主度过高`).toContain(d.autonomy);
    }
  });

  it('自动类不依赖模型（人不在、模型不在也要能转）', () => {
    for (const d of LOOPS.filter((x) => x.mode === 'auto')) {
      expect(d.requires, `${d.id} 自动类不该依赖模型`).not.toContain('model');
    }
  });

  it('CLI 入口写成 habitat 命令，API 入口写成方法 + 路径', () => {
    for (const d of LOOPS) {
      if (d.entry.cli) expect(d.entry.cli.startsWith('habitat '), `${d.id} CLI 入口格式不对`).toBe(true);
      if (d.entry.api) expect(/^(GET|POST|PUT|PATCH|DELETE) \/api\//.test(d.entry.api), `${d.id} API 入口格式不对`).toBe(true);
    }
  });

  it('需要存活判定的闭环必须有触发方式', () => {
    for (const d of LOOPS.filter((x) => x.maxSilenceMinutes > 0)) {
      expect(d.trigger.kind, `${d.id} 有存活上限但没有触发方式`).not.toBe('manual');
    }
  });

  it('手册由目录生成，覆盖每一条', () => {
    const md = renderManual({ generatedAt: '2026-11-04T12:00:00+08:00' });
    for (const d of LOOPS) {
      expect(md, `手册缺 ${d.id}`).toContain(`\`${d.id}\``);
      expect(md).toContain(d.name);
    }
    expect(md).toContain('外部 harness 接入清单');
  });
});

/* ---------------- 健康判定 ---------------- */

describe('健康判定：缺席才是故障', () => {
  const def = loopById('daily-brief')!;

  it('停用 → paused', () => {
    expect(evaluateLoop(def, receipt(), { now: NOW, enabled: false }).state).toBe('paused');
  });

  it('按需型 → manual，不做存活判定', () => {
    expect(evaluateLoop(loopById('index-rebuild')!, undefined, { now: NOW, enabled: true }).state).toBe('manual');
  });

  it('缺依赖 → blocked（而不是 never）', () => {
    const s = evaluateLoop(def, undefined, { now: NOW, enabled: true, blocked: ['邮件通道'] });
    expect(s.state).toBe('blocked');
    expect(s.reason).toContain('邮件通道');
  });

  it('从未运行 → never', () => {
    expect(evaluateLoop(def, undefined, { now: NOW, enabled: true }).state).toBe('never');
  });

  it('上限内 → ok；1~2 倍 → late；超过 2 倍 → down', () => {
    const at = (min: number) => receipt({ at: new Date(NOW - min * 60_000).toISOString() });
    expect(evaluateLoop(def, at(60), { now: NOW, enabled: true }).state).toBe('ok');
    expect(evaluateLoop(def, at(def.maxSilenceMinutes + 10), { now: NOW, enabled: true }).state).toBe('late');
    expect(evaluateLoop(def, at(def.maxSilenceMinutes * 2 + 10), { now: NOW, enabled: true }).state).toBe('down');
  });

  it('上次失败 → down，哪怕刚跑过', () => {
    const s = evaluateLoop(def, receipt({ at: new Date(NOW - 60_000).toISOString(), result: 'fail', note: 'SMTP 超时' }), { now: NOW, enabled: true });
    expect(s.state).toBe('down');
    expect(s.reason).toContain('SMTP 超时');
  });

  it('跳过不算失败，但原因要留在状态里', () => {
    const s = evaluateLoop(def, receipt({ result: 'skipped', note: '没有配置邮件通道' }), { now: NOW, enabled: true });
    expect(s.state).toBe('ok');
    expect(s.reason).toContain('没有配置邮件通道');
  });
});

describe('cron 生成', () => {
  it('每天 / 每 N 分钟 / 事件', () => {
    expect(cronOf({ kind: 'daily', at: '08:00' })).toBe('0 8 * * *');
    expect(cronOf({ kind: 'interval', minutes: 15 })).toBe('*/15 * * * *');
    expect(cronOf({ kind: 'interval', minutes: 0.25 })).toBe('* * * * *');
    expect(cronOf({ kind: 'event', on: 'x' })).toBeNull();
  });
});

/* ---------------- 能力协商 ---------------- */

describe('harness 能力协商', () => {
  const full: HarnessProfile = {
    name: 'claude-code',
    scheduler: 'cron',
    invoke: ['cli', 'http', 'mcp', 'fs'],
    model: true,
    humanApproval: true,
    mail: 'both',
    shell: true,
  };

  it('能力齐全 → daily-brief 可完整承担', () => {
    expect(fitLoop(loopById('daily-brief')!, full).level).toBe('full');
  });

  it('没有模型 → 判断类只能备料', () => {
    const f = fitLoop(loopById('triage-inbox')!, { ...full, model: false });
    expect(f.level).toBe('partial');
    expect(f.missing).toContain('model');
    expect(f.why).toContain('判断');
  });

  it('没有调度器 → 只能按需触发', () => {
    const f = fitLoop(loopById('daily-brief')!, { ...full, scheduler: 'none' });
    expect(f.level).toBe('partial');
    expect(f.why).toContain('按需');
  });

  it('只有 CLI → job-advance 接不了（它要 HTTP）', () => {
    const f = fitLoop(loopById('job-advance')!, { name: 'x', scheduler: 'cron', invoke: ['cli'] });
    expect(f.level).toBe('none');
  });

  it('没有 Shell → 发布闭环接不了', () => {
    const f = fitLoop(loopById('release-promote')!, { ...full, shell: false });
    expect(f.missing).toContain('shell');
  });

  it('没有任何调用通道 → 全部 none', () => {
    for (const d of LOOPS) {
      expect(fitLoop(d, { name: 'x', scheduler: 'cron', invoke: [] }).level).toBe('none');
    }
  });
});

/* ---------------- 回执与执行 ---------------- */

describe('回执：跑过要留证据', () => {
  it('追加、读取、取最新', async () => {
    await appendReceipt(hab, receipt({ at: '2026-11-01T08:00:00+08:00' }));
    await appendReceipt(hab, receipt({ at: '2026-11-02T08:00:00+08:00', counts: { sent: 2 } }));
    const all = await readReceipts(hab);
    expect(all).toHaveLength(2);
    const latest = latestByLoop(all);
    expect(latest['daily-brief'].at).toContain('2026-11-02');
    expect(latest['daily-brief'].counts?.sent).toBe(2);
  });

  it('同一窗口重复执行会被去重，--force 才重跑', async () => {
    const first = await runLoop(hab, 'watch-external', { actor: 'agent:test' });
    expect(first.ran).toBe(true);
    const second = await runLoop(hab, 'watch-external', { actor: 'agent:test' });
    expect(second.ran).toBe(false);
    expect(second.deduped).toBe(true);
    const forced = await runLoop(hab, 'watch-external', { actor: 'agent:test', force: true });
    expect(forced.ran).toBe(true);
  });

  it('判断类只出工单，不假装完成', async () => {
    const r = await runLoop(hab, 'triage-inbox', { actor: 'agent:test' });
    expect(r.result).toBe('prepared');
    expect(r.output).toContain('工单');
    expect(r.output).toContain('积压');
  });

  it('跑完可手动记回执，失败会被 check 抓到', async () => {
    await beat(hab, 'daily-brief', { ok: false, note: 'SMTP 超时', actor: 'agent:cron' });
    const r = await checkAutomation(hab);
    expect(r.passed).toBe(false);
    expect(r.silent.map((s) => s.id)).toContain('daily-brief');
  });

  it('回执文件就在空间状态目录，harness 可以自己读', async () => {
    await appendReceipt(hab, receipt());
    const raw = await hab.store.adapter.read(LOOP_RUNS);
    expect(raw.trim().split('\n')).toHaveLength(1);
  });
});

/* ---------------- 配置与自检 ---------------- */

describe('配置：归属与启停', () => {
  it('默认全开；写配置后 status 反映停用', async () => {
    const cfg = await loadAutomation(hab);
    expect(cfg.loops).toEqual({});
    cfg.loops['daily-brief'] = { enabled: false, owner: 'harness-a' };
    await saveAutomation(hab, cfg);
    const status = await computeStatuses(hab);
    const s = status.states.find((x) => x.id === 'daily-brief')!;
    expect(s.state).toBe('paused');
    const raw = await hab.store.adapter.read(AUTOMATION_CONFIG);
    expect(raw).toContain('harness-a');
  });

  it('声明了 owner 却没回执 → 出现在 unowned/never 里可见', async () => {
    const r = await checkAutomation(hab);
    expect(r.never.length).toBeGreaterThan(0);
    expect(r.unowned).toContain('triage-inbox');
  });

  it('交接单包含状态、积压和三条规矩', async () => {
    const text = await agentBrief(hab);
    expect(text).toContain('自动化闭环交接单');
    expect(text).toContain('积压');
    expect(text).toContain('只提案，不 commit');
  });
});

void path;
