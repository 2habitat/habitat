/**
 * 远端 ACP 驱动：平台主动 POST 到一个远端 bridge（HTTP + JSON/SSE）。
 *
 * 远端 bridge 由 `scripts/agent-bridge.mjs` 提供；它在本机拉起 dsh，
 * 平台仍然持有会话、上下文、工具面和审批。适合 LAN / 有公网入口的机器。
 * NAT 后面请先做反向隧道；平台不假设远端能访问 localhost。
 */
import type { AgentEvent, ConfigOption, HarnessCaps, HarnessConfig, StartResult } from '../../shared/agent.ts';
import type { DriverEvent, DriverStartInput } from './acp.ts';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
}

function normalizeOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfigOption[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o.id) continue;
    const choices: ConfigOption['options'] = [];
    for (const opt of Array.isArray(o.options) ? o.options : []) {
      const x = asRecord(opt);
      if (Array.isArray(x.options)) {
        for (const c0 of x.options) {
          const c = asRecord(c0);
          if (c.value !== undefined) choices.push({ value: String(c.value), name: String(c.name ?? c.value), description: c.description ? String(c.description) : undefined });
        }
      } else if (x.value !== undefined) {
        choices.push({ value: String(x.value), name: String(x.name ?? x.value), description: x.description ? String(x.description) : undefined });
      }
    }
    out.push({
      id: String(o.id), name: String(o.name ?? o.id), category: o.category ? String(o.category) : undefined,
      type: String(o.type ?? 'select'), currentValue: String(o.currentValue ?? ''), options: choices,
    });
  }
  return out;
}

function parseSse(chunk: string): { frames: string[]; rest: string } {
  const parts = chunk.split(/\n\n/);
  return { frames: parts.slice(0, -1), rest: parts[parts.length - 1] ?? '' };
}

export class RemoteAcpDriver {
  private input: DriverStartInput | null = null;
  private sessionId = '';
  private options: ConfigOption[] = [];
  private seq = 0;

  constructor(private readonly cfg: HarnessConfig) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
    };
  }

  private async request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (!this.cfg.endpoint) throw new Error('远端 harness 缺少 endpoint');
    const id = ++this.seq;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.cfg.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`远端 ACP HTTP ${res.status}：${(await res.text()).slice(0, 300)}`);
      const ct = String(res.headers.get('content-type') ?? '');
      if (!ct.includes('text/event-stream')) {
        const text = await res.text();
        const msg = asRecord(JSON.parse(text));
        if (msg.error) throw new Error(String(asRecord(msg.error).message ?? '远端 ACP 请求失败'));
        return msg.result;
      }
      if (!res.body) throw new Error('远端 ACP 没有响应体');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSse(buf);
        buf = rest;
        for (const frame of frames) {
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          let msg: Record<string, unknown>;
          try { msg = asRecord(JSON.parse(data)); } catch { continue; }
          if (typeof msg.method === 'string' && msg.id === undefined) {
            this.onNotification(msg.method, asRecord(msg.params));
          }
          if (Number(msg.id) === id) {
            if (msg.error) throw new Error(String(asRecord(msg.error).message ?? '远端 ACP 请求失败'));
            return msg.result;
          }
        }
      }
      throw new Error(`远端 ACP 连接结束但没有响应：${method}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async start(input: DriverStartInput): Promise<StartResult> {
    this.input = input;
    const init = asRecord(await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'habitat', version: '1.0.0' },
    }, 40_000));
    const ac = asRecord(init.agentCapabilities);
    const prompt = asRecord(ac.promptCapabilities);
    const mcp = asRecord(ac.mcpCapabilities);
    const caps: HarnessCaps = {
      streamText: true,
      thoughts: true,
      toolCalls: true,
      permissions: true,
      mcp: { http: mcp.http === true, sse: mcp.sse === true, stdio: true },
      systemPrompt: false,
      images: prompt.image === true,
      embeddedContext: prompt.embeddedContext === true,
      resume: Boolean(ac.loadSession || asRecord(ac.sessionCapabilities).resume),
      maxContextChars: this.cfg.context?.maxChars ?? 24000,
      protocolVersion: String(init.protocolVersion ?? ''),
      configOptions: [],
    };
    const created = asRecord(await this.request('session/new', {
      cwd: input.cwd,
      mcpServers: input.withMcp === false ? [] : [{
        type: 'http',
        name: 'habitat',
        url: input.mcpUrl,
        headers: [{ name: 'Authorization', value: `Bearer ${input.token}` }],
      }],
    }, 30_000));
    this.sessionId = String(created.sessionId ?? '');
    if (!this.sessionId) throw new Error('远端 bridge 没有返回 sessionId');
    this.options = normalizeOptions(created.configOptions);
    caps.configOptions = this.options;
    return { caps, configOptions: this.options };
  }

  async prompt(text: string): Promise<{ stopReason?: string }> {
    const r = asRecord(await this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, 180_000));
    return { stopReason: r.stopReason ? String(r.stopReason) : undefined };
  }

  async cancel(): Promise<void> {
    try { await this.request('session/cancel', { sessionId: this.sessionId }, 5_000); } catch { /* ignore */ }
  }

  async setConfig(optionId: string, value: string): Promise<ConfigOption[]> {
    const r = asRecord(await this.request('session/set_config_option', {
      sessionId: this.sessionId, configId: optionId, value,
    }, 15_000));
    const next = normalizeOptions(r.configOptions);
    this.options = next.length ? next : this.options.map((o) => (o.id === optionId ? { ...o, currentValue: value } : o));
    return this.options;
  }

  async close(): Promise<void> {
    try { if (this.sessionId) await this.request('session/close', { sessionId: this.sessionId }, 5_000); } catch { /* ignore */ }
    this.sessionId = '';
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update') return;
    const update = asRecord(params.update);
    const kind = String(update.sessionUpdate ?? '');
    const emit = (e: DriverEvent) => this.input?.onEvent({ ...e, turnId: '' });
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = asRecord(update.content);
      const text = content.type === 'text' ? String(content.text ?? '') : '';
      if (text) emit({ t: kind === 'agent_message_chunk' ? 'text' : 'thought', turnId: '', delta: text });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const status = String(update.status ?? '');
      const end = status === 'completed' || status === 'failed';
      emit({
        t: 'tool', turnId: '', callId: String(update.toolCallId ?? ''), phase: end ? 'end' : 'start',
        name: String(update.name ?? update.title ?? 'tool'), tier: 'read', title: update.title ? String(update.title) : undefined,
        ok: end ? status === 'completed' : undefined,
      });
      return;
    }
    if (kind === 'config_option_update') {
      const next = normalizeOptions(update.configOptions);
      if (next.length) { this.options = next; emit({ t: 'config', options: next }); }
    }
  }
}
