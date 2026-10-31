/**
 * 从自然语言问题里抽出「真正该拿去检索的那几个字」。
 *
 * 为什么需要它：中文问句会带一堆不承载信息的成分（有哪些 / 怎么做 / 帮我 / 吗），
 * 整句丢进 BM25 一个都命中不了——库里明明有，助手却说「没有」。
 * 这是假阴性，比不回答更伤信任。
 *
 * 策略按可靠度排：
 *   1. 在第一个疑问词处截断（「X 有哪些做法」→ X）——中文问句的主语几乎总在前面
 *   2. 剥掉开头的请求动作（帮我 / 查一下 / 关于）
 *   3. 剥掉结尾的泛化名词与语气词（做法 / 方法 / 吗 / 呢），可反复剥
 */

/** 标点：先清掉，否则 `$` 锚点会被问号挡住 */
const PUNCT = /[。.？?！!：:；;、，"'“”‘’（）()【】\[\]「」《》\s]/g;

/** 开头的请求动作 */
const LEAD =
  /^(请|麻烦|帮我|帮忙|我想|我要|想知道|知道|想问|问一下|问问|问|找一下|找找|查找|查一下|查一查|查|搜一下|搜索|搜|关于|有关|看看|看一下)+/;

/** 疑问词：在这里截断，前半段就是检索对象 */
const INTERROG = /(为什么|怎么|怎样|如何|哪些|哪种|什么|是否|有没有|能不能|可不可以|多少|哪年|谁)/;

/** 结尾的泛化名词与语气词，可反复剥 */
const TAIL_PART =
  /(有哪些|有什么|是什么|是啥|的做法|的方法|的思路|的内容|做法|方法|思路|内容|相关|方面|吗|呢|吧|呀|啊|有|是|的|了)+$/;

/** 不承载检索意义的连接词 */
const FILLER = /[的在了于和与及]/g;

const MIN = 2;

export function extractKey(q: string): string {
  let s = q.replace(PUNCT, '').trim();

  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.replace(LEAD, '').trim();
    if (s === before) break;
  }

  // 在第一个疑问词处截断：主语在前，问法在后
  const head = s.split(INTERROG)[0] ?? '';
  if (head.replace(FILLER, '').length >= MIN) s = head;

  for (let i = 0; i < 4; i += 1) {
    const before = s;
    s = s.replace(TAIL_PART, '').trim();
    if (s === before) break;
  }

  const cut = s.replace(FILLER, '');
  const out = cut.length >= MIN ? cut : q.replace(PUNCT, '').replace(FILLER, '');
  return out.slice(0, 30);
}

/**
 * 一次没命中时退一步的候选：8 / 6 / 4 字的前缀。
 * 中文 2-gram 索引下，「上下文压缩做法」这种带尾词的串仍可能全 miss，
 * 而「上下文压缩」一定命中。
 */
export function keyFallbacks(key: string): string[] {
  const out: string[] = [];
  if (key.length > 8) out.push(key.slice(0, 8));
  if (key.length > 6) out.push(key.slice(0, 6));
  if (key.length > 4) out.push(key.slice(0, 4));
  return [...new Set(out.filter((k) => k.length >= MIN && k !== key))];
}
