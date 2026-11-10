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

export interface HarnessConfig {
  id: string;
  label: string;
  driver: DriverKind;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  endpoint?: string;
  /** 远端 bridge 的 Bearer token；只存在于服务端，不下发浏览器 */
  token?: string;
  context?: { maxChars?: number };
  approvals?: Partial<ApprovalPolicy>;
  remote?: boolean;
  enabled?: boolean;
}

export interface HarnessFile {
  version: number;
  default: string;
  harnesses: HarnessConfig[];
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
