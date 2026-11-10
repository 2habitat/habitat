import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from './api.ts';

export const qk = {
  space: ['space'] as const,
  works: ['works'] as const,
  work: (id: string) => ['work', id] as const,
  rep: (id: string) => ['rep', id] as const,
  annotations: (rep?: string) => ['annotations', rep ?? ''] as const,
  inbox: ['inbox'] as const,
  today: (d?: string) => ['today', d ?? ''] as const,
  projects: ['projects'] as const,
  flow: ['flow'] as const,
  tags: ['tags'] as const,
  graph: ['graph'] as const,
  search: (q: string, t?: string) => ['search', q, t ?? ''] as const,
  journal: (q: Record<string, string>) => ['journal', JSON.stringify(q)] as const,
  changes: ['changes'] as const,
  proposals: ['proposals'] as const,
  jobs: ['jobs'] as const,
  system: ['system'] as const,
  loops: ['loops'] as const,
  manifest: ['manifest'] as const,
  objects: (t?: string) => ['objects', t ?? ''] as const,
};

export function useSpace() { return useQuery({ queryKey: qk.space, queryFn: endpoints.space }); }
/** 当前登录身份：账号页、改密页与「强制改密」提示都靠它 */
export function useMe() {
  return useQuery({ queryKey: ['auth-me'], queryFn: endpoints.me, staleTime: 10_000 });
}
export function useAuthUsers(enabled: boolean) {
  return useQuery({ queryKey: ['auth-users'], queryFn: endpoints.users, enabled, staleTime: 5_000 });
}
export function useWorks() { return useQuery({ queryKey: qk.works, queryFn: endpoints.works }); }
export function useWork(id: string) { return useQuery({ queryKey: qk.work(id), queryFn: () => endpoints.work(id), enabled: !!id }); }
export function useRep(id: string) { return useQuery({ queryKey: qk.rep(id), queryFn: () => endpoints.rep(id), enabled: !!id }); }
export function useAnnotations(rep?: string) { return useQuery({ queryKey: qk.annotations(rep), queryFn: () => endpoints.annotations(rep) }); }
export function useInbox() { return useQuery({ queryKey: qk.inbox, queryFn: endpoints.inbox }); }
export function useToday(date?: string) { return useQuery({ queryKey: qk.today(date), queryFn: () => endpoints.today(date) }); }
export function useProjects() { return useQuery({ queryKey: qk.projects, queryFn: endpoints.projects }); }
export function useFlow() { return useQuery({ queryKey: qk.flow, queryFn: endpoints.flow }); }
export function useTags() { return useQuery({ queryKey: qk.tags, queryFn: endpoints.tags }); }
export function useGraph(limit = 200) { return useQuery({ queryKey: qk.graph, queryFn: () => endpoints.graph(limit) }); }
export function useSearch(q: string, type?: string) { return useQuery({ queryKey: qk.search(q, type), queryFn: () => endpoints.search(q, type), enabled: q.trim().length > 0 }); }
export function useJournal(q: Record<string, string> = {}) { return useQuery({ queryKey: qk.journal(q), queryFn: () => endpoints.journal(q) }); }
export function useChangesSummary() {
  return useQuery({ queryKey: [...qk.changes, 'summary'], queryFn: endpoints.changesSummary, staleTime: 15_000 });
}
export function useChanges() { return useQuery({ queryKey: qk.changes, queryFn: endpoints.changes }); }
export function useProposals() { return useQuery({ queryKey: qk.proposals, queryFn: endpoints.proposals }); }
export function useJobs() { return useQuery({ queryKey: qk.jobs, queryFn: endpoints.jobs }); }
export function useSystem() { return useQuery({ queryKey: qk.system, queryFn: endpoints.system }); }
/** 闭环状态：30 秒一轮，够快看到 down，也不至于把服务打满 */
export function useLoops() { return useQuery({ queryKey: qk.loops, queryFn: endpoints.loops, refetchInterval: 30_000 }); }
export function useManifest() { return useQuery({ queryKey: qk.manifest, queryFn: endpoints.manifest }); }
export function useObjects(type?: string) { return useQuery({ queryKey: qk.objects(type), queryFn: () => endpoints.objects(type) }); }
/** Peek 面板的数据源。id 为空时不发请求 */
export function useObject(id: string | null) {
  return useQuery({
    queryKey: ['object', id ?? ''],
    queryFn: () => endpoints.object(id!),
    enabled: !!id,
  });
}

/** 写完之后统一失效：保证界面看到的就是文件里的内容 */
export function useRefresh() {
  const qc = useQueryClient();
  // 必须是稳定引用：助手/阅读器的 effect 依赖它，每次渲染换函数会把 SSE 连接反复重建
  return useCallback(() => qc.invalidateQueries(), [qc]);
}

/** 通知：轮询比 websocket 简单可靠；本机服务，10 秒一次不心疼 */
export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => endpoints.notifications(),
    refetchInterval: 20_000,
  });
}

/** 全部未完成任务：未来任务也要能看见，否则等于没建 */
export function useActions() {
  return useQuery({ queryKey: ['actions'], queryFn: () => endpoints.actions() });
}

/** 管家简报：今天该看什么、库里哪些地方积压了 */
export function useBrief() {
  return useQuery({ queryKey: ['brief'], queryFn: () => endpoints.brief(), staleTime: 30_000 });
}
