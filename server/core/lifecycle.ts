/**
 * 生命周期快照：把模型套到真实对象上，回答三个问题——
 *   这个东西在哪一步 / 缺什么 / 下一步谁能推
 *
 * 这是 AI 的切入点清单来源：没有它，AI 只能「你自己说要干什么」；
 * 有了它，AI 能主动说「这 7 条卡在同一处，要我逐条处理吗」。
 */
import type { Habitat } from './space.ts';
import type { AnyObject } from '../../shared/types.ts';
import { lifeOf, factsOf, type LifeView, type LifeFacts } from '../../shared/lifecycle-model.ts';
import { usageOf, daysSince, type UsageRec } from './usage.ts';

/**
 * 活性：跟成熟度正交的第二个维度。
 * 成熟度回答「长成什么样」，活性回答「还有没有人碰」。
 * 只算成熟度会出现「已定稿但三年没人看」——状态很好，实际已经是灰。
 */
export type Vitality = 'hot' | 'warm' | 'cooling' | 'cold' | 'ash';

export function vitalityOf(rec: UsageRec | undefined, createdAt?: string): { level: Vitality; days: number } {
  const last = rec?.last ?? createdAt;
  const d = daysSince(last);
  if (d <= 7) return { level: 'hot', days: d };
  if (d <= 30) return { level: 'warm', days: d };
  if (d <= 90) return { level: 'cooling', days: d };
  if (d <= 180) return { level: 'cold', days: d };
  return { level: 'ash', days: d };
}

const VITALITY_NAME: Record<Vitality, string> = {
  hot: '活跃',
  warm: '常温',
  cooling: '转冷',
  cold: '冰冷',
  ash: '灰',
};

export function vitalityName(v: Vitality): string {
  return VITALITY_NAME[v];
}

export interface StuckItem {
  id: string;
  type: string;
  title: string;
  state: string;
  stateName: string;
  blockers: string[];
  aiHook?: string;
  /** 卡了多少天（按文件 mtime） */
  days: number;
  /** 多久没人碰过 */
  idleDays: number;
  vitality: Vitality;
}

export interface LifeSnapshot {
  at: string;
  byState: { flow: string; state: string; stateName: string; n: number }[];
  stuck: StuckItem[];
  /** 有 AI 钩子的卡点——这才是 AI 该接手的 */
  agentReady: StuckItem[];
  /** 稳定态：内容写成完整判断、只差一次人工确认的（不计入欠账） */
  stable: { id: string; title: string; state: string; stateName: string; why: string }[];
  /** 翻新队列：冷掉但还没结灰的，和已经结灰的 */
  refresh: { id: string; title: string; state: string; stateName: string; vitality: Vitality; idleDays: number; why: string }[];
  byVitality: { vitality: Vitality; name: string; n: number }[];
}

function inboundOf(hab: Habitat, id: string): number {
  const links = (hab.store as unknown as { links: { from: string; to: string; resolved: string | null }[] }).links;
  return links.filter((l) => l.resolved === id).length;
}

function outboundOf(hab: Habitat, id: string): number {
  const links = (hab.store as unknown as { links: { from: string; to: string; resolved: string | null }[] }).links;
  return links.filter((l) => l.from === id).length;
}

/** 单个对象的完整视图（CLI / API 都走这里，不各写一份） */
/**
 * withStat：是否需要「文件多久没改」。
 *
 * 默认不需要——快照里用的闲置天数是 usage 记录的（谁碰过），不是 mtime。
 * 之前每算一个对象就 stat 一次盘，186 个对象就是 186 次串行 IO，
 * 实测让 /api/maintenance/brief 多花 88ms，而那个值根本没人读。
 */
