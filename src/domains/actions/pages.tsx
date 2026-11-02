/** 行动域：承诺(due)、安排(scheduled)、推进(now/next/later) 三个字段分开，不混成「待办」 */
import { useMemo, useState } from 'react';
import { Card, Stat, Chip, Empty, Spinner, ErrorBox, Bar, todayStr } from '../../components/ui.tsx';
import { useToday, useInbox, useProjects, useObjects, useRefresh, useActions } from '../../services/use.ts';
import { endpoints } from '../../services/api.ts';
import { useUi } from '../../app/ui.ts';
import { BatchBar, useBatch } from '../../components/batch.tsx';
import { StewardCard } from './StewardCard.tsx';
import { navigate } from '../../app/router.ts';
import type { ActionView } from '../../services/api.ts';
import { buildMonth } from '../../../shared/calendar.ts';
import type { Action, EventRec } from '../../../shared/types.ts';

type ActivityAction = ActionView;

const FLOW_LABEL: Record<string, string> = { now: '现在做', next: '接着做', later: '以后做' };

function ActionRow({ a, onDone }: { a: ActionView; onDone: () => void }) {
  const refresh = useRefresh();
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const overdue = a.due && a.due < todayStr() && a.state !== 'done';

  async function next() {
    setBusy(true);
    try {
      await endpoints.propose([{ t: 'update', id: a.id, patch: { state: a.state === 'done' ? 'open' : 'done' } }], `改任务状态：${a.text.slice(0, 16)}`);
      const r = await endpoints.commit((await endpoints.changes()).changesets[0].id);
      if (!r.ok) throw new Error('撞车了，请刷新重试');
      toast(a.state === 'done' ? '已重新打开' : '已完成', 'ok');
      refresh();
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <input
        type="checkbox"
        checked={a.state === 'done'}
        disabled={busy}
        aria-label={`完成：${a.text}`}
        data-testid="action-toggle"
        onChange={() => void next()}
      />
      <span style={{ flex: 1, textDecoration: a.state === 'done' ? 'line-through' : undefined }} className="ellipsis">
        {a.text}
      </span>
      {a.due && <Chip tone={overdue ? 'danger' : ''}>{a.due}{overdue ? ' 已过期' : ''}</Chip>}
      <Chip>{FLOW_LABEL[a.flow] ?? a.flow}</Chip>
      {a.state === 'blocked' && <Chip tone="warn">卡住</Chip>}
    </div>
  );
}

export function TodayPage() {
  const { data, isLoading, error, refetch } = useToday();
  const { data: allActions } = useActions();
  const toast = useUi((s) => s.toast);
  const openSheet = useUi((s) => s.openSheet);
  const openAi = useUi((s) => s.openAi);
  const refresh = useRefresh();

  /** 不想等到那天就先挪到今天；本质是改 due，不是新建 */
  async function moveToToday(a: ActivityAction) {
    const today = new Date().toISOString().slice(0, 10);
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

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  return (
    <div className="content-wide">
      <div className="grid" style={{ marginBottom: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Stat num={data.actions.length} label="今天要做" />
        <Stat num={data.overdue.length} label="已过期" hint="due 早于今天" />
        <Stat num={data.events.length} label="今天的安排" />
        <Stat num={data.reading.length} label="读到一半" />
        {/* 未来任务不算「今天」，但第一屏全 0 会让人以为库里什么都没建 */}
        <Stat num={allActions?.actions.length ?? 0} label="全部待办" hint="含未来" />
      </div>

      <StewardCard />

      <Card
        title="今天"
        desc={todayStr()}
        actions={
          <>
            <button className="btn btn-sm" onClick={() => openSheet('task', { flow: 'now' })} data-testid="today-add-task">加任务</button>
            <button className="btn btn-sm" onClick={() => openSheet('event')}>加日程</button>
            <button className="btn btn-sm" onClick={() => openAi({ kind: 'none', id: '', title: '今天' })}>问助手</button>
          </>
        }
      >
        {data.actions.length === 0
          ? <Empty title="今天没有安排" desc="从收件箱挑一条，或者直接加一件要做的事" action={<button className="btn" onClick={() => openSheet('task', { flow: 'now' })}>加一件</button>} />
          : data.actions.map((a) => <ActionRow key={a.id} a={a} onDone={() => refresh()} />)}
      </Card>

      {data.overdue.length > 0 && (
        <Card title="过期了" desc="要么改日期，要么删掉——挂着只会让人麻木">
          {data.overdue.map((a) => (
            <div key={a.id} className="row" style={{ padding: '6px 0' }}>
              <Chip tone="danger">{a.due}</Chip>
              <span className="ellipsis" style={{ flex: 1 }}>{a.text}</span>
              <button className="btn btn-sm" onClick={() => openSheet('task', { text: a.text, due: todayStr() })}>改到今天</button>
            </div>
          ))}
        </Card>
      )}

      <Card title="今天的安排" desc="安排和到期是两件事，别混">
        {data.events.length === 0
          ? <div className="small muted">今天没有日程。</div>
          : data.events.map((e) => (
            <div key={e.id} className="row" style={{ padding: '6px 0' }}>
              <span className="mono">{e.start.slice(11, 16)}–{e.end.slice(11, 16)}</span>
              <span style={{ flex: 1 }}>{e.title}</span>
            </div>
          ))}
      </Card>

      {(() => {
        // 今天页原来只显示「今天到期」和「已逾期」，未来的任务在界面上彻底消失。
        // 这里按日期把它们摊开：7 天内、更远、没有日期。
        const today = new Date().toISOString().slice(0, 10);
        const soon = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
        const future = (allActions?.actions ?? []).filter((a) => a.state !== 'done' && a.due && a.due > today);
        const undated = (allActions?.actions ?? []).filter((a) => a.state !== 'done' && !a.due);
        const in7 = future.filter((a) => a.due! <= soon);
        const later = future.filter((a) => a.due! > soon);
        if (!future.length && !undated.length) return null;
        const Row = ({ a }: { a: ActivityAction }) => (
          <div className="row row-wrap" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }} data-testid="upcoming-row">
            <span className="small muted mono" style={{ width: 84 }}>{a.due ?? '无日期'}</span>
            <span style={{ flex: 1, minWidth: 0 }}>{a.text}</span>
            {a.projectId ? <Chip tone="info">项目任务</Chip> : null}
            <button className="btn btn-sm" onClick={() => void moveToToday(a)} data-testid="upcoming-today">改到今天</button>
          </div>
        );
        return (
          <>
            {in7.length > 0 && (
              <Card title="接下来 7 天" desc={`${in7.length} 条`} data-testid="upcoming-7">
                {in7.map((a) => <Row key={a.id} a={a} />)}
              </Card>
            )}
            {later.length > 0 && (
              <Card title="更远" desc={`${later.length} 条；不在今天页里，但一直存在`} data-testid="upcoming-later">
                {later.map((a) => <Row key={a.id} a={a} />)}
              </Card>
            )}
            {undated.length > 0 && (
              <Card title="没有日期" desc={`${undated.length} 条；没有截止日就不会出现在「今天」`} data-testid="undated">
                {undated.map((a) => <Row key={a.id} a={a} />)}
              </Card>
            )}
          </>
        );
      })()}

      <Card title="继续读" desc="按读到哪儿排序，回看不会把最远位置清掉">
        {data.reading.length === 0
          ? <Empty title="没有在读的条目" desc="去书架挑一章" action={<button className="btn" onClick={() => navigate('shelf')}>打开书架</button>} />
          : data.reading.map((r) => (
            <div key={r.rep.id} className="row" style={{ padding: '6px 0' }}>
              <span className="ellipsis" style={{ flex: 1 }}>{r.title}</span>
              <div style={{ width: 120 }}><Bar value={r.pct} /></div>
              <span className="small mono" style={{ width: 42, textAlign: 'right' }}>{Math.round(r.pct * 100)}%</span>
              <button className="btn btn-sm" onClick={() => navigate('reader', { rep: r.rep.id })}>继续</button>
            </div>
          ))}
      </Card>
    </div>
  );
}

export function InboxPage() {
  const { data, isLoading, error } = useInbox();
  const openSheet = useUi((s) => s.openSheet);
  const refresh = useRefresh();
  const batch = useBatch();

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  return (
    <div className="content-wide">
      <Card
        title="收件箱"
        desc="未消化的碎片。想清楚了就衍生出去，别在这里堆"
        actions={<button className="btn btn-sm btn-primary" onClick={() => openSheet('capture')} data-testid="inbox-capture">采集一条</button>}
      >
        {!data?.notes.length
          ? <Empty title="收件箱是空的" desc="这是好事——碎片都消化完了" action={<button className="btn" onClick={() => openSheet('capture')}>采集一条</button>} />
          : data.notes.map((n) => (
            <div key={n.id} className="card" style={{ marginBottom: 8 }}>
              <div className="row">
                <input
                  type="checkbox"
                  checked={batch.has(n.id)}
                  onChange={() => batch.toggle(n.id)}
                  aria-label={`选择：${n.title}`}
                  data-testid="inbox-pick"
                />
                <strong>{n.title}</strong>
                <Chip>{n.status === 'seedling' ? '未消化' : n.status}</Chip>
                <span className="spacer" />
                <button className="btn btn-sm" onClick={() => navigate('editor', { id: n.id })} data-testid="inbox-open">打开</button>
                <button
                  className="btn btn-sm btn-primary"
                  data-testid="inbox-derive"
                  onClick={() => openSheet('derive', { srcId: n.id, title: `${n.title} · 我的理解` })}
                >
                  衍生
                </button>
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>{(n.body ?? '').slice(0, 160)}</div>
            </div>
          ))}
      </Card>
      <BatchBar ids={batch.ids} onDone={batch.clear} label="碎片" />
      <div className="small muted" style={{ marginTop: 8 }}>
        衍生之后，收件箱里的原文仍然保留——它是你当时看到的原文，不是草稿。
        <button className="btn btn-sm btn-ghost" onClick={() => refresh()}>刷新</button>
      </div>
    </div>
  );
}

export function CalendarPage() {
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const refresh = useRefresh();
  const openSheet = useUi((s) => s.openSheet);
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
            <button className="btn btn-sm" onClick={() => setMonth(shift(month, -1))}>←</button>
            <input className="input" type="month" value={month} style={{ width: 140 }} onChange={(e) => setMonth(e.target.value)} />
            <button className="btn btn-sm" onClick={() => setMonth(shift(month, 1))}>→</button>
            <button className="btn btn-sm btn-primary" onClick={() => openSheet('event', { date: `${month}-01` })} data-testid="cal-add">加日程</button>
          </>
        }
      >
        <div className="row small muted" style={{ gap: 14, marginBottom: 8 }}>
          <span><Chip tone="info">09:00</Chip> 日程</span>
          <span><Chip tone="accent">14:00</Chip> 排期任务</span>
          <span>
            <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 9, background: 'var(--text-3)', marginRight: 5, verticalAlign: 'middle' }} />
            仅到期
          </span>
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
          {['一', '二', '三', '四', '五', '六', '日'].map((d) => (
            <div key={d} className="small muted" style={{ textAlign: 'center', padding: 4 }}>{d}</div>
          ))}
          {cells.map((d, i) => {
            const key = d ? `${month}-${String(d).padStart(2, '0')}` : '';
            const items = byDay.get(key) ?? { blocks: [], due: [] };
            const isToday = key === todayStr();
            return (
              <div
                key={i}
                onClick={() => d && openSheet('event', { date: key })}
                data-testid={isToday ? 'cal-today' : undefined}
                style={{
                  minHeight: 78, minWidth: 0, overflow: 'hidden', padding: 6, borderRadius: 6, cursor: d ? 'pointer' : 'default',
                  border: isToday ? '2px solid var(--accent)' : '1px solid var(--border)',
                  background: d ? 'var(--surface-2)' : 'transparent',
                }}
              >
                <div className="small muted">{d ?? ''}</div>
                {items.blocks.map((b) => (
                  <div key={b.id} className="small ellipsis" style={{ marginTop: 2 }} title={b.title} data-testid="cal-block">
                    <Chip tone={b.kind === 'event' ? 'info' : 'accent'}>{b.allDay ? '全天' : b.start}</Chip> {b.title}
                  </div>
                ))}
                {items.due.map((t) => (
                  <div key={t.id} className="small ellipsis" style={{ marginTop: 2, color: 'var(--text-2)' }} title={t.title} data-testid="cal-due">
                    <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 9, background: 'var(--text-3)', marginRight: 5, verticalAlign: 'middle' }} />
                    {t.title}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {total === 0 && (
          <div className="small muted" style={{ marginTop: 10 }}>
            这个月还没有安排。点格子加日程；任务的 [at:: 14:00-15:30] 写好之后，也会在这里占一个时间块。
          </div>
        )}
      </Card>
      <div className="row"><button className="btn btn-sm" onClick={() => refresh()}>刷新</button></div>
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
  if (isLoading) return <Spinner />;

  return (
    <div className="content-wide">
      <Card
        title="项目"
        desc="项目要有终点：写出「什么样子算完成」"
        actions={<button className="btn btn-sm btn-primary" onClick={() => openSheet('project')} data-testid="project-add">新建项目</button>}
      >
        {!data?.projects.length
          ? <Empty title="还没有项目" desc="项目 = 有一个想要的结果、需要多步才能达成的事" action={<button className="btn" onClick={() => openSheet('project')}>建一个</button>} />
          : data.projects.map((p) => (
            <div key={p.id} className="card" style={{ marginBottom: 8 }}>
              <div className="row">
                <strong>{p.title}</strong>
                <Chip tone={p.state === 'active' ? 'ok' : ''}>{p.state}</Chip>
                <span className="spacer" />
                <span className="small muted">
                  {p.actions.length === 0 ? '还没挂任务' : `${p.done}/${p.actions.length} 完成`}
                </span>
                <button className="btn btn-sm" onClick={() => openSheet('task', { projectId: p.id })} data-testid="project-add-task">加任务</button>
              </div>
              {p.desc && <div className="small muted" style={{ marginTop: 4 }}>{p.desc}</div>}
              {p.actions.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <Bar value={p.actions.length ? p.done / p.actions.length : 0} />
                  {p.actions.slice(0, 6).map((a) => (
                    <div key={a.id} className="row small" style={{ padding: '3px 0' }}>
                      <span>{a.state === 'done' ? '✓' : '·'}</span>
                      <span className="ellipsis" style={{ flex: 1 }}>{a.text}</span>
                      {a.due && <span className="muted">{a.due}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
      </Card>
    </div>
  );
}

export function AreasPage() {
  const { data, isLoading } = useObjects('area');
  if (isLoading) return <Spinner />;
  const areas = (data?.objects ?? []) as unknown as { id: string; title: string; standard?: string }[];
  return (
    <div className="content-wide">
      <Card title="领域" desc="领域是要长期维持的标准，不是项目——它没有终点">
        {areas.length === 0
          ? <Empty title="还没有领域" desc="领域描述的是「要维持成什么样」，比如「系统与工具 · 每周检查一次健康」" />
          : areas.map((a) => (
            <div key={a.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <strong>{a.title}</strong>
              <span className="small muted" style={{ flex: 1 }}>{a.standard ?? '（还没写维护标准）'}</span>
            </div>
          ))}
      </Card>
      <div className="small muted" style={{ marginTop: 8 }}>
        领域的意义在于：项目会结束，领域不会。判断一件事该不该做，看它服务于哪个领域的标准。
      </div>
    </div>
  );
}

export function ReviewPage() {
  const { data, isLoading } = useToday();
  const openSheet = useUi((s) => s.openSheet);
  const { data: works } = useObjects('work');
  const refresh = useRefresh();
  if (isLoading) return <Spinner />;

  const items = [
    ...(works?.objects ?? []).slice(0, 5).map((w) => ({ id: (w as { id: string }).id, title: (w as { title: string }).title, kind: 'work' as const })),
  ];

  return (
    <div className="content-wide">
      <Card title="复盘" desc="回顾会被记成事件，生命周期的「回顾」闸门靠它">
        <ol style={{ paddingLeft: '1.4em' }}>
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
            <div key={it.id} className="row" style={{ padding: '6px 0' }}>
              <span className="ellipsis" style={{ flex: 1 }}>{it.title}</span>
              <button className="btn btn-sm" data-testid="review-do" onClick={() => openSheet('review', { id: it.id, title: it.title })}>回顾</button>
            </div>
          ))}
      </Card>

      <Card title="今天还没做完" desc={`${data?.overdue.length ?? 0} 条过期 · ${data?.actions.length ?? 0} 条今天`}>
        {(data?.overdue ?? []).slice(0, 8).map((a) => (
          <div key={a.id} className="row small" style={{ padding: '3px 0' }}>
            <Chip tone="danger">{a.due}</Chip>
            <span className="ellipsis" style={{ flex: 1 }}>{a.text}</span>
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn btn-sm" onClick={() => refresh()}>刷新</button>
        </div>
      </Card>
    </div>
  );
}
