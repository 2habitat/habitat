/**
 * 页内助手（设计方案 §7）
 * 三条硬要求：
 *  · 每次可见：带入对象、可见范围、预算、允许动作
 *  · 回答必须带依据（条目或段落），不能编造；检索为空就说空
 *  · 每条回复至少有一个可执行动作
 *
 * 这里没有接大模型：回答由本地检索结果拼装，句句有出处。
 * 接 LLM 的位置在 `ask()` 里的 compose —— 换掉它即可，其余（依据、动作、事件）不动。
 */
import { useEffect, useRef, useState } from 'react';
import { endpoints, type SearchView, type TodayView, type FlowView } from '../services/api.ts';
import { useUi, type AiContext } from './ui.ts';
import { navigate } from './router.ts';
import { Chip } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';
import { extractKey, keyFallbacks } from '../../shared/ai.ts';

interface Evidence { id: string; title: string; type: string; snippet: string }
interface ActionBtn { label: string; run: () => void | Promise<void> }
interface Msg {
  role: 'me' | 'ai';
  text: string;
  evidence?: Evidence[];
  actions?: ActionBtn[];
  budget?: { used: number; limit: number };
}

const SUGGESTIONS = [
  '我有哪些书没读完？',
  '最近谁动过我的库？',
  '这一章讲了什么？',
  '卡住的知识有哪些？',
  '帮我找关于状态的内容',
];

