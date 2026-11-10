/**
 * Harness 配置加载。
 *
 * 配置是「人写的」，所以放空间根 agents.yaml；没有就用内置默认值。
 * 密钥只允许 ${ENV} 引用，不把 API key 写进文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import type {
  ApprovalPolicy, HarnessConfig, HarnessFile, HarnessModels, ModelEntry, ModelRoute,
} from '../../shared/agent.ts';

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

function normalizeModelEntry(raw: Partial<ModelEntry>): ModelEntry | null {
  const id = String(raw.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    name: raw.name ? String(raw.name) : undefined,
    description: raw.description ? String(raw.description) : undefined,
    contextWindow: Number(raw.contextWindow) || undefined,
    maxTokens: Number(raw.maxTokens) || undefined,
    input: Array.isArray(raw.input) ? raw.input.map(String).filter(Boolean) : undefined,
  };
}

function normalizeRoute(raw: Partial<ModelRoute>): ModelRoute | null {
  const provider = String(raw.provider ?? '').trim();
  const baseURL = String(raw.baseURL ?? '').trim();
  if (!provider || !baseURL) return null;
  const models = (Array.isArray(raw.models) ? raw.models : [])
    .map((m) => normalizeModelEntry(m as Partial<ModelEntry>))
    .filter((m): m is ModelEntry => m !== null);
  if (!models.length) return null;
  return {
    provider,
    // pi-ai 的协议名；本地 OpenAI 兼容网关基本都用 openai-completions
    api: String(raw.api ?? 'openai-completions'),
    baseURL,
    apiKeyEnv: raw.apiKeyEnv ? String(raw.apiKeyEnv) : undefined,
    headers: raw.headers && typeof raw.headers === 'object'
      ? Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, String(v)]))
      : undefined,
    displayName: raw.displayName ? String(raw.displayName) : undefined,
    models,
  };
}

export function normalizeModels(raw: unknown): HarnessModels | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Partial<HarnessModels>;
  const routes = (Array.isArray(src.routes) ? src.routes : [])
    .map((r) => normalizeRoute(r as Partial<ModelRoute>))
    .filter((r): r is ModelRoute => r !== null);
  if (!routes.length) return undefined;
  const def = src.default && typeof src.default === 'object' ? src.default : undefined;
  return {
    routePluginId: src.routePluginId ? String(src.routePluginId) : undefined,
    default: def && def.provider && def.model
      ? {
          provider: String(def.provider),
          model: String(def.model),
          reasoningEffort: def.reasoningEffort ? String(def.reasoningEffort) : undefined,
        }
      : undefined,
    routes,
  };
}

/** 覆盖层落盘位置。绝对路径：会话 cwd 是每个会话独立的沙箱，相对路径会找不到。 */
export function patchPathFor(root: string, harnessId: string): string {
  return path.join(root, '.habitat', 'state', 'harness', `${harnessId}.patch.yml`);
}

/**
 * 把模型路由翻译成 dsh 的 loader patch（`dsh --patch <file>`）。
 *
 * 只写三类条目：provider 路由、默认模型、ACP 会话的初始模型。
 * 后者不能省：dsh 的 acp 插件自带 provider/model，不覆盖就还是它自己的官方端点。
 */
export function dshPatchYaml(models: HarnessModels): string {
  const providers: Record<string, unknown> = {};
  for (const r of models.routes) {
    providers[r.provider] = {
      api: r.api,
      baseURL: r.baseURL,
      ...(r.apiKeyEnv ? { apiKeyEnv: r.apiKeyEnv } : {}),
      ...(r.headers && Object.keys(r.headers).length ? { headers: r.headers } : {}),
      ...(r.displayName ? { displayName: r.displayName } : {}),
      models: r.models.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.description ? { description: m.description } : {}),
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
        ...(m.input?.length ? { input: m.input } : {}),
      })),
    };
  }

  const entries: unknown[] = [{
    id: models.routePluginId ?? 'llm-pi-ai',
    name: '@deepseek-ai/dsh-llm-pi-ai',
    config: { providers },
  }];
  if (models.default) {
    // 两个 entry 各拿一份字面量：共用对象会被 yaml 序列化成锚点/别名，
    // 解析回来是同一个引用，loader 合并时容易互相污染。
    entries.push(
      {
        id: 'agent-default-model',
        name: '@deepseek-ai/dsh-agent-default-model',
        config: { provider: models.default.provider, model: models.default.model },
      },
      {
        id: 'acp',
        name: '@deepseek-ai/dsh-acp',
        config: { provider: models.default.provider, model: models.default.model },
      },
    );
  }
  return [
    '# 由 Habitat 生成，勿手改：源配置在空间根的 agents.yaml（harness.models）',
    yamlStringify(entries, { lineWidth: 0 }),
  ].join('\n');
}

