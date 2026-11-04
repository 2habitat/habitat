/**
 * 阅读器（设计方案 §7）
 * 三栏：章节+大纲 / 正文 620–652px / 批注+血缘+反链
 * 位置分 current 与 furthest，回看不覆盖最远；原件只读，页面明说「可批注、可衍生，不改原文」
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { Card, Chip, Empty, Spinner, ErrorBox, Bar } from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
import { NOTE_STATUS } from '../../app/labels.ts';
import { useWork, useRep, useAnnotations, useRefresh } from '../../services/use.ts';
import { endpoints } from '../../services/api.ts';
import { useUi } from '../../app/ui.ts';
import { navigate, setParam } from '../../app/router.ts';

const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

export function ReaderPage({ workId, repId, partId }: { workId?: string; repId?: string; partId?: string }) {
  const { data: work } = useWork(workId ?? '');
  const refresh = useRefresh();
  const openSheet = useUi((s) => s.openSheet);
  const openAi = useUi((s) => s.openAi);
  const toast = useUi((s) => s.toast);

  // 没给 rep 就取这一章的 md 载体；没给 part 就从作品第一章开始
  const fallbackRep = useMemo(() => {
    if (repId) return repId;
    if (!work) return '';
    const parts = [...(work.parts ?? [])].sort((a, b) => a.part.order - b.part.order);
    const first = (partId ? parts.find((p) => p.part.id === partId) : undefined) ?? parts[0];
    const r = first?.reps?.find((x) => x.carrier === 'md') ?? first?.reps?.[0];
    return r?.id ?? '';
  }, [repId, work, partId]);

  const currentRep = repId || fallbackRep;
  const { data: repData, isLoading, error } = useRep(currentRep);
  const { data: anns } = useAnnotations(currentRep);
  const readingWidth = useUi((s) => s.readingWidth);
  const setReadingWidth = useUi((s) => s.setReadingWidth);
  const mainRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ text: string; top: number; left: number; from: number; to: number; prefix: string; suffix: string } | null>(null);
  const [pct, setPct] = useState(0);
  const lastSent = useRef(0);

  // 恢复阅读位置：进入时跳到上次读到的地方
  useEffect(() => {
    if (!repData || !mainRef.current) return;
    const el = mainRef.current;
    const target = repData.cursor.current;
    setPct(target);
    if (target > 0.005) {
      const prev = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto';
      const jump = () => {
        el.scrollTop = (el.scrollHeight - el.clientHeight) * target;
      };
      jump();
      requestAnimationFrame(() => {
        jump();
        el.style.scrollBehavior = prev;
      });
    }
  }, [repData?.rep.id, repData?.cursor.current]);

  // 滚动进度：节流上报，furthest 由服务端保证只增不减
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const onScroll = () => {
      const max = el.scrollHeight - el.clientHeight;
      const p = max > 0 ? Math.min(1, el.scrollTop / max) : 0;
      setPct(p);
      const now = Date.now();
      if (now - lastSent.current > 1200 && currentRep) {
        lastSent.current = now;
        void endpoints.cursor(currentRep, p);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [currentRep]);

  // 选中正文 → 工具条
  useEffect(() => {
    const onUp = () => {
      const s = window.getSelection();
      const text = s?.toString().trim() ?? '';
      const host = mainRef.current;
      if (!text || !s || !host || !host.contains(s.anchorNode)) {
        setSel(null);
        return;
      }
      const rect = s.getRangeAt(0).getBoundingClientRect();
      const full = host.innerText;
      const idx = full.indexOf(text);
      setSel({
        text,
        top: rect.top,
        left: rect.left + rect.width / 2,
        from: idx < 0 ? 0 : idx,
        to: idx < 0 ? text.length : idx + text.length,
        prefix: idx > 0 ? full.slice(Math.max(0, idx - 24), idx) : '',
        suffix: idx < 0 ? '' : full.slice(idx + text.length, idx + text.length + 24),
      });
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onUp);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onUp);
    };
  }, []);

  // 正文优先用服务端解析好的那份；正则兜底是为了旧缓存和 CRLF 文件不漏出 YAML
  const body = (repData?.body ?? repData?.content ?? '')
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
    .replace(/^\s*#\s+.+\r?\n+/, '');
  const carrier = repData?.rep.carrier ?? 'md';
  const fileUrl = currentRep ? `/api/reps/${encodeURIComponent(currentRep)}/file` : '';
  const html = carrier === 'html' ? body : md.render(body);
  const annList = anns?.annotations ?? [];
  const currentPart = work?.parts.find((p) => p.reps.some((r) => r.id === currentRep));
  const chapterTitle = currentPart?.part.title ?? '正文';
  const furthest = Math.round(((repData?.cursor.furthest ?? 0) as number) * 100);

  // 把批注的引文在正文里标出来。
  // 注意：这个 useMemo 必须在下面那几个提前 return 之前——hooks 不能放在条件分支后面。
  const marked = useMemo(() => {
    let out = html;
    for (const a of annList) {
      if (!a.quote || a.quote.length < 2) continue;
      const esc = a.quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        out = out.replace(new RegExp(esc, 'g'), (m) => `<mark data-ann="${a.id}" style="background:var(--hl-${a.color === 'yellow' ? 'yellow' : a.color === 'green' ? 'green' : a.color === 'blue' ? 'blue' : 'pink'})">${m}</mark>`);
      } catch {
        /* 引文里有正则特殊字符就跳过，不影响阅读 */
      }
    }
    return out;
  }, [html, annList]);

  if (workId && isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!repData) return <Empty title="选一章开始读" desc="从书架进，或者直接点左侧章节" action={<button className="btn" onClick={() => navigate('shelf')}>打开书架</button>} />;

  async function markReadDone() {
    try {
      await endpoints.cursor(currentRep, 1);
      toast('已标记读完', 'ok');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  return (
    <div className="reader" style={{ height: '100%' }}>
      <nav className="reader-toc" aria-label="章节">
        {work ? (
          <>
            <div className="toc-head">
              <div className="toc-work ellipsis" title={work.work.title}>{work.work.title}</div>
              <div className="toc-sub">{work.parts?.length ?? 0} 章 · 读 {Math.round(pct * 100)}%</div>
            </div>
            <div className="toc-list">
              {(work.parts ?? [])
                .slice()
                .sort((a, b) => a.part.order - b.part.order)
                .map((p, i) => {
                  const r = p.reps.find((x) => x.carrier === 'md') ?? p.reps[0];
                  return (
                    <button
                      key={p.part.id}
                      className={`toc-item ${p.part.supplemental ? 'toc-supplemental' : ''}`}
                      aria-current={r?.id === currentRep}
                      data-testid="toc-item"
                      onClick={() => r && setParam('rep', r.id, { work: workId ?? '' })}
                    >
                      <span className="toc-no">{String(i + 1).padStart(2, '0')}</span>
                      <span className="toc-label">{p.part.title}</span>
                      {p.annotations > 0 && <span className="toc-count">{p.annotations}</span>}
                    </button>
                  );
                })}
            </div>
            <div className="toc-foot">
              <span>当前 {Math.round(pct * 100)}%</span>
              <span className="mono">最远 {furthest}%</span>
            </div>
          </>
        ) : (
          <div className="small muted" style={{ padding: '8px 4px' }}>从书架进来才能看到章节列表。</div>
        )}
      </nav>

      <div className="reader-main" ref={mainRef} data-testid="reader-main">
        {/* 常驻阅读条：章节、进度、行宽、出口动作都在手边，不用滚到文末再回来 */}
        <div className="reader-bar">
          <span className="reader-chapter ellipsis" title={chapterTitle}>{chapterTitle}</span>
          <span className="reader-pct mono">{Math.round(pct * 100)}%</span>
          <span className="spacer" />
          <span className="reading-w" role="group" aria-label="行宽">
            {([['narrow', '窄'], ['normal', '中'], ['wide', '宽']] as const).map(([w, label]) => (
              <button
                key={w}
                className="btn btn-sm btn-quiet"
                aria-pressed={readingWidth === w}
                data-testid={`reading-${w}`}
                onClick={() => setReadingWidth(w)}
              >{label}</button>
            ))}
          </span>
          <button className="btn btn-sm btn-quiet" onClick={() => void markReadDone()} data-testid="reader-done">标记读完</button>
          <button className="btn btn-sm btn-quiet" onClick={() => openSheet('derive', { srcId: currentRep, title: '读后一得' })} data-testid="reader-derive">衍生</button>
          <button className="btn btn-sm btn-quiet" onClick={() => openAi({ kind: 'rep', id: currentRep, title: chapterTitle })}>
            <Icon name="assistant" size={13} />
            问
          </button>
          <button className="btn btn-sm" onClick={() => openSheet('annotate', { repId: currentRep })} data-testid="reader-annotate">批注</button>
          <span className="reader-bar-progress" aria-hidden="true"><i style={{ width: `${Math.round(pct * 100)}%` }} /></span>
        </div>

        {repData.locked && (
          <div className="notice" style={{ maxWidth: 'var(--reading-w)' }}>
            <Chip tone="warn">入库原件 · 只读</Chip>
            <span>可批注、可衍生，不改原文。要改就衍生一篇笔记。</span>
          </div>
        )}

        {carrier === 'pdf' && (
          <div className="pdf-wrap" data-testid="reader-pdf">
            {/* 浏览器内置 PDF 阅读器；用 iframe 而不是 embed，移动端表现更稳 */}
            <iframe className="pdf-frame" src={`${fileUrl}#view=FitH`} title="PDF 原文" />
            <div className="row row-wrap small muted" style={{ marginTop: 8 }}>
              <span>PDF 是原件，只读。要摘录就选中右侧批注，或衍生一篇笔记。</span>
              <span className="spacer" />
              <a className="btn btn-sm" href={fileUrl} target="_blank" rel="noreferrer">在新标签打开</a>
            </div>
          </div>
        )}

        {carrier === 'epub' && (
          <div className="panel" data-testid="reader-epub" style={{ maxWidth: 'var(--reading-w)' }}>
            <div className="row"><Chip tone="warn">EPUB · 暂不支持页内阅读</Chip></div>
            <p className="small" style={{ marginTop: 8 }}>
              浏览器不能原生渲染 EPUB。现在可以下载原件；要在这里读，先把 EPUB 转成 Markdown 放进 <code>parts/</code>。
            </p>
            <a className="btn btn-sm" href={fileUrl} download>下载 EPUB</a>
          </div>
        )}

        {(carrier === 'md' || carrier === 'html') && (
          <article className="prose" data-testid="reader-body" dangerouslySetInnerHTML={{ __html: marked }} />
        )}

        <div className="reader-end">
          <span className="reader-end-mark">※</span>
          读到这里。回看不会把最远位置清掉——最远 {furthest}%。
        </div>
      </div>

      <aside className="reader-aside">
        <Card title="批注" desc={`${annList.length} 条`}>
          {annList.length === 0
            ? <p className="section-note">选中正文就能划重点、写批注。批注会记在事件流里，可追溯。</p>
            : annList.map((a) => (
              <div key={a.id} className="ann" data-testid="annotation-item">
                <span className="ann-color" data-color={a.color} aria-hidden="true" />
                <div className="ann-body">
                  <blockquote className="ann-quote">{a.quote}</blockquote>
                  {a.note && <p className="ann-note">{a.note}</p>}
                  <div className="ann-foot">
                    <span className="mono">{a.author.startsWith('agent:') ? `AI·${a.author.slice(6)}` : '我'} · {a.createdAt.slice(5, 10)}</span>
                    <button
                      className="btn btn-sm btn-quiet"
                      onClick={() => openSheet('derive', { srcId: currentRep, title: '由批注衍生', body: `\n\n> ${a.quote}\n\n${a.note ?? ''}\n` })}
                    >
                      由此衍生
                    </button>
                  </div>
                </div>
              </div>
            ))}
        </Card>

        {work && (
          <Card title="血缘" desc="从这里长出去的东西">
            {(work.derived ?? []).length === 0
              ? <p className="section-note">还没有衍生。读到有想法的地方，选中一段就能长出笔记。</p>
              : (work.derived ?? []).map((d) => (
                <button key={d.id} className="lineage" onClick={() => navigate('editor', { id: d.id })}>
                  <Icon name="pen" size={13} />
                  <span className="ellipsis">{d.title}</span>
                  <span className="mono muted">{NOTE_STATUS[d.status] ?? d.status}</span>
                </button>
              ))}
          </Card>
        )}
      </aside>

      {sel && (
        <div className="selbar" style={{ top: sel.top - 8, left: sel.left }} data-testid="selbar">
          <button onClick={() => openSheet('annotate', { repId: currentRep, quote: sel.text, from: sel.from, to: sel.to, prefix: sel.prefix, suffix: sel.suffix })} data-testid="sel-annotate">
            批注
          </button>
          <button onClick={() => openSheet('derive', { srcId: currentRep, title: '读后一得', body: `\n\n> ${sel.text}\n\n` })} data-testid="sel-derive">
            衍生
          </button>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(`> ${sel.text}`);
              toast('引文已复制', 'ok');
              setSel(null);
            }}
          >
            复制引用
          </button>
          <button
            onClick={() => {
              void endpoints.annotate({ repId: currentRep, quote: sel.text, color: 'yellow', from: sel.from, to: sel.to, prefix: sel.prefix, suffix: sel.suffix });
              toast('已高亮', 'ok');
              setSel(null);
              refresh();
            }}
            data-testid="sel-highlight"
          >
            高亮
          </button>
        </div>
      )}
    </div>
  );
}
