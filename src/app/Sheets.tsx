/** 所有表单弹层。每张表单一提交就走 /api/changes 或直接语义接口，都会留下事件。 */
import { useState } from 'react';
import { endpoints, ApiError, invalidateAll } from '../services/api.ts';
import { useUi, toast as toastFn } from './ui.ts';
import { Sheet, Overlay, Field, Chip, Empty } from '../components/ui.tsx';
import { navigate } from './router.ts';
import { useNotifications } from '../services/use.ts';
import { todayStr } from '../components/ui.tsx';

type Ctx = { onDone?: () => void };

function useClose() {
  const closeSheet = useUi((s) => s.closeSheet);
  const sheet = useUi((s) => s.sheet);
  return () => {
    const cb = sheet?.onDone;
    closeSheet();
    cb?.();
  };
}

/* ---------------- 采集 ---------------- */

function CaptureSheet({ props }: { props: Record<string, unknown> }) {
  const close = useClose();
  const [title, setTitle] = useState(String(props.title ?? ''));
  const [body, setBody] = useState(String(props.body ?? ''));
  const [target, setTarget] = useState<'inbox' | 'notes'>('inbox');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!title.trim()) return toastFn('标题不能为空', 'err');
    setBusy(true);
    try {
      await endpoints.capture({ title, body, target });
      toastFn(`已采集到${target === 'inbox' ? '收件箱' : '笔记'}`, 'ok');
      close();
      navigate(target === 'inbox' ? 'inbox' : 'shelf');
    } catch (e) {
      toastFn(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="采集"
      desc="原文先落收件箱，想清楚了再衍生"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-testid="capture-submit">
            {busy ? '写入中…' : '采集'}
          </button>
        </>
      }
    >
      <Field label="标题">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="capture-title" data-autofocus />
      </Field>
      <Field label="内容" hint="可以只写一句话，回头再补">
        <textarea className="textarea textarea-prose" value={body} onChange={(e) => setBody(e.target.value)} data-testid="capture-body" />
      </Field>
      <Field label="落到哪">
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value as 'inbox' | 'notes')}>
          <option value="inbox">inbox/（未消化）</option>
          <option value="notes">knowledge/notes/（已成型的笔记）</option>
        </select>
      </Field>
    </Sheet>
  );
}

/* ---------------- 衍生 ---------------- */

function DeriveSheet({ props }: { props: Record<string, unknown> }) {
  const close = useClose();
  const [title, setTitle] = useState(String(props.title ?? ''));
  const [body, setBody] = useState(String(props.body ?? ''));
  const [kind, setKind] = useState('point');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!title.trim()) return toastFn('标题不能为空', 'err');
    setBusy(true);
    try {
      const r = await endpoints.derive({ srcId: String(props.srcId ?? ''), title, body, kind });
      toastFn('已衍生一篇笔记', 'ok');
      close();
      navigate('editor', { id: r.id });
    } catch (e) {
      toastFn(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="衍生笔记"
      desc="原文不动，你的理解写成新笔记，血缘自动连上"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-testid="derive-submit">
            {busy ? '写入中…' : '衍生'}
          </button>
        </>
      }
    >
      <div className="row" style={{ marginBottom: 12 }}>
        <Chip tone="accent">来源：{String(props.srcId ?? '').slice(0, 24)}…</Chip>
      </div>
      <Field label="标题">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="derive-title" data-autofocus />
      </Field>
      <Field label="类型">
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="point">观点（一个观点一篇）</option>
          <option value="summary">摘要</option>
          <option value="outline">提纲</option>
          <option value="question">问题</option>
        </select>
      </Field>
      <Field label="内容">
        <textarea className="textarea textarea-prose" value={body} onChange={(e) => setBody(e.target.value)} data-testid="derive-body" />
      </Field>
    </Sheet>
  );
}

/* ---------------- 批注 ---------------- */

