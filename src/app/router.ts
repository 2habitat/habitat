/**
 * 极简 hash 路由：路由表即导航结构，URL 可分享、可刷新。
 * 用法：navigate('reader', { work, rep })
 */
import { useEffect, useState } from 'react';
import type { IconName } from '../components/icons.tsx';

export type RouteId =
  | 'today' | 'inbox' | 'calendar' | 'projects' | 'areas' | 'review'
  | 'shelf' | 'continue' | 'compose' | 'reader' | 'editor'
  | 'search' | 'tags' | 'collections' | 'graph'
  | 'assistant' | 'changes' | 'jobs' | 'automation' | 'loops'
  | 'storage' | 'agent' | 'budget' | 'files' | 'channels' | 'health' | 'account';

export const ROUTES: { id: RouteId; path: string; group: string; title: string; icon: IconName }[] = [
  { id: 'today', path: '/today', group: '行动', title: '今天', icon: 'today' },
  { id: 'inbox', path: '/inbox', group: '行动', title: '收件箱', icon: 'inbox' },
  { id: 'calendar', path: '/calendar', group: '行动', title: '日程', icon: 'calendar' },
  { id: 'projects', path: '/projects', group: '行动', title: '项目', icon: 'projects' },
  { id: 'areas', path: '/areas', group: '行动', title: '领域', icon: 'areas' },
  { id: 'review', path: '/review', group: '行动', title: '复盘', icon: 'review' },

  { id: 'shelf', path: '/shelf', group: '知识', title: '书架', icon: 'shelf' },
  { id: 'continue', path: '/continue', group: '知识', title: '继续阅读', icon: 'bookmark' },
  { id: 'compose', path: '/compose', group: '知识', title: '创作', icon: 'pen' },
  { id: 'reader', path: '/reader', group: '知识', title: '阅读', icon: 'shelf' },
  { id: 'editor', path: '/editor', group: '知识', title: '编辑', icon: 'pen' },

  { id: 'search', path: '/search', group: '连接', title: '检索', icon: 'search' },
  { id: 'tags', path: '/tags', group: '连接', title: '标签', icon: 'tags' },
  { id: 'collections', path: '/collections', group: '连接', title: '专题', icon: 'collections' },
  { id: 'graph', path: '/graph', group: '连接', title: '关系', icon: 'graph' },

  { id: 'assistant', path: '/assistant', group: 'AI', title: '助手', icon: 'assistant' },
  { id: 'changes', path: '/changes', group: 'AI', title: '变更', icon: 'changes' },
  { id: 'jobs', path: '/jobs', group: 'AI', title: '作业', icon: 'jobs' },
  { id: 'automation', path: '/automation', group: 'AI', title: '自动化', icon: 'automation' },
  { id: 'loops', path: '/loops', group: 'AI', title: '闭环', icon: 'automation' },

  { id: 'storage', path: '/storage', group: '系统', title: '空间与存储', icon: 'storage' },
  { id: 'account', path: '/account', group: '系统', title: '账号与登录', icon: 'account' },
  { id: 'agent', path: '/agent', group: '系统', title: 'Agent 接入', icon: 'agent' },
  { id: 'budget', path: '/budget', group: '系统', title: '权限与预算', icon: 'budget' },
  { id: 'files', path: '/files', group: '系统', title: '文件', icon: 'files' },
  { id: 'channels', path: '/channels', group: '系统', title: '通知渠道', icon: 'channels' },
  { id: 'health', path: '/health', group: '系统', title: '健康与恢复', icon: 'health' },
];

export const GROUP_HINT: Record<string, string> = {
  行动: '承诺 · 安排',
  知识: '读 · 写',
  连接: '找 · 连',
  AI: '代理 · 审计',
  系统: '空间 · 账号',
};

export const GROUPS = ['行动', '知识', '连接', 'AI', '系统'] as const;

export interface Location {
  id: RouteId;
  params: Record<string, string>;
}

function parse(): Location {
  const raw = window.location.hash.replace(/^#/, '') || '/today';
  const [path, qs] = raw.split('?');
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(qs ?? '')) params[k] = v;
  const hit = ROUTES.find((r) => r.path === path);
  return { id: hit?.id ?? 'today', params };
}

export function navigate(id: RouteId, params: Record<string, string> = {}): void {
  const r = ROUTES.find((x) => x.id === id)!;
  const qs = new URLSearchParams(params).toString();
  window.location.hash = `${r.path}${qs ? `?${qs}` : ''}`;
}

export function href(id: RouteId, params: Record<string, string> = {}): string {
  const r = ROUTES.find((x) => x.id === id)!;
  const qs = new URLSearchParams(params).toString();
  return `#${r.path}${qs ? `?${qs}` : ''}`;
}

export function useLocation(): Location {
  const [loc, setLoc] = useState<Location>(parse);
  useEffect(() => {
    const onChange = () => setLoc(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return loc;
}

export function setParam(key: string, value: string | undefined, keep: Record<string, string> = {}): void {
  const loc = parse();
  const next = { ...loc.params, ...keep };
  if (value === undefined || value === '') delete next[key];
  else next[key] = value;
  navigate(loc.id, next);
}

export function routeTitle(id: RouteId): string {
  return ROUTES.find((r) => r.id === id)?.title ?? '';
}

/* ---------------- 对象 Peek ----------------
 * Peek 不另开页面，而是挂在当前页的 URL 上（#/today?peek=act-xxx）。
 * 这样刷新不丢、链接能直接发给别人，也不用给 26 个页面各加一个 onPeek 回调。
 */
export function openPeek(id: string): void {
  setParam('peek', id);
}

export function closePeek(): void {
  setParam('peek', undefined);
}

export function peekTarget(): string | null {
  return parse().params.peek ?? null;
}
