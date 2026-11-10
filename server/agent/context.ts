/**
 * 上下文打包与选区定位。
 *
 * 两条纪律：
 *  · 永远不信模型给的 offset；服务端用 quote + prefix/suffix 重新定位。
 *  · 发出去多少字要有账；超预算从低优先级开始裁，裁了要能告诉用户。
 */
import type { ContextRef, QuoteAnchor } from '../../shared/agent.ts';

export interface OutlineItem {
  level: number;
  text: string;
  from: number;
  to: number;
}

export interface LocateResult {
  ok: boolean;
  from?: number;
  to?: number;
  reason?: string;
}

export function parseOutline(body: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const re = /^(#{1,3})[ \t]+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const text = m[2].trim();
    if (!text) continue;
    out.push({ level: m[1].length, text, from: m.index, to: m.index + m[0].length });
  }
  return out;
}

/** 折叠空白并建立「压缩下标 → 原文下标」的映射 */
function compactMap(body: string): { text: string; map: number[] } {
  const text: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (/\s/.test(ch)) continue;
    text.push(ch);
    map.push(i);
  }
  return { text: text.join(''), map };
}

function countOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = haystack.indexOf(needle, i + Math.max(1, needle.length));
  }
  return out;
}

function contextScore(body: string, at: number, quote: string, prefix: string, suffix: string): number {
  let score = 0;
  const pre = prefix.slice(-24);
  const post = suffix.slice(0, 24);
  if (pre && body.slice(Math.max(0, at - pre.length), at).endsWith(pre)) score += 3;
  if (post && body.slice(at + quote.length, at + quote.length + post.length).startsWith(post)) score += 3;
  // 离上一次阅读位置越近越可信；没有位置信息时不加分
  return score;
}

/**
 * 重新定位一段引文。
 * 顺序：原文精确命中 → 多处时 prefix/suffix 打分 → 折叠空白后再试。
 */
export function locateQuote(
  body: string,
  quote: string,
  opts: { prefix?: string; suffix?: string; from?: number; to?: number } = {},
): LocateResult {
  const q = (quote ?? '').trim();
  if (!q) return { ok: false, reason: '引文为空' };
  if (!body) return { ok: false, reason: '正文为空' };

  const hits = countOf(body, q);
  if (hits.length === 1) return { ok: true, from: hits[0], to: hits[0] + q.length };
  if (hits.length > 1) {
    const scored = hits
      .map((at) => ({ at, score: contextScore(body, at, q, opts.prefix ?? '', opts.suffix ?? '') }))
      .sort((a, b) => b.score - a.score);
    if (scored[0].score > scored[1].score) {
      return { ok: true, from: scored[0].at, to: scored[0].at + q.length };
    }
    return { ok: false, reason: `引文在正文里出现 ${hits.length} 次，且有歧义` };
  }

  // 空白折叠：跨段/换行的引文在原文里可能只差一个换行
  const cq = q.replace(/\s+/g, '');
  if (cq.length >= 2) {
    const { text, map } = compactMap(body);
    const at = text.indexOf(cq);
    if (at >= 0 && text.indexOf(cq, at + 1) < 0) {
      const from = map[at];
      const to = map[at + cq.length - 1] + 1;
      return { ok: true, from, to, reason: '空白折叠后命中' };
    }
  }

  return { ok: false, reason: '正文里找不到这段引文' };
}

export function anchorFrom(
  repId: string,
  quote: string,
  located: { from: number; to: number },
  revision: number,
  prefix = '',
  suffix = '',
  headingId?: string,
): QuoteAnchor {
  return { repId, quote, from: located.from, to: located.to, prefix, suffix, headingId, revision };
}

export function sectionAt(body: string, outline: OutlineItem[], at: number): { title: string; text: string } {
  if (!outline.length) return { title: '', text: body };
  let current = outline[0];
  for (const h of outline) {
    if (h.from <= at) current = h;
    else break;
  }
  const index = outline.indexOf(current);
  const next = index >= 0 && index + 1 < outline.length ? outline[index + 1] : null;
  const from = current.from;
  const to = next ? next.from : body.length;
  return { title: current.text, text: body.slice(from, to) };
}

