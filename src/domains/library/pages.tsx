/** 知识域：阅读与编辑是对象模式，不是两个长期目的地 */
import { useState } from 'react';
import { Card, Stat, Chip, Empty, Spinner, ErrorBox, Bar, fmtBytes } from '../../components/ui.tsx';
import { useQuery } from '@tanstack/react-query';
import { useWorks, useRefresh } from '../../services/use.ts';
import { endpoints } from '../../services/api.ts';
import { useUi } from '../../app/ui.ts';
import { navigate } from '../../app/router.ts';
import type { WorkView, WorkCandidateView } from '../../services/api.ts';

const STAGE_NAME: Record<string, string> = { capture: '采集', derive: '衍生', digest: '消化', review: '回顾', settle: '沉淀' };

export function ShelfPage() {
  const { data, isLoading, error, refetch } = useWorks();
  const { data: cand } = useQuery({
    queryKey: ['candidates'],
    queryFn: () => endpoints.candidates(),
    staleTime: 30_000,
  });
  const [q, setQ] = useState('');
  const [showSup, setShowSup] = useState(false);
  const openSheet = useUi((s) => s.openSheet);
  const openAi = useUi((s) => s.openAi);

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} onRetry={() => void refetch()} />;
  const all = data?.works ?? [];
  const works = q.trim() ? all.filter((w) => (w.work.title + w.work.desc).toLowerCase().includes(q.trim().toLowerCase())) : all;
  const totalParts = all.reduce((a, w) => a + w.parts.length, 0);

  return (
    <div className="content-wide">
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat num={all.length} label="作品" hint="界面主口径是作品，不是文件数" />
        <Stat num={totalParts} label="章节" />
        <Stat num={all.reduce((a, w) => a + w.annotations, 0)} label="批注" />
        <Stat num={all.reduce((a, w) => a + w.derived, 0)} label="衍生笔记" />
      </div>

      <Card
        title="书架"
        desc="同一章节的多个载体合成一行"
        actions={
          <>
            <input className="input" placeholder="过滤…" style={{ width: 160 }} value={q} onChange={(e) => setQ(e.target.value)} data-testid="shelf-filter" />
            <button className="btn btn-sm" onClick={() => setShowSup((v) => !v)}>{showSup ? '隐藏' : '显示'}补充材料</button>
            <button className="btn btn-sm" onClick={() => openSheet('capture', { title: '新作品' })} data-testid="shelf-new">新建</button>
          </>
        }
      >
        {works.length === 0
          ? <Empty title="书架上没有东西" desc="采集一份原文，或者新建一篇笔记" action={<button className="btn" onClick={() => openSheet('capture')}>采集</button>} />
          : works.map((w) => <WorkCard key={w.work.id} w={w} showSup={showSup} onAi={() => openAi({ kind: 'work', id: w.work.id, title: w.work.title })} />)}
      </Card>
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
        <div key={c.dir} className="row row-wrap" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
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

function WorkCard({ w, showSup, onAi }: { w: WorkView; showSup: boolean; onAi: () => void }) {
  const [open, setOpen] = useState(false);
  const main = w.parts.filter((p) => !p.supplemental).sort((a, b) => a.order - b.order);
  const sup = w.parts.filter((p) => p.supplemental);
  const done = Math.round(w.readPct * 100);

  return (
    <div className="card" style={{ marginBottom: 10 }} data-testid="work-card">
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="work-expand">
          {open ? '▾' : '▸'}
        </button>
        <strong className="work-title" style={{ fontSize: 'var(--fs-5)' }}>{w.work.title}</strong>
        <Chip>{w.work.kind}</Chip>
        {w.locked && <Chip tone="warn">原件只读</Chip>}
        <span className="spacer" />
        <Chip tone={w.stage ? 'accent' : ''}>{STAGE_NAME[w.stage ?? ''] ?? '未开始'}</Chip>
        <button className="btn btn-sm" onClick={onAi} data-testid="work-ask-ai">问助手</button>
        <button className="btn btn-sm btn-primary" onClick={() => navigate('reader', { work: w.work.id })} data-testid="work-read">读</button>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <div style={{ width: 160 }}><Bar value={w.readPct} /></div>
        <span className="small mono">{done}%</span>
        <span className="small muted">{main.length} 章 · 批注 {w.annotations} · 衍生 {w.derived}{w.originals ? ` · 原件 ${w.originals}` : ''}</span>
      </div>

      {w.next && <div className="small" style={{ marginTop: 6 }}>卡在「{STAGE_NAME[w.next.key]}」：{w.next.text}</div>}
      {w.work.desc && <div className="small muted" style={{ marginTop: 4 }}>{w.work.desc}</div>}

      {open && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          {main.map((p) => <PartRow key={p.id} w={w} partId={p.id} title={p.title} />)}
          {sup.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="small muted" style={{ marginBottom: 4 }}>补充材料（不进正文顺序）</div>
              {showSup && sup.map((p) => <PartRow key={p.id} w={w} partId={p.id} title={p.title} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PartRow({ w, partId, title }: { w: WorkView; partId: string; title: string }) {
  const reps = w.reps.filter((r) => r.partId === partId);
  const md = reps.find((r) => r.carrier === 'md') ?? reps[0];
  return (
    <div className="row" style={{ padding: '4px 0' }}>
      <span className="ellipsis" style={{ flex: 1 }}>{title}</span>
      {reps.map((r) => (
        <button
          key={r.id}
          className="btn btn-sm"
          title={`${r.path} · ${fmtBytes(r.bytes)}${r.locked ? ' · 只读' : ''}`}
          data-testid="part-carrier"
          // pdf / epub 也进阅读器（阅读器里各自有渲染分支），只有二进制杂项才退回编辑器
          onClick={() => navigate(['md', 'html', 'pdf', 'epub'].includes(r.carrier) ? 'reader' : 'editor', { rep: r.id })}
        >
          {r.carrier}{r.locked ? ' 🔒' : ''}
        </button>
      ))}
      {md && <button className="btn btn-sm btn-ghost" onClick={() => navigate('reader', { rep: md.id })}>打开</button>}
    </div>
  );
}

export function ContinuePage() {
  const { data, isLoading } = useWorks();
  const navigate_ = navigate;
  if (isLoading) return <Spinner />;
  const reading = (data?.works ?? [])
    .filter((w) => w.readPct > 0 && w.readPct < 0.999)
    .sort((a, b) => b.readPct - a.readPct);
  const untouched = (data?.works ?? []).filter((w) => w.readPct === 0);

  return (
    <div className="content-wide">
      <Card title="继续阅读" desc="按读到哪儿排序">
        {reading.length === 0
          ? <Empty title="没有读到一半的条目" desc="去书架挑一章开始" action={<button className="btn" onClick={() => navigate('shelf')}>打开书架</button>} />
          : reading.map((w) => (
            <div key={w.work.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <strong className="ellipsis" style={{ width: 220 }}>{w.work.title}</strong>
              <div style={{ width: 200 }}><Bar value={w.readPct} /></div>
              <span className="small mono" style={{ width: 46 }}>{Math.round(w.readPct * 100)}%</span>
              <span className="small muted">批注 {w.annotations} · 衍生 {w.derived}</span>
              <span className="spacer" />
              <button className="btn btn-sm btn-primary" onClick={() => navigate_('reader', { work: w.work.id })}>继续</button>
            </div>
          ))}
      </Card>

      <Card title="还没开始" desc="读了 0% 的">
        {untouched.length === 0
          ? <div className="small muted">都开过头的了。</div>
          : untouched.map((w) => (
            <div key={w.work.id} className="row" style={{ padding: '6px 0' }}>
              <span className="ellipsis" style={{ flex: 1 }}>{w.work.title}</span>
              <span className="small muted">{w.parts.length} 章</span>
              <button className="btn btn-sm" onClick={() => navigate_('reader', { work: w.work.id })}>开始读</button>
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

  return (
    <div className="content-wide">
      <Card title="创作" desc="写东西的入口。写完之后它是笔记，不是草稿堆">
        <div className="grid grid-2">
          <button className="btn" style={{ padding: 18, justifyContent: 'flex-start', flexDirection: 'column', alignItems: 'flex-start' }} onClick={() => openSheet('capture', { title: '' })} data-testid="compose-capture">
            <strong>采集一段</strong>
            <span className="small muted">原文先落收件箱，不动脑子</span>
          </button>
          <button className="btn" style={{ padding: 18, justifyContent: 'flex-start', flexDirection: 'column', alignItems: 'flex-start' }} onClick={() => openSheet('derive', { srcId: '' })} data-testid="compose-derive">
            <strong>衍生一篇</strong>
            <span className="small muted">基于已有条目写自己的理解，血缘自动连上</span>
          </button>
          <button className="btn" style={{ padding: 18, justifyContent: 'flex-start', flexDirection: 'column', alignItems: 'flex-start' }} onClick={() => navigate('editor', { id: '' })} data-testid="compose-editor">
            <strong>直接写笔记</strong>
            <span className="small muted">源码 + 预览 + 元数据表单</span>
          </button>
          <button className="btn" style={{ padding: 18, justifyContent: 'flex-start', flexDirection: 'column', alignItems: 'flex-start' }} onClick={() => refresh()} data-testid="compose-refresh">
            <strong>刷新索引</strong>
            <span className="small muted">写完在界面上看不到时点一下</span>
          </button>
        </div>
      </Card>

      <Card title="最近动过的作品" desc="从书架过来的">
        {(data?.works ?? []).slice(0, 6).map((w) => (
          <div key={w.work.id} className="row" style={{ padding: '5px 0' }}>
            <span className="ellipsis" style={{ flex: 1 }}>{w.work.title}</span>
            <span className="small muted">{w.work.updatedAt.slice(0, 10)}</span>
            <button className="btn btn-sm" onClick={() => openSheet('derive', { srcId: w.work.id, title: `${w.work.title} · 读后` })}>衍生</button>
          </div>
        ))}
      </Card>
    </div>
  );
}