export function AiPanel() {
  const open = useUi((s) => s.aiOpen);
  const close = useUi((s) => s.closeAi);
  const ctx = useUi((s) => s.aiCtx);
  const openSheet = useUi((s) => s.openSheet);
  const toast = useUi((s) => s.toast);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [budget, setBudget] = useState({ used: 0, limit: 3 });
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, open]);

  useEffect(() => {
    endpoints.system().then((s) => setBudget({ used: s.budget.usedToday, limit: s.budget.dailyProposalLimit })).catch(() => undefined);
  }, [open]);

  if (!open) return null;

  const say = (m: Msg) => setMsgs((p) => [...p, m]);

  async function go(text: string): Promise<Msg> {
    const q = text.trim();
    if (!q) return { role: 'ai', text: '想问什么？可以直接问，也可以点上面的建议。' };

    // 1. 阅读进度：按「作品读了多少」判断，而不是只看有没有阅读游标记录——
    //    否则你正站在阅读器里问「哪些没读完」，它却回答「没有正在读的条目」
    if (/读到|进度|没读完|读完|继续读/.test(q)) {
      const { works } = await endpoints.works();
      const un = works.filter((w) => w.readPct < 0.99);
      if (!un.length) {
        return {
          role: 'ai',
          text: `书架上的 ${works.length} 部作品都读完了。`,
          actions: [{ label: '打开书架', run: () => navigate('shelf') }],
        };
      }
      const started = un.filter((w) => w.readPct > 0);
      return {
        role: 'ai',
        text: started.length
          ? `有 ${un.length} 部作品没读完，其中 ${started.length} 部读到一半：`
          : `有 ${un.length} 部作品还没开始读：`,
        evidence: un.slice(0, 6).map((w) => ({
          id: w.work.id,
          title: w.work.title,
          type: 'work',
          snippet: `读到 ${Math.round(w.readPct * 100)}%，共 ${w.parts.length} 章${w.next ? `；下一步：${w.next.text}` : ''}`,
        })),
        actions: [
          {
            label: started.length ? '继续读最靠前的一部' : '从第一部开始读',
            run: () => navigate('reader', { work: (started[0] ?? un[0]).work.id }),
          },
          { label: '看全部', run: () => navigate('continue') },
        ],
      };
    }

    // 2. 谁动过（对账）
    if (/谁|最近|动过|未署名|外部/.test(q)) {
      const j = await endpoints.journal({ limit: '12' });
      const unsigned = j.events.filter((e) => e.actor === 'external:unknown');
      const lines = j.events.slice(0, 8).map((e) => `${e.at.slice(5, 16)} ${actorName(e.actor)} · ${opName(e.op)} · ${e.summary}`);
      return {
        role: 'ai',
        text: unsigned.length
          ? `最近 ${j.events.length} 条动作里有 ${unsigned.length} 条没署名，可能是外部编辑器改的。`
          : `最近 ${j.events.length} 条动作都有署名。`,
        evidence: j.events.slice(0, 6).map((e) => ({
          id: e.id, title: e.summary, type: 'event',
          snippet: `${e.at.slice(0, 16)} · ${actorName(e.actor)} · ${e.target}`,
        })),
        actions: [
          { label: '去接入页看全部', run: () => navigate('agent') },
          {
            label: unsigned.length ? '对账一次' : '刷新事件流',
            run: async () => {
              const r = await endpoints.reconcile();
              toast(r.report.unsigned.length ? `发现 ${r.report.unsigned.length} 处未署名改动` : '没有未署名改动', r.report.unsigned.length ? 'err' : 'ok');
              navigate('agent');
            },
          },
        ],
      };
    }

    // 3. 卡在哪
    if (/卡|下一步|推进|消化|沉淀|没做/.test(q)) {
      const f: FlowView = await endpoints.flow();
      const stuck = f.stuck.slice(0, 6);
      if (!stuck.length) return { role: 'ai', text: '没有卡住的条目，五道闸门全过了。' };
      return {
        role: 'ai',
        text: `有 ${f.stuck.length} 个条目卡在闸门上：`,
        evidence: stuck.map((c) => ({
          id: c.id, title: c.title, type: c.kind,
          snippet: `卡在「${stageName(c.next?.key)}」：${c.next?.text ?? ''}`,
        })),
        actions: [
          { label: '打开流转看板', run: () => navigate('changes') },
          { label: '看流转', run: () => navigate('shelf') },
        ],
      };
    }

    // 4. 这一章讲了什么（用上下文）
    if (/这|讲了什么|摘要|总结|概括/.test(q) && ctx.id && ctx.kind !== 'none') {
      if (ctx.kind === 'rep') {
        const r = await endpoints.rep(ctx.id);
        const body = r.content.replace(/^---[\s\S]*?---\n/, '').replace(/^#.*$/m, '').trim();
        const sents = body.split(/(?<=[。！？\n])/).map((s) => s.trim()).filter((s) => s.length > 8);
        return {
          role: 'ai',
          text: sents.length
            ? `这一章的要点（都取自原文，没加我的发挥）：\n${sents.slice(0, 4).map((s, i) => `${i + 1}. ${s}`).join('\n')}`
            : '正文是空的，或者短到提不出要点。',
          evidence: [{ id: ctx.id, title: ctx.title, type: 'rep', snippet: body.slice(0, 160) }],
          actions: [
            {
              label: '就这段衍生一篇笔记',
              run: () => openSheet('derive', { srcId: ctx.id, title: `${ctx.title} · 读后`, body: `\n\n> ${sents.slice(0, 2).join('')}\n` }),
            },
            { label: '给这一章做批注', run: () => openSheet('annotate', { repId: ctx.id }) },
          ],
        };
      }
    }

    // 5. 找内容 → 检索
    // 整句拿去搜在中文里几乎必然 miss（问句里全是「有哪些」「帮我」这类成分），
    // 所以先抽关键词，还不行就退到更短的片段再试一次。
    const key = extractKey(q) || q;
    let used = key;
    let s: SearchView = await endpoints.search(key);
    if (!s.hits.length) {
      for (const alt of keyFallbacks(key)) {
        const t: SearchView = await endpoints.search(alt);
        if (t.hits.length) {
          s = t;
          used = alt;
          break;
        }
      }
    }
    if (!s.hits.length) {
      return {
        role: 'ai',
        text: `库里没有跟「${key}」相关的内容。我不能凭空编一段给你，换个词或者先去采集一条。`,
        actions: [
          { label: `采集「${key}」`, run: () => openSheet('capture', { title: key }) },
          { label: '全库检索', run: () => navigate('search', { q: key }) },
        ],
      };
    }
    return {
      role: 'ai',
      text: used === key
        ? `库里有 ${s.hits.length} 处跟「${key}」相关，最靠前的几处：`
        : `按「${key}」没搜到，缩小到「${used}」找到 ${s.hits.length} 处：`,
      evidence: s.hits.slice(0, 5).map((h) => ({ id: h.id, title: h.title, type: h.type, snippet: h.snippet })),
      actions: [
        { label: '打开检索页看全部', run: () => navigate('search', { q: used }) },
        {
          label: '把这几条收进一个专题',
          run: () => openSheet('capture', { title: `专题：${key}`, body: s.hits.slice(0, 5).map((h) => `- [[${h.title}]]`).join('\n') }),
        },
      ],
    };
  }

  async function ask(text: string) {
    setBusy(true);
    say({ role: 'me', text });
    setInput('');
    try {
      const m = await go(text);
      say({ ...m, budget });
      // 助手的每次回答都留痕：外部 Agent 做的事必须能被看见
      await endpoints.journalLog({ op: 'read', target: 'assistant', summary: `助手：${text.slice(0, 40)}`, payload: { ctx: ctx.id } });
    } catch (e) {
      say({ role: 'ai', text: `我没能回答这个问题：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="ai-panel" role="complementary" aria-label="AI 助手" data-testid="ai-panel">
      <div className="ai-ctx">
        <span className="ai-ctx-title">助手</span>
        <span className="ai-ctx-item">带入：{ctx.kind === 'none' ? '无' : ctx.title}</span>
        <span className="ai-ctx-item" data-warn={budget.used >= budget.limit ? '1' : '0'}>提案 {budget.used}/{budget.limit}</span>
        <span className="spacer" />
        <button className="btn btn-ghost btn-icon btn-sm" onClick={close} aria-label="收起助手" data-testid="ai-close">
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="ai-log" ref={logRef}>
        {msgs.length === 0 && (
          <div className="ai-intro">
            <p className="ai-intro-text">
              我能看到的只有你这个空间里的真实内容，回答都会附上出处。检索不到我会直说，不会编。
            </p>
            <div className="ai-allow">
              允许的动作：检索 / 打开 / 衍生笔记 / 采集 / 建任务 / 生成提案。要改正文必须你逐条确认。
            </div>
            <div className="ai-starters">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="ai-starter" onClick={() => void ask(s)} data-testid="ai-suggest">
                  <span>{s}</span>
                  <Icon name="arrow" size={12} />
                </button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m, i) => (
          m.role === 'me' ? (
            <div key={i} className="ai-msg ai-msg-me" data-testid="ai-msg-me">{m.text}</div>
          ) : (
            <article key={i} className="ai-reply" data-testid="ai-msg-ai">
              <div className="ai-reply-head">
                <span className="ai-reply-mark" aria-hidden="true">✦</span>
                <span>助手</span>
                {!!m.evidence?.length && <span className="ai-reply-cite">依据 {m.evidence.length}</span>}
              </div>
              <div className="ai-reply-body">{m.text}</div>

              {!!m.evidence?.length && (
                <ol className="ai-cites">
                  {m.evidence.map((e, j) => (
                    <li key={e.id}>
                      <span className="ai-cite-no">{j + 1}</span>
                      <div className="ai-cite-main">
                        <a
                          href="#"
                          onClick={(ev) => {
                            ev.preventDefault();
                            close();
                            navigate(e.type === 'event' ? 'agent' : e.type === 'note' ? 'editor' : 'reader', { id: e.id, rep: e.id });
                          }}
                        >
                          {e.title}
                        </a>
                        <div className="ai-cite-snip ellipsis">{e.snippet}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              {!!m.actions?.length && (
                <div className="ai-acts">
                  {m.actions.map((a, j) => (
                    <button key={j} className="btn btn-sm" data-testid="ai-action" onClick={() => { void a.run(); }}>
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </article>
          )
        ))}

        {busy && <div className="ai-thinking"><span className="spin" /> 在库里找…</div>}
      </div>

      <div className="ai-composer">
        <textarea
          className="ai-input"
          placeholder="问点什么…"
          value={input}
          rows={2}
          data-testid="ai-input"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(input);
            }
          }}
        />
        <div className="ai-composer-foot">
          <span className="ai-composer-hint">回车发送 · Shift+回车换行</span>
          <button
            className="btn btn-sm btn-primary"
            disabled={!input.trim() || busy}
            onClick={() => void ask(input)}
          >
            发送
          </button>
        </div>
      </div>
    </aside>
  );
}

export function AiFab() {
  const open = useUi((s) => s.aiOpen);
  const openAi = useUi((s) => s.openAi);
  if (open) return null;
  return (
    <button className="ai-fab" onClick={() => openAi()} aria-label="打开 AI 助手" data-testid="ai-fab">
      <Icon name="assistant" size={15} />
      助手
    </button>
  );
}

function actorName(a: string): string {
  if (a === 'human') return '我';
  if (a === 'system') return '系统';
  if (a === 'external:unknown') return '未署名';
  return `AI·${a.replace('agent:', '')}`;
}

function opName(op: string): string {
  return ({
    capture: '采集', ingest: '入库', read: '阅读', annotate: '批注', derive: '衍生', edit: '编辑',
    propose: '提案', review: '回顾', settle: '沉淀', commit: '提交', build: '构建', import: '导入',
    revert: '撤销', external_edit: '未署名改动', reconcile: '对账',
  } as Record<string, string>)[op] ?? op;
}

function stageName(k?: string): string {
  return ({ capture: '采集', derive: '衍生', digest: '消化', review: '回顾', settle: '沉淀' } as Record<string, string>)[k ?? ''] ?? '未开始';
}

export type { AiContext };
