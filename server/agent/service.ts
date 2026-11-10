/**
 * Agent 会话服务：状态机、上下文、审批闸门、session MCP。
 *
 * 平台在这里拥有三件事：
 *  · 会话生命周期（谁在跑、跑到哪、怎么停）
 *  · 上下文打包（发什么、多少字、哪些引用）
 *  · 写闸门（批注/提案/自动提交）
 * harness 只是被 AcpDriver 包起来的一个进程。
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Habitat } from '../core/space.ts';
import type {
  AgentEvent, AgentSkill, AnnotationSuggestion, ApprovalPolicy, ConfigOption,
  ContextRef, HarnessCaps, HarnessConfig, HarnessView, QuoteAnchor, SessionContext,
  SessionFocus, SessionView, StartResult, ToolTier,
} from '../../shared/agent.ts';
import { AcpDriver, type DriverEvent, type DriverStartInput } from './acp.ts';
import { WorkbuddyHttpDriver } from './workbuddy.ts';
import { RemoteAcpDriver } from './remote.ts';
import { MockDriver } from './mock.ts';
import { harnessById, loadHarnessFile } from './config.ts';
import { compileSkill, loadSkills, skillById } from './skills.ts';
import { packContext, parseOutline, locateQuote, sectionAt } from './context.ts';
import {
  agentBrief, beat, checkAutomation, claimTarget, computeStatuses,
  listClaims, listLeases, releaseClaims, runLoop, runLoopAlerts,
} from '../core/loops.ts';
import { LOOPS, loopById } from '../../shared/loops.ts';

export interface AgentTaskInput {
  prompt: string;
  harnessId?: string;
  skillId?: string;
  approvals?: Partial<ApprovalPolicy>;
  loopId?: string;
  /** 平台工单已经圈定的对象；agent 没产出时至少把它们记进回执 */
  loopProduced?: string[];
  timeoutMs?: number;
  keepAlive?: boolean;
}

export interface AgentTaskResult {
  sessionId: string;
  harnessId: string;
  status: 'ok' | 'error' | 'timeout';
  text: string;
  tools: string[];
  errors: string[];
  proposals: string[];
  durationMs: number;
  receipt?: unknown;
}

export interface AgentDriver {
  start(input: DriverStartInput): Promise<StartResult>;
  prompt(text: string): Promise<{ stopReason?: string }>;
  cancel(): Promise<void>;
  setConfig(id: string, value: string): Promise<ConfigOption[]>;
  close(): Promise<void>;
}

interface PendingProposal {
  id: string;
  changesetId: string;
  diff: string;
  reason: string;
}

interface SessionSub {
  send: (e: AgentEvent) => void;
}

const TOOL_DEFS = [
  { name: 'kb_session', description: '当前焦点、选区、引用、技能、审批策略与上下文预算。' },
  { name: 'kb_outline', description: '当前正文的标题树与字符区间。' },
  { name: 'kb_read', description: '按 repId / heading / 字符区间读取正文，默认当前焦点。' },
  { name: 'kb_search', description: '全库检索，中文 2-gram。' },
  { name: 'kb_annotate_suggest', description: '提交批注建议；不落盘，由平台校验并交给用户接受。' },
  { name: 'kb_propose', description: '对已有对象提变更；默认只出提案，是否自动提交由审批策略决定。' },
  { name: 'kb_capture', description: '采集一条碎片到收件箱。' },
  { name: 'kb_loops', description: '自动化闭环清单、状态、认领与交接单。' },
  { name: 'kb_loop_run', description: '执行一条确定性闭环（服务端能独立跑完的那种）。' },
  { name: 'kb_loop_report', description: '给闭环写回执；跑完必须调用，否则平台会认为它没跑。' },
];

