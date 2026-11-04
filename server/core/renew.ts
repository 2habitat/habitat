/**
 * 翻新：把「该翻新」变成「有证据可判」。
 *
 * 借鉴 Obsidian Contradiction Finder 的两段式：便宜召回 → 昂贵判定。
 * 但它靠 embedding + LLM；这里没有模型，所以拆成：
 *   服务端负责**召回**（用已有的 BM25 索引找候选冲突，确定性、可解释）
 *   harness 负责**判定**（读证据包，决定要不要 supersede）
 *
 * 这样服务端不需要模型也能给出高价值的候选，AI 只在最后一米介入。
 */
import type { Habitat } from './space.ts';
import { daysSince, type UsageRec } from './usage.ts';

/* ---------------- 间隔重复：翻新节奏 ---------------- */

const LADDER = [1, 3, 7, 21, 60, 180];
const STATE = '.habitat/state/review.json';

export interface ReviewRec {
  /** 下次该看的时间 */
  due: string;
  /** 当前间隔（天），对应 LADDER 的下标 */
  step: number;
  lastOk?: string;
  /** 连续确认次数 */
  streak: number;
}

type ReviewMap = Record<string, ReviewRec>;

async function loadReview(hab: Habitat): Promise<ReviewMap> {
  const raw = await hab.store.adapter.read(STATE).catch(() => '');
  try {
    return (JSON.parse(raw) as ReviewMap) ?? {};
  } catch {
    return {};
  }
}

async function saveReview(hab: Habitat, m: ReviewMap): Promise<void> {
  await hab.store.adapter.write(STATE, JSON.stringify(m, null, 2), { backup: false });
}

/**
 * 记一次复核。
 * ok=true：仍然成立 → 间隔往上一档（1→3→7→21→60→180）
 * ok=false：已经不对 → 回到第 0 档，明天再看（要改写，不是要忘掉）
 *
 * 刻意不用 SM-2 的难度因子：社区反馈「ease hell」——老判难会让卡片永远
 * 高频出现，人很快就烦了。固定阶梯更好预测，也更容易解释。
 */
export async function markReviewed(
  hab: Habitat,
  id: string,
  ok: boolean,
): Promise<{ rec: ReviewRec; nextIn: number }> {
  const m = await loadReview(hab);
  const prev = m[id];
  const step = ok ? Math.min((prev?.step ?? -1) + 1, LADDER.length - 1) : 0;
  const days = LADDER[step];
  const now = new Date();
  const rec: ReviewRec = {
    due: new Date(now.getTime() + days * 86400_000).toISOString(),
    step,
    lastOk: ok ? now.toISOString() : prev?.lastOk,
    streak: ok ? (prev?.streak ?? 0) + 1 : 0,
  };
  m[id] = rec;
  await saveReview(hab, m);
  return { rec, nextIn: days };
}

export async function reviewOf(hab: Habitat, id: string): Promise<ReviewRec | undefined> {
  return (await loadReview(hab))[id];
}

export interface DueReview {
  id: string;
  title: string;
  idleDays: number;
  /** 上次复核时排的下次时间；从未复核过则没有 */
  due?: string;
}

/**
 * 到期复核队列：活性上「冷掉或结灰」且（从未复核 或 已到期）的对象。
 * 之前这段逻辑只写在 CLI 里，服务端和 harness 各自抄一遍就会漂；
 * 现在只有这一份，CLI、/api/loops、手册都用它。
 */
export async function reviewQueue(hab: Habitat): Promise<DueReview[]> {
  const { lifeSnapshot } = await import('./lifecycle.ts');
  const snap = await lifeSnapshot(hab);
  const map = await loadReview(hab);
  const now = Date.now();
  const out: DueReview[] = [];
  for (const x of snap.refresh) {
    const rv = map[x.id];
    if (rv && Date.parse(rv.due) > now) continue;
    out.push({ id: x.id, title: x.title, idleDays: x.idleDays, due: rv?.due });
  }
  return out;
}

/* ---------------- 冲突召回（确定性，不需要模型） ---------------- */

/** 只在结论里出现的转折词：出现这些，说明作者自己就在推翻/限定某个说法 */
const HEDGE = /(但是|然而|其实|实际上|并不|并非|相反|推翻|过时|不再|纠正|误以为|错误|前提变了)/;

export interface ConflictCandidate {
  id: string;
  title: string;
  /** 词袋相似度（Jaccard），用来解释排序 */
  sim: number;
  /** 和目标的共同关键词，用来解释「为什么把它挑出来」 */
  shared: string[];
  /** 比目标新多少天（负数=更旧） */
  newerBy: number;
  /** 对方开头的结论片段 */
  excerpt: string;
  /** 命中了转折词 */
  hedged: boolean;
}

/**
 * 粗糙但可用的词袋：中文取**全部**二元组，英文取词。
 *
 * 之前只取每段的前 6 个二元组（`i < 6`），而中文整句没有空格会被当成一段，
 * 于是两条不同文本的共同词几乎为 0——候选召回永远是空的。
 */
function bagOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of text.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []) out.add(w);
  return out;
}

