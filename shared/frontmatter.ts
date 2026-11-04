/**
 * Markdown + YAML frontmatter 的无损读写。
 * 关键约束：未知 frontmatter 字段（related / aliases / 自定义）必须原样保留，
 * 表单只覆盖自己认识的字段。
 */
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

export interface ParsedDoc {
  fm: Record<string, unknown>;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function hasFrontmatter(raw: string): boolean {
  return FM_RE.test(raw);
}

export function parseDoc(raw: string): ParsedDoc {
  const src = raw.replace(/\r\n/g, '\n');
  const m = FM_RE.exec(src);
  if (!m) return { fm: {}, body: src };
  let fm: Record<string, unknown> = {};
  try {
    const v = yamlParse(m[1]);
    if (v && typeof v === 'object' && !Array.isArray(v)) fm = v as Record<string, unknown>;
  } catch {
    // 坏了就当没有 frontmatter，正文照常给出，避免整篇丢失
    fm = {};
  }
  return { fm, body: src.slice(m[0].length) };
}

export function serializeDoc(fm: Record<string, unknown>, body: string): string {
  const keys = Object.keys(fm);
  if (keys.length === 0) return body.replace(/^\n+/, '');
  // 用 PLAIN：手写文件里的 status: growing 不该被我们改写成 status: "growing"，
  // 否则每次保存都会产生一堆与内容无关的引号噪音，diff 没法看。
  const head = yamlStringify(fm, { lineWidth: 0, defaultKeyType: 'PLAIN', defaultStringType: 'PLAIN' });
  return `---\n${head.trimEnd()}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/** 只覆盖 patch 里的键，其余原样保留；值为 undefined 表示删除该键 */
export function patchFm(fm: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fm };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  // id 是身份，放在第一行：翻文件的人第一眼就该看到「这是谁」
  if ('id' in out && Object.keys(out)[0] !== 'id') {
    const { id, ...rest } = out;
    return { id, ...rest };
  }
  return out;
}

/** 去掉正文首个 H1（阅读器里标题由元数据给出，避免重复） */
export function stripLeadingH1(body: string): string {
  return body.replace(/^\s*#\s+.+\n+/, '');
}

/** 取正文首段作为摘要 */
export function excerpt(body: string, n = 120): string {
  const t = body
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*`_\-\[\]()!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 正文里的 [[wikilink]]，按 stem 解析，与目录无关 */
export function wikiLinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push(m[1].trim());
  return out;
}

export function countChars(body: string): number {
  return body.replace(/\s/g, '').length;
}
