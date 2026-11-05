/**
 * 全站唯一的 Markdown 渲染入口。
 *
 * 三件事在这里收口，避免每个页面各配一套：
 * 1. 标题 id（目录、深链都靠它）
 * 2. 脚注
 * 3. 代码高亮（Shiki 按需加载，没准备好就先出朴素 pre，好了再通知重渲）
 *
 * 渲染本身是同步的：Reader 每帧都在调，不能等 Promise。
 */
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import type { HighlighterCore } from 'shiki/core';

/** 中文标题要能直接做锚点：只留字母、数字、空白和连字符，别把汉字编码成 %E4%B8%80 */
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

function escapeHtml(input: string): string {
  return input.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string
  ));
}

let highlighter: HighlighterCore | null = null;
let booting: Promise<void> | null = null;
const readyListeners = new Set<() => void>();

export const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  // 直引号转弯引号：中文正文里的 "..." 应该长成 “...”
  typographer: true,
  quotes: '“”‘’',
});

md.use(anchor, { slugify, permalink: false, tabIndex: false });
md.use(footnote);

/** 没有高亮时也要有语言标签，样式才知道怎么画 */
function plainCode(code: string, lang: string): string {
  const tag = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  return `<pre data-lang="${escapeHtml(lang || 'text')}" class="code-plain"><code${tag}>${escapeHtml(code)}</code></pre>`;
}

md.options.highlight = (code, lang) => {
  if (highlighter && lang) {
    try {
      const html = highlighter.codeToHtml(code, {
        lang,
        themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
      });
      // markdown-it 只有在返回值以 <pre 开头时才不额外包一层
      return html.replace('<pre class="shiki', `<pre data-lang="${escapeHtml(lang)}" class="shiki`);
    } catch {
      /* 语言没加载或语法不认，退回朴素代码块 */
    }
  }
  return plainCode(code, lang);
};

/** 同步渲染；Markdown 之外的调用方（编辑器预览）也走这里，保证两边样式一致 */
export function renderMarkdown(source: string): string {
  return md.render(source);
}

/** 高亮准备好了就通知订阅方重渲一次；返回取消订阅 */
export function onMarkdownReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

export function isMarkdownReady(): boolean {
  return highlighter !== null;
}

/**
 * 幂等：重复调用只加载一次。
 * Shiki 是重依赖，用动态 import 单独切块，首屏不背它。
 */
export function prepareMarkdown(): Promise<void> {
  if (highlighter) return Promise.resolve();
  if (booting) return booting;

  booting = (async () => {
    const [
      { createHighlighterCore },
      { createJavaScriptRegexEngine },
      ts, tsx, js, jsx, json, bash, shell, sql, markdown, html, css, python, yaml, diff,
      vitesseLight, vitesseDark,
    ] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/langs/ts.mjs'),
      import('shiki/langs/tsx.mjs'),
      import('shiki/langs/js.mjs'),
      import('shiki/langs/jsx.mjs'),
      import('shiki/langs/json.mjs'),
      import('shiki/langs/bash.mjs'),
      import('shiki/langs/shell.mjs'),
      import('shiki/langs/sql.mjs'),
      import('shiki/langs/markdown.mjs'),
      import('shiki/langs/html.mjs'),
      import('shiki/langs/css.mjs'),
      import('shiki/langs/python.mjs'),
      import('shiki/langs/yaml.mjs'),
      import('shiki/langs/diff.mjs'),
      import('shiki/themes/vitesse-light.mjs'),
      import('shiki/themes/vitesse-dark.mjs'),
    ]);

    highlighter = await createHighlighterCore({
      themes: [vitesseLight.default, vitesseDark.default],
      langs: [ts, tsx, js, jsx, json, bash, shell, sql, markdown, html, css, python, yaml, diff]
        .map((m) => m.default),
      engine: createJavaScriptRegexEngine(),
    });

    readyListeners.forEach((fn) => fn());
  })().catch(() => {
    /* 高亮失败不阻断阅读，正文照常出 */
    booting = null;
  });

  return booting;
}
