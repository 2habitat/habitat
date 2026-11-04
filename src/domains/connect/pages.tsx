/** 连接域：同一查询模型的四个入口 */
import { useMemo, useState } from 'react';
import { Card, PageHead, Chip, Empty, PageSkeleton, ErrorBox } from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
import { useSearch, useTags, useGraph, useObjects } from '../../services/use.ts';
import { useUi } from '../../app/ui.ts';
import { BatchBar, useBatch } from '../../components/batch.tsx';
import { navigate } from '../../app/router.ts';

const TYPE_LABEL: Record<string, string> = {
  work: '作品', note: '笔记', part: '章节', rep: '载体', annotation: '批注',
  action: '任务', event: '日程', project: '项目', area: '领域', collection: '专题',
};

/** id → 标题：库里到处是 id，界面上一律显示人话 */
function useTitleMap() {
  const { data } = useObjects();
  return useMemo(() => {
    const m = new Map<string, { title: string; type: string }>();
    for (const o of data?.objects ?? []) {
      const rec = o as { id?: string; title?: string; text?: string; type?: string };
      if (!rec.id) continue;
      m.set(rec.id, { title: rec.title ?? rec.text ?? rec.id, type: rec.type ?? '' });
    }
    return m;
  }, [data]);
}

export function SearchPage({ q: initialQ }: { q?: string }) {
  const [q, setQ] = useState(initialQ ?? '');
  const [submitted, setSubmitted] = useState(initialQ ?? '');
  const [type, setType] = useState('');
  const { data, isLoading } = useSearch(submitted, type || undefined);
  const { data: tagData } = useTags();
  const openSheet = useUi((s) => s.openSheet);
  const batch = useBatch();

  const facets = data?.facets;
  const hits = data?.hits ?? [];
  const total = facets?.types?.reduce((n, t) => n + t.n, 0) ?? hits.length;

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="连接 · 检索"
        title="检索"
        lede="中文按 2-gram 切分，英文按词。搜不到就是搜不到——不会拿相似的东西糊弄你。"
      />

      <form
        className="search-hero"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q);
        }}
      >
        <Icon name="search" size={18} />
        <input
          className="search-input"
          placeholder="搜标题、正文、标签…"
          value={q}
          aria-label="检索关键词"
          data-testid="search-input"
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" data-testid="search-go">检索</button>
      </form>

      {submitted ? (
        <div className="facets">
          <button className="facet" aria-pressed={type === ''} onClick={() => setType('')}>
            全部 <span className="facet-n">{total}</span>
          </button>
          {(facets?.types ?? []).map((t) => (
            <button
              key={t.type}
              className="facet"
              aria-pressed={type === t.type}
              onClick={() => setType(t.type)}
              data-testid="search-facet"
            >
              {TYPE_LABEL[t.type] ?? t.type} <span className="facet-n">{t.n}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="search-idle">
          <p className="section-note" style={{ marginTop: 0 }}>
            回车检索。中文按二元组切，所以两个字就能搜；搜不到就是库里还没有。
          </p>
          {(tagData?.tags ?? []).length > 0 && (
            <>
              <div className="group-label" style={{ marginTop: 'var(--sp-5)' }}>从标签开始 · {Math.min(12, tagData!.tags.length)}</div>
              <div className="tag-cloud">
                {tagData!.tags.slice(0, 12).map((t) => (
                  <button key={t.tag} className="tag" onClick={() => { setQ(t.tag); setSubmitted(t.tag); }}>
                    {t.tag}<sup>{t.ids.length}</sup>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {submitted && (
        <section className="section" style={{ marginTop: 'var(--sp-5)' }}>
          <h2 className="rubric">
            <span className="rubric-no">◍</span>
            「{submitted}」
            <span className="rubric-rule" />
            <span className="rubric-meta">{isLoading ? '搜索中…' : `${hits.length} 条命中`}</span>
          </h2>

          {isLoading ? (
            <PageSkeleton rows={3} title={false} />
          ) : hits.length === 0 ? (
            <Empty
              title="没有命中"
              desc="换个说法，或者这个词还没进库。检索只认字面——它不会替你猜。"
              action={<button className="btn" onClick={() => openSheet('capture', { title: submitted })}>把它采集进来</button>}
            />
          ) : (
            <div className="stagger">
              {hits.map((h) => (
                <article key={h.id} className="hit" data-testid="search-hit">
                  <input
                    type="checkbox"
                    checked={batch.has(h.id)}
                    onChange={() => batch.toggle(h.id)}
                    aria-label={`选择：${h.title}`}
                    data-testid="search-pick"
                  />
                  <div className="hit-main">
                    <div className="hit-title ellipsis">{h.title}</div>
                    <div className="hit-snippet ellipsis">{h.snippet}</div>
                  </div>
                  <span className="hit-type">{TYPE_LABEL[h.type] ?? h.type}</span>
                  <button
                    className="btn btn-sm btn-quiet hit-open"
                    onClick={() => navigate(h.type === 'note' ? 'editor' : 'reader', { id: h.id, rep: h.id })}
                    data-testid="search-open"
                  >
                    打开
                    <Icon name="arrow" size={13} />
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <BatchBar ids={batch.ids} onDone={batch.clear} label="条目" />

      {facets?.tags?.length ? (
        <section className="section">
          <h2 className="rubric">
            <span className="rubric-no">#</span>
            按标签收窄
            <span className="rubric-rule" />
            <span className="rubric-meta">{facets.tags.length} 个</span>
          </h2>
          <div className="tag-cloud">
            {facets.tags.slice(0, 30).map((t) => (
              <button key={t.tag} className="tag" onClick={() => { setQ(t.tag); setSubmitted(t.tag); }} data-testid="search-tag">
                {t.tag}<sup>{t.n}</sup>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function TagsPage() {
  const { data, isLoading } = useTags();
  const [active, setActive] = useState<string | null>(null);
  const titles = useTitleMap();
  if (isLoading) return <PageSkeleton rows={2} />;
  const tags = [...(data?.tags ?? [])].sort((a, b) => b.ids.length - a.ids.length);
  const hit = tags.find((t) => t.tag === active);

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="连接 · 标签"
        title="标签"
        lede="标签是横切面：它不改变内容属于哪里，只标记它和什么有关。"
      />

      {tags.length === 0 ? (
        <Empty title="还没有标签" desc="在笔记的 frontmatter 里加 tags: [xxx]，它就会出现在这里。" />
      ) : (
        <>
          <p className="section-note" style={{ marginTop: 'var(--sp-4)' }}>
            {tags.length} 个标签 · 共被引用 {tags.reduce((n, t) => n + t.ids.length, 0)} 次。标签写在笔记的 frontmatter 里，不需要单独维护。
          </p>
          <div className="tag-cloud tag-cloud-lg">
            {tags.map((t) => (
              <button
                key={t.tag}
                className="tag"
                aria-pressed={active === t.tag}
                data-testid="tag-item"
                onClick={() => setActive(active === t.tag ? null : t.tag)}
              >
                {t.tag}<sup>{t.ids.length}</sup>
              </button>
            ))}
          </div>
        </>
      )}

      {hit && (
        <section className="section">
          <h2 className="rubric">
            <span className="rubric-no">#</span>
            {hit.tag}
            <span className="rubric-rule" />
            <span className="rubric-meta">{hit.ids.length} 个对象</span>
          </h2>
          {hit.ids.map((id) => {
            const t = titles.get(id);
            return (
              <div key={id} className="part">
                <span className="hit-type">{TYPE_LABEL[t?.type ?? ''] ?? t?.type ?? '对象'}</span>
                <span className="part-title ellipsis">{t?.title ?? id}</span>
                <button className="btn btn-sm btn-quiet" onClick={() => navigate('reader', { rep: id })}>打开</button>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

export function CollectionsPage() {
  const { data, isLoading } = useObjects('collection');
  const titles = useTitleMap();
  const openSheet = useUi((s) => s.openSheet);
  if (isLoading) return <PageSkeleton rows={3} />;
  const cols = (data?.objects ?? []) as unknown as { id: string; title: string; desc?: string; memberIds: string[]; query?: string }[];

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="连接 · 专题"
        title="专题"
        lede="人工清单 + 动态查询，两者取并集。专题是围绕一个问题的读法，不是文件夹。"
        actions={
          <button className="btn btn-sm btn-primary" onClick={() => openSheet('capture', { title: '新专题' })} data-testid="collection-new">
            <Icon name="plus" size={13} />
            新建专题
          </button>
        }
      />

      {cols.length === 0 ? (
        <Empty title="还没有专题" desc="专题 = 围绕一个问题的清单，可以手写成员，也可以写一条查询自动收。" />
      ) : (
        <div className="stagger">
          {cols.map((c) => (
            <article key={c.id} className="entry">
              <div className="entry-main">
                <div className="entry-title">
                  <h3>{c.title}</h3>
                  {c.query && <Chip tone="info">动态 · {c.query}</Chip>}
                  <span className="entry-kind">{c.memberIds.length} 个成员</span>
                </div>
                {c.desc && <p className="entry-desc">{c.desc}</p>}
                {c.memberIds.length > 0 && (
                  <div className="member-row">
                    {c.memberIds.slice(0, 6).map((m) => (
                      <button key={m} className="tag" onClick={() => navigate('reader', { rep: m })}>
                        {titles.get(m)?.title ?? m.slice(0, 12)}
                      </button>
                    ))}
                    {c.memberIds.length > 6 && <span className="mono muted">+{c.memberIds.length - 6}</span>}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

const TYPE_COLOR: Record<string, string> = {
  work: 'var(--accent)', note: 'var(--info)', project: 'var(--ok)', area: 'var(--warn)', collection: 'var(--danger)',
};

/** 一次性跑完的力导向布局：斥力 + 弹簧 + 向心。120 轮，220 个节点也就几十毫秒 */
function layout(nodes: { id: string }[], edges: { source: string; target: string }[]) {
  // 画布比例跟着版心走：760×520 在 1100 宽的容器里会被拉成 774 高，撑出屏幕
  const W = 1100;
  const H = 540;
  const n = nodes.length;
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const p = nodes.map((_, i) => ({
    x: W / 2 + Math.cos((i / Math.max(1, n)) * Math.PI * 2) * (n > 40 ? 170 : 150),
    y: H / 2 + Math.sin((i / Math.max(1, n)) * Math.PI * 2) * (n > 40 ? 170 : 150),
    vx: 0, vy: 0,
  }));
  // 斥力按节点数放大：11 个节点和 200 个节点需要的推力不是一个量级
  const rep = 900 + n * 190;
  for (let step = 0; step < 160; step++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = p[i].x - p[j].x;
        let dy = p[i].y - p[j].y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d = Math.sqrt(d2);
        const f = Math.min(rep / d2, 5);
        const ux = dx / d;
        const uy = dy / d;
        p[i].vx += ux * f; p[i].vy += uy * f;
        p[j].vx -= ux * f; p[j].vy -= uy * f;
      }
    }
    for (const e of edges) {
      const a = idx.get(e.source);
      const b = idx.get(e.target);
      if (a === undefined || b === undefined) continue;
      const dx = p[b].x - p[a].x;
      const dy = p[b].y - p[a].y;
      const d = Math.hypot(dx, dy) || 0.01;
      const k = (d - 96) * 0.022;
      const ux = dx / d;
      const uy = dy / d;
      p[a].vx += ux * k; p[a].vy += uy * k;
      p[b].vx -= ux * k; p[b].vy -= uy * k;
    }
    for (let i = 0; i < n; i++) {
      p[i].vx += (W / 2 - p[i].x) * 0.0016;
      p[i].vy += (H / 2 - p[i].y) * 0.0016;
      p[i].vx *= 0.80; p[i].vy *= 0.80;
      p[i].x = Math.max(56, Math.min(W - 56, p[i].x + p[i].vx));
      p[i].y = Math.max(36, Math.min(H - 36, p[i].y + p[i].vy));
    }
  }
  return p;
}

export function GraphPage() {
  const { data, isLoading } = useGraph(220);
  const [hover, setHover] = useState<string | null>(null);

  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const pos = useMemo(() => layout(nodes, edges), [nodes, edges]);
  const indexOf = useMemo(() => new Map(nodes.map((n, i) => [n.id, i])), [nodes]);
  const degree = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of edges) {
      m.set(e.source, (m.get(e.source) ?? 0) + 1);
      m.set(e.target, (m.get(e.target) ?? 0) + 1);
    }
    return m;
  }, [edges]);
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!m.has(e.source)) m.set(e.source, new Set());
      if (!m.has(e.target)) m.set(e.target, new Set());
      m.get(e.source)!.add(e.target);
      m.get(e.target)!.add(e.source);
    }
    return m;
  }, [edges]);
  // 标签只给度数最高的那些，其余靠 hover —— 220 个标签叠在一起谁都不好看
  const labelled = useMemo(
    () => new Set([...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, 14).map((n) => n.id)),
    [nodes, degree],
  );

  if (isLoading) return <PageSkeleton rows={2} />;

  const activeSet = hover ? neighbors.get(hover) : null;

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="连接 · 关系"
        title="关系"
        lede="双链长出来的图。按需探索，不是每天必经的页面——它回答「这东西和什么挨着」。"
        actions={<span className="mono muted">{nodes.length} 个节点 · {edges.length} 条链接</span>}
      />

      {nodes.length === 0 ? (
        <Empty title="库里还没有可连的对象" desc="多写几篇带 [[双链]] 的笔记就有了。" />
      ) : (
        <div className="graph-wrap">
          <svg className="graph-svg" viewBox="0 0 1100 540" role="img" aria-label="关系图" data-testid="graph-svg">
            <g className="graph-edges">
              {edges.map((e, i) => {
                const a = pos[indexOf.get(e.source) ?? -1];
                const b = pos[indexOf.get(e.target) ?? -1];
                if (!a || !b) return null;
                const dim = hover && hover !== e.source && hover !== e.target;
                return (
                  <line
                    key={i}
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={dim ? 'var(--border)' : 'var(--border-strong)'}
                    strokeWidth={dim ? 1 : 1.5}
                    opacity={dim ? 0.25 : 0.55}
                  />
                );
              })}
            </g>
            {nodes.map((n, i) => {
              const p = pos[i];
              const deg = degree.get(n.id) ?? 0;
              const r = Math.min(15, 6 + Math.sqrt(deg) * 2.8);
              const dim = hover !== null && hover !== n.id && !(activeSet?.has(n.id));
              const showLabel = hover === n.id || (labelled.has(n.id) && !hover);
              return (
                <g
                  key={n.id}
                  className="graph-node"
                  opacity={dim ? 0.28 : 1}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => navigate(n.type === 'note' ? 'editor' : 'reader', { id: n.id, rep: n.id })}
                >
                  <title>{n.title}</title>
                  <circle cx={p.x} cy={p.y} r={r} fill={TYPE_COLOR[n.type] ?? 'var(--text-3)'} />
                  {hover === n.id && <circle cx={p.x} cy={p.y} r={r + 6} fill="none" stroke={TYPE_COLOR[n.type] ?? 'var(--text-3)'} strokeWidth={1} opacity={0.5} />}
                  {showLabel && (
                    <text x={p.x + r + 4} y={p.y + 3.5} fontSize={hover === n.id ? 15 : 13} fill="var(--text-2)">
                      {n.title.slice(0, 16)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="graph-legend">
            {Object.entries(TYPE_COLOR).map(([t, c]) => (
              <span key={t} className="graph-legend-item">
                <i style={{ background: c }} />{TYPE_LABEL[t] ?? t}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
