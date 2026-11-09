/**
 * 对象 Peek：列表里的每一行点一下看这里。
 * 不换页是刻意的——判断「这条要不要现在做」的时候，上下文一丢就得重来。
 * Esc 收起，点关联条目在原地换一个对象，不叠罗汉。
 */
import { useEffect, useMemo, useState } from 'react';
import { useUi } from './ui.ts';
import { useObject, useRefresh } from '../services/use.ts';
import { endpoints, type ObjectLinkView } from '../services/api.ts';
import { navigate, openPeek, closePeek, useLocation } from './router.ts';
import { Spinner, ErrorBox } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';

const KIND_LABEL: Record<string, string> = {
  action: '任务', event: '日程', note: '笔记', part: '章节',
  work: '作品', project: '项目', area: '领域', rep: '载体', annotation: '批注',
};

const STATE_LABEL: Record<string, string> = {
  open: '待办', doing: '进行中', blocked: '卡住', done: '已完成',
  active: '进行中', someday: '以后', dropped: '已放弃',
  seedling: '碎片', growing: '生长中', evergreen: '定稿',
};

const FLOW_LABEL: Record<string, string> = { now: '现在做', next: '接着做', later: '以后做' };

const ACTOR_LABEL = (a: string) =>
  a === 'human' ? '你' : a.startsWith('agent:') ? a.slice(6) : a === 'system' ? '系统' : '外部';

const today = () => new Date().toISOString().slice(0, 10);