export async function lifeViewOf(
  hab: Habitat,
  id: string,
  opts: { withStat?: boolean } = {},
): Promise<{ view: LifeView; days: number } | null> {
  const obj = hab.store.get(id);
  if (!obj) return null;
  let days = 0;
  if (opts.withStat) {
    const rel = hab.store.file(id);
    const st = rel ? await hab.store.adapter.stat(rel).catch(() => null) : null;
    days = st ? Math.floor((Date.now() - new Date(st.mtime).getTime()) / 86400_000) : 0;
  }

  const extra: Partial<LifeFacts> = {
    inbound: inboundOf(hab, id),
    outbound: outboundOf(hab, id),
    // status 不一定挂在对象上（work.yaml 的 status 只被收进 statusOf），
    // 统一从那里取，否则「备查」标记永远不生效
    reference: (hab.store as unknown as { statusOf: Map<string, string> }).statusOf.get(id) === 'reference',
  };

  const t = (obj as unknown as { type: string }).type;
  if (t === 'note') {
    // 笔记的正文本来就在内存里（Scan 时已解析），这里不会读盘
    const body = await hab.store.body(id).catch(() => '');
    extra.bodyLength = body.length;
    // 「有没有结论段」决定它是「写完了只差确认」还是「真的没写完」。
    // 只看小节标题，不看正文里提没提到 TODO——正文里讨论 TODO 的笔记太多了，
    // 用关键词扫会把引用源码的段落全判成没写完（实测 14 篇误报里 12 篇是这个）。
    extra.hasConclusion = /^#{1,4}\s*(结论|判断|要点|小结|结论先行|一句话)/m.test(body);
  }
  if (t === 'part') {
    const anns = hab.store.all('annotation').filter((a) => (a as unknown as { repId?: string }).repId);
    const partReps = hab.store.all('rep').filter((r) => (r as unknown as { partId?: string }).partId === id);
    const repIds = new Set(partReps.map((r) => (r as unknown as { id: string }).id));
    extra.derived = anns.filter((a) => repIds.has(String((a as unknown as { repId: string }).repId))).length;
    let pct = 0;
    for (const [rid, c] of hab.store.cursors) if (repIds.has(rid)) pct = Math.max(pct, c.furthest ?? c.current);
    extra.readPct = pct;
  }

  const view = lifeOf(factsOf(obj as unknown as AnyObject, extra));
  return view ? { view, days } : null;
}

/**
 * 快照要读每个对象的正文来判「成篇没」，100+ 对象就是 100+ 次文件读。
 * 今天页每次刷新都算一遍会明显发涩，所以按「对象数 + 事件数」缓存 20 秒——
 * 数据一变指纹就变，不会读到旧结果。
 */
let snapCache: { at: number; data: LifeSnapshot } | null = null;

export async function lifeSnapshot(hab: Habitat): Promise<LifeSnapshot> {
  if (snapCache && Date.now() - snapCache.at < 20_000) return snapCache.data;
  const data = await computeSnapshot(hab);
  snapCache = { at: Date.now(), data };
  return data;
}

