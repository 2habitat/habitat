/**
 * WorkBuddy CLI 的 ACP HTTP/SSE 传输。
 *
 * 它的 /api/v1/acp 不是标准 ACP streamable-http：
 *   GET  → SSE，响应头 acp-connection-id
 *   POST → 带 acp-connection-id，SSE 里回 JSON-RPC 帧
 * 所以单独放一个 driver，不污染标准 stdio ACP。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentEvent, ConfigOption, HarnessCaps, HarnessConfig, StartResult } from '../../shared/agent.ts';
import type { DriverEvent, DriverStartInput } from './acp.ts';
import { findCommand } from './config.ts';

type Listener = (method: string, params: Record<string, unknown>) => void;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
}

function normalizeOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfigOption[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    const id = String(o.id ?? '');
    if (!id) continue;
    const choices: ConfigOption['options'] = [];
    for (const opt of Array.isArray(o.options) ? o.options : []) {
      const x = asRecord(opt);
      if (Array.isArray(x.options)) {
        for (const child of x.options) {
          const c = asRecord(child);
          if (c.value !== undefined) choices.push({ value: String(c.value), name: String(c.name ?? c.value), description: c.description ? String(c.description) : undefined });
        }
      } else if (x.value !== undefined) {
        choices.push({ value: String(x.value), name: String(x.name ?? x.value), description: x.description ? String(x.description) : undefined });
      }
    }
    out.push({
      id, name: String(o.name ?? id), category: o.category ? String(o.category) : undefined,
      type: String(o.type ?? 'select'), currentValue: String(o.currentValue ?? ''), options: choices,
    });
  }
  return out;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function waitPort(port: number, ms = 20_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - started > ms) reject(new Error('WorkBuddy ACP 端口没有起来'));
        else setTimeout(tick, 150);
      });
    };
    tick();
  });
}

function parseSse(chunk: string): { frames: string[]; rest: string } {
  const parts = chunk.split(/\n\n/);
  const rest = parts.pop() ?? '';
  return { frames: parts, rest };
}

function dataOf(frame: string): string {
  return frame.split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('\n');
}

class HttpPeer {
  connectionId = '';
  private getReq: http.ClientRequest | null = null;
  private getRes: http.IncomingMessage | null = null;
  private promptActive = 0;

  constructor(
    private readonly port: number,
    private readonly onNotify: Listener,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: this.port, path: '/api/v1/acp', method: 'GET',
        headers: { accept: 'text/event-stream' },
      }, (res) => {
        this.getRes = res;
        this.connectionId = String(res.headers['acp-connection-id'] ?? '');
        if (!this.connectionId) { reject(new Error('WorkBuddy 没有返回 acp-connection-id')); return; }
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk: string) => {
          buf += chunk;
          const { frames, rest } = parseSse(buf);
          buf = rest;
          for (const f of frames) {
            const data = dataOf(f);
            if (!data || data === 'ok') continue;
            try {
              const msg = JSON.parse(data) as Record<string, unknown>;
              // prompt 期间以 POST 流为主；GET 只接异步广播，避免同一段文本到两次
              if (typeof msg.method === 'string' && msg.id === undefined && this.promptActive === 0) {
                this.onNotify(msg.method, asRecord(msg.params));
              }
            } catch { /* 忽略坏帧 */ }
          }
        });
        resolve();
      });
      req.on('error', reject);
      req.end();
      this.getReq = req;
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const rid = ++HttpPeer.seq;
      const isPrompt = method === 'session/prompt';
      if (isPrompt) this.promptActive += 1;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (isPrompt) this.promptActive = Math.max(0, this.promptActive - 1);
        reject(new Error(`ACP HTTP 请求超时：${method}`));
      }, timeoutMs);
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (isPrompt) this.promptActive = Math.max(0, this.promptActive - 1);
        fn();
      };

      const body = JSON.stringify({ jsonrpc: '2.0', id: rid, method, params });
      const req = http.request({
        host: '127.0.0.1', port: this.port, path: '/api/v1/acp', method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'acp-connection-id': this.connectionId,
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        res.setEncoding('utf8');
        let buf = '';
        let raw = '';
        res.on('data', (chunk: string) => {
          raw += chunk;
          if (!String(res.headers['content-type'] ?? '').includes('text/event-stream')) return;
          buf += chunk;
          const { frames, rest } = parseSse(buf);
          buf = rest;
          for (const f of frames) {
            const data = dataOf(f);
            if (!data || data === 'ok') continue;
            try {
              const msg = JSON.parse(data) as Record<string, unknown>;
              if (typeof msg.method === 'string' && msg.id === undefined) {
                // session/prompt 的实时文本/工具事件走 POST 流
                this.onNotify(msg.method, asRecord(msg.params));
              }
              if (Number(msg.id) === rid) {
                if (msg.error) done(() => reject(new Error(String(asRecord(msg.error).message ?? 'ACP 请求失败'))));
                else done(() => resolve(msg.result));
              }
            } catch { /* 忽略坏帧 */ }
          }
        });
        res.on('end', () => {
          if (settled) return;
          // 少数实现直接回 JSON body，不包 SSE
          try {
            const msg = JSON.parse(raw.trim()) as Record<string, unknown>;
            if (Number(msg.id) === rid) {
              if (msg.error) done(() => reject(new Error(String(asRecord(msg.error).message ?? 'ACP 请求失败'))));
              else done(() => resolve(msg.result));
              return;
            }
          } catch { /* ignore */ }
          done(() => reject(new Error(`ACP 连接结束但没有响应：${method}`)));
        });
      });
      req.on('error', (e) => done(() => reject(e)));
      req.write(body);
      req.end();
    });
  }

  close(): void {
    try { this.getRes?.destroy(); } catch { /* ignore */ }
    try { this.getReq?.destroy(); } catch { /* ignore */ }
  }

  private static seq = 0;
}

