/**
 * Agent 会话 HTTP 接口。
 *
 * 普通会话接口走用户登录态；/api/agent/mcp 是 harness 的回调口，
 * 只认 Bearer <session token>，在 auth.ts 里单独放行、在本文件里自行校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Habitat } from '../core/space.ts';
import type { AgentEvent, ApprovalPolicy, ContextRef, SessionFocus } from '../../shared/agent.ts';
import type { AgentService } from '../agent/service.ts';
import { loadHarnessFile } from '../agent/config.ts';

export interface AgentRouteDeps {
  hab: Habitat;
  agent: AgentService;
}

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function bearer(req: FastifyRequest): string {
  const h = String(req.headers.authorization ?? '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function sse(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  reply.raw.write(':ok\n\n');
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const { hab, agent } = deps;

  app.get('/api/agent/harnesses', async () => {
    const { file, list } = agent.harnesses();
    return { ok: true, source: file.source, path: file.path, default: file.default, harnesses: list };
  });

  app.post('/api/agent/harnesses/:id/probe', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { ok: true, harness: await agent.probe(id) };
    } catch (e) {
      return reply.code(404).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/api/agent/skills', async () => ({ ok: true, skills: agent.skills() }));

  app.post('/api/agent/sessions', async (req, reply) => {
    const b = bodyOf(req);
    const focusRaw = (b.focus ?? {}) as Record<string, unknown>;
    const kind = String(focusRaw.kind ?? 'none');
    const focus: SessionFocus = {
      kind: (['rep', 'note', 'work', 'none'].includes(kind) ? kind : 'none') as SessionFocus['kind'],
      id: String(focusRaw.id ?? ''),
      title: String(focusRaw.title ?? ''),
      revision: Number(focusRaw.revision) || 0,
    };
    try {
      const session = agent.create({
        harnessId: b.harnessId ? String(b.harnessId) : undefined,
        focus,
        refs: Array.isArray(b.refs) ? (b.refs as ContextRef[]) : [],
        skillId: b.skillId ? String(b.skillId) : undefined,
        approvals: (b.approvals ?? undefined) as Partial<ApprovalPolicy> | undefined,
      });
      return { ok: true, session: session.view() };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/api/agent/sessions', async () => ({ ok: true, sessions: agent.list(), metrics: agent.metrics() }));

  app.get('/api/agent/metrics', async () => ({ ok: true, metrics: agent.metrics() }));

  app.post('/api/agent/tasks', async (req, reply) => {
    const b = bodyOf(req);
    const prompt = String(b.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ ok: false, error: 'prompt 不能为空' });
    try {
      const result = await agent.runTask({
        prompt,
        harnessId: b.harnessId ? String(b.harnessId) : undefined,
        skillId: b.skillId ? String(b.skillId) : undefined,
        loopId: b.loopId ? String(b.loopId) : undefined,
        approvals: (b.approvals ?? undefined) as Partial<ApprovalPolicy> | undefined,
        timeoutMs: Number(b.timeoutMs) || undefined,
        keepAlive: b.keepAlive === true,
      });
      return { ok: true, task: result };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/api/agent/tasks/loop/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = bodyOf(req);
    try {
      const task = await agent.runLoopTask(id, {
        harnessId: b.harnessId ? String(b.harnessId) : undefined,
        approvals: (b.approvals ?? undefined) as Partial<ApprovalPolicy> | undefined,
        timeoutMs: Number(b.timeoutMs) || undefined,
      });
      return { ok: true, task };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/api/agent/autopilot/run', async (req, reply) => {
    const b = bodyOf(req);
    try {
      const tasks = await agent.runDueLoops({
        harnessId: b.harnessId ? String(b.harnessId) : undefined,
        limit: Number(b.limit) || 1,
      });
      return { ok: true, tasks };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/api/agent/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = agent.get(id);
    if (!s) return reply.code(404).send({ ok: false, error: '会话不存在' });
    return { ok: true, session: s.view(), context: s.context, lastPack: s.lastPack ?? null };
  });

  app.get('/api/agent/sessions/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = agent.get(id);
    if (!s) return reply.code(404).send({ ok: false, error: '会话不存在' });
    const headerAfter = Number(req.headers['last-event-id']) || 0;
    const after = Number((req.query as { after?: string }).after) || headerAfter;
    sse(reply);
    const raw = reply.raw;
    const send = (e: AgentEvent) => {
      if (raw.writableEnded) return;
      raw.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const unsubscribe = s.subscribe(send, after);
    const heartbeat = setInterval(() => {
      if (!raw.writableEnded) raw.write(':ping\n\n');
    }, 15_000);
    heartbeat.unref?.();
    const done = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', done);
    raw.on('close', done);
  });

  app.post('/api/agent/sessions/:id/turns', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = agent.get(id);
    if (!s) return reply.code(404).send({ ok: false, error: '会话不存在' });
    const b = bodyOf(req);
    const text = String(b.text ?? '').trim();
    if (!text) return reply.code(400).send({ ok: false, error: 'text 不能为空' });
    if (Array.isArray(b.refs)) s.setRefs(b.refs as ContextRef[]);
    return { ok: true, turnId: s.enqueueTurn(text) };
  });

  app.post('/api/agent/sessions/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = agent.get(id);
    if (!s) return reply.code(404).send({ ok: false, error: '会话不存在' });
    await s.cancel();
    return { ok: true };
  });

  app.post('/api/agent/sessions/:id/config', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = agent.get(id);
    if (!s) return reply.code(404).send({ ok: false, error: '会话不存在' });
    const b = bodyOf(req);
    try {
      return { ok: true, configOptions: await s.setConfig(String(b.optionId ?? ''), String(b.value ?? '')) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.patch('/api/agent/sessions/:id/approvals', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = agent.get(id);
    if (!s) return reply.code(404).send({ ok: false, error: '会话不存在' });
    const b = bodyOf(req);
    const next = s.setApprovals({
      annotations: b.annotations as ApprovalPolicy['annotations'],
      body: b.body as ApprovalPolicy['body'],
    });
    return { ok: true, approvals: next };
  });

  app.post('/api/agent/sessions/:id/permission', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = agent.get(id);
    if (!s) return reply.code(404).send({ ok: false, error: '会话不存在' });
    const b = bodyOf(req);
    const requestId = String(b.requestId ?? '');
    if (String(b.decision ?? '') === 'deny') s.rejectProposal(requestId);
    return { ok: true };
  });

  app.post('/api/agent/annotations/accept', async (req, reply) => {
    const b = bodyOf(req);
    const sessionId = String(b.sessionId ?? '');
    const s = agent.get(sessionId);
    if (!s) return reply.code(404).send({ ok: false, error: '会话不存在' });
    const repId = String(b.repId ?? '');
    if (!repId) return reply.code(400).send({ ok: false, error: 'repId 不能为空' });
    const items = Array.isArray(b.items) ? b.items as never[] : [];
    const result = await s.acceptAnnotations(repId, items);
    return { ok: true, ...result };
  });

  app.post('/api/agent/proposals/:id/commit', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = bodyOf(req);
    const s = agent.get(String(b.sessionId ?? ''));
    if (!s) return reply.code(404).send({ ok: false, error: '会话不存在' });
    const r = await s.commitProposal(id);
    return r.ok ? { ok: true } : reply.code(409).send({ ok: false, error: r.error });
  });

  app.get('/api/agent/config', async () => {
    const file = path.join(hab.store.root, 'agents.yaml');
    const raw = await fs.promises.readFile(file, 'utf8').catch(() => '');
    const loaded = loadHarnessFile(hab.store.root);
    return { ok: true, path: file, raw, exists: Boolean(raw), source: loaded.source, error: loaded.source === 'default' && raw ? loaded.path : undefined };
  });

  app.put('/api/agent/config', async (req, reply) => {
    const b = bodyOf(req);
    const raw = String(b.raw ?? '');
    if (raw.length > 200_000) return reply.code(400).send({ ok: false, error: '配置太长（>200KB）' });
    const file = path.join(hab.store.root, 'agents.yaml');
    const old = await fs.promises.readFile(file, 'utf8').catch(() => null);
    try {
      const parsed = yamlParse(raw) as { harnesses?: { id?: string }[] } | null;
      const list = Array.isArray(parsed?.harnesses) ? parsed!.harnesses! : [];
      if (!list.length) throw new Error('至少要有 harnesses 列表，且至少一条');
      const ids = list.map((h) => String(h.id ?? '').trim());
      if (ids.some((id) => !id)) throw new Error('每条 harness 都必须有 id');
      if (new Set(ids).size !== ids.length) throw new Error('harness id 不能重复');
      await fs.promises.writeFile(file, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');
      const loaded = loadHarnessFile(hab.store.root);
      if (loaded.source !== 'file') throw new Error('YAML 结构不对，加载器回退了内置配置');
      return { ok: true, path: file, source: loaded.source, default: loaded.default, harnesses: loaded.harnesses.length };
    } catch (e) {
      // 写坏了就还原，绝不把助手留在半坏状态
      if (old !== null) await fs.promises.writeFile(file, old, 'utf8').catch(() => undefined);
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/api/agent/pair', async (req) => {
    const b = bodyOf(req);
    return { ok: true, ...agent.pairCode(b.label ? String(b.label) : undefined) };
  });

  /** 远端 bridge 用配对码换 token；不需要用户 Cookie，码本身是一次性凭据 */
  app.post('/api/agent/bridge/join', async (req, reply) => {
    const b = bodyOf(req);
    try {
      return { ok: true, ...agent.joinRemote({
        code: String(b.code ?? ''),
        endpoint: String(b.endpoint ?? ''),
        label: b.label ? String(b.label) : undefined,
      }) };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.delete('/api/agent/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const s = agent.get(id);
    if (s) await s.close();
    agent.forget(id);
    return { ok: true };
  });

  /** harness 回调口：只认 session token */
  app.post('/api/agent/mcp', async (req, reply) => {
    const token = bearer(req);
    if (!token) return reply.code(401).send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '缺少 session token' } });
    const payload = req.body as unknown;
    if (Array.isArray(payload)) {
      const out = [];
      for (const item of payload) out.push(await agent.mcp(token, (item ?? {}) as Record<string, unknown>));
      return out;
    }
    const result = await agent.mcp(token, (payload ?? {}) as Record<string, unknown>);
    if (!result) return reply.code(403).send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'token 不匹配任何活跃会话' } });
    return result;
  });
}