/** 展示用：去掉以虚词开头的二元组，否则「的是」「不是」满屏飞 */
const FUNCTION_CHARS = /[的了是在和与有了就不也都还很更最把被让给对从到而或及以之其]/;
function readable(terms: string[], limit = 6): string[] {
  return terms.filter((t) => !(t.length === 2 && FUNCTION_CHARS.test(t[0]))).slice(0, limit);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 找出「可能跟这条打架」的候选。
 * 注意：这是召回，不是判定——它的价值是把 100+ 条缩到 5 条，剩下的交给 AI。
 */
export async function conflictCandidates(hab: Habitat, id: string, limit = 5): Promise<ConflictCandidate[]> {
  const target = hab.store.get(id);
  if (!target) return [];
  const t = target as unknown as { title?: string; text?: string; updatedAt?: string; type: string };
  const title = String(t.title ?? t.text ?? '');
  const body = await hab.store.body(id).catch(() => '');
  const mine = bagOf(`${title} ${body.slice(0, 900)}`);
  const myTime = Date.parse(t.updatedAt ?? '') || 0;

  // 检索用「几个实词」而不是整句标题：整句当 query 只有它自己命中
  const probe = readable(
    [...bagOf(title)].filter((t) => /^[a-z]/.test(t) || !FUNCTION_CHARS.test(t[0])),
    10,
  ).join(' ');
  const hits = hab.index
    .search(probe || title || body.slice(0, 40), { limit: 40 })
    .filter((h) => h.id !== id && (h.type === 'note' || h.type === 'part'));

  const out: ConflictCandidate[] = [];
  for (const h of hits) {
    const o = hab.store.get(h.id);
    if (!o) continue;
    const oo = o as unknown as { title?: string; text?: string; updatedAt?: string; archivedAt?: string };
    if (oo.archivedAt) continue;
    const otherTitle = String(oo.title ?? oo.text ?? '');
    const otherBody = await hab.store.body(h.id).catch(() => '');
    const theirs = bagOf(`${otherTitle} ${otherBody.slice(0, 900)}`);
    const sim = jaccard(mine, theirs);
    // 相似度太低说明八竿子打不着，不可能互相推翻；0.06 是实测出来的下限
    if (sim < 0.03) continue;
    const shared = [...theirs].filter((k) => mine.has(k));
    const otherTime = Date.parse(oo.updatedAt ?? '') || 0;
    out.push({
      id: h.id,
      title: otherTitle.slice(0, 60),
      shared: readable(shared.sort((a, b) => Number(b.length > 2) - Number(a.length > 2))),
      newerBy: otherTime ? Math.round((otherTime - myTime) / 86400_000) : 0,
      excerpt: otherBody.replace(/\s+/g, ' ').slice(0, 200),
      hedged: HEDGE.test(otherBody.slice(0, 1200)),
      sim,
    });
  }

  // 排序：比自己新的优先（新证据最可能推翻旧结论），其次命中转折词，最后共同关键词多
  // 排序：新的优先（新证据最可能推翻旧结论）→ 命中转折词 → 相似度
  return out
    .sort(
      (a, b) =>
        Number(b.newerBy > 0) - Number(a.newerBy > 0) || Number(b.hedged) - Number(a.hedged) || b.sim - a.sim,
    )
    .slice(0, limit);
}

/* ---------------- 证据包 ---------------- */

export interface RenewPack {
  id: string;
  title: string;
  state: string;
  /** 多久没碰 */
  idleDays: number;
  /** 上次复核记录 */
  review?: { streak: number; step: number };
  /** 这条笔记自己的主张（开头 + 小节标题） */
  claims: string[];
  candidates: ConflictCandidate[];
  /** 给 AI 的判定提示 */
  ask: string;
}

export async function renewPack(hab: Habitat, id: string, usage: Record<string, UsageRec> = {}): Promise<RenewPack | null> {
  const obj = hab.store.get(id);
  if (!obj) return null;
  const o = obj as unknown as { title?: string; text?: string; updatedAt?: string; createdAt?: string };
  const body = await hab.store.body(id).catch(() => '');
  const title = String(o.title ?? o.text ?? id);

  const headings = body
    .split('\n')
    .filter((l) => /^#{2,3}\s+/.test(l))
    .map((l) => l.replace(/^#{2,3}\s+/, '').trim())
    .slice(0, 6);
  const firstPara = body
    .replace(/^---[\s\S]*?---/, '')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .slice(0, 3)
    .join(' ')
    .slice(0, 280);

  const review = (await loadReview(hab))[id];

  return {
    id,
    title,
    state: 'settled',
    idleDays: daysSince(usage[id]?.last ?? o.updatedAt ?? o.createdAt),
    review: review ? { streak: review.streak, step: review.step } : undefined,
    claims: [firstPara, ...headings].filter(Boolean),
    candidates: await conflictCandidates(hab, id),
    ask: '判断这些候选里有没有真的推翻它：有就出 supersededBy 提案（不删旧文），没有就 review --ok 把它往后推一档。',
  };
}

export function renderRenew(p: RenewPack): string {
  const lines: string[] = [];
  lines.push(`# 翻新：${p.title}`);
  lines.push(`搁置 ${p.idleDays} 天${p.review ? ` · 已确认 ${p.review.streak} 次（间隔第 ${p.review.step} 档）` : ' · 从未复核过'}`);
  lines.push('');
  lines.push('## 它主张什么');
  for (const c of p.claims) lines.push(`- ${c}`);
  lines.push('');
  if (!p.candidates.length) {
    lines.push('## 库里没有找到可能冲突的条目');
    lines.push('这不代表它一定还成立，只说明没有新东西撞上来。');
  } else {
    lines.push(`## 可能撞上的 ${p.candidates.length} 条`);
    for (const c of p.candidates) {
      const when = c.newerBy > 0 ? `比它新 ${c.newerBy} 天` : c.newerBy < 0 ? `比它旧 ${-c.newerBy} 天` : '同一天';
      lines.push(`- **${c.title}**（${when}${c.hedged ? '，含转折/纠正语气' : ''}）`);
      lines.push(`    共同词：${c.shared.join('、')}`);
      lines.push(`    ${c.excerpt}`);
      lines.push(`    id：${c.id}`);
    }
  }
  lines.push('');
  lines.push('## 你要做的');
  lines.push(p.ask);
  return lines.join('\n');
}