export class WorkbuddyHttpDriver {
  private child: ChildProcessWithoutNullStreams | null = null;
  private peer: HttpPeer | null = null;
  private input: DriverStartInput | null = null;
  private sessionId = '';
  private options: ConfigOption[] = [];
  private stderr = '';

  constructor(private readonly cfg: HarnessConfig) {}

  async start(input: DriverStartInput): Promise<StartResult> {
    this.input = input;
    const cwd = path.resolve(input.cwd);
    fs.mkdirSync(cwd, { recursive: true });
    const port = await freePort();
    const command = findCommand(this.cfg.command ?? '') || this.cfg.command || '';
    if (!command) throw new Error(`找不到 WorkBuddy CLI：${this.cfg.command ?? ''}`);
    const baseArgs = this.cfg.args?.length
      ? this.cfg.args.filter((a) => a !== '--port' && !/^\d+$/.test(a))
      : ['--serve', '--acp', '--auth', 'none', '--tools', ''];
    const args = [...baseArgs, '--port', String(port), '--host', '127.0.0.1'];

    const isScript = !/\.(exe|cmd|bat)$/i.test(command) && fs.existsSync(command);
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const spawnCmd = isScript ? process.execPath : command;
    const spawnArgs = isScript ? [command, ...args] : args;
    this.child = spawn(spawnCmd, spawnArgs, {
      cwd,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      windowsHide: true,
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child.on('error', (e) => { this.stderr = `${this.stderr}${e.message}`.slice(-4000); });
    this.child.stderr.on('data', (d) => { this.stderr = `${this.stderr}${d.toString()}`.slice(-4000); });
    this.child.stdout.on('data', () => undefined);
    this.child.on('exit', () => {
      if (this.peer) this.peer.close();
      this.peer = null;
    });

    try {
      // WorkBuddy CLI 冷启动会先起 Web 服务再挂 ACP，20s 在慢机器上不够
      await waitPort(port, 60_000);
    } catch (e) {
      const detail = this.stderr.trim().slice(-600);
      throw new Error(`WorkBuddy ACP 端口没有起来：${detail || '启动超时'}`);
    }
    const peer = new HttpPeer(port, (method, params) => this.onNotification(method, params));
    this.peer = peer;
    await peer.connect();

    const init = asRecord(await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'habitat', version: '1.0.0' },
    }, 20_000));
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
      resume: Boolean(ac.loadSession),
      maxContextChars: this.cfg.context?.maxChars ?? 32000,
      protocolVersion: String(init.protocolVersion ?? ''),
      configOptions: [],
    };

    const created = asRecord(await peer.request('session/new', {
      cwd,
      mcpServers: input.withMcp === false ? [] : [{
        type: 'http',
        name: 'habitat',
        url: input.mcpUrl,
        headers: [{ name: 'Authorization', value: `Bearer ${input.token}` }],
      }],
    }, 30_000));
    this.sessionId = String(created.sessionId ?? '');
    this.options = normalizeOptions(created.configOptions);
    caps.configOptions = this.options;
    if (!this.sessionId) throw new Error('WorkBuddy 没有返回 sessionId');
    return { caps, configOptions: this.options };
  }

  async prompt(text: string): Promise<{ stopReason?: string }> {
    if (!this.peer) throw new Error('WorkBuddy 未启动');
    const r = asRecord(await this.peer.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, 180_000));
    const meta = asRecord(r._meta);
    const rawError = meta['codebuddy.ai/errorMessage'];
    if (rawError) {
      let message = String(rawError);
      try {
        const parsed = asRecord(JSON.parse(message));
        const data = asRecord(parsed.data);
        message = String(data.details ?? parsed.message ?? message);
      } catch { /* 保持原文 */ }
      if (/Authentication required/i.test(message)) {
        message = 'WorkBuddy CLI 未登录：请先在终端运行 codebuddy，按 /login 完成登录后重试';
      }
      throw new Error(`WorkBuddy：${message}`);
    }
    return { stopReason: r.stopReason ? String(r.stopReason) : undefined };
  }

  async cancel(): Promise<void> {
    try { await this.peer?.request('session/cancel', { sessionId: this.sessionId }, 5_000); } catch { /* ignore */ }
  }

  async setConfig(optionId: string, value: string): Promise<ConfigOption[]> {
    if (!this.peer) throw new Error('WorkBuddy 未启动');
    const r = asRecord(await this.peer.request('session/set_config_option', {
      sessionId: this.sessionId, configId: optionId, value,
    }, 15_000));
    const next = normalizeOptions(r.configOptions);
    this.options = next.length ? next : this.options.map((o) => (o.id === optionId ? { ...o, currentValue: value } : o));
    return this.options;
  }

  async close(): Promise<void> {
    try { if (this.sessionId) await this.peer?.request('session/close', { sessionId: this.sessionId }, 5_000); } catch { /* ignore */ }
    this.peer?.close();
    const pid = this.child?.pid;
    this.child?.kill();
    if (pid) {
      setTimeout(() => {
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
          else process.kill(pid, 'SIGKILL');
        } catch { /* ignore */ }
      }, 1500).unref?.();
    }
    this.peer = null;
    this.child = null;
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update') return;
    const update = asRecord(params.update);
    const kind = String(update.sessionUpdate ?? '');
    const turnId = '';
    const emit = (e: DriverEvent) => this.input?.onEvent({ ...e, turnId });

    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = asRecord(update.content);
      const text = content.type === 'text' ? String(content.text ?? '') : '';
      if (text) emit({ t: kind === 'agent_message_chunk' ? 'text' : 'thought', turnId, delta: text });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const status = String(update.status ?? '');
      const isEnd = status === 'completed' || status === 'failed';
      emit({
        t: 'tool', turnId, callId: String(update.toolCallId ?? ''), phase: isEnd ? 'end' : 'start',
        name: String(update.name ?? update.title ?? 'tool'), tier: 'read',
        title: update.title ? String(update.title) : undefined, ok: isEnd ? status === 'completed' : undefined,
      });
      return;
    }
    if (kind === 'config_option_update') {
      const next = normalizeOptions(update.configOptions);
      if (next.length) { this.options = next; emit({ t: 'config', options: next }); }
    }
  }
}
