/** 知识域：阅读与编辑是对象模式，不是两个长期目的地 */
import { useState } from 'react';
import { Card, PageHead, Chip, Empty, Spinner, PageSkeleton, ErrorBox, Bar, fmtBytes } from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
import { useQuery } from '@tanstack/react-query';
import { useWorks, useRefresh } from '../../services/use.ts';
import { endpoints } from '../../services/api.ts';
import { useUi } from '../../app/ui.ts';
import { navigate } from '../../app/router.ts';
import { WORK_KIND, WORK_STAGE, label } from '../../app/labels.ts';
import type { WorkView, WorkCandidateView } from '../../services/api.ts';

const STAGE_NAME = WORK_STAGE;

/** 0.4% 这种别被四舍五入成 0%，否则「在读」里会出现一排 0% */
function pctLabel(p: number): string {
  if (p <= 0) return '0%';
  if (p >= 0.9995) return '100%';
  return p < 0.1 ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`;
}

export function ShelfPage() {
  const { data, isLoading, error, refetch } = useWorks();
  const { data: cand } = useQuery({
    queryKey: ['candidates'],
    queryFn: () => endpoints.candidates(),
    staleTime: 30_000,
  });
  const [q, setQ] = useState('');
  const [showSup, setShowSup] = useState(false);
  const shelfView = useUi((s) => s.shelfView);
  const setShelfView = useUi((s) => s.setShelfView);
  const openSheet = useUi((s) => s.openSheet);
  const openAi = useUi((s) => s.openAi);

  if (isLoading) return <PageSkeleton rows={4} ledger />;
  if (error) return <ErrorBox error={error} onRetry={() => void refetch()} />;
  const all = data?.works ?? [];
  const works = q.trim() ? all.filter((w) => (w.work.title + w.work.desc).toLowerCase().includes(q.trim().toLowerCase())) : all;
  const totalParts = all.reduce((a, w) => a + w.parts.length, 0);
  const totalNotes = all.reduce((a, w) => a + w.annotations, 0);

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="知识 · 书架"
        title="书架"
        lede="同一章节的多个载体合成一行。读到哪里按章记，回看不会把最远位置清掉。"
        actions={
          <>
            <input
              className="input"
              placeholder="过滤书名…"
              style={{ width: 168 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="shelf-filter"
              aria-label="过滤书架"
            />
            <button className="btn btn-sm" onClick={() => setShowSup((v) => !v)}>
              {showSup ? '隐藏' : '显示'}补充材料
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => openSheet('capture', { title: '新作品' })} data-testid="shelf-new">
              <Icon name="plus" size={13} />
              新建
            </button>
          </>
        }
      />

      <div className="ledger">
        <div className="ledger-cell" data-zero={all.length ? '0' : '1'}>
          <b className="ledger-num">{all.length}</b><span className="ledger-label">作品</span>
        </div>
        <div className="ledger-cell" data-zero={totalParts ? '0' : '1'}>
          <b className="ledger-num">{totalParts}</b><span className="ledger-label">章节</span>
        </div>
        <div className="ledger-cell" data-zero={totalNotes ? '0' : '1'}>
          <b className="ledger-num">{totalNotes}</b><span className="ledger-label">批注</span>
        </div>
        <div className="ledger-cell" data-zero={all.reduce((a, w) => a + w.derived, 0) ? '0' : '1'}>
          <b className="ledger-num">{all.reduce((a, w) => a + w.derived, 0)}</b><span className="ledger-label">衍生笔记</span>
        </div>
        <div className="ledger-side">
          <div className="view-switch" role="group" aria-label="书架展示方式">
            <button aria-pressed={shelfView === 'grid'} onClick={() => setShelfView('grid')} data-testid="shelf-view-grid">书架</button>
            <button aria-pressed={shelfView === 'list'} onClick={() => setShelfView('list')} data-testid="shelf-view-list">列表</button>
          </div>
        </div>
      </div>

      {cand && cand.candidates.length > 0 && <CandidateCard list={cand.candidates} onDone={() => void refetch()} />}

      {works.length === 0 ? (
        <Empty
          title={q ? `没有匹配「${q}」的作品` : '书架上没有东西'}
          desc={q ? '换个词，或者清掉过滤看全部。' : '采集一份原文，或者新建一篇笔记。目录里已有的 Markdown 也可以直接归组成作品。'}
          action={<button className="btn" onClick={() => openSheet('capture')}>采集一份</button>}
        />
      ) : shelfView === 'grid' ? (
        <div className="shelf-grid stagger">
          {works.map((w, i) => (
            <WorkCard
              key={w.work.id}
              w={w}
              index={i}
              onAi={() => openAi({ kind: 'work', id: w.work.id, title: w.work.title })}
            />
          ))}
        </div>
      ) : (
        <div className="stagger">
          {works.map((w) => (
            <WorkEntry
              key={w.work.id}
              w={w}
              showSup={showSup}
              onAi={() => openAi({ kind: 'work', id: w.work.id, title: w.work.title })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 未归组的来源目录：只提示，点了确认才写 work.yaml，文件原地不动 */
function CandidateCard({ list, onDone }: { list: WorkCandidateView[]; onDone: () => void }) {
  const toast = useUi((s) => s.toast);
  const [titles, setTitles] = useState<Record<string, string>>(() =>
    Object.fromEntries(list.map((c) => [c.dir, c.title])),
  );
  const [busy, setBusy] = useState('');

  async function group(c: WorkCandidateView) {
    setBusy(c.dir);
    try {
      await endpoints.groupWork(c.dir, titles[c.dir]?.trim() || c.title);
      toast(`已归组「${titles[c.dir] || c.title}」，章节原地没动`, 'ok');
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  return (
    <Card
      title="发现未归组的来源目录"
      desc="看着像一本书，但还没有作品接管。确认后只写一份 work.yaml 指向原目录，文件不动"
      data-testid="candidates"
    >
      {list.map((c) => (
        <div key={c.dir} className="row row-wrap" style={{ padding: '8px 0', borderBottom: '1px solid var(--rule)' }}>
          <input
            className="input"
            style={{ maxWidth: 260 }}
            value={titles[c.dir] ?? c.title}
            onChange={(e) => setTitles({ ...titles, [c.dir]: e.target.value })}
            aria-label={`书名：${c.slug}`}
            data-testid="candidate-title"
          />
          <span className="small muted" style={{ flex: 1 }}>{c.chapters} 篇 · {c.dir}</span>
          <button className="btn btn-sm btn-primary" onClick={() => void group(c)} disabled={busy === c.dir} data-testid="candidate-group">
            {busy === c.dir ? '归组中…' : '归组成作品'}
          </button>
        </div>
      ))}
    </Card>
  );
}

/** 书架视图：一张「封面」= 一本书。标题印在封面上，进度是书脚那道细线 */
function WorkCard({ w, index, onAi }: { w: WorkView; index: number; onAi: () => void }) {
  const main = w.parts.filter((p) => !p.supplemental);
  const done = Math.round(w.readPct * 100);
  const stage = w.stage ? label(STAGE_NAME, w.stage) : '未开始';
  // 直接落到「上次读的那一章」，否则点继续永远从第一章开始
  const open = () => (w.lastRepId ? navigate('reader', { work: w.work.id, rep: w.lastRepId }) : navigate('reader', { work: w.work.id }));
  return (
    <div className="work-card" data-testid="work-card">
      <button
        className="cover"
        data-kind={w.work.kind}
        onClick={open}
        data-testid="work-read"
        title={w.work.title}
      >
        <span className="cover-spine" aria-hidden="true" />
        <span className="cover-ghost" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
        <span className="cover-title">{w.work.title}</span>
        {w.work.desc && <span className="cover-desc">{w.work.desc}</span>}
        <span className="cover-foot">
          <span className="cover-bar" aria-hidden="true"><i style={{ width: `${done}%` }} /></span>
          <span className="cover-pct mono">{pctLabel(w.readPct)}</span>
        </span>
      </button>
      <div className="card-meta">
        <span>{w.readChapters > 0 ? `${w.readChapters}/${w.chapterCount || main.length} 章` : `${main.length} 章`}</span>
        <span className="card-stage">{stage}</span>
        {w.locked && <span>只读</span>}
        <button className="entry-ai" onClick={onAi} data-testid="work-ask-ai">问助手</button>
      </div>
    </div>
  );
}

function WorkEntry({ w, showSup, onAi }: { w: WorkView; showSup: boolean; onAi: () => void }) {
  const [open, setOpen] = useState(false);
  const main = w.parts.filter((p) => !p.supplemental).sort((a, b) => a.order - b.order);
  const sup = w.parts.filter((p) => p.supplemental);
  const done = Math.round(w.readPct * 100);
  const stage = w.stage ? label(STAGE_NAME, w.stage) : '未开始';

  return (
    <article className="entry" data-testid="work-card">
      <div className="entry-main">
        <div className="entry-title">
          <button
            className="entry-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? '收起章节' : '展开章节'}
            data-testid="work-expand"
          >
            <Icon name="chevron" size={15} className={open ? 'rot-90' : undefined} />
          </button>
          <h3>{w.work.title}</h3>
          <span className="entry-stage" data-empty={w.stage ? '0' : '1'}>{stage}</span>
          {/* 类型在书架上是冗余的（这里全是作品），只留真正影响操作的「只读」 */}
          {w.locked && <span className="entry-kind">只读</span>}
        </div>

        <div className="entry-meta">
          <span>{w.readChapters > 0 ? `${w.readChapters}/${w.chapterCount || main.length} 章` : `${main.length} 章`}</span>
          {w.annotations > 0 && <span>批注 {w.annotations}</span>}
          {w.derived > 0 && <span>衍生 {w.derived}</span>}
          {w.work.updatedAt && <span>{w.work.updatedAt.slice(0, 10)}</span>}
          {/* 动作跟着文字走，不再单独占右边缘一列 */}
          <button
            className="entry-go"
            onClick={() => (w.lastRepId ? navigate('reader', { work: w.work.id, rep: w.lastRepId }) : navigate('reader', { work: w.work.id }))}
            data-testid="work-read"
          >
            {done > 0 ? '继续读' : '开始读'}
            <Icon name="arrow" size={12} />
          </button>
          <button className="entry-ai" onClick={onAi} data-testid="work-ask-ai">问助手</button>
        </div>

        {w.next && <p className="entry-note">卡在「{label(STAGE_NAME, w.next.key)}」：{w.next.text}</p>}
        {w.work.desc && <p className="entry-desc">{w.work.desc}</p>}

        {w.readPct > 0 && (
          <div className="entry-progress">
            <Bar value={w.readPct} />
            <span className="mono">{pctLabel(w.readPct)}</span>
          </div>
        )}
      </div>

      {open && (
        <div className="entry-body">
          {main.map((p) => <PartRow key={p.id} w={w} partId={p.id} title={p.title} />)}
          {sup.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="group-label">补充材料 · 不进正文顺序</div>
              {showSup
                ? sup.map((p) => <PartRow key={p.id} w={w} partId={p.id} title={p.title} />)
                : <div className="small muted">共 {sup.length} 篇，点上方「显示补充材料」展开。</div>}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function PartRow({ w, partId, title }: { w: WorkView; partId: string; title: string }) {
  const reps = w.reps.filter((r) => r.partId === partId);
  const md = reps.find((r) => r.carrier === 'md') ?? reps[0];
  return (
    <div className="part" data-nav-row={partId}>
      <button
        type="button"
        className="peekable part-title"
        onClick={() => md && navigate('reader', { rep: md.id })}
        title={md?.path}
      >
        {title}
      </button>
      <div className="part-carriers">
        {reps.map((r) => (
          <button
            key={r.id}
            className="carrier"
            title={`${r.path} · ${fmtBytes(r.bytes)}${r.locked ? ' · 只读' : ''}`}
            data-testid="part-carrier"
            onClick={() => navigate(['md', 'html', 'pdf', 'epub'].includes(r.carrier) ? 'reader' : 'editor', { rep: r.id })}
          >
            {r.carrier}
            {r.locked ? ' · 只读' : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ContinuePage() {
  const { data, isLoading } = useWorks();
  const navigate_ = navigate;
  if (isLoading) return <PageSkeleton rows={3} />;
  const all = data?.works ?? [];
  // 上次动过的排前面：按百分比排只会把「读了 3 章的长书」一直压到底
  const recent = (a: WorkView, b: WorkView) => (b.lastReadAt ?? '').localeCompare(a.lastReadAt ?? '');
  // 进度是章节覆盖率：读完 8/24 章就是 33%，不会再被「某一章滚到底」顶成 100%
  const reading = all.filter((w) => !!w.lastReadAt && w.readChapters < w.chapterCount).sort(recent);
  const finished = all.filter((w) => w.chapterCount > 0 && w.readChapters >= w.chapterCount).sort(recent);
  const untouched = all.filter((w) => !w.lastReadAt);
  const open = (w: WorkView) => navigate_('reader', w.lastRepId ? { work: w.work.id, rep: w.lastRepId } : { work: w.work.id });

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="知识 · 继续阅读"
        title="继续阅读"
        lede="按最近读过的排。进度按章算——一章滚到底只算这一章，正文章全部读完才是 100%。"
      />

      <Card title="在读" desc={`${reading.length} 篇`}>
        {reading.length === 0
          ? <Empty title="没有在读的条目" desc="去书架挑一章开始" action={<button className="btn" onClick={() => navigate('shelf')}>打开书架</button>} />
          : reading.map((w) => (
            <div key={w.work.id} className="part" style={{ padding: '10px 0' }}>
              <span className="part-title ellipsis" style={{ maxWidth: 300 }}>{w.work.title}</span>
              <span style={{ width: 180 }}><Bar value={w.readPct} /></span>
              <span className="mono" style={{ width: 52 }}>{pctLabel(w.readPct)}</span>
              <span className="small muted mono">读完 {w.readChapters}/{w.chapterCount} 章</span>
              <span className="small muted">批注 {w.annotations} · 衍生 {w.derived}</span>
              <span className="spacer" />
              <button className="btn btn-sm btn-primary" onClick={() => open(w)}>继续</button>
            </div>
          ))}
      </Card>

      <Card title="已读完" desc={`${finished.length} 篇，正文章全部读完`}>
        {finished.length === 0
          ? <p className="section-note">还没有整本读完的。</p>
          : finished.map((w) => (
            <div key={w.work.id} className="part">
              <span className="part-title ellipsis">{w.work.title}</span>
              <span className="small muted mono">{w.readChapters}/{w.chapterCount} 章</span>
              {w.lastReadAt && <span className="small muted mono">{w.lastReadAt.slice(0, 10)}</span>}
              <span className="spacer" />
              <button className="btn btn-sm btn-quiet" onClick={() => open(w)}>重读</button>
            </div>
          ))}
      </Card>

      <Card title="还没开始" desc={`${untouched.length} 篇没打开过`}>
        {untouched.length === 0
          ? <p className="section-note">都开过头的了。</p>
          : untouched.map((w) => (
            <div key={w.work.id} className="part">
              <span className="part-title ellipsis">{w.work.title}</span>
              <span className="small muted mono">{w.chapterCount || w.parts.length} 章</span>
              <span className="spacer" />
              <button className="btn btn-sm btn-quiet" onClick={() => navigate_('reader', { work: w.work.id })}>开始读</button>
            </div>
          ))}
      </Card>
    </div>
  );
}

export function ComposePage() {
  const openSheet = useUi((s) => s.openSheet);
  const { data } = useWorks();
  const refresh = useRefresh();

  const entries = [
    { id: 'capture', title: '采集一段', desc: '原文先落收件箱，不动脑子。想清楚了再衍生。', icon: 'inbox' as const, run: () => openSheet('capture', { title: '' }) },
    { id: 'derive', title: '衍生一篇', desc: '基于已有条目写自己的理解，血缘自动连上。', icon: 'pen' as const, run: () => openSheet('derive', { srcId: '' }) },
    { id: 'editor', title: '直接写笔记', desc: '源码 + 预览 + 元数据表单，适合已经想清楚的。', icon: 'files' as const, run: () => navigate('editor', { id: '' }) },
    { id: 'refresh', title: '刷新索引', desc: '在编辑器里改了文件、界面上看不到时点一下。', icon: 'review' as const, run: () => refresh() },
  ];

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="知识 · 创作"
        title="创作"
        lede="写东西的入口。写完之后它就是笔记，不是草稿堆——只有你知道它还没写完。"
      />

      <div className="compose-grid">
        {entries.map((e) => (
          <button key={e.id} className="compose-card" onClick={e.run} data-testid={`compose-${e.id}`}>
            <span className="compose-icon"><Icon name={e.icon} size={17} /></span>
            <strong>{e.title}</strong>
            <span className="compose-desc">{e.desc}</span>
            <span className="compose-go"><Icon name="arrow" size={14} /></span>
          </button>
        ))}
      </div>

      <Card title="最近动过的作品" desc="从书架过来的">
        {(data?.works ?? []).slice(0, 6).map((w) => (
          <div key={w.work.id} className="part">
            <span className="part-title ellipsis">{w.work.title}</span>
            <span className="small muted mono">{w.work.updatedAt.slice(0, 10)}</span>
            <button className="btn btn-sm btn-quiet" onClick={() => openSheet('derive', { srcId: w.work.id, title: `${w.work.title} · 读后` })}>衍生</button>
          </div>
        ))}
      </Card>
    </div>
  );
}
