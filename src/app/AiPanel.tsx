/**
 * 页内助手（Agent 会话层）。
 *
 * 这里不再有「本地检索 if/else」：界面只消费 /api/agent/sessions/:id/events 的事件流。
 * 换 harness、换技能、换审批策略都不改这个组件的主结构。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { endpoints } from '../services/api.ts';
import type { AgentEvent, AgentSkill, AnnotationSuggestion, HarnessView, SessionView } from '../../shared/agent.ts';
import { useUi, type AiContext } from './ui.ts';
import { useRefresh } from '../services/use.ts';
import { Icon } from '../components/icons.tsx';
import { navigate } from './router.ts';

interface ToolCard {
  callId: string;
  name: string;
  tier: string;
  phase: 'start' | 'end';
  title?: string;
  summary?: string;
  ok?: boolean;
}

interface Msg {
  id: string;
  role: 'me' | 'ai';
  text: string;
  streaming?: boolean;
  tools?: ToolCard[];
  suggestions?: AnnotationSuggestion[];
  error?: boolean;
}

interface PendingPermission {
  requestId: string;
  kind: 'tool' | 'proposal';
  action: string;
  preview: string;
  proposalId?: string;
}

const SUGGESTIONS = [
  '我有哪些书没读完？',
  '最近谁动过我的库？',
  '这一章讲了什么？',
  '卡住的知识有哪些？',
  '帮我找关于状态的内容',
];

let msgSeq = 1;
const nextMsgId = () => `m-${msgSeq++}`;

export function AiPanel() {
  const open = useUi((s) => s.aiOpen);
  const close = useUi((s) => s.closeAi);
  const ctx = useUi((s) => s.aiCtx);
  const surface = useUi((s) => s.aiSurface);
  const setSurface = useUi((s) => s.setAiSurface);
  const floatBox = useUi((s) => s.aiFloat);
  const setFloat = useUi((s) => s.setAiFloat);
  const refs = useUi((s) => s.aiRefs);
  const removeRef = useUi((s) => s.removeAiRef);
  const harnessId = useUi((s) => s.aiHarnessId);
  const setHarness = useUi((s) => s.setAiHarness);
  const skillId = useUi((s) => s.aiSkillId);
  const setSkill = useUi((s) => s.setAiSkill);
  const approvals = useUi((s) => s.aiApprovals);
  const setApprovals = useUi((s) => s.setAiApprovals);
  const toast = useUi((s) => s.toast);
  const refresh = useRefresh();

  const [harnesses, setHarnesses] = useState<HarnessView[]>([]);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [session, setSession] = useState<SessionView | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [lastPack, setLastPack] = useState<{ usedChars: number; omitted: string[] } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SessionView | null>(null);
  sessionRef.current = session;
  const ctxRef = useRef<AiContext>(ctx);
  ctxRef.current = ctx;
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!open) return;
    void endpoints.agentHarnesses().then((r) => {
      setHarnesses(r.harnesses);
      if (!harnessId) {
        const first = r.harnesses.find((h) => h.enabled !== false && h.installed !== false);
        if (first) setHarness(first.id);
      }
    }).catch(() => undefined);
    void endpoints.agentSkills().then((r) => setSkills(r.skills)).catch(() => undefined);
  }, [open, harnessId, setHarness]);

  // 换焦点就是换上下文：旧会话不能继续带着上一章回答，也别把进程留在后台
  useEffect(() => {
    const old = sessionRef.current;
    sessionRef.current = null;
    if (old) void endpoints.agentClose(old.id).catch(() => undefined);
    setSession(null);
    setMessages([]);
    setPending(null);
    setLastPack(null);
  }, [ctx.id, ctx.kind]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open]);

  const handleEvent = useCallback((e: AgentEvent) => {
    switch (e.t) {
      case 'ready':
        setSession((s) => (s ? { ...s, status: 'ready', caps: e.caps, configOptions: e.configOptions } : s));
        setStatusText('');
        break;
      case 'turn':
        if (e.phase === 'start') {
          setBusy(true);
          setStatusText('正在想…');
          setMessages((prev) => [...prev, { id: nextMsgId(), role: 'ai', text: '', streaming: true, tools: [], suggestions: [] }]);
        } else {
          setBusy(false);
          setStatusText('');
          setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
          const active = sessionRef.current;
          if (active) {
            void endpoints.agentSession(active.id).then((r) => {
              setLastPack(r.lastPack as { usedChars: number; omitted: string[] } | null);
            }).catch(() => undefined);
          }
        }
        break;
      case 'text':
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.map((m) => m.role === 'ai' && m.streaming).lastIndexOf(true);
          if (idx >= 0) next[idx] = { ...next[idx], text: next[idx].text + e.delta };
          else next.push({ id: nextMsgId(), role: 'ai', text: e.delta, streaming: true, tools: [], suggestions: [] });
          return next;
        });
        break;
      case 'thought':
        setStatusText('正在想…');
        break;
      case 'tool':
        setStatusText(e.phase === 'end' ? '' : `${e.title ?? e.name}…`);
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.map((m) => m.role === 'ai' && m.streaming).lastIndexOf(true);
          if (idx < 0) return next;
          const cur = next[idx];
          const tools = [...(cur.tools ?? [])];
          const at = tools.findIndex((t) => t.callId === e.callId);
          const card: ToolCard = { callId: e.callId, name: e.name, tier: e.tier, phase: e.phase, title: e.title, summary: e.summary, ok: e.ok };
          if (at >= 0) tools[at] = { ...tools[at], ...card };
          else tools.push(card);
          next[idx] = { ...cur, tools };
          return next;
        });
        break;
      case 'permission':
        setPending({ requestId: e.requestId, kind: e.kind, action: e.action, preview: e.preview, proposalId: e.proposalId });
        break;
      case 'annotation':
        setMessages((prev) => {
          const next = [...prev];
          const idx = next.map((m) => m.role === 'ai' && m.streaming).lastIndexOf(true);
          if (idx >= 0) next[idx] = { ...next[idx], suggestions: [...(next[idx].suggestions ?? []), ...e.items] };
          else next.push({ id: nextMsgId(), role: 'ai', text: '', suggestions: e.items });
          return next;
        });
        if (e.accepted) {
          toast('AI 已按自动模式写入批注', 'ok');
          refresh();
        }
        break;
      case 'config':
        setSession((s) => (s ? { ...s, configOptions: e.options } : s));
        break;
      case 'error':
        setBusy(false);
        setStatusText('');
        setMessages((prev) => [...prev, { id: nextMsgId(), role: 'ai', text: e.message, error: true }]);
        break;
    }
  }, [refresh, toast]);

  useEffect(() => {
    if (!open || !session) return;
    const es = new EventSource(`/api/agent/sessions/${encodeURIComponent(session.id)}/events`);
    es.onmessage = (ev) => {
      try { handleEvent(JSON.parse(ev.data) as AgentEvent); } catch { /* 坏帧跳过 */ }
    };
    es.onerror = () => setStatusText('连接中断，正在重连…');
    return () => es.close();
  }, [open, session?.id, handleEvent]);

  const activeSkill = skills.find((s) => s.id === skillId) ?? null;
  const modelOption = session?.configOptions?.find((o) => (o.id === 'model' || o.category === 'model') && o.options.length > 0) ?? null;
  const starters = activeSkill?.starters?.length ? activeSkill.starters : SUGGESTIONS;
  const estimate = useMemo(() => {
    let n = ctx.title.length + 120;
    for (const r of refs) n += (r.quote?.quote.length ?? r.title.length) + 80;
    return n;
  }, [ctx.title, refs]);

  async function ensureSession(): Promise<SessionView | null> {
    if (sessionRef.current) return sessionRef.current;
    const c = ctxRef.current;
    try {
      const r = await endpoints.agentCreate({
        harnessId: harnessId || undefined,
        focus: {
          kind: ['rep', 'note', 'work'].includes(c.kind) ? c.kind : 'none',
          id: c.id,
          title: c.title,
          revision: c.revision ?? 0,
        },
        refs: refsRef.current,
        skillId: skillId === 'none' ? undefined : skillId,
        approvals,
      });
      setSession(r.session);
      return r.session;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
      return null;
    }
  }

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setInput('');
    setMessages((prev) => [...prev, { id: nextMsgId(), role: 'me', text: q }]);
    const s = await ensureSession();
    if (!s) return;
    setBusy(true);
    setStatusText('正在准备…');
    try {
      await endpoints.agentTurn(s.id, q, refsRef.current);
    } catch (e) {
      setBusy(false);
      setStatusText('');
      setMessages((prev) => [...prev, { id: nextMsgId(), role: 'ai', text: e instanceof Error ? e.message : String(e), error: true }]);
    }
  }

  async function acceptSuggestion(s: AnnotationSuggestion, repId: string) {
    const active = sessionRef.current;
    if (!active) return;
    try {
      const r = await endpoints.agentAcceptAnnotations({ sessionId: active.id, repId, items: [s] });
      if (r.accepted.length) {
        setMessages((prev) => prev.map((m) => ({
          ...m,
          suggestions: m.suggestions?.filter((x) => x.id !== s.id),
        })));
        toast('批注已写入', 'ok');
        refresh();
      } else {
        toast(r.rejected[0]?.reason ?? '这条建议没有通过校验', 'err');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  async function decide(decision: 'allow' | 'deny') {
    const active = sessionRef.current;
    if (!active || !pending) return;
    try {
      if (pending.kind === 'proposal' && decision === 'allow' && pending.proposalId) {
        await endpoints.agentCommitProposal(active.id, pending.proposalId);
        toast('已提交', 'ok');
        refresh();
      } else {
        await endpoints.agentPermission(active.id, pending.requestId, decision);
      }
      setPending(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  function resetSession() {
    const old = sessionRef.current;
    sessionRef.current = null;
    if (old) void endpoints.agentClose(old.id).catch(() => undefined);
    setSession(null);
    setMessages([]);
    setPending(null);
  }

  async function changeSkill(id: string) {
    setSkill(id);
    resetSession();
  }

  async function changeHarness(id: string) {
    setHarness(id);
    resetSession();
  }

  async function changeApprovals(patch: { annotations?: typeof approvals.annotations; body?: typeof approvals.body }) {
    setApprovals(patch);
    const active = sessionRef.current;
    if (active) {
      try { await endpoints.agentApprovals(active.id, patch); } catch { /* 下次发送会再带 */ }
    }
  }

  /* ---------------- float 拖拽 / 缩放 ---------------- */
  const dragRef = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; box: typeof floatBox } | null>(null);
  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if (surface !== 'float') return;
    if ((e.target as HTMLElement).closest('button,select,input,textarea')) return;
    dragRef.current = { mode: 'move', sx: e.clientX, sy: e.clientY, box: floatBox };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizePointerDown = (e: React.PointerEvent) => {
    if (surface !== 'float') return;
    e.stopPropagation();
    dragRef.current = { mode: 'resize', sx: e.clientX, sy: e.clientY, box: floatBox };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === 'move') {
      setFloat({
        x: Math.max(8, Math.min(window.innerWidth - 120, d.box.x + e.clientX - d.sx)),
        y: Math.max(8, Math.min(window.innerHeight - 80, d.box.y + e.clientY - d.sy)),
      });
    } else {
      setFloat({ w: Math.max(360, d.box.w + e.clientX - d.sx), h: Math.max(420, d.box.h + e.clientY - d.sy) });
    }
  };
  const onPointerUp = () => { dragRef.current = null; };

  if (!open) return null;

  const isFloat = surface === 'float';

  return (
    <aside
      className="ai-panel"
      data-surface={surface}
      role="complementary"
      aria-label="AI 助手"
      data-testid="ai-panel"
      style={isFloat ? { left: floatBox.x, top: floatBox.y, width: floatBox.w, height: floatBox.h } : undefined}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="ai-ctx" onPointerDown={onHeaderPointerDown} data-drag={isFloat ? '1' : '0'}>
        <span className="ai-ctx-title">助手</span>
        <span className="ai-ctx-item" title={ctx.title}>带入：{ctx.kind === 'none' ? '无' : ctx.title}</span>
        <span className="spacer" />
        <button
          className="btn btn-ghost btn-icon btn-sm"
          onClick={() => setSurface(isFloat ? 'dock' : 'float')}
          aria-label={isFloat ? '停靠到侧栏' : '切换为悬浮'}
          title={isFloat ? '停靠到侧栏' : '切换为悬浮'}
          data-testid="ai-surface"
        >
          <Icon name={isFloat ? 'panel' : 'assistant'} size={15} />
        </button>
        <button className="btn btn-ghost btn-icon btn-sm" onClick={close} aria-label="收起助手" data-testid="ai-close">
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="ai-controls">
        <select
          className="select select-sm"
          value={harnessId}
          onChange={(e) => void changeHarness(e.target.value)}
          aria-label="选择 harness"
          data-testid="ai-harness"
        >
          {harnesses.filter((h) => h.enabled !== false).map((h) => (
            <option key={h.id} value={h.id}>{h.label}{h.installed === false ? '（未找到）' : ''}</option>
          ))}
        </select>
        <select
          className="select select-sm"
          value={modelOption?.currentValue ?? ''}
          disabled={!modelOption}
          onChange={(e) => {
            if (!session || !modelOption) return;
            void endpoints.agentConfig(session.id, modelOption.id, e.target.value).then((r) => {
              setSession((s) => (s ? { ...s, configOptions: r.configOptions as typeof s.configOptions } : s));
              toast('模型已切换，对下一轮生效', 'ok');
            }).catch((err) => toast(err instanceof Error ? err.message : String(err), 'err'));
          }}
          aria-label="选择模型"
          title={modelOption ? '切换当前会话的模型' : '先发一条消息启动会话，模型列表由 harness 返回'}
          data-testid="ai-model"
        >
          {modelOption
            ? modelOption.options.map((o) => <option key={o.value} value={o.value}>{o.name}</option>)
            : <option value="">模型：先发一条消息</option>}
        </select>
        <select
          className="select select-sm"
          value={skillId}
          onChange={(e) => void changeSkill(e.target.value)}
          aria-label="选择技能"
          data-testid="ai-skill"
        >
          <option value="none">无技能</option>
          {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button
          className="btn btn-quiet btn-sm"
          onClick={() => setShowSettings((v) => !v)}
          aria-expanded={showSettings}
          data-testid="ai-settings"
        >
          审批：{approvalLabel(approvals)}
        </button>
        <button
          className="btn btn-quiet btn-sm"
          onClick={() => { close(); navigate('agent'); }}
          data-testid="ai-config"
          title="配置 harness、探测、远端配对"
        >
          配置
        </button>
      </div>

      {showSettings && (
        <div className="ai-settings">
          <label>批注
            <select className="select select-sm" value={approvals.annotations} onChange={(e) => void changeApprovals({ annotations: e.target.value as typeof approvals.annotations })}>
              <option value="ask">每次确认</option>
              <option value="auto">自动落笔</option>
              <option value="readonly">只读</option>
            </select>
          </label>
          <label>正文
            <select className="select select-sm" value={approvals.body} onChange={(e) => void changeApprovals({ body: e.target.value as typeof approvals.body })}>
              <option value="ask">每次确认</option>
              <option value="auto">自动提交</option>
              <option value="readonly">只读</option>
            </select>
          </label>
          {session?.configOptions?.length ? session.configOptions.filter((o) => o.id !== modelOption?.id && o.options.length > 0).map((o) => (
            <label key={o.id}>{o.name}
              <select
                className="select select-sm"
                value={o.currentValue}
                onChange={(e) => {
                  void endpoints.agentConfig(session.id, o.id, e.target.value).then((r) => {
                    setSession((s) => (s ? { ...s, configOptions: r.configOptions as typeof s.configOptions } : s));
                  });
                }}
              >
                {o.options.map((x) => <option key={x.value} value={x.value}>{x.name}</option>)}
              </select>
            </label>
          )) : null}
        </div>
      )}

      <div className="ai-context-line">
        <span>将发送 ~{estimate.toLocaleString()} 字</span>
        <span>· {refs.length} 条引用</span>
        {lastPack?.omitted?.length ? <span className="ai-warn">· {lastPack.omitted.join('；')}</span> : null}
        <span className="spacer" />
        <span className="mono">{session ? statusLabel(session.status) : '未开会话'}</span>
      </div>

      <div className="ai-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="ai-intro">
            <p className="ai-intro-text">
              我看到的只有这个空间里的真实内容。回答会带出处；改正文或批注按你选的审批级别走。
            </p>
            <div className="ai-allow">
              允许的动作：检索 / 打开 / 引用 / 批注建议 / 提案。{approvals.body === 'auto' ? '自动模式会直接提交，但删除、归档、外发永不自动。' : '改正文要你逐条确认。'}
            </div>
            <div className="ai-starters">
              {starters.map((s) => (
                <button key={s} className="ai-starter" onClick={() => void send(s)} data-testid="ai-suggest">
                  <span>{s}</span>
                  <Icon name="arrow" size={12} />
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          m.role === 'me' ? (
            <div key={m.id} className="ai-msg ai-msg-me" data-testid="ai-msg-me">{m.text}</div>
          ) : (
            <article key={m.id} className="ai-reply" data-testid="ai-msg-ai" data-error={m.error ? '1' : '0'}>
              <div className="ai-reply-head">
                <span className="ai-reply-mark" aria-hidden="true">✦</span>
                <span>{session?.harnessId ?? '助手'}</span>
                {m.streaming ? <span className="ai-stream-dot" aria-label="生成中" /> : null}
              </div>
              {m.text ? <div className="ai-reply-body">{m.text}</div> : null}
              {!!m.tools?.length && (
                <div className="ai-tools">
                  {m.tools.map((t) => (
                    <span key={t.callId || t.name} className="ai-tool" data-tier={t.tier} data-ok={t.ok === false ? '0' : '1'}>
                      {t.name}{t.summary ? ` · ${t.summary}` : ''}
                    </span>
                  ))}
                </div>
              )}
              {!!m.suggestions?.length && (
                <div className="ai-anns">
                  {m.suggestions.map((s) => (
                    <div key={s.id} className="ai-ann">
                      <blockquote>{s.quote}</blockquote>
                      <p>{s.note}</p>
                      <div className="ai-ann-acts">
                        <button className="btn btn-sm btn-primary" onClick={() => void acceptSuggestion(s, s.repId)} data-testid="ai-ann-accept">接受</button>
                        <button className="btn btn-sm" onClick={() => setMessages((prev) => prev.map((x) => ({
                          ...x, suggestions: x.suggestions?.filter((y) => y.id !== s.id),
                        })))}>忽略</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          )
        ))}

        {busy && <div className="ai-thinking"><span className="spin" /> {statusText || '在库里找…'}</div>}
      </div>

      {pending && (
        <div className="ai-permission" data-testid="ai-permission">
          <div className="ai-permission-head">
            <strong>{pending.kind === 'proposal' ? '这条变更要提交吗？' : '这个工具调用要允许吗？'}</strong>
            <span className="mono">{pending.action}</span>
          </div>
          <pre>{pending.preview || '（没有 diff 预览）'}</pre>
          <div className="ai-ann-acts">
            <button className="btn btn-sm btn-primary" onClick={() => void decide('allow')}>允许</button>
            <button className="btn btn-sm" onClick={() => void decide('deny')}>拒绝</button>
          </div>
        </div>
      )}

      <div className="ai-composer">
        {!!refs.length && (
          <div className="ai-refs">
            {refs.map((r) => (
              <span key={r.id} className="ai-ref" title={r.quote?.quote ?? r.title}>
                <span className="ellipsis">{r.quote ? `“${r.quote.quote.slice(0, 18)}…”` : r.title}</span>
                <button onClick={() => removeRef(r.id)} aria-label={`移除引用 ${r.title}`}>×</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          className="ai-input"
          placeholder={activeSkill ? `用「${activeSkill.name}」接着问…` : '问点什么…'}
          value={input}
          rows={2}
          data-testid="ai-input"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div className="ai-composer-foot">
          <span className="ai-composer-hint">回车发送 · Shift+回车换行 · ⌘J 开合</span>
          {busy ? (
            <button className="btn btn-sm" onClick={() => void (session && endpoints.agentCancel(session.id))}>停止</button>
          ) : (
            <button className="btn btn-sm btn-primary" disabled={!input.trim()} onClick={() => void send(input)} data-testid="ai-send">
              发送
            </button>
          )}
        </div>
      </div>

      {isFloat && <div className="ai-resize" onPointerDown={onResizePointerDown} aria-hidden="true" />}
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

function approvalLabel(a: { annotations: string; body: string }): string {
  const one = (x: string) => (x === 'auto' ? '自动' : x === 'readonly' ? '只读' : '确认');
  if (a.annotations === a.body) return one(a.annotations);
  return `批注${one(a.annotations)}/正文${one(a.body)}`;
}

function statusLabel(s: SessionView['status']): string {
  return ({ starting: '准备中', ready: '就绪', running: '生成中', error: '出错', closed: '已关闭' })[s] ?? s;
}