function tool(name: string, tier: ToolTier, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
  return { name, description, tier, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const TOOLS = [
  tool('kb_session', 'read', TOOL_DEFS[0].description),
  tool('kb_outline', 'read', TOOL_DEFS[1].description, { repId: { type: 'string' } }),
  tool('kb_read', 'read', TOOL_DEFS[2].description, {
    repId: { type: 'string' }, heading: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' }, maxChars: { type: 'number' },
  }),
  tool('kb_search', 'read', TOOL_DEFS[3].description, { q: { type: 'string' }, limit: { type: 'number' } }, ['q']),
  tool('kb_annotate_suggest', 'derived', TOOL_DEFS[4].description, {
    repId: { type: 'string' },
    items: { type: 'array', items: { type: 'object' } },
  }, ['items']),
  tool('kb_propose', 'propose', TOOL_DEFS[5].description, {
    ops: { type: 'array', items: { type: 'object' } }, reason: { type: 'string' },
  }, ['ops']),
  tool('kb_capture', 'derived', TOOL_DEFS[6].description, {
    title: { type: 'string' }, body: { type: 'string' }, target: { type: 'string' },
  }, ['title']),
  tool('kb_loops', 'read', TOOL_DEFS[7].description, {
    action: { type: 'string', enum: ['list', 'status', 'show', 'check', 'brief', 'claim', 'release', 'leases', 'alerts'] },
    id: { type: 'string' }, target: { type: 'string' }, ttlMin: { type: 'number' },
  }),
  tool('kb_loop_run', 'commit', TOOL_DEFS[8].description, {
    id: { type: 'string' }, dryRun: { type: 'boolean' }, force: { type: 'boolean' },
  }, ['id']),
  tool('kb_loop_report', 'commit', TOOL_DEFS[9].description, {
    id: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string' },
    produced: { type: 'array', items: { type: 'string' } }, counts: { type: 'object' },
  }, ['id']),
];

function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function textContent(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
}

function normalizeApprovals(v: Partial<ApprovalPolicy> | undefined, fallback: ApprovalPolicy): ApprovalPolicy {
  const pick = (x: unknown, d: ApprovalPolicy['annotations']) => (x === 'readonly' || x === 'ask' || x === 'auto' ? x : d);
  return {
    annotations: pick(v?.annotations, fallback.annotations),
    body: pick(v?.body, fallback.body),
  };
}

/** 自动提交只允许这些 op；删除/归档/移动/外发永远不走自动 */
function autoAllowed(ops: unknown[]): { ok: boolean; reason?: string } {
  for (const raw of ops) {
    const op = asRecord(raw);
    const t = String(op.t ?? '');
    if (!['create', 'update', 'setBody', 'append'].includes(t)) return { ok: false, reason: `自动模式不允许 ${t} 操作` };
    if (t === 'create') {
      const obj = asRecord(op.obj);
      if (String(obj.type ?? '') !== 'note') return { ok: false, reason: '自动模式只允许新建笔记' };
    }
  }
  return { ok: true };
}

export class AgentSession {
  readonly id: string;
  readonly token: string;
  readonly createdAt = new Date().toISOString();
  status: SessionView['status'] = 'starting';
  caps?: HarnessCaps;
  configOptions: ConfigOption[] = [];
  error?: string;
  turns = 0;
  errors = 0;
  totalMs = 0;
  lastActiveAt = this.createdAt;
  context: SessionContext;
  skill?: AgentSkill | null;
  private driver?: AgentDriver;
  private startPromise: Promise<void>;
  private events: AgentEvent[] = [];
  private seq = 0;
  private subs = new Set<SessionSub>();
  private currentTurn = '';
  private turnChain: Promise<void> = Promise.resolve();
  private pendingProposals = new Map<string, PendingProposal>();
  private suggestions = new Map<string, AnnotationSuggestion & { repId: string }>();
  private autoCommits = 0;
  private autoChars = 0;
  readonly reportedLoops = new Set<string>();
  lastPack?: { usedChars: number; omitted: string[] };

  constructor(
    private readonly hab: Habitat,
    private readonly cfg: HarnessConfig,
    private readonly opts: { root: string; baseUrl: string },
    input: { focus: SessionFocus; refs: ContextRef[]; skillId?: string; approvals: Partial<ApprovalPolicy> },
  ) {
    this.id = shortId('sess');
    this.token = randomBytes(24).toString('base64url');
    this.skill = skillById(opts.root, input.skillId);
    this.context = {
      spaceId: hab.store.space.id,
      sessionId: this.id,
      focus: input.focus,
      refs: input.refs,
      skillId: input.skillId,
      approvals: normalizeApprovals(input.approvals, cfg.approvals ? normalizeApprovals(cfg.approvals, { annotations: 'ask', body: 'ask' }) : { annotations: 'ask', body: 'ask' }),
      budget: { maxChars: cfg.context?.maxChars ?? 24000, usedChars: 0 },
    };
    this.startPromise = this.start();
    this.startPromise.catch(() => undefined);
  }

  view(): SessionView {
    return {
      id: this.id,
      harnessId: this.cfg.id,
      status: this.status,
      focus: this.context.focus,
      skillId: this.context.skillId,
      approvals: this.context.approvals,
      caps: this.caps,
      configOptions: this.configOptions,
      createdAt: this.createdAt,
      error: this.error,
    };
  }

  metrics(): {
    id: string; harnessId: string; status: SessionView['status']; turns: number; errors: number;
    avgTurnMs: number; lastActiveAt: string; pendingProposals: number;
  } {
    return {
      id: this.id,
      harnessId: this.cfg.id,
      status: this.status,
      turns: this.turns,
      errors: this.errors,
      avgTurnMs: this.turns ? Math.round(this.totalMs / this.turns) : 0,
      lastActiveAt: this.lastActiveAt,
      pendingProposals: this.pendingProposals.size,
    };
  }

  pendingProposalIds(): string[] {
    return [...this.pendingProposals.keys()];
  }

  subscribe(send: (e: AgentEvent) => void, after = 0): () => void {
    const sub: SessionSub = { send };
    for (const e of this.events) if (e.seq > after) send(e);
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  private emit(e: DriverEvent): void {
    const ev = { ...e, seq: ++this.seq } as AgentEvent;
    this.events.push(ev);
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    for (const s of this.subs) {
      try { s.send(ev); } catch { /* 订阅方断开就算了 */ }
    }
  }

  private async start(): Promise<void> {
    try {
      const cwd = path.join(this.opts.root, '.habitat', 'state', 'agent', this.id, 'cwd');
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(cwd, 'README.md'), [
        '# Habitat agent sandbox',
        '',
        '这个目录是空的。不要在这里找知识库内容；',
        '所有读写都通过 habitat 的 MCP 工具（kb_*）完成。',
      ].join('\n'), 'utf8');

      const driver = this.cfg.driver === 'mock'
        ? new MockDriver()
        : this.cfg.driver === 'http'
          ? new WorkbuddyHttpDriver(this.cfg)
          : this.cfg.driver === 'remote'
            ? new RemoteAcpDriver(this.cfg)
            : new AcpDriver(this.cfg);
      this.driver = driver;

      const publicBase = (process.env.HABITAT_PUBLIC_URL || this.opts.baseUrl).replace(/\/+$/, '');
      const res = await driver.start({
        sessionId: this.id,
        cwd,
        mcpUrl: `${publicBase}/api/agent/mcp`,
        token: this.token,
        onEvent: (e) => this.emit({ ...e, turnId: this.currentTurn || (e as { turnId?: string }).turnId || '' }),
      });
      this.caps = res.caps;
      this.configOptions = res.configOptions;
      this.status = 'ready';
      this.emit({
        t: 'ready',
        sessionId: this.id,
        harness: this.cfg.id,
        caps: this.caps,
        configOptions: this.configOptions,
      });
    } catch (e) {
      await this.driver?.close().catch(() => undefined);
      this.status = 'error';
      this.error = (e as Error).message;
      this.emit({ t: 'error', code: 'start_failed', message: this.error, recoverable: true });
    }
  }

  async ready(): Promise<void> {
    await this.startPromise;
  }

  enqueueTurn(text: string): string {
    const turnId = shortId('turn');
    this.turnChain = this.turnChain.then(() => this.runTurn(turnId, text)).catch(() => undefined);
    return turnId;
  }

  private async runTurn(turnId: string, text: string): Promise<void> {
    await this.ready();
    if (this.status === 'error') {
      this.emit({ t: 'error', code: 'not_ready', message: this.error ?? '会话没有启动', recoverable: true });
      return;
    }
    if (this.status === 'closed') return;

    const started = Date.now();
    this.currentTurn = turnId;
    this.turns += 1;
    this.lastActiveAt = new Date().toISOString();
    this.autoCommits = 0;
    this.autoChars = 0;
    this.status = 'running';
    this.emit({ t: 'turn', turnId, phase: 'start' });

    try {
      const body = await this.focusBody();
      if (this.context.selection) {
        const loc = locateQuote(body, this.context.selection.quote, {
          prefix: this.context.selection.prefix,
          suffix: this.context.selection.suffix,
          from: this.context.selection.from,
          to: this.context.selection.to,
        });
        if (loc.ok) {
          this.context.selection = {
            ...this.context.selection,
            from: loc.from!,
            to: loc.to!,
            revision: this.context.focus.revision,
          };
        } else {
          this.context.selection = undefined;
          this.emit({ t: 'error', code: 'selection_stale', message: `选区在原文里找不到了（${loc.reason ?? '已变化'}），这一轮不带入选区。`, recoverable: true });
        }
      }
      const outline = parseOutline(body);
      const skill = this.skill;
      const section = this.context.selection
        ? sectionAt(body, outline, this.context.selection.from)
        : { title: outline[0]?.text ?? '', text: body };
      const pack = packContext({
        focusId: this.context.focus.id,
        focusTitle: this.context.focus.title,
        focusKind: this.context.focus.kind,
        revision: this.context.focus.revision,
        body,
        outline,
        selection: this.context.selection,
        refs: this.context.refs,
        skill: skill ? { name: skill.name, preamble: compileSkill(skill, { focusTitle: this.context.focus.title, sectionTitle: section.title }) } : null,
        maxChars: this.context.budget.maxChars,
      });
      this.lastPack = { usedChars: pack.usedChars, omitted: pack.omitted };
      this.context.budget.usedChars = pack.usedChars;

      const prompt = `${pack.text}\n\n<user>\n${text}\n</user>`;
      const result = await this.driver!.prompt(prompt);
      this.status = 'ready';
      this.totalMs += Date.now() - started;
      this.emit({ t: 'turn', turnId, phase: 'end', stopReason: result.stopReason ?? 'end_turn' });
    } catch (e) {
      this.status = 'ready';
      this.errors += 1;
      this.totalMs += Date.now() - started;
      this.emit({ t: 'error', code: 'turn_failed', message: (e as Error).message, recoverable: true });
      this.emit({ t: 'turn', turnId, phase: 'end', stopReason: 'error' });
    } finally {
      this.currentTurn = '';
      this.lastActiveAt = new Date().toISOString();
    }
  }

  async cancel(): Promise<void> {
    try { await this.driver?.cancel(); } catch { /* ignore */ }
    this.status = 'ready';
    this.emit({ t: 'turn', turnId: this.currentTurn, phase: 'end', stopReason: 'cancelled' });
  }

  async setConfig(optionId: string, value: string): Promise<ConfigOption[]> {
    if (!this.driver) throw new Error('会话还没有启动');
    this.configOptions = await this.driver.setConfig(optionId, value);
    this.emit({ t: 'config', options: this.configOptions });
    return this.configOptions;
  }

  setApprovals(patch: Partial<ApprovalPolicy>): ApprovalPolicy {
    this.context.approvals = normalizeApprovals({ ...this.context.approvals, ...patch }, this.context.approvals);
    if (this.context.approvals.body === 'readonly') this.pendingProposals.clear();
    return this.context.approvals;
  }

  addRef(ref: ContextRef): void {
    if (this.context.refs.some((r) => r.id === ref.id)) return;
    this.context.refs = [...this.context.refs, ref].slice(-5);
  }

  removeRef(id: string): void {
    this.context.refs = this.context.refs.filter((r) => r.id !== id);
  }

  setRefs(refs: ContextRef[]): void {
    this.context.refs = Array.isArray(refs) ? refs.slice(0, 5) : [];
  }

  async close(): Promise<void> {
    if (this.status === 'closed') return;
    this.status = 'closed';
    try { await this.driver?.close(); } catch { /* ignore */ }
    this.subs.clear();
  }

  private async focusBody(): Promise<string> {
    const id = this.context.focus.id;
    if (!id || this.context.focus.kind === 'none' || this.context.focus.kind === 'work') return '';
    try { return await this.hab.store.body(id); } catch { return ''; }
  }

  /* ---------------- session MCP ---------------- */

  async mcp(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = req.id;
    const method = String(req.method ?? '');
    const params = asRecord(req.params);
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
    const fail = (message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } });

    if (method === 'initialize') {
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'habitat-agent', version: '1.0.0' },
        instructions: '这是 Habitat 会话工具面。先 kb_session 看上下文，再读/搜；写操作受审批策略约束。',
      });
    }
    if (method === 'notifications/initialized' || method === 'ping') return reply({});
    if (method === 'tools/list') {
      return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    if (method !== 'tools/call') return fail(`不支持的方法：${method}`);

    const name = String(params.name ?? '');
    const args = asRecord(params.arguments);
    try {
      const result = await this.callTool(name, args);
      return reply(result);
    } catch (e) {
      return reply(textContent((e as Error).message, true));
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === 'kb_session') {
      return textContent(JSON.stringify({
        focus: this.context.focus,
        selection: this.context.selection ?? null,
        refs: this.context.refs,
        skill: this.skill?.id ?? null,
        approvals: this.context.approvals,
        budget: this.context.budget,
        lastPack: this.lastPack ?? null,
      }, null, 2));
    }
    if (name === 'kb_outline') {
      const body = await this.readBody(args.repId);
      return textContent(JSON.stringify(parseOutline(body), null, 2));
    }
    if (name === 'kb_read') {
      const body = await this.readBody(args.repId);
      const outline = parseOutline(body);
      let from = Number(args.from);
      let to = Number(args.to);
      if (args.heading) {
        const h = outline.find((x) => x.text === String(args.heading) || x.text.includes(String(args.heading)));
        if (!h) return textContent(`没有这个小节：${String(args.heading)}`, true);
        from = h.from;
        const next = outline[outline.indexOf(h) + 1];
        to = next ? next.from : body.length;
      }
      if (!Number.isFinite(from) || from < 0) from = 0;
      if (!Number.isFinite(to) || to <= from) to = body.length;
      const max = Math.min(Math.max(Number(args.maxChars) || 8000, 200), 16000);
      const piece = body.slice(from, Math.min(to, from + max));
      return textContent(piece + (to - from > max ? `\n…（已截断，共 ${to - from} 字）` : ''));
    }
    if (name === 'kb_search') {
      const q = String(args.q ?? '').trim();
      if (!q) return textContent('q 不能为空', true);
      const hits = this.hab.index.search(q).slice(0, Math.min(Number(args.limit) || 8, 20));
      if (!hits.length) return textContent(`没有命中「${q}」。`);
      return textContent(hits.map((h) => `${h.type}\t${h.id}\t${h.title}\n  ${(h.snippet ?? '').slice(0, 140)}`).join('\n'));
    }
    if (name === 'kb_annotate_suggest') {
      return this.suggestAnnotations(args);
    }
    if (name === 'kb_propose') {
      return this.propose(args);
    }
    if (name === 'kb_capture') {
      if (this.context.approvals.body === 'readonly') {
        return textContent('当前会话是只读模式，不能采集。', true);
      }
      const r = await this.hab.capture({
        title: String(args.title ?? '未命名'),
        body: String(args.body ?? ''),
        target: args.target === 'notes' ? 'notes' : 'inbox',
        actor: `agent:${this.cfg.id}`,
      });
      return textContent(`已采集 ${r.id}`);
    }
    if (name === 'kb_loops') return this.loopTool(args);
    if (name === 'kb_loop_run') return this.runLoopTool(args);
    if (name === 'kb_loop_report') return this.reportLoopTool(args);
    return textContent(`没有这个工具：${name}`, true);
  }

  private async readBody(repId?: unknown): Promise<string> {
    const id = String(repId ?? '') || (this.context.focus.kind === 'rep' || this.context.focus.kind === 'note' ? this.context.focus.id : '');
    if (!id) throw new Error('当前没有可读的正文；先打开一章或传 repId');
    return this.hab.store.body(id);
  }

  private async loopTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = String(args.action ?? 'status');
    if (action === 'list') {
      return textContent(JSON.stringify(LOOPS.map((l) => ({
        id: l.id, name: l.name, mode: l.mode, autonomy: l.autonomy, executors: l.executors, backlog: l.backlog,
      })), null, 2));
    }
    if (action === 'status') {
      const s = await computeStatuses(this.hab);
      return textContent(JSON.stringify({ at: s.at, summary: s.summary, backlog: s.backlog, states: s.states }, null, 2));
    }
    if (action === 'show') {
      const def = loopById(String(args.id ?? ''));
      return def ? textContent(JSON.stringify(def, null, 2)) : textContent(`没有这条闭环：${String(args.id ?? '')}`, true);
    }
    if (action === 'check') return textContent(JSON.stringify(await checkAutomation(this.hab), null, 2));
    if (action === 'brief') return textContent(await agentBrief(this.hab));
    if (action === 'leases') return textContent(JSON.stringify(await listLeases(this.hab), null, 2));
    if (action === 'alerts') return textContent(JSON.stringify(await runLoopAlerts(this.hab), null, 2));
    if (action === 'claim') {
      const id = String(args.id ?? '');
      const target = String(args.target ?? '');
      if (!id || !target) return textContent('claim 需要 id + target', true);
      const r = await claimTarget(this.hab, id, target, `agent:${this.cfg.id}`, Number(args.ttlMin) || 120);
      return textContent(JSON.stringify(r, null, 2));
    }
    if (action === 'release') {
      const id = String(args.id ?? '');
      if (!id) return textContent('release 需要 id', true);
      const n = await releaseClaims(this.hab, id, `agent:${this.cfg.id}`);
      return textContent(`已释放 ${n} 条认领`);
    }
    return textContent(`不支持的 action：${action}`, true);
  }

  private async runLoopTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(args.id ?? '');
    const def = loopById(id);
    if (!def) return textContent(`没有这条闭环：${id}`, true);
    // 不让 agent 递归触发「需要 platform-agent」的判断类闭环，否则会自己叫自己
    if (def.executors.includes('platform-agent') && !def.executors.includes('server')) {
      return textContent(`「${def.name}」是判断类闭环，不能由 agent 递归执行；请按工单用业务工具完成并 report。`, true);
    }
    const r = await runLoop(this.hab, id, {
      dryRun: args.dryRun === true,
      force: args.force === true,
      actor: `agent:${this.cfg.id}`,
    });
    return textContent(JSON.stringify(r, null, 2), r.result === 'fail');
  }

  private async reportLoopTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = String(args.id ?? '');
    if (!loopById(id)) return textContent(`没有这条闭环：${id}`, true);
    const produced = Array.isArray(args.produced) ? args.produced.map(String).slice(0, 200) : [];
    const counts = args.counts && typeof args.counts === 'object'
      ? Object.fromEntries(Object.entries(args.counts as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0]))
      : undefined;
    const receipt = await beat(this.hab, id, {
      ok: args.ok !== false,
      note: args.note ? String(args.note) : undefined,
      produced,
      counts,
      actor: `agent:${this.cfg.id}`,
    });
    this.reportedLoops.add(id);
    return textContent(JSON.stringify(receipt, null, 2));
  }

  private async suggestAnnotations(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.context.approvals.annotations === 'readonly') {
      return textContent('当前会话的批注是只读模式，不生成可落盘的批注建议。', true);
    }
    const repId = String(args.repId ?? '') || (this.context.focus.kind === 'rep' ? this.context.focus.id : '');
    if (!repId) return textContent('缺少 repId', true);
    const body = await this.hab.store.body(repId);
    const raw = Array.isArray(args.items) ? args.items : [];
    const accepted: AnnotationSuggestion[] = [];
    const rejected: { quote: string; reason: string }[] = [];

    for (const item of raw.slice(0, 5)) {
      const x = asRecord(item);
      const quote = String(x.quote ?? '').trim();
      const note = String(x.note ?? '').trim();
      if (!quote) { rejected.push({ quote, reason: '引文为空' }); continue; }
      const located = locateQuote(body, quote, { prefix: String(x.prefix ?? ''), suffix: String(x.suffix ?? '') });
      if (!located.ok) { rejected.push({ quote, reason: located.reason ?? '定位失败' }); continue; }
      const sug: AnnotationSuggestion = {
        id: shortId('sug'),
        repId,
        quote,
        note: note || '值得回看',
        color: String(x.color ?? 'yellow'),
        from: located.from,
        to: located.to,
      };
      accepted.push(sug);
      this.suggestions.set(sug.id, sug as AnnotationSuggestion & { repId: string });
    }

    if (accepted.length && this.context.approvals.annotations === 'auto') {
      const chars = accepted.reduce((n, x) => n + x.quote.length + x.note.length, 0);
      if (this.autoCommits >= 5 || this.autoChars + chars > 8000) {
        return textContent('自动模式本轮额度用完了（最多 5 次 / 8000 字），请转为逐条确认。', true);
      }
      this.autoCommits += 1;
      this.autoChars += chars;
      const result = await this.commitSuggestions(repId, accepted);
      this.emit({ t: 'annotation', turnId: this.currentTurn, items: result.accepted, accepted: true });
      return textContent(JSON.stringify({ accepted: result.accepted, rejected: [...rejected, ...result.rejected], auto: true }, null, 2));
    }

    if (accepted.length) this.emit({ t: 'annotation', turnId: this.currentTurn, items: accepted, accepted: false });
    return textContent(JSON.stringify({ accepted, rejected, auto: false }, null, 2));
  }

  private async propose(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.context.approvals.body === 'readonly') {
      return textContent('当前会话的正文是只读模式，不允许提案。', true);
    }
    const ops = Array.isArray(args.ops) ? args.ops : [];
    if (!ops.length) return textContent('ops 不能为空', true);
    // 删除 / 归档 / 移动 / 外发永远不走会话工具面，人工确认也不放开
    const dangerous = ops.map((x) => String(asRecord(x).t ?? '')).filter((t) => ['archive', 'remove', 'move'].includes(t));
    if (dangerous.length) return textContent(`会话不允许 ${dangerous.join(' / ')} 操作；这类动作只能在平台上人工完成。`, true);
    const reason = String(args.reason ?? 'Agent 提案');
    const cs = await this.hab.changes.propose({ ops: ops as never, reason, actor: `agent:${this.cfg.id}` as never });
    const checks = await this.hab.changes.validate(cs);
    const bad = checks.filter((c) => !c.ok && c.level === 'error');
    const diff = (cs.changes ?? []).map((c) => `${c.label}${c.diff ? `\n${c.diff}` : ''}`).join('\n\n') || reason;

    if (bad.length) {
      return textContent(`校验没过，没有落盘：\n${bad.map((b) => `- ${b.label}：${b.detail}`).join('\n')}`, true);
    }

    if (this.context.approvals.body === 'auto') {
      const allow = autoAllowed(ops);
      if (!allow.ok) {
        return textContent(`自动模式拒绝：${allow.reason}`, true);
      }
      const chars = JSON.stringify(ops).length;
      if (this.autoCommits >= 5 || this.autoChars + chars > 8000) {
        return textContent('自动模式本轮额度用完了（最多 5 次 / 8000 字），请转为逐条确认。', true);
      }
      this.autoCommits += 1;
      this.autoChars += chars;
      const r = await this.hab.changes.commit(cs.id);
      if (!r.ok) return textContent(`提交被拦下：${r.blocked?.map((b) => b.label).join('；') ?? '冲突'}`, true);
      this.emit({ t: 'tool', turnId: this.currentTurn, callId: cs.id, phase: 'end', name: 'kb_propose', tier: 'commit', ok: true, summary: '自动提交' });
      return textContent(`已自动提交 ${cs.id}，修订 ${(r.changeset as { rev?: number }).rev ?? '?'}`);
    }

    this.pendingProposals.set(cs.id, { id: cs.id, changesetId: cs.id, diff, reason });
    this.emit({
      t: 'permission',
      turnId: this.currentTurn,
      requestId: cs.id,
      kind: 'proposal',
      action: 'commit',
      preview: diff.slice(0, 4000),
      options: ['allow', 'deny'],
      proposalId: cs.id,
    });
    return textContent(`提案 ${cs.id} 已生成，等用户确认。\n${checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}：${c.detail}`).join('\n')}`);
  }

  async acceptAnnotations(repId: string, items: AnnotationSuggestion[]): Promise<{ accepted: AnnotationSuggestion[]; rejected: { quote: string; reason: string }[] }> {
    return this.commitSuggestions(repId, items);
  }

  private async commitSuggestions(repId: string, items: AnnotationSuggestion[]): Promise<{ accepted: AnnotationSuggestion[]; rejected: { quote: string; reason: string }[] }> {
    if (this.context.approvals.annotations === 'readonly') {
      return { accepted: [], rejected: items.map((i) => ({ quote: i.quote, reason: '当前会话批注为只读模式' })) };
    }
    const body = await this.hab.store.body(repId);
    const existing = this.hab.store.all('annotation') as never as { targetRepId: string; quote: string; locator?: { from?: number } }[];
    const accepted: AnnotationSuggestion[] = [];
    const rejected: { quote: string; reason: string }[] = [];

    for (const item of items.slice(0, 10)) {
      const quote = String(item.quote ?? '').trim();
      if (!quote) { rejected.push({ quote, reason: '引文为空' }); continue; }
      const located = locateQuote(body, quote);
      if (!located.ok) { rejected.push({ quote, reason: located.reason ?? '定位失败' }); continue; }
      const dup = existing.some((a) => a.targetRepId === repId && a.quote === quote && a.locator?.from === located.from);
      if (dup) { rejected.push({ quote, reason: '这条批注已经存在' }); continue; }
      await this.hab.annotate({
        repId,
        quote,
        note: item.note,
        color: item.color || 'yellow',
        from: located.from!,
        to: located.to!,
        actor: `agent:${this.cfg.id}` as never,
        origin: 'ai',
        skillId: this.context.skillId,
        sessionId: this.id,
      });
      accepted.push({ ...item, from: located.from, to: located.to });
      this.suggestions.delete(item.id);
    }
    return { accepted, rejected };
  }

  async commitProposal(proposalId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.context.approvals.body === 'readonly') return { ok: false, error: '当前会话为只读模式' };
    const p = this.pendingProposals.get(proposalId);
    if (!p) return { ok: false, error: '这条提案不属于当前会话，或已经处理过' };
    const r = await this.hab.changes.commit(p.changesetId);
    this.pendingProposals.delete(proposalId);
    if (!r.ok) return { ok: false, error: r.blocked?.map((b) => b.label).join('；') ?? '冲突' };
    this.emit({ t: 'tool', turnId: this.currentTurn, callId: p.id, phase: 'end', name: 'kb_propose', tier: 'commit', ok: true, summary: '用户确认后提交' });
    return { ok: true };
  }

  rejectProposal(proposalId: string): boolean {
    return this.pendingProposals.delete(proposalId);
  }
}

export class AgentService {
  private sessions = new Map<string, AgentSession>();
  private probeCache = new Map<string, { at: number; caps?: HarnessCaps; error?: string }>();
  private remotePeers = new Map<string, HarnessConfig>();
  private pairCodes = new Map<string, { at: number; label: string }>();

  constructor(
    private readonly hab: Habitat,
    private readonly opts: { root: string; baseUrl: () => string },
  ) {
    // 远端 bridge 的 id/endpoint/token 要跨重启保留，否则每次重启都要重新配对
    try {
      const file = path.join(opts.root, '.habitat/state/agent/remote-peers.json');
      const raw = fs.readFileSync(file, 'utf8');
      const list = JSON.parse(raw) as HarnessConfig[];
      for (const h of Array.isArray(list) ? list : []) if (h.id && h.endpoint) this.remotePeers.set(h.id, h);
    } catch { /* 首次运行没有文件 */ }
  }

  private saveRemotePeers(): void {
    try {
      const file = path.join(this.opts.root, '.habitat/state/agent/remote-peers.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify([...this.remotePeers.values()], null, 2), 'utf8');
    } catch { /* 写不了不影响内存里的会话；下次重启会丢 */ }
  }

  harnesses(): { file: ReturnType<typeof loadHarnessFile>; list: HarnessView[] } {
    const file = loadHarnessFile(this.opts.root);
    const all = [...file.harnesses, ...this.remotePeers.values()];
    const list = all.map((h) => {
      const installed = h.driver === 'mock' || h.driver === 'remote'
        ? true
        : Boolean(h.command && fs.existsSync(h.command)) || Boolean(findOnPath(h.command));
      return { ...publicHarness(h), installed };
    });
    return { file, list };
  }

  /** 生成一次配对码；远端 bridge 用它换 token，不用把 token 写进配置文件 */
  pairCode(label = '远端 harness'): { code: string; expiresAt: string } {
    const code = String(randomInt(100000, 1000000));
    this.pairCodes.set(code, { at: Date.now(), label: String(label).slice(0, 60) });
    return { code, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  }

  joinRemote(input: { code: string; endpoint: string; label?: string }): {
    harness: ReturnType<typeof publicHarness>; token: string;
  } {
    const rec = this.pairCodes.get(input.code);
    if (!rec || Date.now() - rec.at > 10 * 60_000) {
      this.pairCodes.delete(input.code);
      throw new Error('配对码无效或已过期');
    }
    if (!/^https?:\/\//i.test(input.endpoint)) throw new Error('endpoint 必须是 http(s) URL');
    this.pairCodes.delete(input.code);
    const token = randomBytes(24).toString('base64url');
    const cfg: HarnessConfig = {
      id: shortId('remote'),
      label: String(input.label || rec.label).slice(0, 60),
      driver: 'remote',
      endpoint: input.endpoint,
      token,
      context: { maxChars: 24000 },
      approvals: { annotations: 'ask', body: 'ask' },
      remote: true,
      enabled: true,
    };
    this.remotePeers.set(cfg.id, cfg);
    this.saveRemotePeers();
    return { harness: publicHarness(cfg), token };
  }

  private cfgOf(id?: string): HarnessConfig | undefined {
    const file = loadHarnessFile(this.opts.root);
    if (id && this.remotePeers.has(id)) return this.remotePeers.get(id);
    return harnessById(file, id ?? file.default);
  }

  skills(): AgentSkill[] {
    return loadSkills(this.opts.root);
  }

  async probe(id: string): Promise<HarnessView> {
    const cfg = this.cfgOf(id);
    if (!cfg) throw new Error(`没有这个 harness：${id}`);
    const cached = this.probeCache.get(id);
    if (cached && Date.now() - cached.at < 60_000) return { ...publicHarness(cfg), installed: !cached.error, caps: cached.caps, probeError: cached.error };
    if (cfg.driver === 'mock') {
      const caps = new MockDriver();
      const r = await caps.start({ sessionId: 'probe', cwd: this.opts.root, mcpUrl: `${this.opts.baseUrl()}/api/agent/mcp`, token: 'probe', onEvent: () => undefined });
      await caps.close();
      return { ...publicHarness(cfg), installed: true, caps: r.caps };
    }
    const driver = cfg.driver === 'remote'
      ? new RemoteAcpDriver(cfg)
      : cfg.driver === 'http' ? new WorkbuddyHttpDriver(cfg) : new AcpDriver(cfg);
    try {
      const r = await driver.start({
        sessionId: 'probe',
        cwd: path.join(this.opts.root, '.habitat', 'state', 'agent-probe', 'cwd'),
        mcpUrl: `${this.opts.baseUrl()}/api/agent/mcp`,
        token: 'probe',
        withMcp: false,
        onEvent: () => undefined,
      });
      await driver.close();
      this.probeCache.set(id, { at: Date.now(), caps: r.caps });
      return { ...publicHarness(cfg), installed: true, caps: r.caps };
    } catch (e) {
      await driver.close().catch(() => undefined);
      this.probeCache.set(id, { at: Date.now(), error: (e as Error).message });
      return { ...publicHarness(cfg), installed: false, probeError: (e as Error).message };
    }
  }

  create(input: {
    harnessId?: string;
    focus: SessionFocus;
    refs?: ContextRef[];
    skillId?: string;
    approvals?: Partial<ApprovalPolicy>;
  }): AgentSession {
    const cfg = this.cfgOf(input.harnessId);
    if (!cfg) throw new Error('没有可用的 harness');
    if (cfg.enabled === false) throw new Error(`${cfg.label} 未启用`);
    const session = new AgentSession(this.hab, cfg, { root: this.opts.root, baseUrl: this.opts.baseUrl() }, {
      focus: input.focus,
      refs: Array.isArray(input.refs) ? input.refs.slice(0, 5) : [],
      skillId: input.skillId,
      approvals: input.approvals ?? cfg.approvals ?? {},
    });
    this.sessions.set(session.id, session);
    return session;
  }

  /** 无界面的任务执行：平台自己跑闭环、批处理时用，不依赖外部 harness 平台调度 */
  async runTask(input: AgentTaskInput): Promise<AgentTaskResult> {
    const started = Date.now();
    const session = this.create({
      harnessId: input.harnessId,
      focus: { kind: 'none', id: '', title: input.loopId ? `闭环：${loopById(input.loopId)?.name ?? input.loopId}` : '平台任务', revision: 0 },
      refs: [],
      skillId: input.skillId,
      approvals: input.approvals ?? { annotations: 'ask', body: 'ask' },
    });
    const harnessId = session.view().harnessId;
    await session.ready();
    if (session.status === 'error') {
      const msg = session.error ?? '会话启动失败';
      if (input.loopId) {
        try {
          await beat(this.hab, input.loopId, {
            ok: false, note: `平台 Agent 启动失败：${msg}`.slice(0, 500), actor: `agent:${harnessId}`,
          });
        } catch { /* 回执失败不再掩盖原始错误 */ }
      }
      return {
        sessionId: session.id, harnessId, status: 'error', text: '', tools: [],
        errors: [msg], proposals: [], durationMs: Date.now() - started,
      };
    }

    const text: string[] = [];
    const tools: string[] = [];
    const errors: string[] = [];
    const proposals: string[] = [];
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    const unsubscribe = session.subscribe((e) => {
      if (e.t === 'text') text.push(e.delta);
      if (e.t === 'tool') tools.push(e.name);
      if (e.t === 'error') errors.push(e.message);
      if (e.t === 'permission' && e.kind === 'proposal') proposals.push(e.requestId);
      if (e.t === 'turn' && e.phase === 'end') settle();
    });
    const timer = setTimeout(() => {
      errors.push(`任务超时（${input.timeoutMs ?? 180_000}ms）`);
      void session.cancel();
      settle();
    }, Math.max(5_000, input.timeoutMs ?? 180_000));
    timer.unref?.();

    session.enqueueTurn(input.prompt);
    await done;
    clearTimeout(timer);
    unsubscribe();

    const result: AgentTaskResult = {
      sessionId: session.id,
      harnessId,
      status: errors.length ? (errors.some((x) => x.includes('超时')) ? 'timeout' : 'error') : 'ok',
      text: text.join(''),
      tools: [...new Set(tools)],
      errors,
      proposals: [...new Set(proposals)],
      durationMs: Date.now() - started,
    };

    // Agent 如果没自己 report，平台代记一笔：闭环的「跑没跑」不能依赖模型自觉。
    if (input.loopId && !session.reportedLoops.has(input.loopId)) {
      try {
        result.receipt = await beat(this.hab, input.loopId, {
          ok: result.status === 'ok',
          note: result.status === 'ok' ? '平台代记（agent 未调用 kb_loop_report）' : result.errors.join('；').slice(0, 500),
          produced: result.proposals.length ? result.proposals : (input.loopProduced ?? []),
          counts: { turns: 1, tools: result.tools.length },
          actor: `agent:${harnessId}`,
        });
      } catch (e) {
        result.errors.push(`回执写入失败：${(e as Error).message}`);
      }
    }

    if (!input.keepAlive) await session.close();
    return result;
  }

  /** 平台接管一条自动化闭环：先出工单，再交给配置好的 harness 执行 */
  async runLoopTask(loopId: string, opts: { harnessId?: string; approvals?: Partial<ApprovalPolicy>; timeoutMs?: number } = {}): Promise<AgentTaskResult> {
    const def = loopById(loopId);
    if (!def) throw new Error(`没有这条闭环：${loopId}`);
    if (!def.executors.includes('platform-agent')) throw new Error(`「${def.name}」没有声明 platform-agent 执行器`);
    const prep = await runLoop(this.hab, loopId, { actor: 'platform-agent' });
    const prompt = [
      `你在替 Habitat 平台执行自动化闭环「${def.name}」（${def.id}）。这不是聊天，按工单做完并交账。`,
      '',
      '<work_order>',
      prep.output,
      '</work_order>',
      '',
      '硬规则：',
      '1. 需要处理具体条目时，先 kb_loops action=claim 认领；不要抢别人已认领的。',
      '2. 只通过 kb_* 工具读写，不要直接改文件。',
      '3. 判断类只提案；确定性闭环可用 kb_loop_run。',
      '4. 完成或放弃都要 kb_loop_report，produced 写清对象/变更集 id。',
      '5. 不要重复报告同一条闭环。',
    ].join('\n');
    return this.runTask({ ...opts, loopId, loopProduced: prep.produced ?? [], prompt });
  }

  /** 跑一轮「该跑但没跑」的闭环；由定时器或运维手动调用 */
  async runDueLoops(opts: { harnessId?: string; limit?: number } = {}): Promise<AgentTaskResult[]> {
    const status = await computeStatuses(this.hab);
    const candidates = status.states
      .filter((s) => s.state === 'down' || s.state === 'late' || s.state === 'never')
      .map((s) => ({ state: s, def: loopById(s.id) }))
      .filter((x): x is { state: typeof status.states[number]; def: NonNullable<ReturnType<typeof loopById>> } => Boolean(x.def))
      .filter((x) => x.def!.executors.includes('platform-agent') && !x.def!.serverOnly)
      .filter((x) => x.state.backlog == null || x.state.backlog > 0)
      .slice(0, Math.max(1, opts.limit ?? 1));
    const out: AgentTaskResult[] = [];
    for (const c of candidates) {
      out.push(await this.runLoopTask(c.def!.id, { harnessId: opts.harnessId }));
    }
    return out;
  }

  list(): ReturnType<AgentSession['metrics']>[] {
    return [...this.sessions.values()].map((s) => s.metrics());
  }

  metrics(): {
    total: number; active: number; turns: number; errors: number; avgTurnMs: number;
    byHarness: Record<string, { sessions: number; turns: number; errors: number }>;
  } {
    const all = this.list();
    const byHarness: Record<string, { sessions: number; turns: number; errors: number }> = {};
    let turns = 0;
    let errors = 0;
    let totalMs = 0;
    let counted = 0;
    for (const s of all) {
      turns += s.turns;
      errors += s.errors;
      if (s.turns) { totalMs += s.avgTurnMs * s.turns; counted += s.turns; }
      const h = byHarness[s.harnessId] ??= { sessions: 0, turns: 0, errors: 0 };
      h.sessions += 1;
      h.turns += s.turns;
      h.errors += s.errors;
    }
    return {
      total: all.length,
      active: all.filter((s) => s.status !== 'closed').length,
      turns,
      errors,
      avgTurnMs: counted ? Math.round(totalMs / counted) : 0,
      byHarness,
    };
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  forget(id: string): void {
    this.sessions.delete(id);
  }

  byToken(token: string): AgentSession | undefined {
    if (!token) return undefined;
    for (const s of this.sessions.values()) if (s.token === token) return s;
    return undefined;
  }

  async mcp(token: string, req: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const s = this.byToken(token);
    if (!s) return null;
    return s.mcp(req);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
  }
}

/** 对外视图不带 env：里面可能有密钥，不能经 /api/agent/harnesses 回给浏览器 */
function publicHarness(h: HarnessConfig): Omit<HarnessConfig, 'env' | 'token'> {
  const { env: _env, token: _token, ...rest } = h;
  return rest;
}

function findOnPath(command?: string): string {
  if (!command) return '';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' && !path.extname(command)
    ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`]
    : [command];
  for (const d of dirs) for (const n of names) {
    const p = path.join(d, n);
    if (fs.existsSync(p)) return p;
  }
  return '';
}
