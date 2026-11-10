/**
 * Agent 会话层的公共契约。
 *
 * 这里只放「跨进程 / 跨界面」的类型：服务端产事件，前端只消费事件；
 * harness 配置、上下文锚点、审批策略、技能定义都在这。
 */
import type { Id } from './types.ts';

export type ApprovalLevel = 'readonly' | 'ask' | 'auto';

export interface ApprovalPolicy {
  /** AI 批注：建议后等人接受，还是直接落笔 */
  annotations: ApprovalLevel;
  /** 正文 / 提案：逐条确认，还是自动提交 */
  body: ApprovalLevel;
}

export type DriverKind = 'acp' | 'http' | 'remote' | 'builtin' | 'mock';

/** 一个可选模型。id 是 harness 侧的模型标识，平台不改写。 */
export interface ModelEntry {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** text / image …；不同 harness 支持的模态不一样 */
  input?: string[];
}

/**
 * 一条模型路由 = 一个端点。
 *
 * 平台只把这段配置翻译成 harness 的启动覆盖层（dsh 走 `--patch`），不代理推理；
 * 所以 `api` / `baseURL` / `headers` 的语义以 harness 为准，平台只做搬运。
 */
export interface ModelRoute {
  /** 路由名，dsh 侧就是 provider key（会话里选模型时按它分组） */
  provider: string;
  /** 协议：openai-completions / anthropic-messages … */
  api: string;
  baseURL: string;
  /** 密钥引用名，写进 harness 的凭据解析；无鉴权网关留空 */
  apiKeyEnv?: string;
  /** 额外请求头；无鉴权网关用 Authorization 占位（pi-ai 要求二者之一） */
  headers?: Record<string, string>;
  displayName?: string;
  models: ModelEntry[];
}

export interface HarnessModels {
  /** 覆盖层里承载 provider 的插件 id；dsh 是 llm-pi-ai */
  routePluginId?: string;
  /** 会话启动时用的模型；不写就沿用 harness 自己的默认 */
  default?: { provider: string; model: string; reasoningEffort?: string };
  routes: ModelRoute[];
}

export interface HarnessConfig {
  id: string;
  label: string;
  driver: DriverKind;
  command?: string;
  args?: string[];
  /** 会话工作目录：相对空间根；不配则每个会话一个独立沙箱 */
  cwd?: string;
  env?: Record<string, string>;
  endpoint?: string;
  /** 远端 bridge 的 Bearer token；只存在于服务端，不下发浏览器 */
  token?: string;
  context?: { maxChars?: number };
  approvals?: Partial<ApprovalPolicy>;
  /** 模型路由；只在 driver=acp 且 harness 支持 patch 覆盖层时生效 */
  models?: HarnessModels;
  remote?: boolean;
  enabled?: boolean;
}

export interface HarnessFile {
  version: number;
  default: string;
  harnesses: HarnessConfig[];
  /** 全局默认模型路由，harness 自己没写 models 时继承 */
  models?: HarnessModels;
}

export interface HarnessCaps {
  streamText: boolean;
  thoughts: boolean;
  toolCalls: boolean;
  permissions: boolean;
  mcp: { http: boolean; sse: boolean; stdio: boolean };
  systemPrompt: boolean;
  images: boolean;
  embeddedContext: boolean;
  resume: boolean;
  maxContextChars: number;
  protocolVersion?: string;
  configOptions?: ConfigOption[];
}

export interface ConfigOptionChoice {
  value: string;
  name: string;
  description?: string;
  /** 分组名（如 provider）；前端按它渲染 optgroup，别把来源拍平 */
  group?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string;
  options: ConfigOptionChoice[];
}

export interface QuoteAnchor {
  repId: Id;
  quote: string;
  from: number;
  to: number;
  prefix: string;
  suffix: string;
  headingId?: string;
  revision: number;
}

export type FocusKind = 'rep' | 'note' | 'work' | 'none';

export interface SessionFocus {
  kind: FocusKind;
  id: string;
  title: string;
  revision: number;
}

export interface ContextRef {
  id: string;
  kind: 'object' | 'quote';
  objectId: Id;
  title: string;
  revision: number;
  quote?: QuoteAnchor;
  addedBy: 'user' | 'auto';
}

export interface SessionContext {
  spaceId: string;
  sessionId: string;
  focus: SessionFocus;
  selection?: QuoteAnchor;
  refs: ContextRef[];
  skillId?: string;
  approvals: ApprovalPolicy;
  budget: { maxChars: number; usedChars: number };
}

export interface AnnotationSuggestion {
  id: string;
  repId: Id;
  quote: string;
  note: string;
  color: string;
  from?: number;
  to?: number;
  reason?: string;
}

export interface AgentSkill {
  id: string;
  name: string;
  version: number;
  appliesTo: string[];
  context: string[];
  tools: string[];
  output: 'questions' | 'annotations' | 'chat';
  starters: string[];
  body: string;
  builtin?: boolean;
}

export type ToolTier = 'read' | 'derived' | 'propose' | 'commit' | 'forbidden';

export type AgentEvent =
  | { seq: number; t: 'ready'; sessionId: string; harness: string; caps: HarnessCaps; configOptions: ConfigOption[] }
  | { seq: number; t: 'turn'; turnId: string; phase: 'start' | 'end'; stopReason?: string; usage?: { used?: number; size?: number } }
  | { seq: number; t: 'text'; turnId: string; delta: string }
  | { seq: number; t: 'thought'; turnId: string; delta: string }
  | { seq: number; t: 'tool'; turnId: string; callId: string; phase: 'start' | 'end'; name: string; tier: ToolTier; title?: string; ok?: boolean; summary?: string }
  | {
      seq: number; t: 'permission'; turnId: string; requestId: string;
      kind: 'tool' | 'proposal'; action: string; preview: string;
      options: string[]; proposalId?: string;
    }
  | { seq: number; t: 'annotation'; turnId: string; items: AnnotationSuggestion[]; accepted?: boolean }
  | { seq: number; t: 'config'; options: ConfigOption[] }
  | { seq: number; t: 'error'; code: string; message: string; recoverable: boolean };

export interface SessionView {
  id: string;
  harnessId: string;
  status: 'starting' | 'ready' | 'running' | 'error' | 'closed';
  focus: SessionFocus;
  skillId?: string;
  approvals: ApprovalPolicy;
  caps?: HarnessCaps;
  configOptions: ConfigOption[];
  createdAt: string;
  error?: string;
}

export interface HarnessView extends HarnessConfig {
  installed?: boolean;
  caps?: HarnessCaps;
  probeError?: string;
  /** 生成的模型覆盖层文件（绝对路径）；没有配 models 就没有 */
  patchPath?: string;
}

export interface AgentAnnotationInput {
  id?: string;
  quote: string;
  note?: string;
  color?: string;
  from?: number;
  to?: number;
}

export interface AnnotationAcceptResult {
  accepted: AnnotationSuggestion[];
  rejected: { quote: string; reason: string }[];
}

/** ACP 之外的内部事件：session/new 返回的配置项与能力 */
export interface StartResult {
  caps: HarnessCaps;
  configOptions: ConfigOption[];
}
