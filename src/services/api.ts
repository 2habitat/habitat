import type {
  AgentSkill, AnnotationSuggestion, ApprovalPolicy, ContextRef, HarnessView, SessionView,
} from '../../shared/agent.ts';

/** 调本地服务。冲突与校验失败要带结构化信息回给界面，不能只剩一句 message。 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: {
      conflict?: ConflictPayload;
      blocked?: BlockedCheck[];
      code?: string;
      problems?: string[];
      change?: PasswordChangeState;
    },
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ConflictPayload {
  id: string;
  base: { rev: number; content: string };
  mine: { content: string };
  theirs: { rev: number; content: string; updatedAt: string; author: string };
}

export interface BlockedCheck {
  name: string;
  label: string;
  ok: boolean;
  level: 'error' | 'warn';
  detail: string;
}

/* ---------------- 写后失效 ----------------
 * 文件才是真相，界面只是它的投影。任何写操作成功后都必须让整个查询缓存失效，
 * 否则界面上看到的还是上一版内容（比如刚采集完，收件箱里却没有）。
 * 放在这一层统一做，比在几十个调用点各写一次 refresh() 可靠。
 */
let queryClient: { invalidateQueries: () => unknown } | null = null;

export function setQueryClient(qc: { invalidateQueries: () => unknown }): void {
  queryClient = qc;
}

