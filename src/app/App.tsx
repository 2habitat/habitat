import { useEffect } from 'react';
import { ROUTES, GROUPS, useLocation, navigate, routeTitle, href } from './router.ts';
import { useUi, applyUiToDocument } from './ui.ts';
import { AiPanel, AiFab } from './AiPanel.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { Sheets } from './Sheets.tsx';
import { Toasts, Spinner } from '../components/ui.tsx';
import { useToday, useInbox, useChangesSummary, useNotifications } from '../services/use.ts';

import { TodayPage, InboxPage, CalendarPage, ProjectsPage, AreasPage, ReviewPage } from '../domains/actions/pages.tsx';
import { ShelfPage, ContinuePage, ComposePage } from '../domains/library/pages.tsx';
import { ReaderPage } from '../domains/reading/Reader.tsx';
import { EditorPage } from '../domains/editing/Editor.tsx';
import { SearchPage, TagsPage, CollectionsPage, GraphPage } from '../domains/connect/pages.tsx';
import { AssistantPage, ChangesPage, JobsPage, AutomationPage } from '../domains/ai/pages.tsx';
import { ChannelsPage, StoragePage, AgentPage, BudgetPage, HealthPage } from '../domains/system/pages.tsx';
import { FilesPage } from '../domains/system/FilesPage.tsx';

