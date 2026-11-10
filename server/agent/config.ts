/**
 * Harness 配置加载。
 *
 * 配置是「人写的」，所以放空间根 agents.yaml；没有就用内置默认值。
 * 密钥只允许 ${ENV} 引用，不把 API key 写进文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import type { ApprovalPolicy, HarnessConfig, HarnessFile } from '../../shared/agent.ts';

const isWin = process.platform === 'win32';

function exists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

/** 在 PATH 里找一个可执行文件；Windows 下补 .cmd/.exe/.bat */
export function findCommand(command: string): string {
  if (!command) return '';
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    if (exists(command)) return command;
    if (isWin && !path.extname(command)) {
      for (const ext of ['.cmd', '.exe', '.bat']) if (exists(`${command}${ext}`)) return `${command}${ext}`;
    }
    return '';
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = isWin && !path.extname(command)
    ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`]
    : [command];
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (exists(p)) return p;
    }
  }
  return '';
}

function defaultDsh(): string {
  if (process.env.DSH_CLI) return process.env.DSH_CLI;
  const local = process.env.LOCALAPPDATA ?? '';
  const shim = local ? path.join(local, 'deepseek-harness', 'bin', 'dsh.cmd') : '';
  if (shim && exists(shim)) return shim;
  return findCommand('dsh');
}

function defaultCodebuddy(): string {
  if (process.env.CODEBUDDY_CLI) return process.env.CODEBUDDY_CLI;
  // .cmd 包装器不适合由 driver 直接 spawn；用包里的 node 脚本入口，driver 会用 node 启动它
  const js = process.platform === 'win32'
    ? 'C:/nvm4w/node_global/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy'
    : '';
  if (js && exists(js)) return js;
  return findCommand('codebuddy');
}

function defaultWorkbuddy(): string {
  if (process.env.WORKBUDDY_CLI) return process.env.WORKBUDDY_CLI;
  const local = process.env.LOCALAPPDATA ?? '';
  const p = local
    ? path.join(local, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy')
    : '';
  if (p && exists(p)) return p;
  return '';
}

export function defaultHarnessFile(): HarnessFile {
  const mock = process.env.HABITAT_AGENT_MOCK === '1';
  const dsh = defaultDsh();
  const cb = defaultCodebuddy();
  const wb = defaultWorkbuddy();
  const harnesses: HarnessConfig[] = [
    {
      id: 'mock',
      label: 'Mock harness（测试用）',
      driver: 'mock',
      enabled: mock,
      context: { maxChars: 12000 },
      approvals: { annotations: 'ask', body: 'ask' },
    },
    {
      id: 'dsh',
      label: '平台内置 dsh',
      driver: 'acp',
      command: dsh || 'dsh',
      args: ['--profile', 'acp'],
      cwd: '.habitat/state/agent-cwd',
      env: { DSH_PERMISSION_MODE: 'read-only' },
      context: { maxChars: 24000 },
      approvals: { annotations: 'ask', body: 'ask' },
      enabled: Boolean(dsh) || mock,
    },
    {
      id: 'codebuddy',
      label: 'CodeBuddy CLI（官方）',
      driver: 'http',
      command: cb || 'codebuddy',
      args: ['--serve', '--acp', '--auth', 'none', '--tools', ''],
      cwd: '.habitat/state/agent-cwd',
      context: { maxChars: 32000 },
      approvals: { annotations: 'ask', body: 'ask' },
      enabled: Boolean(cb),
    },
    {
      id: 'workbuddy',
      label: 'WorkBuddy CLI（本机）',
      driver: 'http',
      command: wb || 'codebuddy',
      // --serve 开 HTTP/SSE ACP 桥；--tools "" 关掉内置文件/终端工具
      args: ['--serve', '--acp', '--auth', 'none', '--tools', ''],
      cwd: '.habitat/state/agent-cwd',
      context: { maxChars: 32000 },
      approvals: { annotations: 'ask', body: 'ask' },
      enabled: Boolean(wb),
    },
  ];
  return { version: 1, default: mock ? 'mock' : dsh ? 'dsh' : 'mock', harnesses };
}

function resolveEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_m, key: string, fallback?: string) => {
    return process.env[key] ?? fallback ?? '';
  });
}

function resolveDeep<T>(v: T): T {
  if (typeof v === 'string') return resolveEnv(v) as T;
  if (Array.isArray(v)) return v.map((x) => resolveDeep(x)) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = resolveDeep(val);
    return out as T;
  }
  return v;
}

function normalizeHarness(raw: Partial<HarnessConfig>, index: number): HarnessConfig {
  const id = String(raw.id ?? '').trim() || `harness-${index + 1}`;
  const driver = (['acp', 'http', 'remote', 'builtin', 'mock'].includes(String(raw.driver))
    ? String(raw.driver)
    : 'acp') as HarnessConfig['driver'];
  return {
    id,
    label: String(raw.label ?? id),
    driver,
    command: raw.command ? String(raw.command) : undefined,
    args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
    cwd: raw.cwd ? String(raw.cwd) : undefined,
    env: raw.env && typeof raw.env === 'object'
      ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]))
      : undefined,
    endpoint: raw.endpoint ? String(raw.endpoint) : undefined,
    token: raw.token ? String(raw.token) : undefined,
    context: raw.context && typeof raw.context === 'object'
      ? { maxChars: Number(raw.context.maxChars) || undefined }
      : undefined,
    approvals: raw.approvals && typeof raw.approvals === 'object'
      ? {
          annotations: normalizeApproval(raw.approvals.annotations),
          body: normalizeApproval(raw.approvals.body),
        }
      : undefined,
    remote: raw.remote === true,
    enabled: raw.enabled !== false,
  };
}

export function normalizeApproval(v: unknown): ApprovalPolicy['annotations'] {
  return v === 'readonly' || v === 'auto' || v === 'ask' ? v : 'ask';
}

export interface LoadedHarnessFile extends HarnessFile {
  source: 'file' | 'default';
  path?: string;
}

export function loadHarnessFile(root: string): LoadedHarnessFile {
  const file = path.join(root, 'agents.yaml');
  if (!exists(file)) return { ...defaultHarnessFile(), source: 'default' };
  try {
    const raw = yamlParse(fs.readFileSync(file, 'utf8')) as Partial<HarnessFile> & { harnesses?: Partial<HarnessConfig>[] };
    const list = Array.isArray(raw.harnesses) ? raw.harnesses : [];
    const harnesses = list.map((h, i) => resolveDeep(normalizeHarness(h, i)));
    if (!harnesses.length) return { ...defaultHarnessFile(), source: 'default' };
    const wanted = String(raw.default ?? '');
    const def = harnesses.some((h) => h.id === wanted) ? wanted : harnesses.find((h) => h.enabled !== false)?.id ?? harnesses[0].id;
    return { version: Number(raw.version) || 1, default: def, harnesses, source: 'file', path: file };
  } catch (e) {
    // 配置写坏了不能把助手整个弄挂：保留内置配置，并把错误带出去给接入页看
    const fallback = defaultHarnessFile();
    return { ...fallback, source: 'default', path: `${file}（解析失败：${(e as Error).message}）` };
  }
}

export function harnessById(file: HarnessFile, id: string): HarnessConfig | undefined {
  return file.harnesses.find((h) => h.id === id) ?? file.harnesses.find((h) => h.enabled !== false);
}