export function invalidateAll(): void {
  try {
    void queryClient?.invalidateQueries();
  } catch {
    /* 失效失败不影响这次写入本身 */
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const hasBody = body !== undefined;
  const res = await fetch(path, {
    method,
    // 没有 body 时不要声明 application/json，否则 Fastify 会按空 JSON 体报 400
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const d = (data ?? {}) as {
      error?: string; code?: string; conflict?: ConflictPayload;
      blocked?: BlockedCheck[]; problems?: string[]; change?: PasswordChangeState;
    };
    // 会话没了就回登录页；强制改密就回改密页。这两种不是「页面上报个错」能解决的
    if (typeof window !== 'undefined') {
      if (res.status === 401 && !window.location.pathname.startsWith('/login')) {
        const next = encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
        window.location.assign(`/login?next=${next}`);
      } else if (res.status === 403 && d.code === 'password_change_required') {
        window.location.assign('/change-password');
      }
    }
    throw new ApiError(res.status, d.error ?? `请求失败（${res.status}）`, {
      conflict: d.conflict,
      blocked: d.blocked,
      code: d.code,
      problems: d.problems,
      change: d.change,
    }, d.code);
  }
  if (method !== 'GET') invalidateAll();
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b),
  putJson: <T>(p: string, b?: unknown) => request<T>('PUT', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
  /** 裸 body 上传：文件不走 JSON，别把它 base64 化 */
  put: async <T>(p: string, body: BodyInit, type = 'application/octet-stream'): Promise<T> => {
    const res = await fetch(p, { method: 'PUT', headers: { 'content-type': type }, body });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg = (data as { error?: string } | null)?.error ?? `请求失败（${res.status}）`;
      throw new ApiError(res.status, msg);
    }
    queryClient?.invalidateQueries();
    return data as T;
  },
};

/* ---------------- 端点 ---------------- */

export interface SpaceInfo {
  space: { id: string; name: string; root: string; tz: string };
  stats: {
    works: number; parts: number; reps: number; notes: number; annotations: number;
    actions: number; events: number; assets: number; assetBytes: number;
    unresolved: number; links: number; objects: number;
  };
}

export interface PasswordChangeState {
  required: boolean;
  reason: 'initial' | 'admin' | 'expired' | null;
  message: string;
  changedAt: string | null;
  expiresAt: string | null;
  daysUsed: number | null;
  daysLeft: number | null;
}

export interface AccountUser {
  username: string;
  displayName?: string;
  role: 'owner' | 'member';
  disabled: boolean;
  mustChangePassword: boolean;
  passwordUpdatedAt: string | null;
  passwordExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  change: PasswordChangeState;
}

export interface AuthMe {
  ok: boolean;
  user: AccountUser | null;
  auth: { mode: 'password' | 'token' | 'none' | 'unknown'; password: boolean; token: boolean };
  change: PasswordChangeState | null;
  canManageUsers: boolean;
}

export const endpoints = {
  space: () => api.get<SpaceInfo>('/api/space'),

  /* 账号与登录 */
  me: () => api.get<AuthMe>('/api/auth/me'),
  logout: () => api.post<{ ok: boolean }>('/api/auth/logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<{ ok: boolean; user: AccountUser }>('/api/auth/password', { currentPassword, newPassword }),
  users: () => api.get<{ ok: boolean; users: AccountUser[]; passwordDays: number; file: string }>('/api/auth/users'),
  createUser: (b: { username: string; displayName?: string; role: 'owner' | 'member'; password?: string }) =>
    api.post<{ ok: boolean; user: AccountUser; tempPassword?: string }>('/api/auth/users', b),
  updateUser: (username: string, b: { displayName?: string | null; role?: 'owner' | 'member'; disabled?: boolean; mustChangePassword?: boolean }) =>
    api.patch<{ ok: boolean; user: AccountUser }>(`/api/auth/users/${encodeURIComponent(username)}`, b),
  resetUserPassword: (username: string, password?: string) =>
    api.post<{ ok: boolean; user: AccountUser; tempPassword?: string }>(
      `/api/auth/users/${encodeURIComponent(username)}/reset`,
      { password },
    ),

  works: () => api.get<{ works: WorkView[] }>('/api/works'),
  work: (id: string) => api.get<WorkDetail>(`/api/works/${encodeURIComponent(id)}`),
  buildInfo: (id: string) => api.get<BuildInfo>(`/api/works/${encodeURIComponent(id)}/build`),
  startBuild: (id: string, action?: string) =>
    api.post<{ ok: boolean; run: BuildRun }>(`/api/works/${encodeURIComponent(id)}/build`, { action }),
  buildRun: (runId: string) => api.get<{ run: BuildRun }>(`/api/builds/${encodeURIComponent(runId)}`),
  workData: (id: string) => api.get<{ files: WorkDataFile[] }>(`/api/works/${encodeURIComponent(id)}/data`),
  workDataFile: (id: string, path: string) =>
    api.get<WorkDataPayload>(`/api/works/${encodeURIComponent(id)}/data/file?path=${encodeURIComponent(path)}`),
  saveWorkData: (id: string, path: string, json: unknown) =>
    api.patch<{ ok: boolean; bytes: number; path: string }>(
      `/api/works/${encodeURIComponent(id)}/data/file?path=${encodeURIComponent(path)}`,
      { json },
    ),
  rep: (id: string) => api.get<RepContent>(`/api/reps/${encodeURIComponent(id)}/content`),
  annotations: (rep?: string) => api.get<{ annotations: AnnotationView[] }>(`/api/annotations${rep ? `?rep=${encodeURIComponent(rep)}` : ''}`),
  inbox: () => api.get<{ notes: NoteView[] }>('/api/inbox'),
  today: (date?: string) => api.get<TodayView>(`/api/today${date ? `?date=${date}` : ''}`),
  projects: () => api.get<{ projects: ProjectView[] }>('/api/projects'),
  flow: () => api.get<FlowView>('/api/flow'),
  tags: () => api.get<TagsView>('/api/tags'),
  graph: (limit = 200) => api.get<GraphView>(`/api/graph?limit=${limit}`),
  search: (q: string, type?: string) => api.get<SearchView>(`/api/search?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}`),
  journal: (q: Record<string, string> = {}) =>
    api.get<{ events: JournalEventView[] }>(`/api/journal?${new URLSearchParams(q).toString()}`),
  /** 只要计数：导航角标用，避免每页都拉 20KB 的完整变更集 */
  changesSummary: () => api.get<{ summary: { total: number; pending: number; latestAt: string | null } }>('/api/changes?summary=1'),
  changes: () => api.get<{ changesets: ChangeSetView[] }>('/api/changes'),
  proposals: () => api.get<{ proposals: ProposalView[] }>('/api/proposals'),
  jobs: () => api.get<{ jobs: JobView[] }>('/api/jobs'),
  system: () => api.get<SystemView>('/api/system'),
  manifest: () => api.get<{ manifest: ManifestView }>('/api/agent/manifest'),
  objects: (type?: string) => api.get<{ objects: Record<string, unknown>[]; total: number }>(`/api/objects${type ? `?type=${type}` : ''}`),
  notes: (q = '', limit = 200) => api.get<{ notes: NoteListItem[]; total: number }>(`/api/notes?q=${encodeURIComponent(q)}&limit=${limit}`),
  object: (id: string) => api.get<ObjectPeekView>(`/api/object/${encodeURIComponent(id)}`),

  /** base 必填：客户端（人或 Agent）看到的基准。没有它，外部抢先的改动会被静默覆盖 */
  propose: (
    ops: unknown[],
    reason: string,
    base?: Record<string, { rev?: number; hash?: string; content?: string }>,
  ) => api.post<{ changeset: ChangeSetView; checks: BlockedCheck[] }>('/api/changes', { ops, reason, base }),
  validate: (id: string) => api.post<{ changeset: ChangeSetView; checks: BlockedCheck[] }>(`/api/changes/${id}/validate`),
  commit: (id: string) => api.post<{ ok: boolean; changeset: ChangeSetView; events: JournalEventView[] }>(`/api/changes/${id}/commit`),
  revert: (id: string) => api.post<{ ok: boolean }>(`/api/changes/${id}/revert`),

  capture: (b: unknown) => api.post<{ ok: boolean; id: string }>('/api/capture', b),
  derive: (b: unknown) => api.post<{ ok: boolean; id: string }>('/api/derive', b),
  annotate: (b: unknown) => api.post<{ ok: boolean; id: string }>('/api/annotate', b),
  removeAnnotation: (id: string) => api.del<{ ok: boolean; id: string }>(`/api/annotations/${encodeURIComponent(id)}`),
  addAction: (b: unknown) => api.post<{ ok: boolean; id: string }>('/api/actions', b),
  addEvent: (b: unknown) => api.post<{ ok: boolean; id: string }>('/api/events', b),
  cursor: (repId: string, pct: number, force = false) => api.post<{ ok: boolean; cursor: { current: number; furthest: number } }>('/api/cursor', { repId, pct, force }),
  review: (id: string, note?: string) => api.post<{ ok: boolean }>('/api/review', { id, note }),
  journalLog: (b: unknown) => api.post<{ ok: boolean }>('/api/journal', b),
  claim: (id: string, actor = 'human') => api.post<{ ok: boolean }>(`/api/journal/${id}/claim`, { actor }),
  proposeAi: (b: unknown) => api.post<{ ok: boolean; proposal: ProposalView }>('/api/proposals', b),
  applyProposal: (id: string) => api.post<{ ok: boolean }>(`/api/proposals/${id}/apply`),
  reconcile: () => api.post<{ ok: boolean; report: ReconcileView }>('/api/agent/reconcile'),
  reindex: () => api.post<{ ok: boolean }>('/api/system/reindex'),

  loops: () => api.get<LoopsView>('/api/loops'),
  loop: (id: string) => api.get<LoopDetailView>(`/api/loops/${encodeURIComponent(id)}`),
  runLoop: (id: string, b?: { dryRun?: boolean; force?: boolean; mail?: boolean; fetch?: boolean; out?: string }) =>
    api.post<LoopRunView>(`/api/loops/${encodeURIComponent(id)}/run`, b ?? {}),
  setLoopConfig: (id: string, b: { enabled?: boolean; owner?: string }) =>
    api.post<{ ok: boolean; config: { enabled?: boolean; owner?: string } }>(`/api/loops/${encodeURIComponent(id)}/config`, b),
  checkLoops: () => api.get<LoopCheckView>('/api/loops/check'),
  loopsBrief: () => api.get<{ brief: string }>('/api/loops/brief'),
  claimLoop: (id: string, target: string) =>
    api.post<{ ok: boolean; claim?: { target: string; until: string }; holder?: { by: string; until: string } }>(
      `/api/loops/${encodeURIComponent(id)}/claim`,
      { target },
    ),
  releaseLoop: (id: string, by?: string) =>
    api.post<{ ok: boolean; released: number }>(`/api/loops/${encodeURIComponent(id)}/release`, { by }),
  alertLoops: (mail = false) => api.post<{ ok: boolean; report: { alerted: { id: string; name: string; reason: string }[]; skipped: string[]; mailed: boolean } }>('/api/loops/alerts', { mail }),

  createJob: (b: unknown) => api.post<{ ok: boolean; job: Record<string, unknown> }>('/api/jobs', b),
  advanceJob: (id: string, approve?: boolean) => api.post<{ ok: boolean; job: JobView }>(`/api/jobs/${id}/advance`, { approve }),
  failJob: (id: string, reason: string) => api.post<{ ok: boolean; job: JobView; permanent: boolean }>(`/api/jobs/${id}/fail`, { reason }),
  rules: () => api.get<{ rules: RuleView[] }>('/api/rules'),
  runRules: (dryRun = false) => api.post<{ ok: boolean; report: RuleRunView }>('/api/rules/run', { dryRun }),
  actions: (includeDone = false) => api.get<{ actions: ActionView[]; total: number }>(`/api/actions${includeDone ? '?includeDone=1' : ''}`),
  uploadAsset: (file: File, dir?: 'originals') =>
    api.put<{ ok: boolean; path: string; url: string; markdown: string; bytes: number; deduped: boolean }>(
      `/api/assets?name=${encodeURIComponent(file.name)}${dir ? `&dir=assets/${dir}` : ''}`,
      file,
      file.type || 'application/octet-stream',
    ),
  renew: (id: string) => api.get<{ ok: boolean; pack: { title: string; idleDays: number; candidates: { id: string; title: string; shared: string[]; newerBy: number; hedged: boolean }[] }; text: string }>(`/api/renew/${id}`),
  /** 翻新复核（和「复盘」的 review 不是一回事：那个是记一次回顾，这个是给知识打间隔） */
  reviewNote: (id: string, ok: boolean) => api.post<{ ok: boolean; nextIn: number; rec: { streak: number; step: number } }>(`/api/review/${id}`, { ok }),
  fsList: (path: string, hidden = false) =>
    api.get<{
      path: string;
      crumbs: { name: string; path: string }[];
      dirs: FsEntry[];
      files: FsEntry[];
      totals: { files: number; dirs: number; bytes: number; unindexed: number };
      hiddenSkipped: number;
    }>(`/api/fs?path=${encodeURIComponent(path)}${hidden ? '&hidden=1' : ''}`),
  fsFile: (path: string) =>
    api.get<{ path: string; kind: string; bytes: number; text?: string; truncated?: boolean; url?: string; objectId?: string }>(
      `/api/fs/file?path=${encodeURIComponent(path)}`,
    ),
  fsMkdir: (path: string) => api.post<{ ok: boolean; path: string }>('/api/fs/mkdir', { path }),
  fsMove: (from: string, to: string, force = false) =>
    api.post<{ ok: boolean; from: string; to: string; brokenLinks: number; needConfirm?: string; error?: string }>('/api/fs/move', {
      from,
      to,
      force,
    }),
  fsArchive: (paths: string[]) => api.post<{ moved: { from: string; to: string }[] }>('/api/fs/archive', { paths }),
  brief: () => api.get<{ data: BriefView; brief: string }>('/api/maintenance/brief'),
  /** 当日对账：只读，返回证据与提案 */
  dayActual: (date?: string) => api.get<DayReconcileView>(`/api/day/actual${date ? `?date=${date}` : ''}`),
  /** 确认「可能已完成」——仍然走 ChangeService，不绕过提交 */
  dayConfirm: (id: string) => api.post<{ ok: boolean; already?: boolean }>('/api/day/confirm', { id }),
  tidy: (apply = false) => api.post<{ ok: boolean; report: { dryRun: boolean; archived: number; candidates: number; brief: string; error?: string } }>('/api/maintenance/tidy', { apply }),
  notifyStatus: () => api.get<NotifyStatusView>('/api/notify/status'),
  saveNotifyConfig: (b: Partial<{ host: string; port: number; secure: boolean; user: string; pass: string; to: string; fromName: string; allowFrom: string[] }>) =>
    api.put<{ ok: boolean } & NotifyStatusView>('/api/notify/config', new Blob([JSON.stringify(b)], { type: 'application/json' }), 'application/json'),
  checkMail: (dryRun = true) => api.post<{ ok: boolean; report: { fetched: number; captured: { subject: string; from: string; skipped?: string }[]; skipped: { subject: string; skipped?: string }[]; error?: string } }>('/api/inbox/mail', { dryRun }),
  testNotify: () => api.post<{ ok: boolean; messageId?: string; error?: string }>('/api/notify/test'),
  runNotify: (dryRun = true) => api.post<{ ok: boolean; report: { sent: { kind: string; title: string }[]; skipped: string[]; error?: string } }>('/api/notify/run', { dryRun }),
  unresolvedLinks: () => api.get<{ items: UnresolvedLinkView[] }>('/api/links/unresolved'),
  candidates: () => api.get<{ candidates: WorkCandidateView[] }>('/api/candidates/works'),
  groupWork: (dir: string, title: string) => api.post<{ ok: boolean; slug: string }>('/api/works/group', { dir, title }),
  notifications: () => api.get<{ notices: NoticeView[]; unread: number }>('/api/notifications'),  readNotifications: (id?: string) => api.post<{ ok: boolean; marked: number }>('/api/notifications/read', { id }),
  createRule: (b: unknown) => api.post<{ ok: boolean; rule: RuleView }>('/api/rules', b),
  toggleRule: (id: string) => api.post<{ ok: boolean }>(`/api/rules/${id}/toggle`),

  /* ---------------- Agent 会话 ---------------- */
  agentHarnesses: () => api.get<{
    ok: boolean; source: 'file' | 'default'; path?: string; default: string; harnesses: HarnessView[];
  }>('/api/agent/harnesses'),
  agentProbe: (id: string) => api.post<{ ok: boolean; harness: HarnessView }>(`/api/agent/harnesses/${encodeURIComponent(id)}/probe`),
  agentPair: (label?: string) => api.post<{ ok: boolean; code: string; expiresAt: string }>('/api/agent/pair', { label }),
  agentConfigFile: () => api.get<{ ok: boolean; path: string; raw: string; exists: boolean; source: string; defaultRaw?: string; error?: string }>('/api/agent/config'),
  saveAgentConfigFile: (raw: string) => api.putJson<{ ok: boolean; path: string; source: string; default: string; harnesses: number }>('/api/agent/config', { raw }),
  agentSkills: () => api.get<{ ok: boolean; skills: AgentSkill[] }>('/api/agent/skills'),
  agentCreate: (b: {
    harnessId?: string; focus: { kind: string; id: string; title: string; revision: number };
    refs?: ContextRef[]; skillId?: string; approvals?: Partial<ApprovalPolicy>;
  }) => api.post<{ ok: boolean; session: SessionView }>('/api/agent/sessions', b),
  agentSession: (id: string) => api.get<{ ok: boolean; session: SessionView; context: unknown; lastPack: unknown }>(`/api/agent/sessions/${encodeURIComponent(id)}`),
  agentTurn: (id: string, text: string, refs?: ContextRef[]) =>
    api.post<{ ok: boolean; turnId: string }>(`/api/agent/sessions/${encodeURIComponent(id)}/turns`, { text, refs }),
  agentCancel: (id: string) => api.post<{ ok: boolean }>(`/api/agent/sessions/${encodeURIComponent(id)}/cancel`),
  agentConfig: (id: string, optionId: string, value: string) =>
    api.post<{ ok: boolean; configOptions: unknown[] }>(`/api/agent/sessions/${encodeURIComponent(id)}/config`, { optionId, value }),
  agentApprovals: (id: string, b: Partial<ApprovalPolicy>) =>
    api.patch<{ ok: boolean; approvals: ApprovalPolicy }>(`/api/agent/sessions/${encodeURIComponent(id)}/approvals`, b),
  agentPermission: (id: string, requestId: string, decision: 'allow' | 'deny') =>
    api.post<{ ok: boolean }>(`/api/agent/sessions/${encodeURIComponent(id)}/permission`, { requestId, decision }),
  agentAcceptAnnotations: (b: { sessionId: string; repId: string; items: AnnotationSuggestion[] }) =>
    api.post<{ ok: boolean; accepted: AnnotationSuggestion[]; rejected: { quote: string; reason: string }[] }>('/api/agent/annotations/accept', b),
  agentCommitProposal: (sessionId: string, proposalId: string) =>
    api.post<{ ok: boolean }>(`/api/agent/proposals/${encodeURIComponent(proposalId)}/commit`, { sessionId }),
  agentClose: (id: string) => api.del<{ ok: boolean }>(`/api/agent/sessions/${encodeURIComponent(id)}`),
  agentMetrics: () => api.get<{
    ok: boolean;
    metrics: { total: number; active: number; turns: number; errors: number; avgTurnMs: number; byHarness: Record<string, { sessions: number; turns: number; errors: number }> };
  }>('/api/agent/metrics'),
  agentRunLoop: (id: string, b?: { harnessId?: string; timeoutMs?: number }) =>
    api.post<{ ok: boolean; task: { status: string; text: string; errors: string[]; proposals: string[]; durationMs: number } }>(
      `/api/agent/tasks/loop/${encodeURIComponent(id)}`, b ?? {},
    ),
  agentAutopilot: (b?: { harnessId?: string; limit?: number }) =>
    api.post<{ ok: boolean; tasks: unknown[] }>('/api/agent/autopilot/run', b ?? {}),
};

/* ---------------- 视图类型 ---------------- */

export interface NoteListItem {
  id: string; title: string; path: string; status: string; kind: string;
  tags: string[]; updatedAt: string;
}

export interface WorkView {
  work: { id: string; title: string; kind: string; desc?: string; slug: string; updatedAt: string };
  parts: { id: string; title: string; order: number; supplemental?: boolean }[];
  reps: { id: string; partId: string; carrier: string; path: string; locked: boolean; bytes: number }[];
  originals: number; annotations: number; derived: number;
  /** 读完的章数 ÷ 正文章数 */
  readPct: number;
  readChapters: number; chapterCount: number;
  lastReadAt: string | null; lastRepId: string | null;
  /** 作品目录下有 data/ 时才有数据页入口 */
  hasData?: boolean;
  gates: { key: string; pass: boolean; detail: string }[];
  stage: string | null; next: { key: string; text: string } | null; locked: boolean;
}
export interface WorkDetail extends Omit<WorkView, 'parts' | 'derived'> {
  parts: ({ part: WorkView['parts'][number]; reps: WorkView['reps']; annotations: number })[];
  derived: NoteView[];
}
export interface BuildAction {
  id: string; label: string; command: string; args: string[]; cwd: string;
  timeoutMs: number; outputs: string[]; env: Record<string, string>;
}
export type BuildStatus = 'queued' | 'running' | 'success' | 'failed' | 'timeout' | 'interrupted';
export interface BuildRun {
  id: string; workId: string; slug: string; actionId: string; label: string;
  command: string; args: string[]; cwd: string; status: BuildStatus;
  exitCode?: number; startedAt: string; finishedAt?: string; stdout: string; stderr: string;
}
export interface BuildInfo { actions: BuildAction[]; lastRun: BuildRun | null }
export interface WorkDataFile { path: string; name: string; bytes: number; updatedAt: string }
export interface WorkDataPayload { path: string; text: string; json: unknown; bytes: number; updatedAt: string }
export interface NoteView {
  id: string; type: string; title: string; body?: string; status: string; kind: string;
  srcIds: string[]; tags?: string[]; updatedAt: string; path?: string;
}
export interface RepContent {
  rep: { id: string; carrier: string; path: string; locked: boolean; partId: string; workId: string; rev?: number };
  /** 整份文件（含 frontmatter），编辑器用它当源码 */
  content: string;
  /** 服务端解析出的正文（frontmatter 已去掉），阅读器用它，避免前端各写一套正则 */
  body: string;
  /** 打开时这份内容的哈希：保存时当作基准回传，服务端才知道有没有人抢先改过 */
  hash: string;
  locked: boolean;
  cursor: { repId: string; current: number; furthest: number };
}
export interface AnnotationView {
  id: string; targetRepId: string; quote: string; note?: string; color: string;
  locator: { from: number; to: number; prefix?: string; suffix?: string };
  author: string; createdAt: string;
  origin?: 'human' | 'ai'; skillId?: string; sessionId?: string;
}
export interface TodayView {
  actions: (ActionView & {})[];
  events: EventView[];
  overdue: ActionView[];
  reading: { rep: { id: string; carrier: string; path: string }; title: string; pct: number }[];
}
export interface ActionView {
  id: string; text: string; due?: string; scheduled?: [string, string];
  flow: string; state: string; projectId?: string; rev: number;
}
export interface EventView { id: string; title: string; start: string; end: string; projectId?: string }

/** 点开一行看到的东西。字段按类型宽松列，任务看 text/due，笔记看 title/status */
export interface ObjectLinkView { id: string; kind: string; title: string; rel: string }
export interface ObjectPeekView {
  object: {
    id: string; type: string; rev?: number; archivedAt?: string; author?: string; updatedAt?: string;
    text?: string; title?: string; slug?: string;
    due?: string; scheduled?: [string, string]; flow?: string; state?: string;
    start?: string; end?: string; status?: string; tags?: string[]; summary?: string;
    projectId?: string;
    /** frontmatter source 是外链时，这里是原文地址 */
    sourceUrl?: string;
  };
  path: string;
  links: ObjectLinkView[];
  events: { id: string; at: string; actor: string; op: string; summary: string }[];
}
export interface ProjectView {
  id: string; title: string; state: string; desc?: string;
  actions: ActionView[]; done: number;
}
export interface FlowView {
  cards: { id: string; kind: string; title: string; path?: string; readPct: number; derived: number; gates: { key: string; pass: boolean; detail: string }[]; stage: string | null; next: { key: string; text: string } | null }[];
  byStage: Record<string, FlowView['cards']>;
  stuck: FlowView['cards'];
}
export interface TagsView { tags: { tag: string; ids: string[] }[]; facets: { tags: { tag: string; n: number }[]; types: { type: string; n: number }[] } }
export interface GraphView { nodes: { id: string; type: string; title: string }[]; edges: { source: string; target: string }[] }
export interface SearchView { hits: { id: string; type: string; title: string; path: string; snippet: string; score: number }[]; facets: TagsView['facets'] }
export interface JournalEventView {
  id: string; at: string; actor: string; op: string; phase: string; target: string;
  summary: string; payload?: Record<string, unknown>; claimedBy?: string;
}
export interface ChangeSetView {
  id: string; state: string; reason?: string; author: string; createdAt: string; committedAt?: string;
  ops: { t: string; id?: string; patch?: Record<string, unknown>; body?: string; obj?: Record<string, unknown> }[];
  checks?: BlockedCheck[];
  snapshot?: Record<string, { baseRev: number; base: string; mine: string; hash: string }>;
  conflict?: ConflictPayload;
  baseRevisions: Record<string, number>;
}
export interface ProposalView {
  id: string; title: string; kind: string; rationale?: string; scope?: string; budgetCny?: number;
  risk?: string; state: string; author: string; changesetId?: string; evidence?: string[]; checks?: BlockedCheck[];
}
export interface JobView {
  id: string; name: string; trigger: string; state: string; checkpoint: string;
  steps: { name: string; state: string }[]; waitingReason?: string; idempotencyKey?: string; updatedAt?: string;
  attempts?: number; lastError?: string; nextTryAt?: string;
}
export interface RuleView {
  kind?: string; threshold?: number; id: string; name: string; when: string; do: string; limit: number; enabled: boolean }
export interface SystemView {
  space: { id: string; name: string; root: string; tz: string };
  stats: SpaceInfo['stats'];
  storage: {
    adapter: string; capabilities: Record<string, boolean>; root: string; wpsNotice: string;
    assets: { path: string; bytes: number; kind: string }[]; assetBytes: number;
  };
  budget: { dailyProposalLimit: number; usedToday: number };
  health: { unresolvedLinks: number; links: number; resolveRate: number; indexDocs: number };
}
export interface ManifestView {
  space: string; generatedAt: string;
  capabilities: { id: string; name: string; human: string; agent: string; writes: string; event: string; command: string; mutating: boolean }[];
}
export interface ActionView {
  id: string; text: string; state: string; flow: string;
  due?: string; doneAt?: string; pri?: string; projectId?: string;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: string;
  bytes: number;
  mtime: string;
  indexed: boolean;
  objectType?: string;
  objectId?: string;
  locked?: boolean;
  inbound?: number;
}

export interface BriefView {
  at: string;
  today: { id: string; text: string }[];
  overdue: { id: string; text: string; due?: string }[];
  upcoming: { id: string; text: string; due?: string }[];
  events: { id: string; title: string; start: string }[];
  reading: { repId: string; title: string; pct: number; staleDays: number }[];
  inbox: { id: string; title: string; days: number }[];
  counts: { links: number; brokenLinks: number; notes: number; parts: number; works: number; doneOld: number };
  archiveCandidates: { id: string; text: string; doneAt?: string }[];
  /** 真欠账，按状态聚合。带 why 说明为什么算欠账——只报数字等于没报 */
  stuck: { state: string; stateName: string; n: number; why: string }[];
  /** 内容完整、只差一次确认的篇数（不计入欠账） */
  stable: number;
  refresh: { id: string; title: string; idleDays: number; why: string }[];
  byVitality: { vitality: string; name: string; n: number }[];
  /** 当日对账：今天实际做了什么 vs 今天该做什么 */
  day: DayReconcileView;
}

export interface DayActivityView {
  day: string;
  events: number;
  meaningful: number;
  taskOps: number;
  hits: { id: string; type: string; title: string; ops: string[]; events: number; readPct?: number; lastAt: string }[];
}

export interface DayPlanView {
  id: string;
  text: string;
  due?: string;
  status: 'covered' | 'touched' | 'idle';
  evidence: { kind: 'ref' | 'lexical'; objectId: string; title: string; detail: string }[];
}

export interface DayReconcileView {
  day: string;
  at: string;
  activity: DayActivityView;
  planned: DayPlanView[];
  unplanned: { id: string; title: string; events: number; readPct?: number }[];
  projects: { id: string; title: string; n: number; titles: string[] }[];
  counts: {
    events: number; active: number; planned: number; covered: number;
    touched: number; idle: number; unplanned: number; taskOps: number;
  };
  /** 服务端渲染好的同一份文本（CLI / 邮件 / 页面一致） */
  text?: string;
}

export interface NotifyStatusView {
  configured: boolean;
  /** 发件邮箱 */
  user?: string | null;
  /** 收件邮箱（可逗号分隔多个） */
  to?: string | null;
  host?: string | null;
  port?: number | null;
  secure?: boolean | null;
  fromName?: string | null;
  /** 投递白名单；空数组 = 只认自己的发件地址 */
  allowFrom?: string[];
  missing?: string[];
  configPath: string;
  env?: { HABITAT_SMTP_HOST: boolean };
}

export interface UnresolvedLinkView { target: string; refs: { id: string; path: string }[] }

export interface WorkCandidateView { dir: string; slug: string; chapters: number; title: string }

export interface NoticeView {
  id: string; at: string; level: 'info' | 'warn' | 'danger';
  title: string; body?: string; href?: string; ruleId?: string; read: boolean;
}

export interface RuleRunView {
  at: string; rules: number; evaluated: number;
  fired: { rule: string; title: string }[];
  skipped: string[];
}

export interface LoopDefView {
  id: string;
  name: string;
  family: 'maintain' | 'digest' | 'decide' | 'deliver';
  intent: string;
  mode: 'auto' | 'assist' | 'gate' | 'verify';
  autonomy: 'read' | 'derived' | 'propose' | 'commit' | 'external';
  trigger: { kind: string; minutes?: number; at?: string; on?: string; note?: string };
  maxSilenceMinutes: number;
  executors: string[];
  requires: string[];
  entry: { cli?: string; api?: string; mcp?: string; ui?: string; command?: string };
  steps: string[];
  outputs: string[];
  evidence: string[];
  idempotency: string;
  degrade: Record<string, string>;
  backlog?: string;
  ownerHint: string;
  harnessArgs?: string;
  serverOnly?: boolean;
  note?: string;
}

export interface LoopStateView {
  id: string;
  state: 'ok' | 'late' | 'down' | 'never' | 'paused' | 'blocked' | 'manual';
  lastAt?: string;
  lastBy?: string;
  lastResult?: string;
  silenceMinutes?: number;
  maxSilenceMinutes: number;
  backlog?: number;
  reason: string;
}

export interface LoopReceiptView {
  loop: string; at: string; by: string; trigger: string;
  result: string; durationMs?: number; counts?: Record<string, number>;
  produced?: string[]; note?: string;
}

export interface LoopsView {
  at: string;
  loops: LoopDefView[];
  states: LoopStateView[];
  summary: Record<string, number>;
  backlog: Record<string, number>;
  config: { version: number; loops: Record<string, { enabled?: boolean; owner?: string; note?: string }> };
}

export interface LoopDetailView {
  loop: LoopDefView;
  status: LoopStateView;
  claims: { loop: string; target: string; by: string; at: string; until: string }[];
  recent: LoopReceiptView[];
}

export interface LoopRunView {
  ok: boolean;
  loop: string;
  ran: boolean;
  result: string;
  output: string;
  counts?: Record<string, number>;
  produced?: string[];
  deduped?: boolean;
  note?: string;
}

export interface LoopCheckView {
  at: string;
  summary: Record<string, number>;
  silent: { id: string; state: string; reason: string }[];
  never: string[];
  unowned: string[];
  double: string[];
  mismatch: { id: string; owner: string; lastBy: string }[];
  passed: boolean;
}

export interface ReconcileView {
  at: string; checked: number; baseline: boolean; added: string[]; removed: string[];
  changed: { path: string; from: string; to: string }[];
  unsigned: { path: string; from: string; to: string }[];
  signed: { path: string; event: string }[];
}
