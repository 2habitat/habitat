/** 行动域：承诺(due)、安排(scheduled)、推进(now/next/later) 三个字段分开，不混成「待办」 */
import { useEffect, useMemo, useState } from 'react';
import { Card, PageHead, Chip, Empty, Spinner, PageSkeleton, ErrorBox, Bar, todayStr } from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
import { useToday, useInbox, useProjects, useObjects, useRefresh, useActions } from '../../services/use.ts';
import { endpoints } from '../../services/api.ts';
import { useUi } from '../../app/ui.ts';
import { BatchBar, useBatch } from '../../components/batch.tsx';
import { StewardCard } from './StewardCard.tsx';
import { navigate } from '../../app/router.ts';
import { FLOW_LABEL, NOTE_STATUS } from '../../app/labels.ts';
import type { ActionView } from '../../services/api.ts';
import { buildMonth } from '../../../shared/calendar.ts';
import type { Action, EventRec } from '../../../shared/types.ts';

type ActivityAction = ActionView;

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** ISO 周数：日期脊上那行 W45 不是装饰，它让「今天」和「这一周」对得上 */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((+t - +y0) / 86400000 + 1) / 7);
}

/** 逾期天数：比一个红色日期更能说明「挂了多久」 */
function daysOverdue(due: string): number {
  const [y, m, d] = due.slice(0, 10).split('-').map(Number);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - Date.UTC(y, m - 1, d)) / 86400000));
}

