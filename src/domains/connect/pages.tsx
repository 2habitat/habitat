/** 连接域：同一查询模型的四个入口 */
import { useMemo, useState } from 'react';
import { Card, Chip, Empty, Spinner, ErrorBox } from '../../components/ui.tsx';
import { useSearch, useTags, useGraph, useObjects } from '../../services/use.ts';
import { useUi } from '../../app/ui.ts';
import { BatchBar, useBatch } from '../../components/batch.tsx';
import { navigate } from '../../app/router.ts';

const TYPE_LABEL: Record<string, string> = {
  work: '作品', note: '笔记', part: '章节', rep: '载体', annotation: '批注',
  action: '任务', event: '日程', project: '项目', area: '领域', collection: '专题',
};

export function SearchPage({ q: initialQ }: { q?: string }) {
  const [q, setQ] = useState(initialQ ?? '');
  const [submitted, setSubmitted] = useState(initialQ ?? '');
  const [type, setType] = useState('');
  const { data, isLoading } = useSearch(submitted, type || undefined);
  const openSheet = useUi((s) => s.openSheet);
  const batch = useBatch();

  const facets = data?.facets;

  return (
    <div className="content-wide">
      <Card title="检索" desc="中文按 2-gram 切分，英文按词；搜不到就是搜不到">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(q);
          }}
        >
          <input
            className="input"
            placeholder="搜全库…"
            value={q}
            data-testid="search-input"
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" data-testid="search-go">检索</button>
        </form>
        <div className="row row-wrap" style={{ marginTop: 8 }}>
          <button className="btn btn-sm" onClick={() => setType('')} aria-pressed={type === ''}>全部</button>
          {(facets?.types ?? []).map((t) => (
            <button key={t.type} className="btn btn-sm" onClick={() => setType(t.type)} aria-pressed={type === t.type} data-testid="search-facet">
              {TYPE_LABEL[t.type] ?? t.type} {t.n}
            </button>
          ))}
        </div>
      </Card>

      {submitted && (
        <Card title={`「${submitted}」`} desc={isLoading ? '搜索中…' : `${data?.hits.length ?? 0} 条命中`}>
          {isLoading ? <Spinner /> : !data?.hits.length
            ? <Empty title="没有命中" desc="换个说法，或者这个词还没进库" action={<button className="btn" onClick={() => openSheet('capture', { title: submitted })}>把它采集进来</button>} />
            : data.hits.map((h) => (
              <div key={h.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }} data-testid="search-hit">
                <input
                  type="checkbox"
                  checked={batch.has(h.id)}
                  onChange={() => batch.toggle(h.id)}
                  aria-label={`选择：${h.title}`}
                  data-testid="search-pick"
                />
                <Chip>{TYPE_LABEL[h.type] ?? h.type}</Chip>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ellipsis"><strong>{h.title}</strong></div>
                  <div className="small muted ellipsis">{h.snippet}</div>
                </div>
                <button className="btn btn-sm" onClick={() => navigate(h.type === 'note' ? 'editor' : 'reader', { id: h.id, rep: h.id })} data-testid="search-open">打开</button>
              </div>
            ))}
        </Card>
      )}

      <BatchBar ids={batch.ids} onDone={batch.clear} label="条目" />

      {facets?.tags?.length ? (
        <Card title="按标签收窄">
          <div className="row row-wrap">
            {facets.tags.slice(0, 30).map((t) => (
              <button key={t.tag} className="btn btn-sm" onClick={() => { setQ(t.tag); setSubmitted(t.tag); }} data-testid="search-tag">{t.tag} {t.n}</button>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

export function TagsPage() {
  const { data, isLoading } = useTags();
  const [active, setActive] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  const tags = data?.tags ?? [];
  const hit = tags.find((t) => t.tag === active);

  return (
    <div className="content-wide">
      <Card title="标签" desc={`${tags.length} 个`}>
        {tags.length === 0
          ? <Empty title="还没有标签" desc="在笔记的 frontmatter 里加 tags: [xxx]" />
          : (
            <div className="row row-wrap">
              {tags.map((t) => (
                <button key={t.tag} className="btn btn-sm" aria-pressed={active === t.tag} data-testid="tag-item" onClick={() => setActive(active === t.tag ? null : t.tag)}>
                  {t.tag} <span className="muted">{t.ids.length}</span>
                </button>
              ))}
            </div>
          )}
      </Card>

      {hit && (
        <Card title={`#${hit.tag}`} desc={`${hit.ids.length} 个对象`}>
          {hit.ids.map((id) => (
            <div key={id} className="row small" style={{ padding: '3px 0' }}>
              <span className="mono ellipsis" style={{ flex: 1 }}>{id}</span>
              <button className="btn btn-sm btn-ghost" onClick={() => navigate('reader', { rep: id })}>打开</button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

export function CollectionsPage() {
  const { data, isLoading } = useObjects('collection');
  const openSheet = useUi((s) => s.openSheet);
  if (isLoading) return <Spinner />;
  const cols = (data?.objects ?? []) as unknown as { id: string; title: string; desc?: string; memberIds: string[]; query?: string }[];

  return (
    <div className="content-wide">
      <Card
        title="专题"
        desc="人工清单 + 动态查询，两者取并集"
        actions={<button className="btn btn-sm btn-primary" onClick={() => openSheet('capture', { title: '新专题' })} data-testid="collection-new">新建专题</button>}
      >
        {cols.length === 0
          ? <Empty title="还没有专题" desc="专题 = 围绕一个问题的清单，可以手写成员，也可以写一条查询自动收" />
          : cols.map((c) => (
            <div key={c.id} className="card" style={{ marginBottom: 8 }}>
              <div className="row">
                <strong>{c.title}</strong>
                {c.query && <Chip tone="info">动态：{c.query}</Chip>}
                <span className="spacer" />
                <Chip>{c.memberIds.length} 个成员</Chip>
              </div>
              {c.desc && <div className="small muted" style={{ marginTop: 4 }}>{c.desc}</div>}
              <div className="row row-wrap" style={{ marginTop: 8 }}>
                {c.memberIds.map((m) => (
                  <button key={m} className="btn btn-sm" onClick={() => navigate('reader', { rep: m })}>{m.slice(0, 14)}…</button>
                ))}
              </div>
            </div>
          ))}
      </Card>
    </div>
  );
}

const TYPE_COLOR: Record<string, string> = {
  work: 'var(--accent)', note: 'var(--info)', project: 'var(--ok)', area: 'var(--warn)', collection: 'var(--danger)',
};

export function GraphPage() {
  const { data, isLoading } = useGraph(220);
  const [hover, setHover] = useState<string | null>(null);

  // useMemo 必须在提前 return 之前调用，否则 hooks 顺序会乱
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const R = 230;
  const cx = 380;
  const cy = 260;
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    nodes.forEach((n, i) => {
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      const r = R * (0.55 + 0.45 * ((i % 3) / 2));
      m.set(n.id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    });
    return m;
  }, [nodes]);

  if (isLoading) return <Spinner />;

  return (
    <div className="content-wide">
      <Card
        title="关系"
        desc="按需探索，不是每天必经的页面"
        actions={<span className="small muted">{nodes.length} 个节点 · {edges.length} 条链接</span>}
      >
        {nodes.length === 0
          ? <Empty title="库里还没有可连的对象" desc="多写几篇带 [[双链]] 的笔记就有了" />
          : (
            <svg className="graph-svg" viewBox="0 0 760 520" role="img" aria-label="关系图" data-testid="graph-svg">
              {edges.map((e, i) => {
                const a = pos.get(e.source);
                const b = pos.get(e.target);
                if (!a || !b) return null;
                return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth={1} opacity={0.5} />;
              })}
              {nodes.map((n) => {
                const p = pos.get(n.id)!;
                const hot = hover === n.id;
                return (
                  <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} style={{ cursor: 'pointer' }}
                    onClick={() => navigate(n.type === 'note' ? 'editor' : 'reader', { id: n.id, rep: n.id })}>
                    <circle cx={p.x} cy={p.y} r={hot ? 8 : 5} fill={TYPE_COLOR[n.type] ?? 'var(--text-3)'} />
                    <text x={p.x + 9} y={p.y + 4} fontSize={hot ? 12 : 10} fill="var(--text)">{n.title.slice(0, 18)}</text>
                  </g>
                );
              })}
            </svg>
          )}
      </Card>
      <div className="row row-wrap">
        {Object.entries(TYPE_COLOR).map(([t, c]) => (
          <span key={t} className="row small"><i style={{ width: 8, height: 8, borderRadius: 99, background: c, display: 'inline-block' }} /> {TYPE_LABEL[t] ?? t}</span>
        ))}
      </div>
    </div>
  );
}