export function App() {
  const loc = useLocation();
  const collapsed = useUi((s) => s.collapsed);
  const toggleCollapsed = useUi((s) => s.toggleCollapsed);
  const setPalette = useUi((s) => s.setPalette);
  const openSheet = useUi((s) => s.openSheet);
  const theme = useUi((s) => s.theme);
  const fontSize = useUi((s) => s.fontSize);
  const drawer = useUi((s) => s.drawer);
  const setDrawer = useUi((s) => s.setDrawer);
  const openAi = useUi((s) => s.openAi);
  const { data: today } = useToday();
  const { data: inbox } = useInbox();
  const { data: changes } = useChangesSummary();
  const { data: notif } = useNotifications();

  useEffect(() => {
    applyUiToDocument();
  }, [theme, fontSize]);

  // 换页就收抽屉，否则手机上点完菜单还要手动关
  useEffect(() => {
    setDrawer(false);
  }, [loc.id, setDrawer]);

  const counts: Record<string, number> = {
    inbox: inbox?.notes.length ?? 0,
    today: (today?.actions.length ?? 0) + (today?.overdue.length ?? 0),
    changes: changes?.summary.pending ?? 0,
  };

  // 手机底栏：四个去处 + 更多。助手是动作不是页面，单独处理。
  const tabs: { id: string; icon: string; label: string; run: () => void }[] = [
    { id: 'today', icon: '☀', label: '今天', run: () => navigate('today') },
    { id: 'shelf', icon: '▤', label: '书架', run: () => navigate('shelf') },
    { id: 'search', icon: '⌕', label: '检索', run: () => navigate('search') },
    { id: 'assistant', icon: '✦', label: '助手', run: () => openAi() },
    { id: 'more', icon: '☰', label: '更多', run: () => setDrawer(true) },
  ];

  const fullBleed = loc.id === 'reader';

  return (
    <div className="app" data-collapsed={collapsed ? '1' : '0'} data-drawer={drawer ? '1' : '0'}>
      <div className="drawer-mask" onClick={() => setDrawer(false)} data-testid="drawer-mask" />
      <aside className="sidebar" aria-hidden={undefined}>
        <div className="sidebar-head">
          <div className="brand"><span className="brand-dot" /><span className="brand-name">Habitat</span></div>
          <span className="spacer" />
          <button className="nav-toggle" onClick={() => setDrawer(false)} aria-label="关闭菜单" style={{ marginLeft: 0 }}>✕</button>
        </div>
        <nav className="sidebar-nav">
          {GROUPS.map((g) => (
            <div key={g}>
              <div className="nav-group">{g}</div>
              {ROUTES.filter((r) => r.group === g && !['reader', 'editor'].includes(r.id)).map((r) => (
                <a
                  key={r.id}
                  className="nav-item"
                  href={href(r.id)}
                  aria-current={loc.id === r.id ? 'page' : undefined}
                  data-testid={`nav-${r.id}`}
                  title={r.title}
                  onClick={() => setDrawer(false)}
                >
                  <span className="ico">{r.icon}</span>
                  <span className="nav-label">{r.title}</span>
                  {counts[r.id] ? <span className="nav-count">{counts[r.id]}</span> : null}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="nav-item" onClick={toggleCollapsed} title="收起侧栏" data-testid="nav-collapse">
            <span className="ico">{collapsed ? '»' : '«'}</span><span className="nav-label">收起</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="nav-toggle" onClick={() => setDrawer(true)} aria-label="打开菜单" data-testid="nav-toggle">☰</button>
          <span className="topbar-title">{routeTitle(loc.id)}</span>
          <span className="topbar-sub">
            {loc.id === 'reader' || loc.id === 'editor' ? (loc.params.rep ?? loc.params.id ?? '') : ''}
          </span>
          <span className="topbar-spacer" />
          <button
            className="btn btn-sm bell"
            onClick={() => openSheet('notifications')}
            aria-label={notif?.unread ? `通知，${notif.unread} 条未读` : '通知'}
            data-testid="open-notifications"
          >
            <span aria-hidden="true">🔔</span>
            {notif?.unread ? <span className="bell-dot" aria-hidden="true" /> : null}
          </button>
          <button className="btn btn-sm" id="open-palette" onClick={() => setPalette(true)} data-testid="open-palette">
            命令 <span className="muted small">⌘K</span>
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => openSheet('capture')} data-testid="quick-capture">
            ＋ 采集
          </button>
          <select
            className="select"
            style={{ width: 96 }}
            value={theme}
            aria-label="主题"
            data-testid="theme-select"
            onChange={(e) => useUi.getState().setTheme(e.target.value as never)}
          >
            <option value="ningzhi">凝脂</option>
            <option value="piaoqing">漂青</option>
            <option value="xuanmo">玄墨</option>
          </select>
          <select
            className="select"
            style={{ width: 84 }}
            value={fontSize}
            aria-label="字号"
            onChange={(e) => useUi.getState().setFontSize(e.target.value as never)}
          >
            <option value="sm">小</option>
            <option value="md">中</option>
            <option value="lg">大</option>
          </select>
        </header>

        <div className="content" style={fullBleed ? { padding: '12px 16px', overflow: 'hidden' } : undefined}>
          <Page id={loc.id} params={loc.params} />
        </div>
      </main>

      <nav className="bottom-tabs" aria-label="主导航">
        {tabs.map((t) => (
          <button
            key={t.id}
            className="bottom-tab"
            aria-current={loc.id === t.id ? 'page' : undefined}
            data-testid={`tab-${t.id}`}
            onClick={t.run}
          >
            <span className="ico">{t.icon}</span>
            <span>{t.label}</span>
            {counts[t.id] ? <span className="nav-count">{counts[t.id]}</span> : null}
          </button>
        ))}
      </nav>

      <AiFab />
      <AiPanel />
      <CommandPalette />
      <Sheets />
      <Toasts />
    </div>
  );
}

function Page({ id, params }: { id: ReturnType<typeof useLocation>['id']; params: Record<string, string> }) {
  switch (id) {
    case 'today': return <TodayPage />;
    case 'inbox': return <InboxPage />;
    case 'calendar': return <CalendarPage />;
    case 'projects': return <ProjectsPage />;
    case 'areas': return <AreasPage />;
    case 'review': return <ReviewPage />;

    case 'shelf': return <ShelfPage />;
    case 'continue': return <ContinuePage />;
    case 'compose': return <ComposePage />;
    case 'reader': return <ReaderPage workId={params.work} repId={params.rep} />;
    case 'editor': return <EditorPage repId={params.rep} noteId={params.id} />;

    case 'search': return <SearchPage q={params.q} />;
    case 'tags': return <TagsPage />;
    case 'collections': return <CollectionsPage />;
    case 'graph': return <GraphPage />;

    case 'assistant': return <AssistantPage />;
    case 'changes': return <ChangesPage />;
    case 'jobs': return <JobsPage />;
    case 'automation': return <AutomationPage />;

    case 'storage': return <StoragePage />;
    case 'agent': return <AgentPage />;
    case 'budget': return <BudgetPage />;
    case 'files': return <FilesPage />;
    case 'channels': return <ChannelsPage />;
    case 'health': return <HealthPage />;

    default: return <Spinner />;
  }
}

export { navigate };