function AnnotateSheet({ props }: { props: Record<string, unknown> }) {
  const close = useClose();
  const [quote, setQuote] = useState(String(props.quote ?? ''));
  const [note, setNote] = useState('');
  const [color, setColor] = useState('yellow');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!quote.trim()) return toastFn('得先选一段原文', 'err');
    setBusy(true);
    try {
      await endpoints.annotate({
        repId: String(props.repId ?? ''),
        quote,
        note,
        color,
        from: Number(props.from ?? 0),
        to: Number(props.to ?? quote.length),
        prefix: String(props.prefix ?? ''),
        suffix: String(props.suffix ?? ''),
      });
      toastFn('批注已保存（原文没动）', 'ok');
      close();
    } catch (e) {
      toastFn(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="批注"
      desc="批注是独立资产，不写进原文"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-testid="annotate-submit">
            {busy ? '保存中…' : '保存批注'}
          </button>
        </>
      }
    >
      <Field label="引文">
        <textarea className="textarea textarea-prose" value={quote} onChange={(e) => setQuote(e.target.value)} data-testid="annotate-quote" data-autofocus />
      </Field>
      <Field label="批注">
        <textarea className="textarea textarea-prose" value={note} onChange={(e) => setNote(e.target.value)} data-testid="annotate-note" placeholder="为什么划这句？" />
      </Field>
      <Field label="颜色">
        <div className="row">
          {[['yellow', 'var(--hl-yellow)'], ['green', 'var(--hl-green)'], ['blue', 'var(--hl-blue)'], ['pink', 'var(--hl-pink)']].map(([c, bg]) => (
            <button key={c} className="sw" style={{ background: bg }} aria-pressed={color === c} aria-label={c} onClick={() => setColor(c)} />
          ))}
        </div>
      </Field>
      <div className="row row-wrap" style={{ marginTop: 8 }}>
        <button className="btn btn-sm" onClick={() => useUi.getState().openSheet('derive', { srcId: props.repId, title: '由批注衍生', body: `\n\n> ${quote}\n` })}>
          顺便衍生一篇笔记
        </button>
      </div>
    </Sheet>
  );
}

/* ---------------- 任务 / 日程 / 项目 ---------------- */

function TaskSheet({ props }: { props: Record<string, unknown> }) {
  const close = useClose();
  const [text, setText] = useState(String(props.text ?? ''));
  const [due, setDue] = useState(String(props.due ?? ''));
  const [flow, setFlow] = useState<'now' | 'next' | 'later'>('next');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!text.trim()) return toastFn('任务内容不能为空', 'err');
    setBusy(true);
    try {
      await endpoints.addAction({ text, due: due || undefined, flow, projectId: props.projectId ? String(props.projectId) : undefined });
      toastFn('已加入任务池', 'ok');
      close();
    } catch (e) {
      toastFn(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="新建任务"
      desc="承诺(due)、安排(scheduled)、推进(flow) 是三件事，这里只填前两件"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-testid="task-submit">{busy ? '写入中…' : '加入'}</button>
        </>
      }
    >
      <Field label="做什么">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} data-testid="task-text" data-autofocus />
      </Field>
      <Field label="什么时候到期" hint="不填就没有承诺，只是「以后做」">
        <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} data-testid="task-due" />
      </Field>
      <Field label="推进节奏">
        <select className="select" value={flow} onChange={(e) => setFlow(e.target.value as never)}>
          <option value="now">现在做</option>
          <option value="next">接着做</option>
          <option value="later">以后做</option>
        </select>
      </Field>
    </Sheet>
  );
}

function EventSheet({ props }: { props: Record<string, unknown> }) {
  const close = useClose();
  const [title, setTitle] = useState(String(props.title ?? ''));
  const [date, setDate] = useState(String(props.date ?? todayStr()));
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!title.trim()) return toastFn('日程得有个名字', 'err');
    setBusy(true);
    try {
      await endpoints.addEvent({ title, date, start, end });
      toastFn('已排进日程', 'ok');
      close();
    } catch (e) {
      toastFn(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="新建日程" desc="安排 = 计划在这个时间段做，和「到期」不是一回事" onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-testid="event-submit">排进去</button>
        </>
      }
    >
      <Field label="什么事">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="event-title" data-autofocus />
      </Field>
      <div className="grid grid-3">
        <Field label="日期"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="event-date" /></Field>
        <Field label="开始"><input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="结束"><input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
    </Sheet>
  );
}