function TaskRow({ a, onDone, overdue = false, onToday }: {
  a: ActionView;
  onDone?: () => void;
  overdue?: boolean;
  onToday?: () => void;
}) {
  const refresh = useRefresh();
  const toast = useUi((s) => s.toast);
  const openPeek = useUi((s) => s.openPeek);
  const [busy, setBusy] = useState(false);
  // 乐观勾选：点击立刻生效，提交失败再回滚。等一个来回再打勾，人会以为没点上。
  const [done, setDone] = useState(a.state === 'done');
  useEffect(() => { setDone(a.state === 'done'); }, [a.state]);
  const late = a.due ? daysOverdue(a.due) : 0;

  async function next() {
    if (busy) return;
    const want = !done;
    setDone(want);
    setBusy(true);
    try {
      await endpoints.propose([{ t: 'update', id: a.id, patch: { state: want ? 'done' : 'open' } }], `改任务状态：${a.text.slice(0, 16)}`);
      const r = await endpoints.commit((await endpoints.changes()).changesets[0].id);
      if (!r.ok) throw new Error('撞车了，请刷新重试');
      toast(want ? '已完成' : '已重新打开', 'ok');
      refresh();
      // 留 240ms 让人看见「划掉」这一下，再从今天里消失
      if (want && onDone) window.setTimeout(onDone, 240);
      else onDone?.();
    } catch (e) {
      setDone(!want);
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="task" data-nav-row={a.id} data-overdue={overdue ? '1' : undefined} data-done={done ? '1' : undefined}>
      <input
        type="checkbox"
        checked={done}
        aria-label={`完成：${a.text}`}
        data-testid="action-toggle"
        data-done-btn
        onChange={() => void next()}
      />
      <div className="task-main">
        <button
          type="button"
          className="peekable task-text"
          onClick={() => openPeek(a.id)}
          title="看详情"
          data-testid="action-open"
        >
          {a.text}
        </button>
        <div className="task-meta">
          {overdue && a.due && <span style={{ color: 'var(--danger)' }}>逾期 {late} 天 · {a.due}</span>}
          {!overdue && a.due && <span>{a.due}</span>}
          {a.scheduled && <span>{a.scheduled[0]}–{a.scheduled[1]}</span>}
          <span>{FLOW_LABEL[a.flow] ?? a.flow}</span>
          {a.projectId && <span>项目任务</span>}
          {a.state === 'blocked' && <span style={{ color: 'var(--warn)' }}>卡住</span>}
        </div>
      </div>
      <div className="task-actions">
        {onToday && (
          <button className="btn btn-sm btn-quiet" onClick={onToday} data-testid={overdue ? 'overdue-today' : 'upcoming-today'}>
            挪到今天
          </button>
        )}
        <button className="btn btn-sm btn-quiet" onClick={() => openPeek(a.id)} aria-label={`打开：${a.text}`}>
          <Icon name="arrow" size={13} />
        </button>
      </div>
    </div>
  );
}

export function TodayPage() {
  const { data, isLoading, error, refetch } = useToday();
  const { data: allActions } = useActions();
  const toast = useUi((s) => s.toast);
  const openSheet = useUi((s) => s.openSheet);
  const openAi = useUi((s) => s.openAi);
  const openPeek = useUi((s) => s.openPeek);
  const navigate_ = navigate;
  const refresh = useRefresh();

  /** 不想等到那天就先挪到今天；本质是改 due，不是新建 */
  async function moveToToday(a: ActivityAction) {
    const today = todayStr();
    try {
      const cs = await endpoints.propose([{ t: 'update', id: a.id, patch: { due: today } }], `顺延到 ${today}`);
      const r = await endpoints.commit(cs.changeset.id);
      toast(r.ok ? '已挪到今天' : '没改成，可能刚被别人改过', r.ok ? 'ok' : 'err');
      refresh();
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  if (isLoading) return <PageSkeleton rows={3} ledger />;
  if (error) return <ErrorBox error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  // 「安排」不只是 event：任务写了 [at:: 14:00-15:30] 也是今天的安排。
  // 两边的来源不同（events vs actions），在视图层合成一条时间线，存储不动。
  const scheduledToday = (allActions?.actions ?? []).filter(
    (a) => a.due?.slice(0, 10) === todayStr() && !!a.scheduled && a.state !== 'done',
  );
  const plan = [
    ...data.events.map((e) => ({ id: e.id, start: e.start.slice(11, 16), end: e.end.slice(11, 16), title: e.title, task: false })),
    ...scheduledToday.map((a) => ({ id: a.id, start: a.scheduled![0], end: a.scheduled![1], title: a.text, task: true })),
  ].sort((x, y) => x.start.localeCompare(y.start));

  const now = new Date();
  const all = allActions?.actions ?? [];
  const future = all.filter((a) => a.state !== 'done' && a.due && a.due > todayStr());
  const undated = all.filter((a) => a.state !== 'done' && !a.due);
  const soon = todayStr(Date.now() + 7 * 86400_000);
  const in7 = future.filter((a) => a.due! <= soon);
  const later = future.filter((a) => a.due! > soon);

  const headline =
    data.actions.length === 0
      ? (data.overdue.length ? `${data.overdue.length} 件已经过期。` : '今天没有必须做的事。')
      : `${data.actions.length} 件要做${data.overdue.length ? `，${data.overdue.length} 件已经过期` : ''}。`;
  const standfirst = data.overdue.length
    ? '过期的那几件先处理——挂着的承诺比没写的更消耗人。'
    : plan.length
      ? `下一段安排在 ${plan[0].start}，中间的时间归你。`
      : '今天没有排好的时间段，时间是你自己的。';

  let no = 0;
  const n = () => String(++no).padStart(2, '0');

  // 排序按「现在最该处理什么」：有过期就先摆过期，没有就把今天要做的放前面。
  // 页面顺序不是固定栏目顺序，是当天的事实顺序。
  const lateSection = data.overdue.length > 0 ? (
    <section className="section" aria-labelledby="sec-late">
      <h2 className="rubric" id="sec-late">
        <span className="rubric-no">{n()}</span>
        已过期
        <span className="rubric-rule" />
        <span className="rubric-meta">{data.overdue.length} 件</span>
      </h2>
      <p className="section-note">要么重排日期，要么删掉。挂着不动的承诺，等于没有承诺。</p>
      <div className="stagger">
        {data.overdue.map((a) => (
          <TaskRow key={a.id} a={a} overdue onDone={() => refresh()} onToday={() => void moveToToday(a)} />
        ))}
      </div>
    </section>
  ) : null;

  const doSection = (
    <section className="section" aria-labelledby="sec-do">
      <h2 className="rubric" id="sec-do">
        <span className="rubric-no">{n()}</span>
        要做
        <span className="rubric-rule" />
        <span className="rubric-meta">{data.actions.length} 件</span>
      </h2>
      {data.actions.length === 0
        ? <p className="section-note">今天没有到期的事。空白也是今天的一部分。</p>
        : <div className="stagger">{data.actions.map((a) => <TaskRow key={a.id} a={a} onDone={() => refresh()} />)}</div>}
    </section>
  );

  return (
    <div className="day">
      {/* 日期脊：整页的装订线，也是这个界面最容易被记住的一处 */}
      <aside className="day-spine" aria-label="今天的日期">
        <span className="spine-weekday">{WEEKDAY[now.getDay()]}</span>
        <span className="spine-day">{String(now.getDate()).padStart(2, '0')}</span>
        <span className="spine-month">{now.getMonth() + 1} 月</span>
        <span className="spine-year">{now.getFullYear()}</span>
        <span className="spine-rule" />
        <span className="spine-week">W{String(isoWeek(now)).padStart(2, '0')}</span>
      </aside>

      <div className="day-main">
        <header className="page-head">
          <p className="eyebrow">今日 · 行动</p>
          <h1 className="page-title">{headline}</h1>
          <p className="lede">{standfirst}</p>
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => openSheet('task', { flow: 'now' })} data-testid="today-add-task">
              <Icon name="plus" size={14} />
              记一件要做的事
            </button>
            <button className="btn" onClick={() => openSheet('event')}>
              <Icon name="calendar" size={14} />
              排日程
            </button>
            <button className="btn btn-quiet" onClick={() => openAi({ kind: 'none', id: '', title: '今天' })}>
              <Icon name="assistant" size={14} />
              问助手
            </button>
          </div>
        </header>

        <div className="ledger">
          <div className="ledger-cell" data-zero={data.actions.length === 0 ? '1' : '0'}>
            <b className="ledger-num">{data.actions.length}</b>
            <span className="ledger-label">今天要做</span>
          </div>
          <div className="ledger-cell" data-zero={data.overdue.length === 0 ? '1' : '0'}>
            <b className="ledger-num" data-tone={data.overdue.length ? 'danger' : undefined}>{data.overdue.length}</b>
            <span className="ledger-label">已过期</span>
          </div>
          <div className="ledger-cell" data-zero={plan.length === 0 ? '1' : '0'}>
            <b className="ledger-num">{plan.length}</b>
            <span className="ledger-label">今天的安排</span>
          </div>
          <div className="ledger-cell" data-zero={all.length === 0 ? '1' : '0'}>
            <b className="ledger-num">{all.length}</b>
            <span className="ledger-label">全部待办</span>
          </div>
        </div>

        {lateSection}
        {doSection}

        <section className="section" aria-labelledby="sec-plan">
          <h2 className="rubric" id="sec-plan">
            <span className="rubric-no">{n()}</span>
            今天的安排
            <span className="rubric-rule" />
            <span className="rubric-meta">{plan.length} 段</span>
          </h2>
          {plan.length === 0 ? (
            <p className="section-note">今天没有日程，也没有排了时段的任务。安排和到期是两件事，这里只放前者。</p>
          ) : (
            <div className="plan">
              {plan.map((p) => (
                <div key={p.id} className="plan-item" data-nav-row={p.id}>
                  <span className="plan-time">{p.start}–{p.end}</span>
                  <span className="plan-dot" data-task={p.task ? '1' : '0'} aria-hidden="true" />
                  <button
                    type="button"
                    className="peekable"
                    style={{ flex: 1 }}
                    onClick={() => openPeek(p.id)}
                    title="看详情"
                    data-testid="plan-open"
                  >
                    {p.title}
                  </button>
                  {p.task && <Chip tone="accent">任务</Chip>}
                </div>
              ))}
            </div>
          )}
        </section>

        {(in7.length > 0 || later.length > 0 || undated.length > 0) && (
          <section className="section" aria-labelledby="sec-next">
            <h2 className="rubric" id="sec-next">
              <span className="rubric-no">{n()}</span>
              接下来
              <span className="rubric-rule" />
              <span className="rubric-meta">{in7.length + later.length + undated.length} 件</span>
            </h2>
            {in7.length > 0 && (
              <div data-testid="upcoming-7">
                <div className="group-label">七天内 · {in7.length}</div>
                {in7.map((a) => <TaskRow key={a.id} a={a} onToday={() => void moveToToday(a)} />)}
              </div>
            )}
            {later.length > 0 && (
              <div data-testid="upcoming-later">
                <div className="group-label">更远 · {later.length}</div>
                {later.map((a) => (
                  <div key={a.id} data-testid="upcoming-row">
                    <TaskRow a={a} onToday={() => void moveToToday(a)} />
                  </div>
                ))}
              </div>
            )}
            {undated.length > 0 && (
              <div data-testid="undated">
                <div className="group-label">没有日期 · {undated.length}</div>
                {undated.map((a) => <TaskRow key={a.id} a={a} onToday={() => void moveToToday(a)} />)}
              </div>
            )}
          </section>
        )}
      </div>

      <aside className="day-rail" aria-label="今日侧栏">
        <StewardCard />

        <Card
          className="panel"
          title="继续读"
          desc={data.reading.length ? `${data.reading.length} 篇读到一半` : '没有在读的'}
        >
          {data.reading.length === 0 ? (
            <div className="small muted" style={{ lineHeight: 1.7 }}>
              书架上有没读完的东西，这里会接着上次的位置。
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-sm" onClick={() => navigate_('shelf')}>去书架</button>
              </div>
            </div>
          ) : data.reading.map((r) => (
            <button
              key={r.rep.id}
              type="button"
              className="rail-read"
              onClick={() => navigate_('reader', { rep: r.rep.id })}
            >
              <span className="rail-read-title ellipsis">{r.title}</span>
              <span className="rail-read-bar"><Bar value={r.pct} /></span>
              <span className="rail-read-pct mono">{Math.round(r.pct * 100)}%</span>
            </button>
          ))}
        </Card>

        <div className="rail-note">
          <span className="rail-note-mark">※</span>
          这一页只回答一个问题：今天该做什么。读书、检索、系统状态各有各的地方。
        </div>
      </aside>
    </div>
  );
}

export function InboxPage() {
  const { data, isLoading, error } = useInbox();
  const openSheet = useUi((s) => s.openSheet);
  const refresh = useRefresh();
  const batch = useBatch();

  if (isLoading) return <PageSkeleton rows={3} />;
  if (error) return <ErrorBox error={error} />;

  const notes = data?.notes ?? [];

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="行动 · 收件箱"
        title="收件箱"
        lede="未消化的碎片。想清楚了就衍生出去，别在这里堆——堆久了，这里就变成垃圾箱。"
        actions={
          <>
            <button className="btn btn-sm btn-quiet" onClick={() => refresh()}>刷新</button>
            <button className="btn btn-sm btn-primary" onClick={() => openSheet('capture')} data-testid="inbox-capture">
              <Icon name="plus" size={13} />
              采集一条
            </button>
          </>
        }
      />

      {notes.length === 0 ? (
        <Empty
          title="收件箱是空的"
          desc="这是好事——碎片都消化完了。有想法先进这里，别直接写成笔记。"
          action={<button className="btn" onClick={() => openSheet('capture')}>采集一条</button>}
        />
      ) : notes.map((n) => (
        <article key={n.id} className="entry">
          <div className="entry-main">
            <div className="entry-title">
              <input
                type="checkbox"
                checked={batch.has(n.id)}
                onChange={() => batch.toggle(n.id)}
                aria-label={`选择：${n.title}`}
                data-testid="inbox-pick"
              />
              <h3>{n.title}</h3>
              <span className="entry-kind">{NOTE_STATUS[n.status] ?? n.status}</span>
            </div>
            {n.body && <p className="entry-desc">{(n.body ?? '').slice(0, 180)}</p>}
          </div>
          <div className="entry-side">
            <div className="entry-actions">
              <button className="btn btn-sm btn-quiet" onClick={() => navigate('editor', { id: n.id })} data-testid="inbox-open">打开</button>
              <button
                className="btn btn-sm btn-primary"
                data-testid="inbox-derive"
                onClick={() => openSheet('derive', { srcId: n.id, title: `${n.title} · 我的理解` })}
              >
                衍生
              </button>
            </div>
          </div>
        </article>
      ))}

      <BatchBar ids={batch.ids} onDone={batch.clear} label="碎片" />
      {notes.length > 0 && (
        <p className="small muted" style={{ marginTop: 14, maxWidth: '62ch', lineHeight: 1.7 }}>
          衍生之后，收件箱里的原文仍然保留——它是你当时看到的原文，不是草稿。
        </p>
      )}
    </div>
  );
}

export function CalendarPage() {
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const refresh = useRefresh();
  const openSheet = useUi((s) => s.openSheet);
  const openPeek = useUi((s) => s.openPeek);
  const { data } = useObjects('event');
  const { data: actData } = useObjects('action');
  const [y, m] = month.split('-').map(Number);

  const events = (data?.objects ?? []) as unknown as EventRec[];
  const actions = (actData?.objects ?? []) as unknown as Action[];
  // 日历 = 日程（event）+ 排了时段的任务（[at::]）+ 只标了到期的任务。
  // 分组规则在 shared/calendar.ts，组件只管画。
  const byDay = useMemo(() => buildMonth(month, events, actions), [events, actions, month]);
  const total = [...byDay.values()].reduce((n, v) => n + v.blocks.length + v.due.length, 0);

  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // 周一开头
  const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="content-wide">
      <Card
        title="日程"
        desc="安排 = 计划在这个时间段做；到期任务也会标在日期里"
        actions={
          <>
            <button className="btn btn-sm btn-quiet cal-refresh" onClick={() => refresh()}>刷新</button>
            <span className="topbar-divider cal-refresh" />
            <button className="btn btn-sm btn-icon" onClick={() => setMonth(shift(month, -1))} aria-label="上个月">←</button>
            <input className="input cal-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="月份" />
            <button className="btn btn-sm btn-icon" onClick={() => setMonth(shift(month, 1))} aria-label="下个月">→</button>
            <button className="btn btn-sm btn-primary" onClick={() => openSheet('event', { date: `${month}-01` })} data-testid="cal-add">加日程</button>
          </>
        }
      >
        <div className="row small muted" style={{ gap: 14, marginBottom: 10, flexWrap: 'wrap' }}>
          <span className="row" style={{ gap: 5 }}><i className="cal-swatch" data-kind="event" />日程</span>
          <span className="row" style={{ gap: 5 }}><i className="cal-swatch" data-kind="task" />排期任务</span>
          <span className="row" style={{ gap: 5 }}><i className="cal-swatch" data-kind="due" />仅到期</span>
        </div>

        <div className="cal">
          {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
            <div key={d} className="cal-head">{d}</div>
          ))}
          {cells.map((d, i) => {
            const key = d ? `${month}-${String(d).padStart(2, '0')}` : '';
            const items = byDay.get(key) ?? { blocks: [], due: [] };
            const isToday = key === todayStr();
            return (
              <div
                key={i}
                className="cal-cell"
                data-today={isToday ? '1' : undefined}
                data-empty={d ? undefined : '1'}
                onClick={() => d && openSheet('event', { date: key })}
                data-testid={isToday ? 'cal-today' : undefined}
              >
                <span className="cal-day">{d ?? ''}</span>
                {items.blocks.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className="cal-item"
                    title={b.title}
                    data-testid="cal-block"
                    data-kind={b.kind === 'event' ? 'event' : 'task'}
                    onClick={(e) => { e.stopPropagation(); openPeek(b.id); }}
                  >
                    <span className="cal-item-time">{b.allDay ? '全天' : b.start}</span>
                    <span className="cal-item-title ellipsis">{b.title}</span>
                  </button>
                ))}
                {items.due.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="cal-item"
                    data-kind="due"
                    title={t.title}
                    data-testid="cal-due"
                    onClick={(e) => { e.stopPropagation(); openPeek(t.id); }}
                  >
                    <span className="cal-item-time">·</span>
                    <span className="cal-item-title ellipsis">{t.title}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>

        {total === 0 && (
          <p className="section-note">
            这个月还没有安排。点格子加日程；任务的 [at:: 14:00-15:30] 写好之后，也会在这里占一个时间块。
          </p>
        )}
      </Card>
    </div>
  );
}

function shift(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function ProjectsPage() {
  const { data, isLoading } = useProjects();
  const openSheet = useUi((s) => s.openSheet);
  const openPeek = useUi((s) => s.openPeek);
  if (isLoading) return <PageSkeleton rows={3} />;

  const projects = data?.projects ?? [];

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="行动 · 项目"
        title="项目"
        lede="项目要有终点：先写清楚「什么样子算完成」，再往里挂任务。"
        actions={
          <button className="btn btn-sm btn-primary" onClick={() => openSheet('project')} data-testid="project-add">
            <Icon name="plus" size={13} />
            新建项目
          </button>
        }
      />

      {projects.length === 0 ? (
        <Empty
          title="还没有项目"
          desc="项目 = 有一个想要的结果、需要多步才能达成的事。没有终点的，那是领域。"
          action={<button className="btn" onClick={() => openSheet('project')}>建一个</button>}
        />
      ) : projects.map((p) => {
        return (
          <article key={p.id} className="entry">
            <div className="entry-main">
              <div className="entry-title">
                <h3>
                  <button
                    type="button"
                    className="peekable"
                    onClick={() => openPeek(p.id)}
                    title="看项目详情"
                    data-testid="project-open"
                  >
                    {p.title}
                  </button>
                </h3>
                <span className="entry-stage" data-empty={p.state === 'active' ? '0' : '1'}>
                  {p.state === 'active' ? '进行中' : p.state}
                </span>
                {p.actions.length > 0 && (
                  <span className="entry-kind">{p.done}/{p.actions.length}</span>
                )}
              </div>
              {p.desc && <p className="entry-desc">{p.desc}</p>}
              {p.actions.length === 0 && <p className="entry-desc">还没挂任务</p>}

              {p.actions.length > 0 && (
                <div className="entry-body">
                  {p.actions.slice(0, 6).map((a) => (
                    <div key={a.id} className="task-line" data-done={a.state === 'done' ? '1' : '0'} data-nav-row={a.id}>
                      <span className="task-check">
                        {a.state === 'done' ? <Icon name="check" size={12} /> : null}
                      </span>
                      <button
                        type="button"
                        className="peekable part-title"
                        onClick={() => openPeek(a.id)}
                        title="看详情"
                        data-testid="project-task-open"
                      >
                        {a.text}
                      </button>
                      {a.due && <span className="task-date">{a.due}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="entry-side">
              <div className="entry-actions">
                <button className="btn btn-sm btn-quiet" onClick={() => openSheet('task', { projectId: p.id })} data-testid="project-add-task">
                  <Icon name="plus" size={12} />
                  加任务
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function AreasPage() {
  const { data, isLoading } = useObjects('area');
  if (isLoading) return <PageSkeleton rows={4} />;
  const areas = (data?.objects ?? []) as unknown as { id: string; title: string; standard?: string }[];
  return (
    <div className="content-wide">
      <PageHead
        eyebrow="行动 · 领域"
        title="领域"
        lede="领域是要长期维持的标准，不是项目——它没有终点。判断一件事该不该做，看它服务于哪个领域的标准。"
      />
      {areas.length === 0 ? (
        <Empty title="还没有领域" desc="领域描述的是「要维持成什么样」，比如「系统与工具 · 每周检查一次健康」" />
      ) : areas.map((a) => (
        <article key={a.id} className="entry">
          <div className="entry-main">
            <div className="entry-title"><h3>{a.title}</h3></div>
            <p className="entry-desc">{a.standard ?? '（还没写维护标准）'}</p>
          </div>
        </article>
      ))}
    </div>
  );
}

export function ReviewPage() {
  const { data, isLoading } = useToday();
  const openSheet = useUi((s) => s.openSheet);
  const { data: works } = useObjects('work');
  const refresh = useRefresh();
  if (isLoading) return <PageSkeleton rows={3} />;

  const items = [
    ...(works?.objects ?? []).slice(0, 5).map((w) => ({ id: (w as { id: string }).id, title: (w as { title: string }).title, kind: 'work' as const })),
  ];

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="行动 · 复盘"
        title="复盘"
        lede="回顾会被记成事件，生命周期的「回顾」闸门靠它。做完一次，这一轮才算走完。"
      />
      <Card>
        <ol>
          <li>收件箱清干净了吗？没清的就问一句：这一条我想要的结果是什么。</li>
          <li>过期任务要么重新安排，要么删掉。挂着不动的承诺等于没有承诺。</li>
          <li>每个在跑的项目，下一步动作是不是明确的？不明确的现在补。</li>
          <li>挑一篇读过的内容，做一次回顾。</li>
        </ol>
      </Card>

      <Card title="挑一条做回顾" desc="点了就记一次回顾事件">
        {items.length === 0
          ? <Empty title="库里还没有作品" desc="先去书架加一本" />
          : items.map((it) => (
            <div key={it.id} className="part">
              <span className="part-title ellipsis">{it.title}</span>
              <button className="btn btn-sm btn-quiet" data-testid="review-do" onClick={() => openSheet('review', { id: it.id, title: it.title })}>回顾</button>
            </div>
          ))}
      </Card>

      <Card title="今天还没做完" desc={`${data?.overdue.length ?? 0} 条过期 · ${data?.actions.length ?? 0} 条今天`}>
        {(data?.overdue ?? []).slice(0, 8).map((a) => (
          <div key={a.id} className="part">
            <span className="mono" style={{ color: 'var(--danger)', flex: 'none' }}>{a.due}</span>
            <span className="part-title ellipsis">{a.text}</span>
          </div>
        ))}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-sm btn-quiet" onClick={() => refresh()}>刷新</button>
        </div>
      </Card>
    </div>
  );
}