async function computeSnapshot(hab: Habitat): Promise<LifeSnapshot> {
  const items: StuckItem[] = [];
  const stableItems: LifeSnapshot['stable'] = [];
  const counter = new Map<string, { flow: string; stateName: string; n: number }>();

  const targets: AnyObject[] = [
    ...hab.store.all('note'),
    ...hab.store.all('action'),
    ...hab.store.all('project'),
    ...hab.store.all('part'),
  ] as unknown as AnyObject[];

  const usage = await usageOf(hab.store);

  for (const obj of targets) {
    const id = String((obj as unknown as { id: string }).id);
    const got = await lifeViewOf(hab, id);
    if (!got) continue;
    const { view, days } = got;

    // 终态不进任何队列：归档、被取代、已定稿、备查都是走完了
    if (['archived', 'superseded', 'settled', 'reference'].includes(view.state)) continue;

    const k = `${view.flow}|${view.state}`;
    const cur = counter.get(k) ?? { flow: view.flow, stateName: view.stateName, n: 0 };
    cur.n += 1;
    counter.set(k, cur);

    const title = String(
      (obj as unknown as { title?: string }).title ?? (obj as unknown as { text?: string }).text ?? id,
    ).slice(0, 60);

    const created = String((obj as unknown as { createdAt?: string }).createdAt ?? '');
    const vit = vitalityOf(usage[id], created);

    // 只差一次确认的，单独归堆，不进欠账清单
    if (!view.stuck) {
      stableItems.push({
        id,
        title,
        state: view.state,
        stateName: view.stateName,
        why: view.blockers[0] ?? '内容完整，等你确认是否定稿',
      });
      continue;
    }

    items.push({
      id,
      type: view.type,
      title,
      state: view.state,
      stateName: view.stateName,
      blockers: view.blockers,
      aiHook: view.aiHook,
      days,
      idleDays: vit.days,
      vitality: vit.level,
    });
  }

  const byState = [...counter.entries()]
    .map(([k, v]) => ({ flow: k.split('|')[0], state: k.split('|')[1], stateName: v.stateName, n: v.n }))
    .sort((a, b) => b.n - a.n);

  // 卡住的排序：有 AI 钩子的优先，其次按多久没人碰
  const stuck = items.sort((a, b) => (a.aiHook ? 0 : 1) - (b.aiHook ? 0 : 1) || b.idleDays - a.idleDays);

  // 翻新队列：不看成熟度，只看「冷掉了会怎样」
  const refresh = stuck
    .filter((x) => x.vitality === 'cold' || x.vitality === 'ash')
    .map((x) => {
      let why = '';
      if (x.state === 'settled' || x.state === 'linked') why = '结论可能已经过期';
      else if (x.state === 'developed') why = '写了一半，放久了就想不起来了';
      else if (x.state === 'captured' || x.state === 'triaged') why = '收了没判断，正在变成灰';
      else if (x.state === 'derive' || x.state === 'digest') why = '读了一半没转化';
      else why = '很久没动';
      return {
        id: x.id,
        title: x.title,
        state: x.state,
        stateName: x.stateName,
        vitality: x.vitality,
        idleDays: x.idleDays,
        why,
      };
    })
    .sort((a, b) => b.idleDays - a.idleDays);

  const vCount = new Map<Vitality, number>();
  for (const x of stuck) vCount.set(x.vitality, (vCount.get(x.vitality) ?? 0) + 1);
  const byVitality = (['hot', 'warm', 'cooling', 'cold', 'ash'] as Vitality[]).map((v) => ({
    vitality: v,
    name: vitalityName(v),
    n: vCount.get(v) ?? 0,
  }));

  return {
    at: new Date().toISOString(),
    byState,
    stuck,
    stable: stableItems.sort((a, b) => a.title.localeCompare(b.title, 'zh')),
    agentReady: stuck.filter((x) => !!x.aiHook).slice(0, 20),
    refresh: refresh.slice(0, 50),
    byVitality,
  };
}

/** 给 AI 看的一份「你可以接手什么」 */
export function renderNext(snap: LifeSnapshot): string {
  const lines: string[] = [`# 可接手的点（${snap.at.slice(0, 16).replace('T', ' ')}）`, ''];
  if (!snap.agentReady.length) {
    lines.push('没有明确可接手的卡点。要么都在终态，要么都缺你自己的判断。');
    return lines.join('\n');
  }
  for (const x of snap.agentReady) {
    lines.push(`- ${x.title}（${x.stateName}，搁置 ${x.days} 天）`);
    if (x.blockers.length) lines.push(`    缺：${x.blockers.join('；')}`);
    if (x.aiHook) lines.push(`    你能做：${x.aiHook}`);
    lines.push(`    id：${x.id}`);
  }
  lines.push('');
  lines.push('动手时走 propose → commit，别直接改文件。');
  return lines.join('\n');
}
