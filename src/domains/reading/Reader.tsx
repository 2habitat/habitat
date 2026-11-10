/**
 * 阅读器（设计方案 §7）
 * 三栏：章目录 + 章内小节 / 正文 / 边注
 *
 * 这一版把「读」放在第一位：
 * - 正文按字数定行宽（30/34/40 字），字号可调，行宽自动跟着走
 * - 批注长在正文外侧（边注），空间不够时自动落到文末，不再是独立卡片栏
 * - 进度只出现一次（阅读条下沿），工具栏只留在手边的四个动作
 * - 位置按标题锚点存，换字号、换窗口都不会漂
 *
 * 原文只读：可批注、可衍生，不改原文。
 */
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { Chip, Empty, Spinner, ErrorBox } from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
import { NOTE_STATUS } from '../../app/labels.ts';
import { useWork, useRep, useAnnotations, useRefresh } from '../../services/use.ts';
import { BuildButton } from '../../components/BuildButton.tsx';
import { endpoints } from '../../services/api.ts';
import type { AnnotationView } from '../../services/api.ts';
import { onMarkdownReady, prepareMarkdown, renderMarkdown } from '../../services/markdown.ts';
import { useUi } from '../../app/ui.ts';
import { navigate, setParam } from '../../app/router.ts';

/* ---------------- 纯工具 ---------------- */

interface OutlineItem { id: string; text: string; level: number }

interface SavedPos { id?: string; offset?: number; ratio?: number }

const HL_COLORS = new Set(['yellow', 'green', 'blue', 'pink']);
const POS_PREFIX = 'habitat.reader.pos.';

/** 旧缓存和 CRLF 文件可能把 YAML / 首个大标题漏出来，这里兜一层 */
function stripFrontmatter(raw: string): string {
  return raw
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
    .replace(/^\s*#\s+.+\r?\n+/, '');
}

function readPos(repId: string): SavedPos | null {
  try {
    const raw = localStorage.getItem(POS_PREFIX + repId);
    return raw ? JSON.parse(raw) as SavedPos : null;
  } catch {
    return null;
  }
}

function writePos(repId: string, pos: SavedPos): void {
  try {
    localStorage.setItem(POS_PREFIX + repId, JSON.stringify(pos));
  } catch {
    /* 隐私模式写不了就算了，服务端还有百分比兜底 */
  }
}

/**
 * 在渲染好的正文里找一段引文，返回 Range。
 * 优先用前后文判定，避免同一段话出现两次时标错位置。
 */
function findQuoteRange(root: HTMLElement, quote: string, prefix?: string, suffix?: string): Range | null {
  if (!quote || quote.length < 2) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script, style, pre, .footnotes')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  let cursor: Node | null = walker.nextNode();
  while (cursor) {
    const t = cursor as Text;
    nodes.push({ node: t, start: text.length });
    text += t.data;
    cursor = walker.nextNode();
  }

  let best = -1;
  let bestScore = -1;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(quote, from);
    if (at < 0) break;
    let score = 0;
    if (prefix && text.slice(Math.max(0, at - prefix.length), at) === prefix) score += 2;
    if (suffix && text.slice(at + quote.length, at + quote.length + suffix.length) === suffix) score += 2;
    if (score > bestScore) { bestScore = score; best = at; }
    if (bestScore === 4) break;
    from = at + 1;
  }
  if (best < 0) return null;

  // 起点用 <=，终点必须用 <：否则终点会落到下一段的第一个字，
  // Range 就会「部分选中」整个 <p>，extractContents 会把段落整块克隆进 <mark>。
  const locate = (offset: number, isEnd: boolean) => {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const hit = isEnd ? nodes[i].start < offset : nodes[i].start <= offset;
      if (hit) return { node: nodes[i].node, offset: Math.min(offset - nodes[i].start, nodes[i].node.data.length) };
    }
    return nodes[0] ? { node: nodes[0].node, offset: 0 } : null;
  };
  const start = locate(best, false);
  const end = locate(best + quote.length, true);
  if (!start || !end) return null;

  const range = document.createRange();
  try {
    range.setStart(start.node, Math.min(start.offset, start.node.data.length));
    range.setEnd(end.node, Math.min(end.offset, end.node.data.length));
  } catch {
    return null;
  }
  return range;
}

/** 把批注画进正文：先拆掉旧 <mark>，再按引文重新包 */
function applyMarks(root: HTMLElement, anns: AnnotationView[]): void {
  root.querySelectorAll('mark[data-ann]').forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  });
  root.normalize();

  for (const a of anns) {
    const range = findQuoteRange(root, a.quote, a.locator?.prefix, a.locator?.suffix);
    if (!range) continue;
    const mark = document.createElement('mark');
    mark.className = 'ann-mark';
    mark.dataset.ann = a.id;
    mark.dataset.color = HL_COLORS.has(a.color) ? a.color : 'yellow';
    try {
      // 引文跨块时不包：inline 的 <mark> 里塞进 <p> 会把版面打散
      if (range.cloneContents().querySelector('p, div, li, blockquote, pre, table, ul, ol, h1, h2, h3, h4, section')) continue;
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
    } catch {
      /* 包不住就跳过，不影响正文 */
    }
  }
}

