/**
 * ACP 客户端驱动。
 *
 * dsh 与 WorkBuddy CLI 都走 ACP v1；平台是 client，harness 是 agent。
 * 这里只实现 stdio；HTTP/SSE 桥留给单独的 transport，避免把私有握手混进协议层。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentEvent, ConfigOption, HarnessCaps, HarnessConfig, StartResult,
} from '../../shared/agent.ts';
import { findCommand } from './config.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** 事件可以有 turnId；ready/config 这类没有，留 optional 方便 driver 统一回传 */
export type DriverEvent = DistributiveOmit<AgentEvent, 'seq'> & { turnId?: string };

export interface DriverStartInput {
  sessionId: string;
  cwd: string;
  mcpUrl: string;
  token: string;
  /** 探测能力时不挂 MCP：此时还没有真实会话 token */
  withMcp?: boolean;
  onEvent: (e: DriverEvent) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = 1;

/**
 * shell 模式下 Node 把 command 与 args 拼成一行，不会替我们加引号：
 * 路径里有空格（空间目录、--patch 覆盖层）就会被拆成两个参数。
 */
export function quoteShellArg(a: string): string {
  return /\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
}

export function normalizeOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfigOption[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    const id = String(o.id ?? '');
    if (!id) continue;
    const rawOptions = Array.isArray(o.options) ? o.options : [];
    const choices: ConfigOption['options'] = [];
    for (const opt of rawOptions) {
      const x = asRecord(opt);
      if (Array.isArray(x.options)) {
        // 分组（如 provider）：组名一路带到前端，否则同名模型分不清来源
        const group = String(x.group ?? x.name ?? '');
        for (const child of x.options) {
          const c = asRecord(child);
          if (c.value !== undefined) {
            choices.push({
              value: String(c.value),
              name: String(c.name ?? c.value),
              description: c.description ? String(c.description) : undefined,
              group: group || undefined,
            });
          }
        }
      } else if (x.value !== undefined) {
        choices.push({ value: String(x.value), name: String(x.name ?? x.value), description: x.description ? String(x.description) : undefined });
      }
    }
    out.push({
      id,
      name: String(o.name ?? id),
      category: o.category ? String(o.category) : undefined,
      type: String(o.type ?? 'select'),
      currentValue: String(o.currentValue ?? ''),
      options: choices,
    });
  }
  return out;
}

class AcpProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  private stderr = '';

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void,
    private readonly onRequest: (method: string, id: number | string, params: Record<string, unknown>) => void,
  ) {}

  start(): void {
    const cmd = findCommand(this.command);
    if (!cmd) throw new Error(`找不到 harness 命令：${this.command}`);
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    // npm 全局包的 bin 是没有扩展名的 node 脚本；Windows 不能直接 spawn，交给 node
    const isScript = !/\.(cmd|bat|exe)$/i.test(cmd) && fs.existsSync(cmd);
    const spawnCmd = isScript ? process.execPath : cmd;
    const spawnArgs = (isScript ? [cmd, ...this.args] : this.args).map((a) => (useShell ? quoteShellArg(a) : a));
    const env = { ...this.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    this.child = spawn(spawnCmd, spawnArgs, {
      cwd: this.cwd,
      env,
      windowsHide: true,
      // .cmd/.bat 必须经 cmd.exe；交给 Node 的 shell 模式拼引号，避免手写 /c 时多一层引号
      shell: useShell,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child.stderr.on('data', (d) => {
      this.stderr = `${this.stderr}${d.toString()}`.slice(-8000);
    });
    this.child.on('error', (e) => this.fail(e));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.fail(new Error(`harness 退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）${this.stderr ? `：${this.stderr.slice(-500)}` : ''}`));
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    const s = line.trim();
    if (!s) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(s) as Record<string, unknown>; } catch { return; }

    const id = msg.id;
    const method = typeof msg.method === 'string' ? msg.method : '';

    // agent → client 的请求（如权限确认）
    if (method && id !== undefined && id !== null) {
      this.onRequest(method, id as number | string, asRecord(msg.params));
      return;
    }

    // 我们发出的请求的响应
    if (id !== undefined && id !== null) {
      const n = Number(id);
      const p = this.pending.get(n);
      if (!p) return;
      this.pending.delete(n);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(String(asRecord(msg.error).message ?? 'ACP 请求失败')));
      else p.resolve(msg.result);
      return;
    }

    if (method) this.onNotification(method, asRecord(msg.params));
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (!this.child || this.closed) return Promise.reject(new Error('harness 未启动'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  reply(id: number | string, result: unknown): void {
    if (!this.child || this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  close(): void {
    this.closed = true;
    try { this.child?.stdin.end(); } catch { /* ignore */ }
    const pid = this.child?.pid;
    if (pid) {
      // 先礼后兵：3 秒内不退再杀进程树。Windows 下 taskkill /T 才会带上子进程。
      const timer = setTimeout(() => {
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
          else process.kill(pid, 'SIGKILL');
        } catch { /* ignore */ }
      }, 3000);
      timer.unref?.();
    }
  }
}

export class AcpDriver {
  private proc: AcpProcess | null = null;
  private input: DriverStartInput | null = null;
  private sessionId = '';
  private options: ConfigOption[] = [];

  constructor(private readonly cfg: HarnessConfig) {}

  async start(input: DriverStartInput): Promise<StartResult> {
    this.input = input;
    const cwd = path.resolve(input.cwd);
    fs.mkdirSync(cwd, { recursive: true });
    const env = { ...process.env, ...(this.cfg.env ?? {}) };
    const args = this.cfg.args ?? [];

    const proc = new AcpProcess(
      this.cfg.command ?? '',
      args,
      cwd,
      env,
      (method, params) => this.onNotification(method, params),
      (method, id, params) => this.onRequest(method, id, params),
    );
    this.proc = proc;
    proc.start();

    const init = asRecord(await proc.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'habitat', version: '1.0.0' },
    }, 20_000));

    const ac = asRecord(init.agentCapabilities);
    const prompt = asRecord(ac.promptCapabilities);
    const mcp = asRecord(ac.mcpCapabilities);
    const sessionCaps = asRecord(ac.sessionCapabilities);
    const caps: HarnessCaps = {
      streamText: true,
      thoughts: true,
      toolCalls: true,
      permissions: true,
      mcp: {
        http: mcp.http === true,
        sse: mcp.sse === true,
        stdio: true,
      },
      systemPrompt: false,
      images: prompt.image === true,
      embeddedContext: prompt.embeddedContext === true,
      resume: Boolean(sessionCaps.resume || ac.loadSession),
      maxContextChars: this.cfg.context?.maxChars ?? 24000,
      protocolVersion: String(init.protocolVersion ?? ''),
      configOptions: [],
    };

    if (!caps.mcp.http) {
      // 目前 dsh 与 WorkBuddy 都公布 http；没有 http 的 harness 先明确拒绝，别假装能读写。
      proc.close();
      throw new Error('这个 harness 没有公布 MCP http 能力，平台暂时无法给它挂工具面');
    }

    const mcpServer = {
      type: 'http',
      name: 'habitat',
      url: input.mcpUrl,
      headers: [{ name: 'Authorization', value: `Bearer ${input.token}` }],
    };

    const created = asRecord(await proc.request('session/new', {
      cwd,
      mcpServers: input.withMcp === false ? [] : [mcpServer],
    }, 30_000));
    this.sessionId = String(created.sessionId ?? '');
    this.options = normalizeOptions(created.configOptions);
    caps.configOptions = this.options;

    if (!this.sessionId) throw new Error('harness 没有返回 sessionId');
    return { caps, configOptions: this.options };
  }

  async prompt(text: string): Promise<{ stopReason?: string }> {
    if (!this.proc) throw new Error('harness 未启动');
    const result = asRecord(await this.proc.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, 180_000));
    return { stopReason: result.stopReason ? String(result.stopReason) : undefined };
  }

  async cancel(): Promise<void> {
    if (!this.proc || !this.sessionId) return;
    try {
      await this.proc.request('session/cancel', { sessionId: this.sessionId }, 5_000);
    } catch { /* 取消本来就可能没有回包 */ }
  }

  async setConfig(optionId: string, value: string): Promise<ConfigOption[]> {
    if (!this.proc || !this.sessionId) throw new Error('harness 未启动');
    const result = asRecord(await this.proc.request('session/set_config_option', {
      sessionId: this.sessionId,
      configId: optionId,
      value,
    }, 15_000));
    const next = normalizeOptions(result.configOptions);
    if (next.length) this.options = next;
    else this.options = this.options.map((o) => (o.id === optionId ? { ...o, currentValue: value } : o));
    return this.options;
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    try {
      if (this.sessionId) await this.proc.request('session/close', { sessionId: this.sessionId }, 5_000);
    } catch { /* ignore */ }
    this.proc.close();
    this.proc = null;
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update') return;
    const update = asRecord(params.update);
    const kind = String(update.sessionUpdate ?? '');
    const turnId = this.input ? `turn-${Date.now()}` : '';

    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = asRecord(update.content);
      const text = content.type === 'text' ? String(content.text ?? '') : '';
      if (text) this.input?.onEvent({ t: kind === 'agent_message_chunk' ? 'text' : 'thought', turnId, delta: text });
      return;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const callId = String(update.toolCallId ?? '');
      const status = String(update.status ?? '');
      const isEnd = status === 'completed' || status === 'failed';
      this.input?.onEvent({
        t: 'tool',
        turnId,
        callId,
        phase: isEnd ? 'end' : 'start',
        name: String(update.name ?? update.title ?? 'tool'),
        tier: 'read',
        title: update.title ? String(update.title) : undefined,
        ok: isEnd ? status === 'completed' : undefined,
        summary: update.rawOutput ? String(update.rawOutput).slice(0, 200) : undefined,
      });
      return;
    }

    if (kind === 'config_option_update') {
      const next = normalizeOptions(update.configOptions);
      if (next.length) {
        this.options = next;
        this.input?.onEvent({ t: 'config', options: next });
      }
    }
  }

  private onRequest(method: string, id: number | string, params: Record<string, unknown>): void {
    if (method !== 'session/request_permission') {
      this.proc?.reply(id, {});
      return;
    }
    // 原生工具一律拒绝：平台只允许经 session MCP 读写。
    // MCP 工具的权限由平台自己的闸门处理，不会走到这里。
    const options = Array.isArray(params.options) ? params.options.map(asRecord) : [];
    const reject = options.find((o) => String(o.kind) === 'reject_once')
      ?? options.find((o) => String(o.kind) === 'reject_always');
    if (reject) this.proc?.reply(id, { outcome: { outcome: 'selected', optionId: String(reject.optionId) } });
    else this.proc?.reply(id, { outcome: { outcome: 'cancelled' } });
    this.input?.onEvent({
      t: 'tool',
      turnId: '',
      callId: String(asRecord(params.toolCall).toolCallId ?? ''),
      phase: 'end',
      name: 'native-tool',
      tier: 'forbidden',
      ok: false,
      summary: '已拒绝原生工具（读写只能走平台工具面）',
    });
  }
}
