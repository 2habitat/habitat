/**
 * Agent 会话层契约：配置、上下文、定位、技能、审批、MCP。
 * 全部用 mock harness，不拉模型；真实 ACP 由单独的冒烟脚本验证。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Habitat } from '../../server/core/space.ts';
import { makeSpace, rmSpace, N1, R1 } from '../helpers/space.ts';
import { loadHarnessFile, defaultHarnessFile } from '../../server/agent/config.ts';
import { locateQuote, parseOutline, packContext } from '../../server/agent/context.ts';
import { compileSkill, loadSkills, skillById } from '../../server/agent/skills.ts';
import { AgentService } from '../../server/agent/service.ts';
import type { AgentEvent } from '../../shared/agent.ts';

let dir: string;
let hab: Habitat;

beforeEach(async () => {
  process.env.HABITAT_AGENT_MOCK = '1';
  dir = await makeSpace();
  hab = await Habitat.open(dir, { fresh: true });
});

afterEach(async () => {
  hab.close();
  await rmSpace(dir);
  delete process.env.HABITAT_AGENT_MOCK;
});

function waitFor(events: AgentEvent[], pred: (e: AgentEvent) => boolean, ms = 4000): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = events.find(pred);
      if (hit) { clearInterval(timer); resolve(hit); return; }
      if (Date.now() - started > ms) { clearInterval(timer); reject(new Error('等待事件超时')); }
    }, 20);
  });
}

describe('harness 配置', () => {
  it('没有 agents.yaml 时给默认配置，mock 在测试模式下启用', () => {
    const f = loadHarnessFile(dir);
    expect(f.source).toBe('default');
    expect(f.harnesses.some((h) => h.id === 'mock' && h.enabled)).toBe(true);
    expect(f.harnesses.some((h) => h.id === 'dsh')).toBe(true);
  });

  it('agents.yaml 支持 ${ENV} 展开；写坏了回退默认值', () => {
    process.env.TEST_HARNESS_CMD = 'node';
    fs.writeFileSync(path.join(dir, 'agents.yaml'), [
      'version: 1',
      'default: mine',
      'harnesses:',
      '  - id: mine',
      '    label: 我的 harness',
      '    driver: acp',
      '    command: ${TEST_HARNESS_CMD}',
      '    args: ["--x"]',
      '    approvals: { annotations: auto, body: readonly }',
    ].join('\n'));
    const f = loadHarnessFile(dir);
    expect(f.source).toBe('file');
    expect(f.default).toBe('mine');
    expect(f.harnesses[0].command).toBe('node');
    expect(f.harnesses[0].approvals).toEqual({ annotations: 'auto', body: 'readonly' });

    fs.writeFileSync(path.join(dir, 'agents.yaml'), 'harnesses: [');
    const bad = loadHarnessFile(dir);
    expect(bad.source).toBe('default');
    expect(bad.harnesses.length).toBe(defaultHarnessFile().harnesses.length);
  });
});

describe('选区定位', () => {
  const body = '线性注意力把 softmax 拆成内积。\n\n代价是固定容量状态，能力变弱。\n\n线性注意力把 softmax 拆成内积。';

  it('唯一命中直接给 offset', () => {
    const r = locateQuote(body, '代价是固定容量状态');
    expect(r.ok).toBe(true);
    expect(body.slice(r.from, r.to)).toBe('代价是固定容量状态');
  });

  it('多处命中靠 prefix/suffix 消歧；消不了就报歧义', () => {
    const q = '线性注意力把 softmax 拆成内积';
    const first = locateQuote(body, q, { prefix: '', suffix: '。\n\n代价是' });
    expect(first.ok).toBe(true);
    expect(first.from).toBe(0);
    const ambiguous = locateQuote(body, q);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.reason).toContain('歧义');
  });

  it('空白折叠后能命中跨行引文', () => {
    const r = locateQuote(body, '代价是固定容量状态， 能力变弱');
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('空白折叠');
  });

  it('找不到就明确失败', () => {
    expect(locateQuote(body, '这句话不在正文里').ok).toBe(false);
  });
});

describe('上下文打包', () => {
  it('带焦点、选区、大纲与引用；超预算会记录省略', () => {
    const body = '第一章\n\n线性注意力把 softmax 拆成内积。\n\n## 代价\n\n固定容量状态。';
    const outline = parseOutline(body);
    const out = packContext({
      focusId: 'rep-1', focusTitle: '线性注意力', focusKind: 'rep', revision: 3,
      body, outline,
      selection: { repId: 'rep-1', quote: '固定容量状态。', from: body.indexOf('固定容量状态'), to: body.indexOf('固定容量状态') + 7, prefix: '', suffix: '', revision: 3 },
      refs: [{ id: 'r1', kind: 'quote', objectId: 'rep-1', title: '线性注意力', revision: 3, addedBy: 'user', quote: { repId: 'rep-1', quote: '固定容量状态。', from: 0, to: 7, prefix: '', suffix: '', revision: 3 } }],
      skill: { name: '苏格拉底', preamble: '每轮只问一个问题。' },
      maxChars: 4000,
    });
    expect(out.text).toContain('focus id="rep-1"');
    expect(out.text).toContain('<selection');
    expect(out.text).toContain('<references>');
    expect(out.text).toContain('每轮只问一个问题');
    expect(out.usedChars).toBeLessThanOrEqual(4000);
  });

  it('预算极小时会截断并说明', () => {
    const body = '很长的正文'.repeat(100);
    const out = packContext({
      focusId: 'rep-1', focusTitle: 'X', focusKind: 'rep', revision: 1,
      body, outline: [], refs: [], maxChars: 200,
    });
    expect(out.usedChars).toBeLessThanOrEqual(200);
    expect(out.omitted.join('')).toContain('截断');
  });
});

describe('技能', () => {
  it('内置苏格拉底能被加载并编译占位符', () => {
    const all = loadSkills(dir);
    const s = all.find((x) => x.id === 'socratic')!;
    expect(s).toBeTruthy();
    expect(s.output).toBe('questions');
    const p = compileSkill(s, { focusTitle: '线性注意力', sectionTitle: '代价' });
    expect(p).toContain('线性注意力');
    expect(p).toContain('代价');
    expect(p).toContain('每轮只问一个问题');
  });

  it('空间技能可以覆盖同名内置技能', () => {
    const d = path.join(dir, 'skills', 'socratic');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), [
      '---', 'id: socratic', 'name: 我的苏格拉底', 'version: 2',
      'appliesTo: [reading]', 'context: [focus]', 'tools: [kb_session]',
      'output: questions', 'starters: ["自定义开场"]', '---',
      '先问学习者：这段话的关键词是什么？',
    ].join('\n'));
    const s = skillById(dir, 'socratic')!;
    expect(s.name).toBe('我的苏格拉底');
    expect(s.body).toContain('关键词');
  });
});

describe('会话 + session MCP + 审批', () => {
  it('mock 会话能启动、流式回答，并能通过 MCP 读上下文', async () => {
    const svc = new AgentService(hab, { root: dir, baseUrl: () => 'http://127.0.0.1:1' });
    const s = svc.create({
      harnessId: 'mock',
      focus: { kind: 'rep', id: R1, title: '线性注意力', revision: 1 },
      refs: [],
      skillId: 'socratic',
      approvals: { annotations: 'ask', body: 'ask' },
    });
    await s.ready();
    expect(s.status).toBe('ready');

    const events: AgentEvent[] = [];
    s.subscribe((e) => events.push(e));
    s.enqueueTurn('别直接告诉我答案，先问我一个问题');
    await waitFor(events, (e) => e.t === 'turn' && e.phase === 'end');
    const text = events.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toContain('？');
    expect(text).toContain('线性注意力');

    const init = await s.mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('habitat-agent');
    const tools = await s.mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(JSON.stringify(tools)).toContain('kb_annotate_suggest');
    const ctx = await s.mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kb_session', arguments: {} } });
    expect(JSON.stringify(ctx)).toContain(R1);
  });

  it('批注建议先校验、后写入；接受后 origin=ai', async () => {
    const svc = new AgentService(hab, { root: dir, baseUrl: () => 'http://127.0.0.1:1' });
    const s = svc.create({
      harnessId: 'mock',
      focus: { kind: 'rep', id: R1, title: '线性注意力', revision: 1 },
      refs: [],
      skillId: 'annotate',
      approvals: { annotations: 'ask', body: 'ask' },
    });
    await s.ready();
    const before = hab.store.all('annotation').length;
    const quote = '把注意力复杂度从平方降到线性';
    const r = await s.mcp({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'kb_annotate_suggest', arguments: { repId: R1, items: [{ quote, note: '关键句' }] } },
    });
    const payload = JSON.parse((r.result as { content: { text: string }[] }).content[0].text) as { accepted: { quote: string }[] };
    expect(payload.accepted[0].quote).toBe(quote);
    expect(hab.store.all('annotation').length).toBe(before);

    const accepted = await s.acceptAnnotations(R1, payload.accepted as never);
    expect(accepted.accepted.length).toBe(1);
    const all = hab.store.all('annotation') as never as { quote: string; origin?: string }[];
    const saved = all.find((a) => a.quote === quote)!;
    expect(saved.origin).toBe('ai');
  });

  it('auto 模式批注直接落盘，事件标记 accepted', async () => {
    const svc = new AgentService(hab, { root: dir, baseUrl: () => 'http://127.0.0.1:1' });
    const s = svc.create({
      harnessId: 'mock',
      focus: { kind: 'rep', id: R1, title: '线性注意力', revision: 1 },
      approvals: { annotations: 'auto', body: 'ask' },
    });
    await s.ready();
    const events: AgentEvent[] = [];
    s.subscribe((e) => events.push(e));
    const quote = '把注意力复杂度从平方降到线性';
    const before = hab.store.all('annotation').length;
    const r = await s.mcp({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'kb_annotate_suggest', arguments: { repId: R1, items: [{ quote, note: '自动落笔' }] } },
    });
    const body = JSON.parse((r.result as { content: { text: string }[] }).content[0].text) as { auto: boolean };
    expect(body.auto).toBe(true);
    expect(hab.store.all('annotation').length).toBe(before + 1);
    expect(events.some((e) => e.t === 'annotation' && e.accepted === true)).toBe(true);
  });

  it('ask 模式出提案等人确认；readonly 直接拒绝', async () => {
    const svc = new AgentService(hab, { root: dir, baseUrl: () => 'http://127.0.0.1:1' });
    const s = svc.create({
      harnessId: 'mock',
      focus: { kind: 'note', id: N1, title: '状态就是记忆', revision: 1 },
      refs: [], approvals: { annotations: 'ask', body: 'ask' },
    });
    await s.ready();
    const r = await s.mcp({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'kb_propose', arguments: { ops: [{ t: 'update', id: N1, patch: { status: 'evergreen' } }], reason: '测试' } },
    });
    const text = (r.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain('等用户确认');
    const id = /提案 (cs-[^\s]+)/.exec(text)?.[1] ?? '';
    expect(id).toBeTruthy();
    const done = await s.commitProposal(id);
    expect(done.ok).toBe(true);

    const ro = svc.create({
      harnessId: 'mock',
      focus: { kind: 'note', id: N1, title: '状态就是记忆', revision: 1 },
      approvals: { annotations: 'readonly', body: 'readonly' },
    });
    await ro.ready();
    const denied = await ro.mcp({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'kb_propose', arguments: { ops: [{ t: 'update', id: N1, patch: { status: 'seedling' } }] } },
    });
    expect((denied.result as { isError?: boolean }).isError).toBe(true);
  });

  it('平台任务：headless 会话跑完自动记回执；metrics 能看到', async () => {
    const svc = new AgentService(hab, { root: dir, baseUrl: () => 'http://127.0.0.1:1' });
    const task = await svc.runTask({ prompt: '你好', harnessId: 'mock' });
    expect(task.status).toBe('ok');
    expect(task.text).toContain('我看到了你的问题');
    expect(svc.metrics().turns).toBe(1);
    expect(svc.list().length).toBe(1);

    const loopTask = await svc.runLoopTask('triage-inbox', { harnessId: 'mock' });
    expect(loopTask.status).toBe('ok');
    const raw = fs.readFileSync(path.join(dir, '.habitat/state/loop-runs.jsonl'), 'utf8');
    expect(raw).toContain('triage-inbox');
    expect(raw).toContain('平台代记');
  });

  it('远端配对：码一次性、token 不下发、harness 列表可见', () => {
    const svc = new AgentService(hab, { root: dir, baseUrl: () => 'http://127.0.0.1:1' });
    const p = svc.pairCode('远端测试');
    expect(p.code).toMatch(/^\d{6}$/);
    const joined = svc.joinRemote({ code: p.code, endpoint: 'http://127.0.0.1:9999/acp', label: '远端测试' });
    expect(joined.token.length).toBeGreaterThan(10);
    const list = svc.harnesses().list;
    const remote = list.find((h) => h.id === joined.harness.id)!;
    expect(remote.driver).toBe('remote');
    expect(remote.endpoint).toBe('http://127.0.0.1:9999/acp');
    expect((remote as unknown as { token?: string }).token).toBeUndefined();
    expect(() => svc.joinRemote({ code: p.code, endpoint: 'http://x/acp' })).toThrow(/过期|无效/);
  });

  it('多会话可以并存，metrics 按 harness 分组', async () => {
    const svc = new AgentService(hab, { root: dir, baseUrl: () => 'http://127.0.0.1:1' });
    const a = svc.create({ harnessId: 'mock', focus: { kind: 'none', id: '', title: 'A', revision: 0 } });
    const b = svc.create({ harnessId: 'mock', focus: { kind: 'none', id: '', title: 'B', revision: 0 } });
    await Promise.all([a.ready(), b.ready()]);
    expect(svc.list().length).toBe(2);
    const m = svc.metrics();
    expect(m.total).toBe(2);
    expect(m.byHarness.mock.sessions).toBe(2);
  });

  it('auto 模式直接提交，且删除/归档被拒', async () => {
    const svc = new AgentService(hab, { root: dir, baseUrl: () => 'http://127.0.0.1:1' });
    const s = svc.create({
      harnessId: 'mock',
      focus: { kind: 'note', id: N1, title: '状态就是记忆', revision: 1 },
      approvals: { annotations: 'auto', body: 'auto' },
    });
    await s.ready();
    const ok = await s.mcp({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'kb_propose', arguments: { ops: [{ t: 'update', id: N1, patch: { status: 'growing' } }], reason: '自动' } },
    });
    expect(JSON.stringify(ok)).toContain('已自动提交');
    const bad = await s.mcp({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'kb_propose', arguments: { ops: [{ t: 'archive', id: N1, archived: true }] } },
    });
    expect((bad.result as { isError?: boolean }).isError).toBe(true);
  });
});
