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
  LOOPS, loopById, evaluateLoop, cronOf, fitLoop, renderManual, renderSpaceGuide,
  type HarnessProfile, type LoopReceipt,
} from '../../shared/loops.ts';
import {
  appendReceipt, readReceipts, latestByLoop, runLoop, beat, checkAutomation, computeStatuses,
  agentBrief, LOOP_RUNS, AUTOMATION_CONFIG, loadAutomation, saveAutomation,
  acquireLease, claimTarget, releaseClaims, listClaims, runLoopAlerts,
} from '../../server/core/loops.ts';
import { buildServer } from '../../server/index.ts';
import { N1 } from '../helpers/space.ts';

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

  it('CLI 入口必须是单条可执行命令，不能是命令序列', () => {
    for (const d of LOOPS) {
      if (!d.entry.cli) continue;
      expect(d.entry.cli, `${d.id} 的 CLI 入口混进了说明文字`).not.toContain('·');
      expect(d.entry.cli, `${d.id} 的 CLI 入口混进了箭头`).not.toContain('→');
      expect(d.entry.cli, `${d.id} 的 CLI 入口混进了括号说明`).not.toContain('（');
    }
  });

  it('harness 参数必须以 -- 开头', () => {
    for (const d of LOOPS) {
      if (d.harnessArgs) expect(d.harnessArgs.trim().startsWith('--'), `${d.id} harnessArgs 不合法`).toBe(true);
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


/* ---------------- P1：租约 / 认领 / 告警 / 作业回执 ---------------- */

describe('租约：同一时刻只有一个执行者', () => {
  it('第二个执行者拿不到；释放后可以接', async () => {
    const a = await acquireLease(hab, 'daily-brief', 'agent:a');
    expect(a.ok).toBe(true);
    const b = await acquireLease(hab, 'daily-brief', 'agent:b');
    expect(b.ok).toBe(false);
    if (b.ok === false) expect(b.holder?.owner).toBe('agent:a');
    if (a.ok) await a.release();
    const c = await acquireLease(hab, 'daily-brief', 'agent:b');
    expect(c.ok).toBe(true);
    if (c.ok) await c.release();
  });

  it('过期的租约可以被接管', async () => {
    await hab.store.adapter.write(
      '.habitat/state/loop-leases.json',
      JSON.stringify({ 'daily-brief': { owner: 'agent:dead', at: '2026-11-01T00:00:00+08:00', until: '2026-11-01T00:10:00+08:00', token: 'x' } }),
      { backup: false },
    );
    const r = await acquireLease(hab, 'daily-brief', 'agent:new');
    expect(r.ok).toBe(true);
    if (r.ok) await r.release();
  });

  it('同一个 owner 可以重入（不会把自己锁死）', async () => {
    const a = await acquireLease(hab, 'rules', 'agent:a');
    expect(a.ok).toBe(true);
    const b = await acquireLease(hab, 'rules', 'agent:a');
    expect(b.ok).toBe(true);
    if (a.ok) await a.release();
    if (b.ok) await b.release();
  });
});

describe('认领：两个 agent 不重复做同一条', () => {
  it('先到先得；别人的工单里看不到已被认领的条目', async () => {
    const item = hab.inbox()[0];
    expect(item, '夹具里应该有收件箱条目').toBeTruthy();
    const r1 = await claimTarget(hab, 'triage-inbox', item.id, 'agent:a');
    expect(r1.ok).toBe(true);
    const r2 = await claimTarget(hab, 'triage-inbox', item.id, 'agent:b');
    expect(r2.ok).toBe(false);

    const a = await runLoop(hab, 'triage-inbox', { actor: 'agent:a' });
    expect(a.output).toContain(item.id);
    const b = await runLoop(hab, 'triage-inbox', { actor: 'agent:b' });
    expect(b.output).not.toContain(item.id);
    expect(b.output).toContain('已被其他执行者认领');
  });

  it('beat 交账时自动释放自己名下的认领', async () => {
    const item = hab.inbox()[0];
    await claimTarget(hab, 'triage-inbox', item.id, 'agent:a');
    expect((await listClaims(hab, 'triage-inbox')).length).toBe(1);
    await beat(hab, 'triage-inbox', { ok: true, actor: 'agent:a', produced: [item.id] });
    expect((await listClaims(hab, 'triage-inbox')).length).toBe(0);
  });

  it('release 只释放指定执行者的', async () => {
    const item = hab.inbox()[0];
    await claimTarget(hab, 'triage-inbox', item.id, 'agent:a');
    await claimTarget(hab, 'triage-inbox', item.id, 'agent:a');
    await releaseClaims(hab, 'triage-inbox', 'agent:b');
    expect((await listClaims(hab, 'triage-inbox')).length).toBe(1);
    await releaseClaims(hab, 'triage-inbox', 'agent:a');
    expect((await listClaims(hab, 'triage-inbox')).length).toBe(0);
  });
});

describe('告警：down 会被推一次，不重复轰炸', () => {
  it('失败回执 → 告警；同一天第二次跳过', async () => {
    await beat(hab, 'daily-brief', { ok: false, note: 'SMTP 超时', actor: 'agent:x' });
    const r = await runLoopAlerts(hab);
    expect(r.alerted.map((x) => x.id)).toContain('daily-brief');
    const again = await runLoopAlerts(hab);
    expect(again.alerted.map((x) => x.id)).not.toContain('daily-brief');
    expect(again.skipped.join(' ')).toContain('今天已告警');
  });
});

describe('空间操作手册', () => {
  it('外部 harness 能看到三条硬规矩与交账方式', () => {
    const md = renderSpaceGuide({ space: '测试空间', generatedAt: '2026-11-04T12:00:00+08:00' });
    expect(md).toContain('不要直接改文件');
    expect(md).toContain('跑完必须交账');
    expect(md).toContain('loops claim');
    expect(md).toContain('loops beat');
  });
});

describe('作业与提案纳入统一回执', () => {
  it('作业完成后写 job-advance 回执', async () => {
    const d = await makeSpace();
    const app = await buildServer({ root: d, authMode: 'off' });
    try {
      const created = await app.inject({ method: 'POST', url: '/api/jobs', payload: { name: '测试作业', steps: ['一', '二', '三'] } });
      const job = (JSON.parse(created.body) as { job: { id: string } }).job;
      for (const payload of [{}, {}, { approve: true }, {}]) {
        await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/advance`, payload });
      }
      const receipts = await readReceipts(app.habitat);
      expect(receipts.some((r) => r.loop === 'job-advance' && r.result === 'ok' && r.produced?.includes(job.id))).toBe(true);
    } finally {
      await app.close();
      app.habitat.close();
      await rmSpace(d);
    }
  });

  it('提案应用后写 proposal-approve 回执', async () => {
    const d = await makeSpace();
    const app = await buildServer({ root: d, authMode: 'off' });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/proposals',
        payload: { title: '测试提案', ops: [{ t: 'update', id: N1, patch: { status: 'evergreen' } }] },
      });
      const prop = (JSON.parse(created.body) as { proposal: { id: string } }).proposal;
      const applied = await app.inject({ method: 'POST', url: `/api/proposals/${prop.id}/apply` });
      expect(applied.statusCode).toBe(200);
      const receipts = await readReceipts(app.habitat);
      expect(receipts.some((r) => r.loop === 'proposal-approve' && r.result === 'ok' && r.produced?.includes(prop.id))).toBe(true);
    } finally {
      await app.close();
      app.habitat.close();
      await rmSpace(d);
    }
  });
});

void path;

