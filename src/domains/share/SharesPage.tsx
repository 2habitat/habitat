/**
 * 分享（抽印本）管理页。
 *
 * 这一页要同时回答三个问题，所以它不是一个「列表 + 弹窗」：
 *   1. 我公开了哪些东西？（白名单是唯一的事实，要能逐项看清）
 *   2. 外面有人在读吗？（近 14 天的小柱线 + 逐内容访问）
 *   3. 现在能不能收回？（暂停 / 换链接 / 到期 / 归档，都在同一屏里）
 *
 * 视觉上沿用档案体系：衬线做标题、等宽做数据、只画发丝线。
 * 每一行右侧的细柱是这 14 天的访问量——它是这一页唯一的图形元素，用来把数字和形状对上。
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  PageHead, StatBand, Chip, Empty, PageSkeleton, ErrorBox, Sheet, Overlay, Field, Spinner,
} from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
import { useShares, useShareOptions, useRefresh } from '../../services/use.ts';
import { endpoints, ApiError, type ShareView } from '../../services/api.ts';
import { toast } from '../../app/ui.ts';

const STATE_TEXT: Record<string, { label: string; tone: '' | 'ok' | 'warn' | 'danger' | 'info' }> = {
  ok: { label: '进行中', tone: 'ok' },
  paused: { label: '已暂停', tone: 'warn' },
  expired: { label: '已到期', tone: '' },
  missing: { label: '已收回', tone: 'danger' },
};


/** 一行说清「公开了什么」。空的一份要说「没有内容」，别留白让人以为还在加载 */
function scopeLine(c: ShareView['counts']): string {
  const bits: string[] = [];
  if (c.works > 0) bits.push(`${c.works} 本书 · ${c.chapters} 章`);
  if (c.collections > 0) bits.push(`${c.collections} 个专题`);
  if (c.notes > 0) bits.push(`${c.notes} 篇笔记`);
  return bits.length ? bits.join(' · ') : '没有内容';
}

function dayLabel(d: string): string {
  const [, m, dd] = d.split('-');
  return `${Number(m)}/${Number(dd)}`;
}