export interface PackInput {
  focusId: string;
  focusTitle: string;
  focusKind: string;
  revision: number;
  body: string;
  outline: OutlineItem[];
  selection?: QuoteAnchor;
  refs: ContextRef[];
  skill?: { name: string; preamble: string } | null;
  maxChars: number;
}

export interface PackOutput {
  text: string;
  usedChars: number;
  omitted: string[];
}

function clip(s: string, n: number): string {
  if (n <= 0) return '';
  return s.length <= n ? s : `${s.slice(0, n)}\n…（已截断）`;
}

/**
 * 按优先级装上下文。优先级：选区 > 当前小节 > 引用 > 大纲。
 * 超预算时从最后一条引用开始丢，并记录 omitted，让界面能说清楚。
 */
export function packContext(input: PackInput): PackOutput {
  const omitted: string[] = [];
  const contract = [
    '你是 Habitat 的阅读助手。只能通过 habitat 工具读取和写入当前空间；',
    '引用原文时必须带出原文句子；找不到就说找不到，不要编造。',
    '改正文或批注属于写操作，必须遵守平台给出的审批策略。',
  ].join('\n');

  const head: string[] = [
    contract,
    input.skill ? `<skill name="${input.skill.name}">\n${input.skill.preamble}\n</skill>` : '',
    `<focus id="${input.focusId}" kind="${input.focusKind}" revision="${input.revision}">${input.focusTitle}</focus>`,
  ].filter(Boolean);

  const outlineText = input.outline
    .filter((h) => h.level <= 2)
    .slice(0, 40)
    .map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.text}`)
    .join('\n');

  const sel = input.selection
    ? `<selection rep="${input.selection.repId}" from="${input.selection.from}" to="${input.selection.to}">\n${clip(input.selection.quote, 2000)}\n</selection>`
    : '';

  const section = input.selection
    ? sectionAt(input.body, input.outline, input.selection.from)
    : { title: '', text: input.body };
  const sectionText = section.text
    ? `<section title="${section.title || '正文'}">\n${clip(section.text, 4000)}\n</section>`
    : '';

  const refText = input.refs
    .slice(0, 5)
    .map((r, i) => {
      if (r.kind === 'quote' && r.quote) {
        return `<ref no="${i + 1}" title="${r.title}">\n${clip(r.quote.quote, 1200)}\n</ref>`;
      }
      return `<ref no="${i + 1}" title="${r.title}" id="${r.objectId}" />`;
    })
    .join('\n');

  const pieces = [...head];
  if (sel) pieces.push(sel);
  if (sectionText) pieces.push(sectionText);
  if (outlineText) pieces.push(`<outline>\n${outlineText}\n</outline>`);
  if (refText) pieces.push(`<references>\n${refText}\n</references>`);

  let text = pieces.join('\n\n');
  let used = text.length;

  // 超预算：先丢引用（从最后一条），再丢大纲，再截当前小节
  if (used > input.maxChars && input.refs.length) {
    for (let n = input.refs.length; n >= 0; n -= 1) {
      const refs = input.refs.slice(0, n);
      const candidate = [...head];
      if (sel) candidate.push(sel);
      if (sectionText) candidate.push(sectionText);
      if (outlineText) candidate.push(`<outline>\n${outlineText}\n</outline>`);
      if (refs.length) {
        candidate.push(`<references>\n${refs.map((r, i) => (
          r.kind === 'quote' && r.quote
            ? `<ref no="${i + 1}" title="${r.title}">\n${clip(r.quote.quote, 1200)}\n</ref>`
            : `<ref no="${i + 1}" title="${r.title}" id="${r.objectId}" />`
        )).join('\n')}\n</references>`);
      }
      text = candidate.join('\n\n');
      used = text.length;
      if (used <= input.maxChars) {
        if (n < input.refs.length) omitted.push(`省略了 ${input.refs.length - n} 条引用`);
        break;
      }
    }
  }

  if (used > input.maxChars) {
    omitted.push('正文已按预算截断');
    text = text.slice(0, input.maxChars);
    used = text.length;
  }

  return { text, usedChars: used, omitted };
}