function buildOutline(root: HTMLElement): OutlineItem[] {
  return [...root.querySelectorAll<HTMLElement>('h2, h3')]
    .filter((h) => h.id)
    .map((h) => ({ id: h.id, text: (h.textContent ?? '').trim(), level: h.tagName === 'H2' ? 2 : 3 }))
    .filter((x) => x.text.length > 0);
}

function sameOutline(a: OutlineItem[], b: OutlineItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.text === b[i].text && x.level === b[i].level);
}

/* ---------------- 页面 ---------------- */

export function ReaderPage({ workId, repId, partId, noteId }: { workId?: string; repId?: string; partId?: string; noteId?: string }) {
  const { data: work } = useWork(workId ?? '');
  const refresh = useRefresh();
  const openSheet = useUi((s) => s.openSheet);
  const openAi = useUi((s) => s.openAi);
  const addAiRef = useUi((s) => s.addAiRef);
  const toast = useUi((s) => s.toast);

  const readingWidth = useUi((s) => s.readingWidth);
  const setReadingWidth = useUi((s) => s.setReadingWidth);
  const readerSize = useUi((s) => s.readerSize);
  const setReaderSize = useUi((s) => s.setReaderSize);
  const readerFont = useUi((s) => s.readerFont);
  const setReaderFont = useUi((s) => s.setReaderFont);
  const readerIndent = useUi((s) => s.readerIndent);
  const setReaderIndent = useUi((s) => s.setReaderIndent);

  // 没给 rep 就取这一章的 md 载体；没给 part 就从作品第一章开始
  const fallbackRep = useMemo(() => {
    if (repId) return repId;
    if (!work) return '';
    const parts = [...(work.parts ?? [])].sort((a, b) => a.part.order - b.part.order);
    const first = (partId ? parts.find((p) => p.part.id === partId) : undefined) ?? parts[0];
    const r = first?.reps?.find((x) => x.carrier === 'md') ?? first?.reps?.[0];
    return r?.id ?? '';
  }, [repId, work, partId]);

  const currentRep = repId || noteId || fallbackRep;
  const { data: repData, isLoading, error } = useRep(currentRep);
  const { data: anns } = useAnnotations(currentRep);
  // 空引文的历史批注不参与渲染：包不住，也不该占一条边注
  const annList = useMemo(
    () => (anns?.annotations ?? []).filter((a) => (a.quote ?? '').trim().length >= 2),
    [anns],
  );

  const mainRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const notesRef = useRef<HTMLElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const aaRef = useRef<HTMLDivElement>(null);
  const lastSent = useRef(0);
  const lastSaved = useRef(0);
  const restoredFor = useRef('');
  // 选区回调只挂一次，用 ref 拿「此刻是哪一章」，避免闭包里是首帧的空 rep
  const repRef = useRef(currentRep);
  repRef.current = currentRep;

  // 选区只存「引文 + 定位 + 所属章」：动作都在阅读条里，不再需要屏幕坐标
  const [sel, setSel] = useState<{ text: string; rep: string; from: number; to: number; prefix: string; suffix: string } | null>(null);
  // 换章后旧选区自然失效；用比对而不是 effect 清空，避免「刚选完就被切章副作用清掉」的竞态
  const liveSel = sel && sel.rep === currentRep ? sel : null;
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [activeId, setActiveId] = useState('');
  const [aaOpen, setAaOpen] = useState(false);
  // 划错的批注：先在原位问一句，确认了才真删（不弹窗打断阅读）
  const [delId, setDelId] = useState('');
  const [deleting, setDeleting] = useState('');
  // 手机上目录收进抽屉：横排 chip 占一整行，阅读区就少了一屏的第一段
  const [tocOpen, setTocOpen] = useState(false);
  const [focus, setFocus] = useState(false);
  const [mdReady, setMdReady] = useState(false);

  // 代码高亮是异步准备的：好了重渲一次，没好也不挡阅读
  useEffect(() => {
    void prepareMarkdown();
    return onMarkdownReady(() => setMdReady(true));
  }, []);

  const body = stripFrontmatter(repData?.body ?? repData?.content ?? '');
  const carrier = repData?.rep.carrier ?? 'md';
  const fileUrl = currentRep ? `/api/reps/${encodeURIComponent(currentRep)}/file` : '';
  const html = useMemo(
    () => (carrier === 'html' ? body : renderMarkdown(body)),
    [body, carrier, mdReady],
  );

  const noteTitle = useMemo(() => {
    if (!noteId) return '';
    const raw = (repData?.content ?? '').split('\r').join('');
    const lines = raw.split('\n');
    let inFm = false;
    let title = '';
    for (const line of lines) {
      if (line.trim() === '---') {
        if (!inFm) { inFm = true; continue; }
        break;
      }
      if (inFm && line.startsWith('title:')) {
        title = line.slice(6).trim().replace(/^["']|["']$/g, '');
      }
    }
    if (title) return title;
    const heading = (repData?.body ?? '').split('\n').find((l) => l.startsWith('# '));
    return heading ? heading.slice(2).trim() : '笔记';
  }, [noteId, repData?.content, repData?.body]);

  const currentPart = work?.parts.find((p) => p.reps.some((r) => r.id === currentRep));
  const chapterTitle = noteId ? noteTitle : currentPart?.part.title ?? '正文';
  const furthest = Math.round(((repData?.cursor.furthest ?? 0) as number) * 100);
  const isDoc = carrier === 'md' || carrier === 'html';

  const charCount = useMemo(() => body.replace(/\s+/g, '').length, [body]);
  const minutes = Math.max(1, Math.round(charCount / 400));
  // 章节顺序只排一次：章号、下一章都从同一个序列里取，避免两套顺序打架
  const orderedParts = useMemo(
    () => [...(work?.parts ?? [])].sort((a, b) => a.part.order - b.part.order),
    [work],
  );
  const partIndex = useMemo(
    () => (currentPart ? orderedParts.findIndex((p) => p.part.id === currentPart.part.id) : -1),
    [orderedParts, currentPart],
  );
  const chapterOrder = partIndex >= 0 ? partIndex + 1 : 0;
  const nextPart = partIndex >= 0 ? orderedParts[partIndex + 1] : undefined;
  const nextRep = nextPart ? (nextPart.reps.find((r) => r.carrier === 'md') ?? nextPart.reps[0]) : undefined;

  /* ---- 边注对齐：把每条批注贴到它引文的那一行 ---- */
  const placeNotes = useCallback(() => {
    const art = articleRef.current;
    const host = notesRef.current;
    if (!art || !host) return;
    // 边注列的起点是 flow 顶部（章扉页那一行），不是正文顶部
    const base = host.getBoundingClientRect().top;
    let prevBottom = -Infinity;
    host.querySelectorAll<HTMLElement>('.mnote').forEach((note) => {
      const id = note.dataset.anchor;
      const mark = id ? art.querySelector<HTMLElement>(`mark[data-ann="${CSS.escape(id)}"]`) : null;
      let y = mark ? mark.getBoundingClientRect().top - base : (Number.isFinite(prevBottom) ? prevBottom + 28 : 0);
      if (y < prevBottom + 18) y = prevBottom + 18;
      note.style.transform = `translateY(${Math.max(0, Math.round(y))}px)`;
      prevBottom = y + note.offsetHeight;
    });
  }, []);

  /* ---- 渲染后：画批注、建大纲、对齐边注 ---- */
  useLayoutEffect(() => {
    const art = articleRef.current;
    if (!art) return;
    // 裸 table 没法在 CSS 里加滚动容器，这里补一层；重渲后重新包，不会叠加
    art.querySelectorAll('table').forEach((table) => {
      const parent = table.parentElement;
      if (parent?.classList.contains('table-scroll')) return;
      const wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      parent?.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
    applyMarks(art, annList);
    const next = buildOutline(art);
    setOutline((prev) => (sameOutline(prev, next) ? prev : next));
    placeNotes();
  }, [html, annList, placeNotes]);

  useEffect(() => {
    const art = articleRef.current;
    if (!art || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => placeNotes());
    ro.observe(art);
    window.addEventListener('resize', placeNotes);
    return () => { ro.disconnect(); window.removeEventListener('resize', placeNotes); };
    // 正文第一次挂载时 articleRef 才有值，repData 变了要重新观察
  }, [placeNotes, repData?.rep.id, html]);

  /* ---- 位置：按标题锚点存，换字号不漂 ---- */
  const savePos = useCallback(() => {
    const el = mainRef.current;
    const art = articleRef.current;
    if (!el || !art || !currentRep) return;
    const top = el.getBoundingClientRect().top;
    let current: HTMLElement | null = null;
    for (const h of art.querySelectorAll<HTMLElement>('h2, h3')) {
      if (h.getBoundingClientRect().top - top <= 72) current = h;
      else break;
    }
    if (current) {
      const docTop = current.getBoundingClientRect().top - top + el.scrollTop;
      writePos(currentRep, { id: current.id, offset: Math.max(0, Math.round(el.scrollTop - docTop)) });
    } else {
      const max = el.scrollHeight - el.clientHeight;
      writePos(currentRep, { ratio: max > 0 ? el.scrollTop / max : 0 });
    }
  }, [currentRep]);

  useEffect(() => {
    if (!repData || !mainRef.current || !articleRef.current) return;
    if (restoredFor.current === repData.rep.id) return;
    restoredFor.current = repData.rep.id;

    const el = mainRef.current;
    const saved = readPos(repData.rep.id);
    requestAnimationFrame(() => {
      let top = 0;
      if (saved?.id) {
        const heading = articleRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(saved.id)}"]`);
        if (heading) {
          const docTop = heading.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
          // 停在节首时要让开吸顶条；已经滚进本节很远了就按原偏移还原
          const shift = (saved.offset ?? 0) < 80 ? 56 : 0;
          top = docTop + (saved.offset ?? 0) - shift;
        }
      }
      if (!top && saved?.ratio) top = (el.scrollHeight - el.clientHeight) * saved.ratio;
      if (!top && repData.cursor.current > 0.005) top = (el.scrollHeight - el.clientHeight) * repData.cursor.current;
      // 新章没有存档时必须显式回到顶部：否则会沿用上一章滚到底的 scrollTop，
      // 点「下一章」进去直接落在文末，等于没翻页
      el.scrollTop = Math.max(0, top);
    });
  }, [repData?.rep.id, html]);

  /* ---- 一屏就放得下的章：滚不动就没有滚动事件，进度永远报不上来 ---- */
  useEffect(() => {
    const el = mainRef.current;
    if (!el || !currentRep || !isDoc || body.trim().length === 0) return;
    const t = setTimeout(() => {
      // 停留几秒之后还没溢出，说明整章就在眼前——这一章可以算读完
      if (el.scrollHeight - el.clientHeight > 8) return;
      void endpoints.cursor(currentRep, 1);
    }, 4000);
    return () => clearTimeout(t);
  }, [currentRep, html, isDoc, body]);

  /* ---- 滚动：只改进度条和当前小节，不整页重渲 ---- */
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const max = el.scrollHeight - el.clientHeight;
        const p = max > 0 ? Math.min(1, el.scrollTop / max) : 0;
        if (barRef.current) barRef.current.style.width = `${(p * 100).toFixed(2)}%`;

        const art = articleRef.current;
        if (art) {
          const top = el.getBoundingClientRect().top;
          let current = '';
          for (const h of art.querySelectorAll<HTMLElement>('h2, h3')) {
            if (h.getBoundingClientRect().top - top <= 72) current = h.id;
            else break;
          }
          setActiveId((prev) => (prev === current ? prev : current));
        }

        const now = Date.now();
        if (now - lastSaved.current > 900) { lastSaved.current = now; savePos(); }
        if (now - lastSent.current > 1200 && currentRep) {
          lastSent.current = now;
          void endpoints.cursor(currentRep, p);
        }
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // 首帧 mainRef 还是 null（数据没回来），必须等 rep 挂载后再绑一次
  }, [currentRep, savePos, repData?.rep.id]);

  /* ---- 选中正文 → 阅读条切到选区模式 ---- */
  useEffect(() => {
    const onUp = (e: Event) => {
      // e.target 可能是 document（合成事件），所以 closest 也要可选调用
      const t = e.target as Element | null;
      // 点阅读条自己的按钮时不能重算选区：mouseup 先于 click，重算会把 sel 清掉，
      // 点「高亮」就变成了点空。表单控件同理（批注抽屉里打字）。
      if (t?.closest?.('.reader-bar, .sheet, .overlay, input, textarea, select, [contenteditable="true"]')) return;

      const s = window.getSelection();
      const text = s?.toString().trim() ?? '';
      const host = articleRef.current;
      if (!text || !s || s.rangeCount === 0 || !host || !host.contains(s.anchorNode)) {
        setSel(null);
        return;
      }
      const range = s.getRangeAt(0);

      let prefix = '';
      let suffix = '';
      try {
        const pre = document.createRange();
        pre.selectNodeContents(host);
        pre.setEnd(range.startContainer, range.startOffset);
        prefix = pre.toString().slice(-24);
      } catch { /* 选区起点不在正文里，就不留上下文 */ }
      try {
        const post = document.createRange();
        post.selectNodeContents(host);
        post.setStart(range.endContainer, range.endOffset);
        suffix = post.toString().slice(0, 24);
      } catch { /* 同上 */ }

      const from = host.innerText.indexOf(text);
      setSel({
        text,
        rep: repRef.current,
        from: from < 0 ? 0 : from,
        to: from < 0 ? text.length : from + text.length,
        prefix,
        suffix,
      });
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onUp);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onUp);
    };
  }, []);

  const clearSel = useCallback(() => {
    try { window.getSelection()?.removeAllRanges(); } catch { /* 选区跨了 shadow root 之类，清不掉就算了 */ }
    setSel(null);
  }, []);

  /* ---- Esc 退出选区模式 ---- */
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clearSel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sel, clearSel]);

  /* ---- 换章后把旧选区真正扔掉（比对 rep，不会误清刚选的新选区） ---- */
  useEffect(() => {
    if (sel && sel.rep !== currentRep) setSel(null);
  }, [sel, currentRep]);

  /* ---- Aa 面板：点外面或 Esc 关掉 ---- */
  useEffect(() => {
    if (!aaOpen) return;
    const onDown = (e: PointerEvent) => {
      if (aaRef.current && !aaRef.current.contains(e.target as Node)) setAaOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAaOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [aaOpen]);

  /* ---- 专注模式：F 收起两侧 ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setFocus((v) => !v); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const scrollToId = (id: string) => {
    const el = mainRef.current;
    const target = articleRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    if (!el || !target) return;
    el.scrollTo({
      top: target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 56,
      behavior: 'smooth',
    });
    setActiveId(id);
  };

  const jumpToMark = (annId: string) => {
    const el = mainRef.current;
    const mark = articleRef.current?.querySelector<HTMLElement>(`mark[data-ann="${CSS.escape(annId)}"]`);
    if (!el || !mark) return;
    el.scrollTo({
      top: mark.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 120,
      behavior: 'smooth',
    });
  };

  if ((workId || noteId) && isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!repData) {
    return (
      <Empty
        title={noteId ? '这篇笔记读不到' : '选一章开始读'}
        desc={noteId ? '文件可能被移动或删除；从书架「笔记」分类重新打开。' : '从书架进，或者直接点左侧章节'}
        action={<button className="btn" onClick={() => navigate('shelf')}>打开书架</button>}
      />
    );
  }

  const editParams: Record<string, string> = noteId ? { id: currentRep } : { rep: currentRep };

  async function markReadDone() {
    try {
      await endpoints.cursor(currentRep, 1);
      toast('已标记读完', 'ok');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  async function removeAnnotation(id: string) {
    setDeleting(id);
    try {
      await endpoints.removeAnnotation(id);
      setDelId('');
      toast('已删除批注，高亮同时移除', 'ok');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setDeleting('');
    }
  }

  /* ---- 选区动作：都从阅读条发起，不盖正文 ---- */
  async function highlightSelection() {
    const s = liveSel;
    if (!s) return;
    try {
      // 必须等写入回来再 refresh：否则重取可能跑在 POST 前面，界面看起来「点了没反应」
      await endpoints.annotate({
        repId: currentRep, quote: s.text, color: 'yellow',
        from: s.from, to: s.to, prefix: s.prefix, suffix: s.suffix,
      });
      clearSel();
      toast('已高亮', 'ok');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  function annotateSelection() {
    const s = liveSel;
    if (!s) return;
    openSheet('annotate', {
      repId: currentRep, quote: s.text, from: s.from, to: s.to, prefix: s.prefix, suffix: s.suffix,
    }, clearSel);
  }

  function deriveSelection() {
    const s = liveSel;
    if (!s) return;
    openSheet('derive', { srcId: currentRep, title: '读后一得', body: `\n\n> ${s.text}\n\n` }, clearSel);
  }

  function copySelection() {
    const s = liveSel;
    if (!s) return;
    void navigator.clipboard.writeText(`> ${s.text}`);
    toast('引文已复制', 'ok');
    clearSel();
  }

  function goNextChapter() {
    if (!nextRep) return;
    clearSel();
    setParam('rep', nextRep.id, { work: workId ?? '' });
  }

  /** 选中一段 → 加入助手引用。锚点复用批注的 from/to/prefix/suffix，不另造一套。 */
  function referenceSelection() {
    const s = liveSel;
    if (!s) return;
    addAiRef({
      id: `ref-${currentRep}-${s.from}-${s.to}`,
      kind: 'quote',
      objectId: currentRep,
      title: chapterTitle,
      revision: repData?.rep.rev ?? 0,
      quote: {
        repId: currentRep,
        quote: s.text,
        from: s.from,
        to: s.to,
        prefix: s.prefix,
        suffix: s.suffix,
        headingId: activeId || undefined,
        revision: repData?.rep.rev ?? 0,
      },
      addedBy: 'user',
    });
    openAi({ kind: 'rep', id: currentRep, title: chapterTitle, revision: repData?.rep.rev ?? 0 });
    toast('已加入助手引用', 'ok');
    clearSel();
  }

  return (
    <div className="reader" data-focus={focus ? '1' : undefined} style={{ height: '100%' }}>
      <nav className="reader-toc" aria-label="章节">
        {work ? (
          <>
            <div className="toc-head">
              <div className="toc-work ellipsis" title={work.work.title}>{work.work.title}</div>
              <div className="toc-sub">{work.parts?.length ?? 0} 章</div>
            </div>
            <div className="toc-list">
              {(work.parts ?? [])
                .slice()
                .sort((a, b) => a.part.order - b.part.order)
                .map((p, i) => {
                  const r = p.reps.find((x) => x.carrier === 'md') ?? p.reps[0];
                  const active = r?.id === currentRep;
                  return (
                    <div key={p.part.id} className="toc-group">
                      <button
                        className={`toc-item ${p.part.supplemental ? 'toc-supplemental' : ''}`}
                        aria-current={active}
                        data-testid="toc-item"
                        onClick={() => r && setParam('rep', r.id, { work: workId ?? '' })}
                      >
                        <span className="toc-no">{String(i + 1).padStart(2, '0')}</span>
                        <span className="toc-label">{p.part.title}</span>
                        {p.annotations > 0 && <span className="toc-count">{p.annotations}</span>}
                      </button>
                      {active && outline.length > 0 && (
                        <div className="toc-sections">
                          {outline.map((item) => (
                            <button
                              key={item.id}
                              className="toc-section"
                              data-level={item.level}
                              aria-current={activeId === item.id}
                              onClick={() => scrollToId(item.id)}
                            >
                              {item.text}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
            <div className="toc-foot">
              <span>最远 {furthest}%</span>
            </div>
          </>
        ) : noteId ? (
          <>
            <div className="toc-head">
              <div className="toc-work ellipsis" title={noteTitle}>{noteTitle}</div>
              <div className="toc-sub">笔记</div>
            </div>
            <div className="toc-list">
              {outline.length === 0 ? (
                <div className="small muted" style={{ padding: '8px 4px' }}>这篇笔记没有小标题。</div>
              ) : outline.map((item) => (
                <button
                  key={item.id}
                  className="toc-section"
                  data-level={item.level}
                  aria-current={activeId === item.id}
                  onClick={() => scrollToId(item.id)}
                >
                  {item.text}
                </button>
              ))}
            </div>
            <div className="toc-foot"><span>约 {minutes} 分钟</span></div>
          </>
        ) : (
          <div className="small muted" style={{ padding: '8px 4px' }}>从书架进来才能看到章节列表。</div>
        )}
      </nav>

      <div className="reader-main" ref={mainRef} data-testid="reader-main">
        {/* 常驻阅读条：四个动作 + 一条进度，进度只在条的下沿长一次 */}
        <div className="reader-bar">
          <button
            className="bar-btn toc-btn"
            onClick={() => setTocOpen(true)}
            data-testid="reader-toc-open"
            title="目录"
          >
            <Icon name="menu" size={13} /><span>目录</span>
          </button>
          {liveSel ? (
            /* 选区模式：动作就在阅读条里，正文一个字都不盖 */
            <>
              <span className="reader-sel-count" data-testid="sel-count">
                已选 <b className="mono">{liveSel.text.length.toLocaleString('zh-CN')}</b> 字
              </span>
              <button
                className="bar-btn bar-btn-icon"
                onClick={clearSel}
                title="取消选择（Esc）"
                aria-label="取消选择"
                data-testid="sel-clear"
              >
                <Icon name="close" size={12} />
              </button>
              <span className="reader-bar-spacer" />
              <span className="reader-sel-actions" data-testid="selbar" role="toolbar" aria-label="选中的文字">
                <button className="bar-btn bar-btn-accent" onClick={highlightSelection} data-testid="sel-highlight">高亮</button>
                <button className="bar-btn" onClick={annotateSelection} data-testid="sel-annotate">批注</button>
                <button className="bar-btn" onClick={referenceSelection} data-testid="sel-reference">引用</button>
                <button className="bar-btn" onClick={deriveSelection} data-testid="sel-derive">衍生</button>
                <button className="bar-btn" onClick={copySelection}>复制引用</button>
              </span>
            </>
          ) : (
            <>
              <span className="reader-chapter ellipsis" title={chapterTitle}>{chapterTitle}</span>
              <span className="reader-bar-spacer" />
              {repData && !repData.locked && (
                <button className="bar-btn" onClick={() => navigate('editor', editParams)} data-testid="reader-edit" title={noteId ? '编辑这篇笔记' : '编辑这一章'}>
                  编辑
                </button>
              )}
              {work && <BuildButton workId={work.work.id} compact showStatus={false} />}
              {work?.hasData && <button className="bar-btn" onClick={() => navigate('data', { work: work.work.id })} title="编辑数据">数据</button>}
              <button className="bar-btn" onClick={() => void markReadDone()} data-testid="reader-done" title="标记读完">
                <Icon name="check" size={13} /><span>读完</span>
              </button>
              <button
                className="bar-btn"
                onClick={() => openSheet('derive', { srcId: currentRep, title: '读后一得' })}
                data-testid="reader-derive"
                title="衍生一篇笔记"
              >
                <Icon name="pen" size={13} /><span>衍生</span>
              </button>

              <div className="reader-aa" ref={aaRef}>
                <button
                  className="bar-btn"
                  aria-expanded={aaOpen}
                  aria-haspopup="dialog"
                  data-testid="reader-aa"
                  title="阅读设置"
                  onClick={() => setAaOpen((v) => !v)}
                >Aa</button>
                {aaOpen && (
                  <div className="aa-panel" role="dialog" aria-label="阅读设置">
                    <div className="aa-row">
                      <span className="aa-label">字号</span>
                      <div className="aa-seg">
                        <button onClick={() => setReaderSize(readerSize - 1)} disabled={readerSize <= 15} aria-label="减小字号">−</button>
                        <b className="mono">{readerSize}</b>
                        <button onClick={() => setReaderSize(readerSize + 1)} disabled={readerSize >= 20} aria-label="增大字号">＋</button>
                      </div>
                    </div>
                    <div className="aa-row">
                      <span className="aa-label">行宽</span>
                      <div className="aa-seg">
                        {([['narrow', '窄'], ['normal', '中'], ['wide', '宽'], ['full', '满']] as const).map(([w, label]) => (
                          <button
                            key={w}
                            data-testid={`reading-${w}`}
                            aria-pressed={readingWidth === w}
                            onClick={() => setReadingWidth(w)}
                          >{label}</button>
                        ))}
                      </div>
                    </div>
                    <div className="aa-row">
                      <span className="aa-label">字体</span>
                      <div className="aa-seg">
                        <button aria-pressed={readerFont === 'sans'} onClick={() => setReaderFont('sans')}>黑</button>
                        <button aria-pressed={readerFont === 'serif'} onClick={() => setReaderFont('serif')}>宋</button>
                      </div>
                    </div>
                    <div className="aa-row">
                      <span className="aa-label">缩进</span>
                      <div className="aa-seg">
                        <button aria-pressed={!readerIndent} onClick={() => setReaderIndent(false)}>关</button>
                        <button aria-pressed={readerIndent} onClick={() => setReaderIndent(true)}>开</button>
                      </div>
                    </div>
                    <p className="aa-note">窄/中/宽按「几个字」算，改字号不会把每行字数带跑。「满」铺满整列，批注落到文末。</p>
                  </div>
                )}
              </div>

              <button
                className="bar-btn bar-btn-icon"
                onClick={() => openAi({ kind: 'rep', id: currentRep, title: chapterTitle })}
                title="问这一章"
                data-testid="reader-ask"
              >
                <Icon name="assistant" size={14} />
              </button>
              <button
                className="bar-btn bar-btn-accent"
                onClick={() => openSheet('annotate', { repId: currentRep })}
                data-testid="reader-annotate"
              >
                批注
                {annList.length > 0 && <span className="bar-count">{annList.length}</span>}
              </button>
              <button
                className="bar-btn bar-btn-icon"
                aria-pressed={focus}
                onClick={() => setFocus((v) => !v)}
                title="专注模式（F）"
                data-testid="reader-focus"
              >
                <Icon name="panel" size={14} />
              </button>
            </>
          )}
          <span className="reader-bar-progress" aria-hidden="true"><i ref={barRef} /></span>
        </div>

        {repData.locked && (
          <div className="reader-notice-wrap">
            <div className="notice reader-notice">
              <Chip tone="warn">入库原件 · 只读</Chip>
              <span>可批注、可衍生，不改原文。</span>
            </div>
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

        {isDoc && (
          <div className="reader-flow">
            <header className="reader-opening">
              <p className="reader-kicker">
                {noteId
                  ? '笔记'
                  : work
                    ? `${work.work.title}${chapterOrder ? (currentPart?.part.supplemental ? ' · 附录' : ` · 第 ${chapterOrder} 章`) : ''}`
                    : '正文'}
              </p>
              <h1>{chapterTitle}</h1>
              <p className="reader-meta">{charCount.toLocaleString('zh-CN')} 字 · 约 {minutes} 分钟</p>
            </header>

            <article className="prose" data-testid="reader-body" ref={articleRef} dangerouslySetInnerHTML={{ __html: html }} />

            <aside className="reader-notes" aria-label="批注" ref={notesRef}>
              <div className="notes-head">
                <span>批注</span>
                <span className="mono">{annList.length}</span>
              </div>
              {annList.length === 0 ? (
                <p className="notes-empty">选中正文就能划重点、写批注。批注会记在事件流里，可追溯。</p>
              ) : annList.map((a, i) => (
                <div className="mnote" key={a.id} data-anchor={a.id} data-testid="annotation-item">
                  <button className="mnote-quote" onClick={() => jumpToMark(a.id)} title="跳到原文">
                    <span className="mnote-no mono">{String(i + 1).padStart(2, '0')}</span>
                    <span>{a.quote}</span>
                  </button>
                  {a.note && <p className="mnote-text">{a.note}</p>}
                  <div className="mnote-foot">
                    {delId === a.id ? (
                      <>
                        <span className="mnote-ask">删除这条批注？</span>
                        <span className="mnote-acts">
                          <button
                            className="link-btn link-btn-danger"
                            disabled={deleting === a.id}
                            onClick={() => void removeAnnotation(a.id)}
                            data-testid="annotation-delete-confirm"
                          >
                            {deleting === a.id ? '删除中…' : '删除'}
                          </button>
                          <button className="link-btn" onClick={() => setDelId('')}>取消</button>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="mono">
                          {a.author.startsWith('agent:') ? `AI·${a.author.slice(6)}` : '我'} · {a.createdAt.slice(5, 10)}
                        </span>
                        <span className="mnote-acts">
                          <button
                            className="link-btn"
                            onClick={() => openSheet('derive', { srcId: currentRep, title: '由批注衍生', body: `\n\n> ${a.quote}\n\n${a.note ?? ''}\n` })}
                          >由此衍生</button>
                          <button
                            className="link-btn"
                            onClick={() => setDelId(a.id)}
                            data-testid="annotation-delete"
                            title="删除这条批注，正文里的高亮一并移除"
                          >删除</button>
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </aside>

            <div className="reader-end">
              <p className="reader-end-note">
                <span className="reader-end-mark">※</span>
                读到这里。回看不会把最远位置清掉——最远 {furthest}%。
              </p>
              {work && (nextPart && nextRep ? (
                <button className="reader-next" onClick={goNextChapter} data-testid="reader-next">
                  <span className="reader-next-text">
                    <span className="reader-next-kicker">{nextPart.part.supplemental ? '附录' : '下一章'}</span>
                    <span className="reader-next-title">{nextPart.part.title}</span>
                  </span>
                  <Icon name="arrow" size={16} />
                </button>
              ) : (
                <p className="reader-end-last" data-testid="reader-end-last">
                  整本读完了。
                  <button className="link-btn" onClick={() => navigate('shelf')}>回到书架</button>
                </p>
              ))}
            </div>

            {work && (work.derived ?? []).length > 0 && (
              <section className="reader-lineage" aria-label="血缘">
                <h3>血缘 <span className="mono">{(work.derived ?? []).length}</span></h3>
                <p className="reader-lineage-note">从这里长出去的东西</p>
                {(work.derived ?? []).map((d) => (
                  <button key={d.id} className="lineage" onClick={() => navigate('editor', { id: d.id })}>
                    <Icon name="pen" size={13} />
                    <span className="ellipsis">{d.title}</span>
                    <span className="mono muted">{NOTE_STATUS[d.status] ?? d.status}</span>
                  </button>
                ))}
              </section>
            )}
          </div>
        )}
      </div>

      {tocOpen && (
        <div className="toc-mask" onClick={() => setTocOpen(false)} data-testid="reader-toc-mask">
          <div className="toc-drawer" role="dialog" aria-label="目录" onClick={(e) => e.stopPropagation()}>
            <div className="toc-drawer-head">
              <b className="ellipsis">{work?.work.title ?? (noteId ? noteTitle : '目录')}</b>
              <button className="btn btn-sm btn-quiet" onClick={() => setTocOpen(false)}>关闭</button>
            </div>
            <div className="toc-drawer-list">
              {work ? (
                (work.parts ?? []).slice().sort((a, b) => a.part.order - b.part.order).map((p, i) => {
                  const r = p.reps.find((x) => x.carrier === 'md') ?? p.reps[0];
                  const active = r?.id === currentRep;
                  return (
                    <button
                      key={p.part.id}
                      className="toc-drawer-item"
                      aria-current={active}
                      onClick={() => { setTocOpen(false); if (r) setParam('rep', r.id, { work: workId ?? '' }); }}
                    >
                      <span className="toc-no">{String(i + 1).padStart(2, '0')}</span>
                      <span className="ellipsis">{p.part.title}</span>
                      {p.annotations > 0 && <span className="toc-count">{p.annotations}</span>}
                    </button>
                  );
                })
              ) : noteId ? (
                outline.map((item) => (
                  <button
                    key={item.id}
                    className="toc-drawer-item"
                    data-level={item.level}
                    onClick={() => { setTocOpen(false); scrollToId(item.id); }}
                  >
                    <span className="ellipsis">{item.text}</span>
                  </button>
                ))
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