export function ObjectPeek() {
  const loc = useLocation();
  const peekId = loc.params.peek ?? null;
  const toast = useUi((s) => s.toast);
  const refresh = useRefresh();
  const { data, isLoading, error } = useObject(peekId);
  const [busy, setBusy] = useState(false);
  // 每类默认只露 10 条，点一下展开。整本书 24 章全铺开，任务就被挤到看不见的地方了
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const out: { rel: string; items: ObjectLinkView[] }[] = [];
    for (const l of data?.links ?? []) {
      const last = out[out.length - 1];
      if (last && last.rel === l.rel) last.items.push(l);
      else out.push({ rel: l.rel, items: [l] });
    }
    return out;
  }, [data?.links]);

  useEffect(() => {
    if (!peekId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closePeek();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [peekId, closePeek]);

  if (!peekId) return null;

  const o = data?.object;
  const isTask = o?.type === 'action';
  const done = o?.state === 'done';

  async function patch(p: Record<string, unknown>, reason: string) {
    if (!peekId) return;
    setBusy(true);
    try {
      const { changeset } = await endpoints.propose([{ t: 'update', id: peekId, patch: p }], reason);
      const r = await endpoints.commit(changeset.id);
      if (!r.ok) throw new Error('刚被别处改过，刷新后再试');
      toast('已保存', 'ok');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  /** 关联条目点进去要「到那儿」，不是再看一层卡片——手机上尤其明显，点完像没反应 */
  async function openRelated(id: string) {
    let ob: { id: string; type: string; workId?: string } | undefined;
    try {
      const d = await endpoints.object(id);
      // 章节对象在运行时带 workId（类型里没声明），没有它就只能落到书架
      ob = d.object as unknown as { id: string; type: string; workId?: string };
    } catch {
      ob = undefined;
    }
    if (!ob) return;
    // 先关面板再跳：closePeek 会按「当前 URL」重写 hash，
    // 放在 navigate 之后会把刚设好的路由又盖回原来那页。
    closePeek();
    if (ob.type === 'note') navigate('reader', { note: ob.id });
    else if (ob.type === 'part') {
      if (ob.workId) navigate('reader', { work: ob.workId, part: ob.id });
      else navigate('shelf');
    } else if (ob.type === 'rep') navigate('reader', { rep: ob.id });
    else if (ob.type === 'work') navigate('reader', { work: ob.id });
    else if (ob.type === 'project') navigate('projects');
    else if (ob.type === 'event') navigate('calendar');
    else openPeek(id);
  }

  function openFull() {
    if (!o) return;
    // 章节和载体要落到阅读器的那一章，不能停在书架上——「打开全文」的意义就是少走两步
    if (o.type === 'note') navigate('reader', { note: o.id });
    else if (o.type === 'part') {
      const wid = (o as { workId?: string }).workId;
      // 带上 part：同一部书 24 章，不带章节就只能落到第一章，点了等于没点
      if (wid) navigate('reader', { work: wid, part: o.id });
      else navigate('shelf');
    }
    else if (o.type === 'rep') navigate('reader', { rep: o.id });
    else if (o.type === 'work') navigate('reader', { work: o.id });
    else if (o.type === 'project') navigate('projects');
    else if (o.type === 'event') navigate('calendar');
    closePeek();
  }

  const title = o?.text ?? o?.title ?? o?.slug ?? '';

  return (
    <div
      className="overlay overlay-right"
      onClick={closePeek}
      data-testid="object-peek"
      // 高于移动端底栏（250）与抽屉（290）：面板不能在手机上被导航条压住
      style={{ background: 'rgba(0,0,0,0.18)', zIndex: 300 }}
    >
      <div
        className="sheet sheet-drawer peek"
        role="dialog"
        aria-modal="true"
        aria-label={title || '对象详情'}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="peek-head">
          <div className="peek-head-row">
            <span className="peek-kind">{KIND_LABEL[o?.type ?? ''] ?? o?.type ?? ''}</span>
            {o?.state && <span className="peek-state" data-state={o.state}>{STATE_LABEL[o.state] ?? o.state}</span>}
            <span className="spacer" />
            <button className="btn btn-sm btn-quiet btn-icon" onClick={closePeek} aria-label="关闭" data-testid="peek-close">
              <Icon name="close" size={15} />
            </button>
          </div>
          <h2 className="peek-title">{title || (isLoading ? '读取中…' : '对象')}</h2>
          {data?.path && <div className="peek-sub mono" title={data.path}>{data.path}</div>}
        </header>

        <div className="peek-body">
          {isLoading && <Spinner />}
          {error && <ErrorBox error={error as Error} />}

          {o && (
            <>
              <dl className="peek-meta">
                {o.due !== undefined && <div><dt>到期</dt><dd className="mono">{o.due || '没定'}</dd></div>}
                {o.scheduled && <div><dt>安排</dt><dd className="mono">{o.scheduled[0]}–{o.scheduled[1]}</dd></div>}
                {o.start && <div><dt>时间</dt><dd className="mono">{o.start.slice(11, 16)}–{(o.end ?? o.start).slice(11, 16)}</dd></div>}
                {o.flow && <div><dt>推进</dt><dd>{FLOW_LABEL[o.flow] ?? o.flow}</dd></div>}
                {o.status && <div><dt>成熟度</dt><dd>{STATE_LABEL[o.status] ?? o.status}</dd></div>}
                {o.sourceUrl && (
                  <div>
                    <dt>原文</dt>
                    <dd>
                      <a href={o.sourceUrl} target="_blank" rel="noreferrer noopener" className="small" data-testid="peek-source">
                        打开原始链接 ↗
                      </a>
                    </dd>
                  </div>
                )}
              </dl>

              {o.summary && <p className="peek-summary">{o.summary}</p>}

              {!!data?.links.length && (
                <section className="peek-sec">
                  <h3 className="peek-sec-head">
                    资料与关联
                    <span className="peek-sec-n">{data.links.length}</span>
                  </h3>
                  {/*
                    按类分组：24 条资料如果每条都重复一个「资料」标签，等于把列宽喂给了噪音。
                    组头写一次就够了，条目只留标题和类型。
                  */}
                  {groups.map((g) => {
                    const open = expanded[g.rel] ?? g.items.length <= 10;
                    const shown = open ? g.items : g.items.slice(0, 10);
                    const isMaterial = g.rel === '资料' || g.rel === '项目资料';
                    return (
                      <div key={g.rel}>
                        <div className="peek-rel" data-material={isMaterial ? '1' : '0'}>
                          <span>{g.rel}</span>
                          <span className="peek-rel-n">{g.items.length}</span>
                          {g.items.length > 10 && (
                            <button
                              className="btn btn-sm btn-quiet"
                              onClick={() => setExpanded((s) => ({ ...s, [g.rel]: !open }))}
                              data-testid="peek-expand"
                            >
                              {open ? '收起' : `展开 ${g.items.length - 10} 条`}
                            </button>
                          )}
                        </div>
                        {shown.map((l) => (
                          <button
                            key={`${l.rel}-${l.id}`}
                            className="peek-link"
                            onClick={() => void openRelated(l.id)}
                            title={`${l.rel} · ${l.kind}`}
                            data-testid="peek-link"
                            data-rel={l.rel}
                          >
                            <span className="ellipsis">{l.title}</span>
                            <span className="peek-link-kind">{KIND_LABEL[l.kind] ?? ''}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </section>
              )}

              <section className="peek-sec">
                <h3 className="peek-sec-head">
                  {isTask ? '任务池最近变动' : '最近变动'}
                  <span className="peek-sec-n">{data?.events.length ?? 0}</span>
                </h3>
                {isTask && (
                  <p className="section-note" style={{ margin: '0 0 6px' }}>
                    任务都存在同一个文件里，这里显示的是该文件的改动，不一定是这一条。
                  </p>
                )}
                {data?.events.length ? (
                  <div className="peek-evs">
                    {data.events.map((e) => (
                      <div key={e.id} className="peek-ev">
                        <span className="mono peek-ev-time">{e.at.slice(5, 16).replace('T', ' ')}</span>
                        <span className="peek-ev-actor">{ACTOR_LABEL(e.actor)}</span>
                        <span className="ellipsis">{e.summary || e.op}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="section-note" style={{ margin: 0 }}>还没有留下变动记录。</p>
                )}
              </section>
            </>
          )}
        </div>

        <footer className="peek-foot">
          <span className="peek-hint">J/K 换一条 · Space 收起 · Esc 关闭</span>
          {isTask && (
            <>
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void patch({ state: done ? 'open' : 'done' }, done ? '重新打开任务' : '完成任务')}
                data-testid="peek-toggle-done"
              >
                {done ? '重新打开' : '完成'}
              </button>
              <button
                className="btn btn-sm"
                disabled={busy || o?.due === today()}
                onClick={() => void patch({ due: today() }, '改到今天')}
                data-testid="peek-today"
              >
                改到今天
              </button>
              <button
                className="btn btn-sm btn-quiet"
                disabled={busy || !o?.due}
                onClick={() => {
                  const d = new Date(o!.due!);
                  d.setDate(d.getDate() + 1);
                  void patch({ due: d.toISOString().slice(0, 10) }, '顺延一天');
                }}
              >
                顺延一天
              </button>
            </>
          )}
          <span className="spacer" />
          <button
            className="btn btn-sm btn-quiet"
            disabled={busy || !o}
            onClick={() => void patch({ archivedAt: new Date().toISOString() }, '归档')}
            title="归档不是删除，文件还在"
          >
            归档
          </button>
          {o && o.type !== 'action' && (
            <button className="btn btn-sm btn-primary" onClick={openFull}>
              打开全文
              <Icon name="arrow" size={13} />
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
