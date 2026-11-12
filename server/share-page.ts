/**
 * 公开只读页（抽印本）。
 *
 * 为什么服务端渲染而不是复用前端 SPA：
 *  1. 外部读者不该为了看一章去下载整个管理端，更不该继承管理端的路由与鉴权假设；
 *  2. 分享页要能被任意浏览器、阅读模式、打印直接打开，不依赖 JS；
 *  3. 公开面与私有面在文件层面分开，权限只靠 token 判断，少一个泄漏整库的入口。
 *
 * 设计上它是「从档案里抽出来的一册」：纸色、衬线标题、书脊式的页边、卷末的版本说明。
 * 不用卡片、不用投影、不做悬浮动效——阅读页的装饰越少，文字越像主角。
 */
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import path from 'node:path';

/* ---------------- 安全与格式化 ---------------- */

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

/** 中文标题直接做锚点，不把汉字编码成 %E4%B8%80 */
function slugify(input: string): string {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'section';
}

export function formatWords(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万字`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} 千字`;
  return `${n} 字`;
}

export function formatDay(iso: string | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10).replace(/-/g, '.');
}

export function excerptOf(body: string, n = 96): string {
  const t = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[#>*`_~\-\[\]()!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/* ---------------- Markdown ---------------- */

interface RenderEnv {
  token: string;
  /** 当前文件的相对路径，用来解析相对图片 */
  rel: string;
  /** 相对路径 → 公开页地址；解析不到就保留原文 */
  hrefOf?: (href: string) => string | null;
  /** [[标题]] → 公开地址；解析不到就只留标题文字，不泄漏私有内容 */
  wikiOf?: (target: string) => { href: string; label: string } | null;
}

const publicMd: MarkdownIt = new MarkdownIt({
  // 公开页一律不执行正文里的 HTML。原文里的 <script>、<iframe> 只会被当成字面量。
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});
publicMd.use(anchor, { slugify, permalink: false, tabIndex: false });
publicMd.use(footnote);

publicMd.renderer.rules.image = (tokens, idx, options, env: RenderEnv, self) => {
  const t = tokens[idx];
  const src = t.attrGet('src') ?? '';
  if (src && !/^(https?:|data:)/i.test(src)) {
    let p = src;
    if (p.startsWith('/assets/') || p.startsWith('/knowledge/')) {
      p = p.slice(1);
    } else if (!p.startsWith('/')) {
      p = path.posix.normalize(path.posix.join(path.posix.dirname(env.rel), p));
    }
    if (!p.startsWith('/')) t.attrSet('src', `/s/${env.token}/raw?p=${encodeURIComponent(p)}`);
  }
  t.attrSet('loading', 'lazy');
  t.attrSet('decoding', 'async');
  return self.renderToken(tokens, idx, options);
};

publicMd.renderer.rules.link_open = (tokens, idx, options, env: RenderEnv, self) => {
  const t = tokens[idx];
  const href = t.attrGet('href') ?? '';
  if (env.hrefOf && href && !/^(https?:|mailto:|#|\/)/i.test(href)) {
    const mapped = env.hrefOf(href);
    if (mapped) t.attrSet('href', mapped);
  }
  if (/^https?:/i.test(href)) {
    t.attrSet('target', '_blank');
    t.attrSet('rel', 'noopener noreferrer');
  }
  return self.renderToken(tokens, idx, options);
};

/**
 * [[链接]] 在公开页要有两种结局：指向同一份抽印本里的内容，就变成真链接；
 * 指向私有内容，就只留文字。宁可少一个链接，也不能把私有标题暴露给外面。
 */
function wikiToMarkdown(body: string, resolve: RenderEnv['wikiOf']): string {
  if (!resolve) return body;
  let fence = '';
  return body.split('\n').map((line) => {
    const f = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = '';
      return line;
    }
    if (fence) return line;
    // 行内代码里的 [[…]] 是示例，不解析
    return line.replace(/(`[^`\n]*`)|\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (all, code, target, label) => {
      if (code) return all;
      const r = resolve(String(target).trim());
      const text = String(label ?? target).trim();
      return r ? `[${text}](${r.href})` : text;
    });
  }).join('\n');
}

export function renderPublicMarkdown(body: string, env: RenderEnv): string {
  const src = wikiToMarkdown(body, env.wikiOf);
  return publicMd.render(src, env);
}

/* ---------------- 页面模型 ---------------- */

export interface Chrome {
  token: string;
  title: string;
  space: string;
  byline: string;
}

export interface Crumb { label: string; href?: string }

export interface IndexEntry {
  href: string;
  title: string;
  meta?: string;
  desc?: string;
  tag?: string;
}

export interface ChapterEntry {
  href: string;
  title: string;
  no: number;
  words: number;
}

export interface ChapterLink { href: string; title: string }

export type SharePageModel =
  | {
    kind: 'index'; chrome: Chrome; intro?: string; meta: string;
    books: IndexEntry[]; topics: IndexEntry[]; notes: IndexEntry[];
  }
  | {
    kind: 'work'; chrome: Chrome; title: string; desc?: string; meta: string;
    chapters: ChapterEntry[]; supplements: ChapterEntry[]; startHref?: string;
  }
  | {
    kind: 'chapter'; chrome: Chrome; crumbs: Crumb[]; title: string; kicker: string; no: number; meta: string;
    bodyHtml: string; prev?: ChapterLink; next?: ChapterLink; tocHref: string; rail: string;
  }
  | {
    kind: 'note'; chrome: Chrome; crumbs: Crumb[]; title: string; meta: string;
    bodyHtml: string; tags: string[]; rail: string;
  }
  | {
    kind: 'topic'; chrome: Chrome; title: string; desc?: string; meta: string;
    books: IndexEntry[]; notes: IndexEntry[];
  }
  | { kind: 'error'; chrome: Chrome; title: string; message: string; tone: 'muted' | 'closed' };

/* ---------------- 样式 ---------------- */

const CSS = `
:root {
  color-scheme: light;
  --paper: #f7f2e6;
  --ink: #211c15;
  --ink-2: #5d5445;
  --rule: #d8cdb8;
  --rule-soft: #e7dfcd;
  --sunken: #efe7d6;
  --accent: #a63f28;
  --accent-soft: #f1ded3;
  --serif: 'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', Georgia, serif;
  --sans: 'PingFang SC', 'HarmonyOS Sans SC', 'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei', -apple-system, 'Segoe UI', sans-serif;
  --mono: 'JetBrains Mono', 'IBM Plex Mono', 'Cascadia Code', 'SF Mono', ui-monospace, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --paper: #141312;
    --ink: #e9e2d4;
    --ink-2: #a49c8e;
    --rule: #35312a;
    --rule-soft: #26231e;
    --sunken: #1c1a16;
    --accent: #d98f63;
    --accent-soft: #2e211a;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 17px/1.78 var(--sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { color: var(--ink); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
::selection { background: var(--accent-soft); color: var(--ink); }
hr { border: 0; border-top: 1px solid var(--rule); margin: 2.4em 0; }
img { max-width: 100%; }

.skip { position: absolute; left: -9999px; top: 0; background: var(--paper); color: var(--ink); padding: 10px 14px; z-index: 20; }
.skip:focus { left: 12px; top: 12px; }

/* 顶栏：一条细带，不做悬浮玻璃；书页不需要 App 的顶栏 */
.band {
  display: flex; align-items: center; gap: 16px;
  padding: 13px clamp(18px, 4vw, 44px);
  border-bottom: 1px solid var(--rule);
  position: sticky; top: 0; z-index: 5;
  background: var(--paper);
}
.mark { display: flex; align-items: center; gap: 9px; color: inherit; text-decoration: none; flex: none; }
.seal {
  width: 26px; height: 26px; display: grid; place-items: center; flex: none;
  background: var(--accent); color: #fff8ed;
  font-family: var(--serif); font-size: 15px; line-height: 1;
  border-radius: 1px;
}
.mark-text { display: flex; flex-direction: column; line-height: 1.1; }
.mark-name { font-family: var(--serif); font-size: 15px; letter-spacing: .1em; }
.mark-sub { font: 9px/1 var(--mono); letter-spacing: .26em; color: var(--ink-2); margin-top: 4px; }
.crumbs {
  display: flex; align-items: center; gap: 7px; min-width: 0;
  font-size: 12px; color: var(--ink-2); white-space: nowrap; overflow: hidden;
}
/* 窄屏上只留最后一段：前面几段被挤出可视区时，任何一段都不该被切一半 */
.crumbs > a:not(:last-child) { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; }
.crumbs a { color: var(--ink-2); text-decoration: none; }
.crumbs a:hover { color: var(--accent); text-decoration: underline; }
.crumbs .here { flex: 1 1 auto; min-width: 3em; color: var(--ink); overflow: hidden; text-overflow: ellipsis; }
.crumbs .sep { opacity: .45; }
.mode {
  margin-left: auto; flex: none;
  font: 10px/1 var(--mono); letter-spacing: .2em; color: var(--accent);
  border: 1px solid var(--accent); border-radius: 1px; padding: 4px 7px;
}

.page { width: min(1080px, calc(100% - 40px)); margin: 0 auto; }
.page-narrow { width: min(860px, calc(100% - 40px)); margin: 0 auto; }

/* 封面 */
.cover { padding: clamp(42px, 8vw, 88px) 0 clamp(26px, 4vw, 42px); border-bottom: 1px solid var(--rule); }
.kicker { font: 10px/1.4 var(--mono); letter-spacing: .24em; color: var(--accent); margin: 0 0 18px; }
.display {
  margin: 0 0 20px; font-family: var(--serif); font-weight: 600;
  font-size: clamp(2.15rem, 6vw, 4rem); line-height: 1.16; letter-spacing: .005em;
  text-wrap: balance;
}
.cover h1.display-s { font-size: clamp(1.9rem, 4.6vw, 3rem); }
.lede { max-width: 46ch; margin: 0 0 22px; color: var(--ink-2); font-size: 1rem; line-height: 1.85; }
.meta { font: 11px/1.7 var(--mono); letter-spacing: .06em; color: var(--ink-2); display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 0; }
.meta > * + * { margin-left: 9px; }
/* 分隔点是独立的 span，两侧都要留白；只靠 gap 会把它挤成「1 本书·1 篇」 */
.meta > span[aria-hidden='true'] { margin: 0 9px; color: var(--border-strong); }
.meta b { font-weight: 500; color: var(--ink); }
.cta {
  display: inline-flex; align-items: center; gap: 9px; margin-top: 26px;
  padding-bottom: 5px; border-bottom: 1px solid var(--accent);
  font-size: .92rem; text-decoration: none;
}
.cta:hover { border-color: var(--ink); }

/* 目录 / 索引 */
.section { padding: clamp(30px, 5vw, 52px) 0 0; }
.section-head {
  display: flex; align-items: baseline; gap: 12px;
  margin: 0 0 14px; font-family: var(--serif); font-size: 1.16rem; font-weight: 600;
}
.section-head .count { font: 10px var(--mono); color: var(--ink-2); letter-spacing: .08em; }
.index-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule); }
.index-list li { border-bottom: 1px solid var(--rule-soft); }
.index-list a {
  display: flex; align-items: baseline; gap: 12px;
  padding: 15px 2px 13px; color: inherit; text-decoration: none;
}
.index-list a:hover .t { color: var(--accent); }
.index-list .t { font-family: var(--serif); font-size: 1.1rem; font-weight: 600; line-height: 1.4; }
.index-list .leader { flex: 1 1 32px; min-width: 18px; border-bottom: 1px dotted var(--rule); transform: translateY(-4px); }
.index-list .meta { font: 10px var(--mono); color: var(--ink-2); letter-spacing: .06em; flex: none; }
.index-list .tag { font: 10px var(--mono); color: var(--accent); border: 1px solid var(--rule); padding: 2px 5px; flex: none; }
.index-desc { margin: -4px 0 14px; color: var(--ink-2); font-size: .84rem; line-height: 1.7; max-width: 62ch; }

/* 书籍目录 */
.toc { list-style: none; margin: 14px 0 0; padding: 0; border-top: 1px solid var(--rule); }
.toc li { border-bottom: 1px solid var(--rule-soft); }
.toc a { display: flex; align-items: baseline; gap: 14px; padding: 13px 2px; color: inherit; text-decoration: none; }
.toc a:hover .t { color: var(--accent); }
.toc .no { flex: none; width: 2.4em; font: 10px var(--mono); letter-spacing: .06em; color: var(--accent); }
.toc .t { font-family: var(--serif); font-size: 1.01rem; line-height: 1.5; }
.toc .leader { flex: 1; min-width: 20px; border-bottom: 1px dotted var(--rule); transform: translateY(-4px); }
.toc .w { flex: none; font: 10px var(--mono); color: var(--ink-2); }
.subhead {
  display: flex; align-items: baseline; gap: 10px;
  margin: 34px 0 0; font: 10px var(--mono); letter-spacing: .2em; color: var(--ink-2);
}
.subhead span { letter-spacing: 0; opacity: .7; }

/* 阅读页：书脊在左，正文在右 */
.reader {
  display: grid; grid-template-columns: 74px minmax(0, 680px);
  gap: clamp(4px, 1vw, 10px); justify-content: center;
  padding: clamp(26px, 5vw, 56px) 0 30px;
}
/* 书脊线画在正文栏的左沿：它跟着文章开始、也随着文章结束，
   不会像画在 aside 上那样悬到格子底下（格子高度由较长的一栏决定）。 */
.rail {
  text-align: right; padding: 8px 18px 0 0;
  display: flex; flex-direction: column; align-items: flex-end;
}
.rail-no { display: block; font: 12px var(--mono); letter-spacing: .06em; color: var(--accent); }
.rail-book {
  display: block; margin: 20px 0 0 auto; max-height: 21em;
  writing-mode: vertical-rl; text-orientation: mixed;
  font-family: var(--serif); font-size: 12px; letter-spacing: .26em; color: var(--ink-2);
  overflow: hidden;
}
.reader-body { min-width: 0; border-left: 1px solid var(--rule); padding-left: clamp(18px, 3vw, 34px); }
.chapter-head { margin: 0 0 30px; padding-bottom: 22px; border-bottom: 1px solid var(--rule); }
.chapter-head h1 {
  margin: 10px 0 12px; font-family: var(--serif); font-weight: 600;
  font-size: clamp(1.75rem, 3.6vw, 2.5rem); line-height: 1.3; letter-spacing: .005em;
  text-wrap: balance;
}

/* 正文：首行缩进是纸书的读法，网页上反而成了辨识度 */
.prose { font-size: 18px; line-height: 1.95; overflow-wrap: break-word; }
.prose p { margin: 0 0 .6em; text-indent: 2em; }
.prose li p, .prose td p, .prose th p, .prose figcaption, .prose .footnotes p { text-indent: 0; }
.prose h1, .prose h2, .prose h3, .prose h4 {
  font-family: var(--serif); font-weight: 600; line-height: 1.4; text-indent: 0;
}
.prose h1 { font-size: 1.6em; margin: 2em 0 .7em; }
.prose h2 { font-size: 1.32em; margin: 2.1em 0 .7em; }
.prose h3 { font-size: 1.12em; margin: 1.8em 0 .55em; }
.prose h4 { font-size: 1em; margin: 1.5em 0 .45em; }
.prose ul, .prose ol { margin: .4em 0 1em; padding-left: 1.7em; }
.prose li { margin: .25em 0; }
.prose blockquote {
  margin: 1.7em 0; padding: .1em 0 .1em 1.1em;
  border-left: 2px solid var(--accent); color: var(--ink-2); font-family: var(--serif);
}
.prose blockquote p { text-indent: 0; }
.prose code { font-family: var(--mono); font-size: .84em; background: var(--sunken); padding: .12em .34em; border-radius: 2px; }
.prose pre {
  margin: 1.5em 0; padding: 14px 16px; overflow: auto;
  background: var(--sunken); border-radius: 2px;
  font: .8em/1.65 var(--mono);
}
.prose pre code { background: none; padding: 0; font-size: 1em; }
.prose table { width: 100%; border-collapse: collapse; margin: 1.5em 0; font-size: .9em; }
.prose th, .prose td { padding: 8px 10px; border-bottom: 1px solid var(--rule-soft); text-align: left; vertical-align: top; }
.prose th { font-family: var(--serif); font-weight: 600; border-bottom-color: var(--rule); }
.prose img { display: block; margin: 1.7em auto; }
.prose a { text-decoration: underline; }
.prose hr { margin: 2.6em 0; }
.prose .footnotes { margin-top: 3em; padding-top: 1em; border-top: 1px solid var(--rule); font-size: .8em; color: var(--ink-2); }
.prose .footnotes hr { display: none; }
.prose .task-list-item { list-style: none; }
.prose .tag { font: 10px var(--mono); color: var(--accent); }

/* 翻页 */
.pager { display: flex; gap: 24px; margin: 54px 0 0; padding-top: 18px; border-top: 1px solid var(--rule); }
.pager a { max-width: 47%; color: inherit; text-decoration: none; }
.pager a:hover .t { color: var(--accent); }
.pager .dir { font: 9px var(--mono); letter-spacing: .2em; color: var(--ink-2); }
.pager .t { display: block; margin-top: 4px; font-family: var(--serif); font-size: .95rem; }
.pager .next { margin-left: auto; text-align: right; }
.back { display: inline-block; margin-top: 26px; font: 11px var(--mono); letter-spacing: .08em; color: var(--ink-2); text-decoration: none; }
.back:hover { color: var(--accent); }

/* 卷末说明 */
.colophon {
  display: flex; align-items: flex-start; gap: 14px;
  margin-top: 44px; padding: 22px 0 40px; border-top: 1px solid var(--rule);
  color: var(--ink-2); font-size: 11px; line-height: 1.8;
}
.colophon .seal { width: 22px; height: 22px; font-size: 12px; }
.colophon .grow { flex: 1; min-width: 0; }
.colophon .line { margin: 0 0 2px; }
.colophon .no { font-family: var(--mono); letter-spacing: .08em; white-space: nowrap; }
.colophon .no span { margin: 0 6px; color: var(--rule); }

/* 链接失效 */
.note-box { padding: clamp(56px, 12vw, 120px) 0 80px; max-width: 34rem; }
.note-box h1 { font-family: var(--serif); font-weight: 600; font-size: clamp(1.7rem, 4vw, 2.4rem); margin: 0 0 14px; }
.note-box p { color: var(--ink-2); margin: 0; }
.note-box .rule { width: 42px; height: 2px; background: var(--accent); margin: 0 0 26px; }

@media (max-width: 820px) {
  .page, .page-narrow { width: calc(100% - 32px); }
  .reader { grid-template-columns: minmax(0, 1fr); padding-top: 24px; }
  .rail { display: none; }
  .reader-body { border-left: 0; padding-left: 0; }
  .band { gap: 12px; padding: 11px 16px; }
  /* 手机上只显示当前这一层，再靠页面内的「回到目录」往回走 */
  .crumbs { font-size: 11px; gap: 5px; }
  .crumbs > a, .crumbs > .sep { display: none; }
  .crumbs > .here { flex: 1 1 auto; }
  .mode { display: none; }
  .prose { font-size: 17px; line-height: 1.9; }
  .pager { flex-direction: column; gap: 16px; }
  .pager a, .pager .next { max-width: 100%; text-align: left; }
}
@media print {
  .band, .pager, .cta, .back { display: none; }
  body { background: #fff; color: #000; font-size: 11pt; }
  .reader { display: block; padding: 0; }
  .rail { display: none; }
  .cover { border-color: #999; }
  a { color: #000; text-decoration: none; }
  .prose { font-size: 11pt; line-height: 1.7; }
}
@media (prefers-reduced-motion: reduce) {
  * { scroll-behavior: auto !important; }
}
`;

/* ---------------- 片段 ---------------- */

function head(title: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>`;
}

function band(chrome: Chrome, crumbs: Crumb[] = [], mode = '只读'): string {
  const home = `/s/${encodeURIComponent(chrome.token)}`;
  const trail = crumbs.length
    ? crumbs.map((c) => (c.href
      ? `<a href="${esc(c.href)}">${esc(c.label)}</a>`
      : `<span class="here" aria-current="page">${esc(c.label)}</span>`)).join('<span class="sep" aria-hidden="true">/</span>')
    : '<span class="here">目录</span>';
  return `<a class="skip" href="#main">跳到正文</a>
<header class="band">
  <a class="mark" href="${esc(home)}" aria-label="回到抽印本目录">
    <span class="seal" aria-hidden="true">栖</span>
    <span class="mark-text"><span class="mark-name">Habitat</span><span class="mark-sub">抽印本</span></span>
  </a>
  <nav class="crumbs" aria-label="位置"><span class="sep" aria-hidden="true">/</span>${trail}</nav>
  <span class="mode">${esc(mode)}</span>
</header>`;
}

function colophon(chrome: Chrome): string {
  return `<footer class="colophon">
  <span class="seal" aria-hidden="true">栖</span>
  <div class="grow">
    <p class="line"><b>${esc(chrome.title)}</b> · 由「${esc(chrome.space)}」抽出，供阅读。</p>
    <p class="line">内容以原件为准；这一册是只读的，改动请回到来源处。</p>
  </div>
  <span class="no">${esc(chrome.byline)}<span aria-hidden="true">·</span>${esc(chrome.token.slice(0, 6))}</span>
</footer>`;
}

function indexSection(title: string, entries: IndexEntry[]): string {
  if (!entries.length) return '';
  return `<section class="section">
  <h2 class="section-head">${esc(title)}<span class="count">${entries.length}</span></h2>
  <ul class="index-list">
    ${entries.map((e) => `<li>
      <a href="${esc(e.href)}">
        <span class="t">${esc(e.title)}</span>
        ${e.tag ? `<span class="tag">${esc(e.tag)}</span>` : ''}
        <span class="leader" aria-hidden="true"></span>
        ${e.meta ? `<span class="meta">${esc(e.meta)}</span>` : ''}
      </a>
      ${e.desc ? `<p class="index-desc">${esc(e.desc)}</p>` : ''}
    </li>`).join('')}
  </ul>
</section>`;
}

function tocList(entries: ChapterEntry[], supplement = false): string {
  return `<ol class="toc">
    ${entries.map((c) => `<li><a href="${esc(c.href)}">
      <span class="no">${supplement ? '附' : String(c.no).padStart(2, '0')}</span>
      <span class="t">${esc(c.title)}</span>
      <span class="leader" aria-hidden="true"></span>
      <span class="w">${esc(formatWords(c.words))}</span>
    </a></li>`).join('')}
  </ol>`;
}

/* ---------------- 渲染 ---------------- */

export function renderSharePage(m: SharePageModel): string {
  if (m.kind === 'error') {
    return `${head(`${m.title} · ${m.chrome.title}`)}
<body>
${band(m.chrome, [{ label: m.title }])}
<main class="page-narrow" id="main">
  <div class="note-box">
    <div class="rule" aria-hidden="true"></div>
    <h1>${esc(m.title)}</h1>
    <p>${esc(m.message)}</p>
  </div>
</main>
</body></html>`;
  }

  if (m.kind === 'index') {
    const body = `${head(`${m.chrome.title} · 抽印本`)}
<body>
${band(m.chrome)}
<main class="page" id="main">
  <article class="cover">
    <p class="kicker">${esc(m.chrome.space)} · 抽印本</p>
    <h1 class="display">${esc(m.chrome.title)}</h1>
    ${m.intro ? `<p class="lede">${esc(m.intro)}</p>` : ''}
    <p class="meta">${m.meta}</p>
  </article>
  ${indexSection('书籍', m.books)}
  ${indexSection('专题', m.topics)}
  ${indexSection('笔记', m.notes)}
  ${!m.books.length && !m.topics.length && !m.notes.length
    ? '<section class="section"><p class="lede">这份抽印本还没有内容。链接是真的，只是主人还没放东西进来。</p></section>'
    : ''}
  ${colophon(m.chrome)}
</main>
</body></html>`;
    return body;
  }

  if (m.kind === 'work') {
    return `${head(`${m.title} · ${m.chrome.title}`)}
<body>
${band(m.chrome, [{ label: m.chrome.title, href: `/s/${encodeURIComponent(m.chrome.token)}` }, { label: m.title }])}
<main class="page" id="main">
  <article class="cover">
    <p class="kicker">书籍</p>
    <h1 class="display display-s">${esc(m.title)}</h1>
    ${m.desc ? `<p class="lede">${esc(m.desc)}</p>` : ''}
    <p class="meta">${m.meta}</p>
    ${m.startHref ? `<a class="cta" href="${esc(m.startHref)}">从第一章读起 <span aria-hidden="true">→</span></a>` : ''}
  </article>
  <section class="section">
    <h2 class="section-head">目录<span class="count">${m.chapters.length + m.supplements.length}</span></h2>
    ${m.chapters.length ? tocList(m.chapters) : '<p class="lede">这本书还没有可读的章节。</p>'}
    ${m.supplements.length ? `<p class="subhead">补充材料<span>不进正文顺序</span></p>${tocList(m.supplements, true)}` : ''}
  </section>
  ${colophon(m.chrome)}
</main>
</body></html>`;
  }

  if (m.kind === 'topic') {
    return `${head(`${m.title} · ${m.chrome.title}`)}
<body>
${band(m.chrome, [{ label: m.chrome.title, href: `/s/${encodeURIComponent(m.chrome.token)}` }, { label: m.title }])}
<main class="page" id="main">
  <article class="cover">
    <p class="kicker">专题</p>
    <h1 class="display display-s">${esc(m.title)}</h1>
    ${m.desc ? `<p class="lede">${esc(m.desc)}</p>` : ''}
    <p class="meta">${m.meta}</p>
  </article>
  ${indexSection('收入的书', m.books)}
  ${indexSection('收入的笔记', m.notes)}
  ${colophon(m.chrome)}
</main>
</body></html>`;
  }

  // 章节与笔记共用阅读页；差别只在页边标记与翻页
  const chapter = m.kind === 'chapter' ? m : null;
  const note = m.kind === 'note' ? m : null;
  const title = m.title;
  const kicker = chapter ? chapter.kicker : '笔记';
  const rail = chapter ? chapter.rail : (note?.rail ?? '');
  const tags = note?.tags ?? [];
  const meta = m.meta;
  return `${head(`${title} · ${m.chrome.title}`)}
<body>
${band(m.chrome, m.crumbs)}
<main class="page" id="main">
  <div class="reader">
    <aside class="rail" aria-hidden="true">
      <span class="rail-no">${chapter ? String(chapter.no).padStart(2, '0') : '记'}</span>
      <span class="rail-book">${esc(rail)}</span>
    </aside>
    <article class="reader-body">
      <header class="chapter-head">
        <p class="kicker">${esc(kicker)}</p>
        <h1>${esc(title)}</h1>
        <p class="meta">${meta}${tags.length ? `<span>${tags.map((t) => `#${esc(t)}`).join(' ')}</span>` : ''}</p>
      </header>
      <div class="prose">${m.bodyHtml}</div>
      ${chapter ? `<nav class="pager" aria-label="翻页">
        ${chapter.prev ? `<a href="${esc(chapter.prev.href)}"><span class="dir">上一章</span><span class="t">${esc(chapter.prev.title)}</span></a>` : '<span></span>'}
        ${chapter.next ? `<a class="next" href="${esc(chapter.next.href)}"><span class="dir">下一章</span><span class="t">${esc(chapter.next.title)}</span></a>` : ''}
      </nav>
      <a class="back" href="${esc(chapter.tocHref)}">← 回到目录</a>` : ''}
      ${colophon(m.chrome)}
    </article>
  </div>
</main>
</body></html>`;
}