export interface ModelOverlay {
  harness: HarnessConfig;
  patchPath?: string;
  error?: string;
}

/**
 * 给 harness 挂模型覆盖层。harness 自己没写 models 就继承文件级默认。
 * 只对 driver=acp 生效：HTTP/远端 harness 没有这种启动参数。
 */
export function withModelOverlay(root: string, cfg: HarnessConfig, inherited?: HarnessModels): ModelOverlay {
  const models = cfg.models ?? inherited;
  if (!models) return { harness: cfg };
  if (cfg.driver !== 'acp') return { harness: cfg, error: '模型覆盖层只支持 driver=acp 的 harness' };
  const file = patchPathFor(root, cfg.id);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, dshPatchYaml(models), 'utf8');
  } catch (e) {
    return { harness: cfg, error: `写模型覆盖层失败：${(e as Error).message}` };
  }
  const args = cfg.args ?? [];
  const already = args.some((a, i) => a === '--patch' && args[i + 1] === file);
  return {
    harness: { ...cfg, args: already ? args : [...args, '--patch', file] },
    patchPath: file,
  };
}

/**
 * 会话工作目录。配了 cwd 就按空间根解析（人明确指定了工作区），
 * 没配才用每会话独立的沙箱，避免两个会话互相看见对方的临时文件。
 */
export function sessionCwd(root: string, cfg: HarnessConfig, sessionId: string): string {
  if (cfg.cwd) return path.resolve(root, cfg.cwd);
  return path.join(root, '.habitat', 'state', 'agent', sessionId, 'cwd');
}

/** 没有 agents.yaml 时给界面用的等价内容：看到的就是正在跑的那份。 */
export function defaultHarnessYaml(): string {
  const body = yamlStringify(defaultHarnessFile(), { lineWidth: 0 });
  // 注释里放一段最小示例：模型配置是最容易「找不到入口」的地方，别让人去翻代码
  return [
    body,
    '# 想配模型：给对应 harness 条目加一段 models（下面是示例，取消注释后改成自己的）',
    '#   models:',
    '#     default: { provider: local, model: <模型 id> }        # 会话初始模型',
    '#     routes:',
    '#       - provider: local                                  # 路由名，会话里按它分组',
    '#         api: openai-completions',
    '#         baseURL: http://127.0.0.1:8080/v1',
    '#         headers: { Authorization: "Bearer local" }        # 无鉴权网关的占位头',
    '#         models:',
    '#           - { id: <模型 id>, name: <显示名>, contextWindow: 1000000, input: [text, image] }',
    '# 保存后平台生成 .habitat/state/harness/<harness-id>.patch.yml，并以 --patch 传给 dsh；',
    '# 密钥只走 ${ENV} 或 apiKeyEnv，别把真 key 写进来。',
  ].join('\n');
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
    models: normalizeModels((raw as { models?: unknown }).models),
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
    return {
      version: Number(raw.version) || 1,
      default: def,
      harnesses,
      models: normalizeModels(raw.models),
      source: 'file',
      path: file,
    };
  } catch (e) {
    // 配置写坏了不能把助手整个弄挂：保留内置配置，并把错误带出去给接入页看
    const fallback = defaultHarnessFile();
    return { ...fallback, source: 'default', path: `${file}（解析失败：${(e as Error).message}）` };
  }
}

export function harnessById(file: HarnessFile, id: string): HarnessConfig | undefined {
  return file.harnesses.find((h) => h.id === id) ?? file.harnesses.find((h) => h.enabled !== false);
}
