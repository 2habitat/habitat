/**
 * 作品归组候选：找出「看起来是一本书、但还没有作品接管」的来源目录。
 *
 * 迁移评审的结论是「不直接移动文件」，所以归组只是写一份 work.yaml，
 * 用 partsFrom 指向原来的目录，章节原地不动。
 */
import type { Store } from './store.ts';
import { parseDoc } from '../../shared/frontmatter.ts';

export interface WorkCandidate {
  dir: string;
  slug: string;
  chapters: number;
  title: string;
}

/** 少于这个数就不当书看，顶多是一组剪藏 */
const MIN_CHAPTERS = 3;

export async function findWorkCandidates(store: Store): Promise<WorkCandidate[]> {
  // 已经被作品认领的目录：作品自己的 parts/，或 work.yaml 里声明的 partsFrom
  const claimed = new Set<string>();
  const files = await store.adapter.list();
  for (const e of files) {
    if (!/^knowledge\/works\/[^/]+\/work\.yaml$/.test(e.path)) continue;
    const raw = await store.adapter.read(e.path).catch(() => '');
    const fm = parseDoc(raw).fm ?? {};
    const slug = e.path.split('/')[2];
    claimed.add(slug);
    if (fm.partsFrom) claimed.add(String(fm.partsFrom).replace(/\/+$/, '').split('/').pop() ?? '');
  }

  const counts = new Map<string, number>();
  for (const e of files) {
    if (!e.path.startsWith('knowledge/sources/') || !e.path.endsWith('.md')) continue;
    const seg = e.path.split('/');
    if (seg.length < 5) continue; // knowledge/sources/<年>/<目录>/<文件>
    const dir = seg.slice(0, 4).join('/');
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }

  const out: WorkCandidate[] = [];
  for (const [dir, n] of counts) {
    if (n < MIN_CHAPTERS) continue;
    const slug = dir.split('/').pop() ?? '';
    if (claimed.has(slug)) continue;
    out.push({ dir, slug, chapters: n, title: slug.replace(/[-_]/g, ' ') });
  }
  return out.sort((a, b) => b.chapters - a.chapters);
}
