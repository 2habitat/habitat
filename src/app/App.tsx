import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ROUTES, GROUPS, GROUP_HINT, useLocation, navigate, routeTitle, href } from './router.ts';
import { useUi, applyUiToDocument } from './ui.ts';
import { AiPanel, AiFab } from './AiPanel.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { Sheets } from './Sheets.tsx';
import { ObjectPeek } from './ObjectPeek.tsx';
import { useListNav } from './useListNav.ts';
import { Toasts, Spinner } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';
import { useToday, useInbox, useChangesSummary, useNotifications } from '../services/use.ts';

import { TodayPage, InboxPage, CalendarPage, ProjectsPage, AreasPage, ReviewPage } from '../domains/actions/pages.tsx';
import { ShelfPage, ContinuePage, ComposePage } from '../domains/library/pages.tsx';
import { ReaderPage } from '../domains/reading/Reader.tsx';
import { EditorPage } from '../domains/editing/Editor.tsx';
import { SearchPage, TagsPage, CollectionsPage, GraphPage } from '../domains/connect/pages.tsx';
import { AssistantPage, ChangesPage, JobsPage, AutomationPage } from '../domains/ai/pages.tsx';
import { LoopsPage } from '../domains/ai/LoopsPage.tsx';
import { ChannelsPage, StoragePage, AgentPage, BudgetPage, HealthPage } from '../domains/system/pages.tsx';
import { FilesPage } from '../domains/system/FilesPage.tsx';
import { AccountPage } from '../domains/system/AccountPage.tsx';

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

  // 全站一套键盘：J/K 选行、Enter 打开、Space 预览、X 完成
  useListNav();

  // 换页就收抽屉，否则手机上点完菜单还要手动关
  useEffect(() => {
    setDrawer(false);
  }, [loc.id, setDrawer]);

  // 换页回顶：滚动容器是常驻的，不重置的话从长页跳到短页会停在半空
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [loc.id]);

  /**
   * 侧栏选中块会「滑」过去，而不是瞬间换一个背景。
   * 位置用 offsetTop 量（不受滚动影响），压缩后高度也一起过渡。
   */
  const navRef = useRef<HTMLElement>(null);
  const [marker, setMarker] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const el = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el) { setMarker(null); return; }
    setMarker({ top: el.offsetTop, height: el.offsetHeight });
  }, [loc.id, collapsed, drawer]);

  const counts: Record<string, number> = {
    inbox: inbox?.notes.length ?? 0,
    today: (today?.actions.length ?? 0) + (today?.overdue.length ?? 0),
    changes: changes?.summary.pending ?? 0,
  };

  // 手机底栏：四个去处 + 更多。助手是动作不是页面，单独处理。
  const tabs: { id: string; icon: 'today' | 'shelf' | 'search' | 'assistant' | 'more'; label: string; run: () => void }[] = [
    { id: 'today', icon: 'today', label: '今天', run: () => navigate('today') },
    { id: 'shelf', icon: 'shelf', label: '书架', run: () => navigate('shelf') },
    { id: 'search', icon: 'search', label: '检索', run: () => navigate('search') },
    { id: 'assistant', icon: 'assistant', label: '助手', run: () => openAi() },
    { id: 'more', icon: 'more', label: '更多', run: () => setDrawer(true) },
  ];

  const fullBleed = loc.id === 'reader';
  const group = ROUTES.find((r) => r.id === loc.id)?.group ?? '';

  return (
    <div className="app" data-collapsed={collapsed ? '1' : '0'} data-drawer={drawer ? '1' : '0'}>
      {/* 键盘用户第一下 Tab 就能跳过整条导航 */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          contentRef.current?.focus();
        }}
      >
        跳到正文
      </a>
      <div className="drawer-mask" onClick={() => setDrawer(false)} data-testid="drawer-mask" />
      <aside className="sidebar">
        <div className="sidebar-head">
          <a className="brand" href={href('today')} title="Habitat · 今天">
            <span className="brand-seal" aria-hidden="true">栖</span>
            <span className="brand-text">
              <span className="brand-name">Habitat</span>
              <span className="brand-sub">个人档案</span>
            </span>
          </a>
          <button className="nav-toggle" onClick={() => setDrawer(false)} aria-label="关闭菜单">
            <Icon name="close" />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="主导航" ref={navRef}>
          {marker && <span className="nav-marker" aria-hidden="true" style={{ transform: `translateY(${marker.top}px)`, height: marker.height }} />}
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
                  <span className="ico"><Icon name={r.icon} /></span>
                  <span className="nav-label">{r.title}</span>
                  {counts[r.id] ? <span className="nav-count">{counts[r.id]}</span> : null}
                </a>
              ))}
            </div>
          ))}
        </nav>

        {/* 外观是低频设置，放在侧栏底部而不是主操作区——顶栏只留真正常用的动作 */}
        <div className="sidebar-foot">
          <div className="appearance">
            <select
              className="select"
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
              value={fontSize}
              aria-label="字号"
              data-testid="font-size-select"
              onChange={(e) => useUi.getState().setFontSize(e.target.value as never)}
            >
              <option value="sm">小号</option>
              <option value="md">中号</option>
              <option value="lg">大号</option>
            </select>
          </div>
          <button className="nav-item" onClick={toggleCollapsed} title={collapsed ? '展开侧栏' : '收起侧栏'} data-testid="nav-collapse">
            <span className="ico"><Icon name="panel" /></span>
            <span className="nav-label">{collapsed ? '展开' : '收起'}</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="nav-toggle" onClick={() => setDrawer(true)} aria-label="打开菜单" data-testid="nav-toggle">
            <Icon name="menu" size={18} />
          </button>
          <span className="topbar-title">{routeTitle(loc.id)}</span>
          <span className="topbar-sub">{GROUP_HINT[group] ?? ''}</span>
          <span className="topbar-spacer" />
          <button
            className="btn btn-quiet btn-sm"
            id="open-palette"
            onClick={() => setPalette(true)}
            data-testid="open-palette"
            aria-label="打开命令面板"
          >
            <Icon name="search" />
            <span className="label-hide">命令</span>
            <kbd className="kbd">⌘K</kbd>
          </button>
          <button
            className="btn btn-quiet btn-sm btn-icon bell"
            onClick={() => openSheet('notifications')}
            aria-label={notif?.unread ? `通知，${notif.unread} 条未读` : '通知'}
            data-testid="open-notifications"
          >
            <Icon name="bell" />
            {notif?.unread ? <span className="bell-dot" aria-hidden="true" /> : null}
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => openSheet('capture')} data-testid="quick-capture">
            <Icon name="plus" />
            采集
          </button>
        </header>

        <div className="content" id="main-content" tabIndex={-1} ref={contentRef} style={fullBleed ? { padding: '14px 18px 0', overflow: 'hidden' } : undefined}>
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
            <span className="ico"><Icon name={t.icon} size={19} /></span>
            <span>{t.label}</span>
            {counts[t.id] ? <span className="nav-count">{counts[t.id]}</span> : null}
          </button>
        ))}
      </nav>

      <AiFab />
      <AiPanel />
      <CommandPalette />
      <ObjectPeek />
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
    case 'reader': return <ReaderPage workId={params.work} repId={params.rep} partId={params.part} />;
    case 'editor': return <EditorPage repId={params.rep} noteId={params.id} />;

    case 'search': return <SearchPage q={params.q} />;
    case 'tags': return <TagsPage />;
    case 'collections': return <CollectionsPage />;
    case 'graph': return <GraphPage />;

    case 'assistant': return <AssistantPage />;
    case 'changes': return <ChangesPage />;
    case 'jobs': return <JobsPage />;
    case 'automation': return <AutomationPage />;
    case 'loops': return <LoopsPage />;

    case 'storage': return <StoragePage />;
    case 'account': return <AccountPage />;
    case 'agent': return <AgentPage />;
    case 'budget': return <BudgetPage />;
    case 'files': return <FilesPage />;
    case 'channels': return <ChannelsPage />;
    case 'health': return <HealthPage />;

    default: return <Spinner />;
  }
}

export { navigate };