function ProjectSheet({ props }: { props: Record<string, unknown> }) {
  const close = useClose();
  const [title, setTitle] = useState(String(props.title ?? ''));
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!title.trim()) return toastFn('项目名不能为空', 'err');
    setBusy(true);
    try {
      const ops = [{
        t: 'create',
        obj: {
          type: 'project',
          id: `project-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
          schema: 1, spaceId: 'space-local', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          author: 'human', sensitivity: 'private', rev: 1, title, desc, state: 'active',
        },
      }];
      const { changeset } = await endpoints.propose(ops, `新建项目：${title}`);
      await endpoints.commit(changeset.id);
      toastFn('项目已创建', 'ok');
      close();
    } catch (e) {
      toastFn(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="新建项目" onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-testid="project-submit">创建</button>
        </>
      }
    >
      <Field label="项目名"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="project-title" data-autofocus /></Field>
      <Field label="想要的结果" hint="项目要有终点，写清楚什么样子算完成">
        <textarea className="textarea textarea-prose" value={desc} onChange={(e) => setDesc(e.target.value)} />
      </Field>
    </Sheet>
  );
}

/* ---------------- 回顾 ---------------- */

function ReviewSheet({ props }: { props: Record<string, unknown> }) {
  const close = useClose();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await endpoints.review(String(props.id ?? ''), note || '回顾了一次');
      toastFn('已记一次回顾', 'ok');
      close();
    } catch (e) {
      toastFn(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="回顾" desc="回顾会被记成事件，生命周期的「回顾」闸门靠它" onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-testid="review-submit">记录</button>
        </>
      }
    >
      <div className="row" style={{ marginBottom: 12 }}><Chip tone="accent">{String(props.title ?? '')}</Chip></div>
      <Field label="这次想到什么">
        <textarea className="textarea textarea-prose" value={note} onChange={(e) => setNote(e.target.value)} data-testid="review-note" data-autofocus />
      </Field>
    </Sheet>
  );
}

/* ---------------- 冲突：三方 ---------------- */

function diffLines(a: string, b: string): { t: 'same' | 'add' | 'del'; s: string }[] {
  // 简洁的逐行对比：够看清「我改了什么」，不做花哨的 LCS
  const al = a.split('\n');
  const bl = b.split('\n');
  const out: { t: 'same' | 'add' | 'del'; s: string }[] = [];
  const set = new Map(bl.map((l, i) => [`${l}#${i}`, l]));
  let bi = 0;
  for (const l of al) {
    if (bl[bi] === l) {
      out.push({ t: 'same', s: l });
      bi += 1;
    } else if (bl.includes(l) && set.has(`${l}#${bl.indexOf(l)}`)) {
      out.push({ t: 'same', s: l });
      bi = bl.indexOf(l) + 1;
    } else {
      out.push({ t: 'del', s: l });
    }
  }
  for (; bi < bl.length; bi += 1) out.push({ t: 'add', s: bl[bi] });
  return out;
}

function ConflictSheet({ props }: { props: Record<string, unknown> }) {
  const close = useClose();
  const conflict = props.conflict as NonNullable<import('../services/api.ts').ConflictPayload>;
  const [view, setView] = useState<'diff' | 'mine' | 'theirs'>('diff');
  const [busy, setBusy] = useState(false);
  const diff = diffLines(conflict.base.content, conflict.mine.content);

  /** 重新载入 = 放弃我这次的改动，编辑器回到盘上当前的内容 */
  async function reload() {
    // 缓存失效后编辑器会重新拉正文，我改的那一版就没了——这是「重新载入」该有的代价，要说清楚
    void invalidateAll();
    if (props.onReload) (props.onReload as () => void)();
    toastFn('已重新载入：你这次的改动被丢弃了', 'ok');
    close();
  }

  async function saveCopy() {
    setBusy(true);
    try {
      const body = conflict.mine.content.replace(/^---[\s\S]*?---\n/, '');
      const title = `${(props.title as string) || '未命名'} · 我的副本`;
      await endpoints.capture({ title, body, target: 'notes' });
      toastFn('已另存为副本，没有覆盖任何人的改动', 'ok');
      close();
    } catch (e) {
      toastFn(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="这次提交撞车了"
      desc="我没有覆盖别人的改动。三条路：重新载入、看差异、另存副本"
      wide
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={() => void reload()} data-testid="conflict-reload">重新载入</button>
          <button className="btn" onClick={() => void saveCopy()} disabled={busy} data-testid="conflict-copy">
            {busy ? '另存中…' : '另存副本'}
          </button>
        </>
      }
    >
      <div className="row row-wrap" style={{ marginBottom: 12 }}>
        <Chip tone="danger">基准 r{conflict.base.rev}</Chip>
        <Chip tone="warn">我的（r{conflict.base.rev} → 待写）</Chip>
        <Chip tone="info">当前 r{conflict.theirs.rev} · {conflict.theirs.author} · {conflict.theirs.updatedAt.slice(0, 16)}</Chip>
      </div>
      <div className="tabs" role="tablist">
        {([['diff', '看差异'], ['mine', '我要写的'], ['theirs', '当前的']] as const).map(([k, label]) => (
          <button key={k} className="tab" role="tab" aria-selected={view === k} onClick={() => setView(k)}>{label}</button>
        ))}
      </div>
      {view === 'diff' && (
        <div className="diff" data-testid="conflict-diff">
          {diff.map((d, i) => (
            <div key={i} className={d.t === 'add' ? 'diff-add' : d.t === 'del' ? 'diff-del' : ''}>
              {d.t === 'add' ? '+ ' : d.t === 'del' ? '- ' : '  '}{d.s}
            </div>
          ))}
        </div>
      )}
      {view === 'mine' && <pre className="diff">{conflict.mine.content}</pre>}
      {view === 'theirs' && <pre className="diff">{conflict.theirs.content}</pre>}
    </Sheet>
  );
}

/* ---------------- 记账 / 提案 ---------------- */

function JournalSheet() {
  const close = useClose();
  const [op, setOp] = useState('build');
  const [target, setTarget] = useState('');
  const [summary, setSummary] = useState('');
  const [actor, setActor] = useState('agent:workbuddy');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!target.trim()) return toastFn('target 必填', 'err');
    setBusy(true);
    try {
      // actor 要放顶层：服务端 actorOf() 读的是 body.actor，塞进 payload 会被当成「我」干的
      await endpoints.journalLog({ op, target, summary, actor });
      toastFn('已记账', 'ok');
      close();
    } catch (e) {
      toastFn(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="补一条事件" desc="外部 Agent 做了事但没走接口时，用它补账" onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-testid="journal-submit">记账</button>
        </>
      }
    >
      <Field label="主体" hint="填 agent:名字 表示是 AI 做的">
        <input className="input" value={actor} onChange={(e) => setActor(e.target.value)} data-testid="journal-actor" />
      </Field>
      <Field label="动作">
        <select className="select" value={op} onChange={(e) => setOp(e.target.value)}>
          {['capture', 'ingest', 'read', 'annotate', 'derive', 'edit', 'propose', 'review', 'settle', 'commit', 'build', 'import'].map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </Field>
      <Field label="对象路径"><input className="input" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="journal-target" data-autofocus /></Field>
      <Field label="做了什么"><input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
    </Sheet>
  );
}

function ProposalSheet({ props }: { props: Record<string, unknown> }) {
  const close = useClose();
  const [title, setTitle] = useState(String(props.title ?? ''));
  const [scope, setScope] = useState('');
  const [budget, setBudget] = useState(0);
  const [opsText, setOpsText] = useState('[]');
  const [busy, setBusy] = useState(false);

  async function submit() {
    let ops: unknown[];
    try {
      ops = JSON.parse(opsText);
      if (!Array.isArray(ops)) throw new Error('ops 必须是数组');
    } catch (e) {
      return toastFn(`ops 不是合法 JSON：${e instanceof Error ? e.message : ''}`, 'err');
    }
    // 空提案撤不回来，也会在变更列表里留一张废卡——这里就拦住
    if (ops.length === 0) return toastFn('提案里至少要有一条具体改动', 'err');
    setBusy(true);
    try {
      await endpoints.proposeAi({ title, scope, budgetCny: budget, ops, kind: 'derive', evidence: [], risk: 'low' });
      toastFn('提案已生成，等你在变更页确认', 'ok');
      close();
      navigate('changes');
    } catch (e) {
      if (e instanceof ApiError && e.detail?.blocked) {
        toastFn(`校验没过：${e.detail.blocked.filter((b) => !b.ok).map((b) => b.label).join('、')}`, 'err');
      } else {
        toastFn(e instanceof Error ? e.message : String(e), 'err');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="生成提案" desc="AI 不直接写正文：这里产出提案，人逐条确认后才落盘" wide onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-testid="proposal-submit">生成</button>
        </>
      }
    >
      <Field label="提案标题"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="proposal-title" data-autofocus /></Field>
      <Field label="影响范围"><input className="input" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="knowledge/notes/" /></Field>
      <Field label="预算（元）"><input className="input" type="number" value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></Field>
      <Field label="变更 ops（JSON 数组）" hint="示例：[{&quot;t&quot;:&quot;update&quot;,&quot;id&quot;:&quot;note-xxx&quot;,&quot;patch&quot;:{&quot;status&quot;:&quot;evergreen&quot;}}]">
        <textarea className="textarea" value={opsText} onChange={(e) => setOpsText(e.target.value)} data-testid="proposal-ops" />
      </Field>
    </Sheet>
  );
}

/* ---------------- 分发 ---------------- */

export function Sheets() {
  const sheet = useUi((s) => s.sheet);
  const closeSheet = useUi((s) => s.closeSheet);
  if (!sheet) return null;
  const { kind, props } = sheet;
  const body =
    kind === 'capture' ? <CaptureSheet props={props} />
      : kind === 'derive' ? <DeriveSheet props={props} />
        : kind === 'annotate' ? <AnnotateSheet props={props} />
          : kind === 'task' ? <TaskSheet props={props} />
            : kind === 'event' ? <EventSheet props={props} />
              : kind === 'project' ? <ProjectSheet props={props} />
                : kind === 'review' ? <ReviewSheet props={props} />
                  : kind === 'conflict' ? <ConflictSheet props={props} />
                    : kind === 'journal' ? <JournalSheet />
                      : kind === 'notifications' ? <NotificationsSheet />
                      : kind === 'proposal' ? <ProposalSheet props={props} />
                        : null;

  return <Overlay onClose={closeSheet}>{body}</Overlay>;
}

/* ---------------- 通知 ---------------- */

function NotificationsSheet() {
  const close = useClose();
  const { data, refetch } = useNotifications();
  const notices = data?.notices ?? [];

  async function readAll() {
    await endpoints.readNotifications();
    await refetch();
    toastFn('已全部标为已读', 'ok');
  }

  return (
    <Sheet
      title="通知"
      desc="规则命中、作业失败这类需要你知道的事；本机休眠时不会触发"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>关闭</button>
          <button className="btn btn-primary" onClick={() => void readAll()} disabled={!data?.unread} data-testid="notif-read-all">全部已读</button>
        </>
      }
    >
      {notices.length === 0
        ? <Empty title="没有通知" desc="规则触发或作业失败时，会记在这里" />
        : notices.map((n) => (
          <div key={n.id} className="card" style={{ marginBottom: 8, opacity: n.read ? 0.62 : 1 }} data-testid="notif-item">
            <div className="row row-wrap">
              <Chip tone={n.level === 'danger' ? 'danger' : n.level === 'warn' ? 'warn' : 'info'}>
                {n.level === 'danger' ? '要处理' : n.level === 'warn' ? '提醒' : '进展'}
              </Chip>
              <strong className="ellipsis" style={{ flex: 1 }}>{n.title}</strong>
              <span className="small muted">{n.at.slice(5, 16).replace('T', ' ')}</span>
            </div>
            {n.body && <div className="small muted" style={{ marginTop: 6 }}>{n.body}</div>}
            {n.href && (
              <a
                className="btn btn-sm"
                style={{ marginTop: 8 }}
                href={n.href}
                onClick={close}
                data-testid="notif-go"
              >去看</a>
            )}
          </div>
        ))}
    </Sheet>
  );
}

export type { Ctx };