function timeLabel(iso: string | null | undefined): string {
  if (!iso) return '还没有人来过';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return iso.slice(0, 10).replace(/-/g, '.');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文（http://内网IP）没有 clipboard API，退回到老办法
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/* ---------------- 页 ---------------- */

export function SharesPage() {
  const { data, isLoading, error, refetch, isFetching } = useShares();
  const refresh = useRefresh();
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ShareView | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const shares = data?.shares ?? [];
  const totals = data?.totals;

  const act = async (key: string, fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(key);
    try {
      await fn();
      await refresh();
      toast(ok, 'ok');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String((e as Error).message), 'err');
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) return <PageSkeleton rows={3} ledger />;
  if (error) return <ErrorBox error={error} onRetry={() => void refetch()} />;

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="连接 · 分享"
        title="分享"
        lede="把选中的书、专题、笔记抽成一册，交给一个只读链接。外部浏览器打开就能读，不用账号；链接可随时收回。"
        actions={
          <>
            <button className="btn btn-sm btn-quiet" onClick={() => void refetch()} disabled={isFetching}>
              <Icon name="review" size={13} />
              刷新数据
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')} data-testid="share-new">
              <Icon name="plus" size={13} />
              新建分享
            </button>
          </>
        }
      />

      {totals && (
        <StatBand
          items={[
            { num: totals.active, label: '进行中的分享', hint: '没暂停、没过期、没归档' },
            { num: totals.views7, label: '近 7 日阅读', hint: '所有分享加起来的页面访问' },
            { num: totals.visitors7, label: '近 7 日访客', hint: '按浏览器去重，不是精确人数' },
            { num: timeLabel(totals.lastAt), label: '最近一次访问' },
          ]}
        />
      )}

      {data?.baseUrlHint && (
        <div className="notice" data-testid="share-base-hint">
          <strong>链接目前是本机地址</strong>
          <span>
            外网读者打不开 <code>{data.baseUrl}</code>。要给出可用的地址，启动服务时设
            <code>HABITAT_PUBLIC_URL=https://你的域名</code>（或走反向隧道）。下面每条链接都按这个前缀生成。
          </span>
        </div>
      )}

      {shares.length === 0 ? (
        <Empty
          title="还没有分享"
          desc="分享不是把整库公开：你只选要抽出去的那几样，其余连标题都不会出现在外面。"
          action={<button className="btn btn-primary" onClick={() => setEditing('new')}>新建第一个分享</button>}
        />
      ) : (
        <div className="share-list" data-testid="share-list">
          {shares.map((s) => {
            const st = STATE_TEXT[s.state] ?? STATE_TEXT.missing;
            const open = openId === s.id;
            const stats = s.stats;
            const max = Math.max(1, ...(stats?.series.map((x) => x.views) ?? [1]));
            const copyKey = `copy-${s.id}`;
            return (
              <article key={s.id} className="share-row" data-open={open ? '1' : '0'} data-state={s.state}>
                <div className="share-main">
                  <div className="share-title">
                    <button
                      className="share-toggle"
                      onClick={() => setOpenId(open ? null : s.id)}
                      aria-expanded={open}
                      aria-controls={`share-body-${s.id}`}
                    >
                      <Icon name="chevron" size={14} className={open ? 'rot-90' : ''} />
                      <span className="sr">{open ? '收起' : '展开'}「{s.title}」</span>
                    </button>
                    <h3>{s.title}</h3>
                    <Chip tone={st.tone}>{st.label}</Chip>
                    {s.expiresAt && s.state === 'ok' && (
                      <span className="share-kind">至 {s.expiresAt.slice(0, 10).replace(/-/g, '.')}</span>
                    )}
                  </div>
                  <p className="share-targets">
                    {/* 拼成一句话再描：伪元素分隔符在 flex 里左右间距容易被吃掉 */}
                    <span className="share-scope">{scopeLine(s.counts)}</span>
                    <span className="share-updated">改于 {timeLabel(s.updatedAt)}</span>
                  </p>
                </div>

                {/* 唯一的图形：近 14 天访问。柱高就是相对量，读数字之前先看出形状 */}
                <div
                  className="share-spark"
                  role="img"
                  aria-label={`近 14 天访问 ${stats?.last30 ?? 0} 次，今日 ${stats?.today ?? 0} 次`}
                  title={`近 7 日 ${stats?.last7 ?? 0} 次 · 独立访客 ${stats?.unique ?? 0}`}
                >
                  {(stats?.series ?? []).slice(-14).map((p) => (
                    <i
                      key={p.d}
                      data-zero={p.views === 0 ? '1' : '0'}
                      style={{ height: `${Math.max(2, Math.round((p.views / max) * 100))}%` }}
                      title={`${dayLabel(p.d)} · ${p.views} 次`}
                    />
                  ))}
                </div>

                <div className="share-side">
                  <span className="share-count" title={`近 7 日 ${stats?.last7 ?? 0} 次 · 累计 ${stats?.total ?? 0} 次`}>
                    <b>{stats?.last7 ?? 0}</b>
                    <span className="share-count-total">{`/ ${stats?.total ?? 0}`}</span>
                  </span>
                  <div className="share-actions">
                    {/* 打开是这一行最常用的动作，常显；次要动作（设置）才收起来 */}
                    <a className="btn btn-sm" href={s.url} target="_blank" rel="noreferrer noopener">
                      打开
                    </a>
                    <button
                      className="btn btn-sm btn-quiet"
                      disabled={busy === copyKey}
                      onClick={() => void act(copyKey, async () => {
                        const ok = await copyText(s.url);
                        if (!ok) throw new Error('这个浏览器不让写剪贴板，请手动复制地址栏里的链接');
                      }, '链接已复制')}
                    >
                      复制链接
                    </button>
                    <button className="btn btn-sm btn-quiet" onClick={() => setEditing(s)} data-testid={`share-edit-${s.id}`}>
                      设置
                    </button>
                  </div>
                </div>

                {open && (
                  <div className="share-body" id={`share-body-${s.id}`}>
                    <ShareDetail
                      share={s}
                      busy={busy}
                      onAct={act}
                      onEdit={() => setEditing(s)}
                      onArchive={async () => {
                        if (!window.confirm(`归档「${s.title}」？链接会立刻失效，统计与文件都保留。`)) return;
                        await act(`arch-${s.id}`, () => endpoints.archiveShare(s.id), '已收回这个分享');
                        setOpenId(null);
                      }}
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      <section className="section">
        <p className="section-note">
          分享是「抽出去的一册」：内容仍以空间里的原件为准，这里只控制谁看得到、能看到哪几样。
          链接本身就是权限——换了链接，旧地址立即失效。
        </p>
      </section>

      {editing && (
        <Overlay onClose={() => setEditing(null)}>
          <ShareEditor
            initial={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await refresh();
            }}
          />
        </Overlay>
      )}
    </div>
  );
}

/* ---------------- 展开后的详情 ---------------- */

function ShareDetail({ share, busy, onAct, onEdit, onArchive }: {
  share: ShareView;
  busy: string | null;
  onAct: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
  onEdit: () => void;
  onArchive: () => Promise<void>;
}) {
  const stats = share.stats;
  const hasCollection = share.counts.collections > 0;
  const max = Math.max(1, ...(stats?.series.map((x) => x.views) ?? [1]));

  return (
    <div className="share-detail">
      <div className="share-detail-grid">
        {/* 左边：公开了什么 */}
        <section className="share-col">
          <h4 className="share-h">公开的内容</h4>
          {share.targets.length === 0 ? (
            <p className="small muted">这份分享里已经没有任何可读的内容了。</p>
          ) : (
            <ul className="share-target-list">
              {share.targets.map((t) => (
                <li key={t.id}>
                  <span className="share-target-kind">{t.kind === 'work' ? '书' : t.kind === 'collection' ? '专题' : '笔记'}</span>
                  <span className="share-target-title">{t.title}</span>
                  <span className="share-target-meta">{t.meta}</span>
                  {t.via && <span className="share-target-via">来自专题</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="share-hint">
            {share.allowDownload ? 'PDF / EPUB 原件可下载。' : '只在线读，不提供原件下载。'}
          </p>
          <div className="share-link-line">
            <code>{share.url}</code>
          </div>
          <div className="row share-quick">
            {hasCollection && (
              <button
                className="btn btn-sm"
                disabled={busy === `sync-${share.id}`}
                onClick={() => void onAct(`sync-${share.id}`, () => endpoints.syncShare(share.id), '已按专题当前成员同步')}
                title="专题里新加的成员不会自动公开，点这里把这些成员补进来"
              >
                同步专题成员
              </button>
            )}
            <button
              className="btn btn-sm"
              disabled={busy === `rot-${share.id}`}
              onClick={async () => {
                if (!window.confirm('换一条新链接？旧地址会立刻失效，已经发出去的链接都打不开了。')) return;
                await onAct(`rot-${share.id}`, () => endpoints.rotateShare(share.id), '已换新链接');
              }}
            >
              换链接
            </button>
            <button
              className="btn btn-sm"
              disabled={busy === `pause-${share.id}`}
              onClick={() => void onAct(
                `pause-${share.id}`,
                () => endpoints.updateShare(share.id, { state: share.state === 'paused' ? 'active' : 'paused' }),
                share.state === 'paused' ? '已恢复访问' : '已暂停，链接暂时打不开',
              )}
            >
              {share.state === 'paused' ? '恢复访问' : '暂停'}
            </button>
            <button className="btn btn-sm btn-quiet" onClick={onEdit}>改设置</button>
            <button className="btn btn-sm btn-danger" disabled={busy === `arch-${share.id}`} onClick={() => void onArchive()}>
              收回
            </button>
          </div>
        </section>

        {/* 右边：谁在读 */}
        <section className="share-col">
          <h4 className="share-h">
            阅读
            <span className="share-h-meta">
              {stats ? `${stats.last30} 次 / 30 天 · ${stats.unique} 位访客` : '暂无数据'}
            </span>
          </h4>

          {!stats || stats.total === 0 ? (
            <p className="small muted">还没有人来过。把链接发出去，这里会开始记数。</p>
          ) : (
            <>
              <div className="share-chart" role="img" aria-label="近 30 天每日访问量">
                {stats.series.map((p) => (
                  <i
                    key={p.d}
                    data-zero={p.views === 0 ? '1' : '0'}
                    style={{ height: `${Math.max(2, Math.round((p.views / max) * 100))}%` }}
                    title={`${p.d} · ${p.views} 次 / ${p.unique} 人`}
                  />
                ))}
              </div>
              <div className="share-axis">
                <span>{stats.series[0] ? dayLabel(stats.series[0].d) : ''}</span>
                <span>今天 {stats.today} 次</span>
              </div>

              <table className="table share-table">
                <thead>
                  <tr><th>内容</th><th style={{ width: 56 }}>次数</th><th style={{ width: 56 }}>访客</th><th style={{ width: 74 }}>最近</th></tr>
                </thead>
                <tbody>
                  {stats.items.slice(0, 8).map((it) => (
                    <tr key={it.id}>
                      <td className="ellipsis">{it.title}</td>
                      <td className="mono">{it.views}</td>
                      <td className="mono muted">{it.unique}</td>
                      <td className="mono muted">{timeLabel(it.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {stats.refs.length > 0 && (
                <p className="share-refs">
                  来自：
                  {stats.refs.map((r) => <span key={r.host}><b>{r.host}</b> {r.views}</span>)}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/* ---------------- 新建 / 编辑 ---------------- */

function ShareEditor({ initial, onClose, onSaved }: {
  initial: ShareView | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { data: options, isLoading } = useShareOptions();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [intro, setIntro] = useState(initial?.intro ?? '');
  const [byline, setByline] = useState(initial?.byline ?? '');
  const [expires, setExpires] = useState(initial?.expiresAt ? initial.expiresAt.slice(0, 10) : '');
  const [download, setDownload] = useState(Boolean(initial?.allowDownload));
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set((initial?.targets ?? []).filter((t) => !t.via).map((t) => t.id)),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 公开范围先说清楚：勾了专题就等于把成员一起放出去
  const preview = useMemo(() => {
    if (!options) return { works: 0, chapters: 0, notes: 0, collections: 0 };
    let works = 0;
    let chapters = 0;
    let notes = 0;
    let collections = 0;
    for (const id of picked) {
      const w = options.works.find((x) => x.id === id);
      if (w) { works += 1; chapters += w.chapters; continue; }
      const c = options.collections.find((x) => x.id === id);
      if (c) { collections += 1; continue; }
      if (options.notes.some((x) => x.id === id)) notes += 1;
    }
    return { works, chapters, notes, collections };
  }, [options, picked]);

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      setErr('给它一个标题：外面的人先看到的就是这一行。');
      return;
    }
    if (picked.size === 0) {
      setErr('至少选一样内容，否则链接打开是空的。');
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const body = {
        title: title.trim(),
        intro: intro.trim(),
        byline: byline.trim(),
        expiresAt: expires ? expires : null,
        allowDownload: download,
        targetIds: [...picked],
      };
      if (initial) await endpoints.updateShare(initial.id, body);
      else await endpoints.createShare(body);
      toast(initial ? '已保存' : '分享已建立，链接可以发出去了', 'ok');
      await onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title={initial ? '分享设置' : '新建分享'}
      desc={initial ? initial.title : '只有你勾选的内容会出现在外面'}
      onClose={onClose}
      wide
      footer={
        <div className="row" style={{ width: '100%' }}>
          <span className="small muted">
            {preview.works > 0 && `${preview.works} 本书（${preview.chapters} 章）`}
            {preview.collections > 0 && `${preview.works > 0 ? ' · ' : ''}${preview.collections} 个专题`}
            {preview.notes > 0 && `${preview.works + preview.collections > 0 ? ' · ' : ''}${preview.notes} 篇笔记`}
            {picked.size === 0 && '还没选内容'}
          </span>
          <span className="spacer" />
          <button className="btn btn-quiet" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={saving} data-testid="share-save">
            {saving ? '保存中…' : initial ? '保存' : '建立分享'}
          </button>
        </div>
      }
    >
      {err && <div className="notice" role="alert">{err}</div>}

      <div className="grid grid-2" style={{ gap: 'var(--sp-4)' }}>
        <Field label="标题" hint="外面读者看到的第一行">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：给同事的三章" data-testid="share-title" />
        </Field>
        <Field label="落款" hint="卷末那句「由谁抽出」；留空用空间名">
          <input className="input" value={byline} onChange={(e) => setByline(e.target.value)} placeholder="可选" />
        </Field>
      </div>

      <Field label="引言" hint="一段话说明为什么挑这些内容；留空就直接进目录">
        <textarea className="textarea" rows={2} value={intro} onChange={(e) => setIntro(e.target.value)} placeholder="可选" />
      </Field>

      <div className="grid grid-2" style={{ gap: 'var(--sp-4)' }}>
        <Field label="到期日" hint="到期当天仍可读，之后链接失效；留空表示不过期">
          <input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        {/* Field 本身就是一个 <label>，里面不能再套 label：嵌套会让无障碍名称拼成一句话 */}
        <div className="field">
          <span className="field-label">原件</span>
          <label className="share-check">
            <input
              type="checkbox"
              checked={download}
              onChange={(e) => setDownload(e.target.checked)}
              data-testid="share-download"
            />
            <span>允许下载 PDF / EPUB</span>
          </label>
          <span className="field-hint">Markdown 始终只在线读</span>
        </div>
      </div>

      <h4 className="share-h" style={{ marginTop: 'var(--sp-4)' }}>
        公开的内容
        <span className="share-h-meta">勾选专题会把它的成员一起带出去，之后新加的成员需要手动同步</span>
      </h4>

      {isLoading || !options ? (
        <Spinner label="读取书架与专题…" />
      ) : (
        <div className="share-picker">
          <PickerGroup title="书籍" empty="书架上还没有书">
            {options.works.map((w) => (
              <PickerRow
                key={w.id} id={w.id} title={w.title} meta={`${w.chapters} 章`} desc={w.desc}
                checked={picked.has(w.id)} onToggle={toggle}
              />
            ))}
          </PickerGroup>
          <PickerGroup title="专题" empty="还没有专题">
            {options.collections.map((c) => (
              <PickerRow
                key={c.id} id={c.id} title={c.title} meta={`${c.members} 项`} desc={c.desc}
                checked={picked.has(c.id)} onToggle={toggle}
              />
            ))}
          </PickerGroup>
          <PickerGroup title="笔记" empty="还没有笔记">
            {options.notes.map((n) => (
              <PickerRow
                key={n.id} id={n.id} title={n.title} meta={n.kind === 'report' ? '报告' : '笔记'}
                desc={(n.tags ?? []).map((t) => `#${t}`).join(' ')}
                checked={picked.has(n.id)} onToggle={toggle}
              />
            ))}
          </PickerGroup>
        </div>
      )}
    </Sheet>
  );
}

function PickerGroup({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <section className="share-picker-col">
      <h5 className="share-picker-h">{title}<span>{children.length}</span></h5>
      {children.length === 0 ? <p className="small muted">{empty}</p> : <ul className="share-picker-list">{children}</ul>}
    </section>
  );
}

function PickerRow({ id, title, meta, desc, checked, onToggle }: {
  id: string; title: string; meta: string; desc?: string; checked: boolean; onToggle: (id: string) => void;
}) {
  return (
    <li>
      <label className="share-pick" data-checked={checked ? '1' : '0'}>
        <input type="checkbox" checked={checked} onChange={() => onToggle(id)} value={id} />
        <span className="share-pick-body">
          <span className="share-pick-title">{title}</span>
          {desc ? <span className="share-pick-desc">{desc}</span> : null}
        </span>
        <span className="share-pick-meta">{meta}</span>
      </label>
    </li>
  );
}
