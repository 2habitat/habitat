/** 所有表单弹层。每张表单一提交就走 /api/changes 或直接语义接口，都会留下事件。 */
import { useState } from 'react';
import { endpoints, ApiError, invalidateAll } from '../services/api.ts';
import { useUi, toast as toastFn } from './ui.ts';
import { Sheet, Overlay, Field, Chip, Empty } from '../components/ui.tsx';
import { Icon } from '../components/icons.tsx';
import { navigate } from './router.ts';
import { useNotifications } from '../services/use.ts';
import { todayStr } from '../components/ui.tsx';
import { parseScheduled } from '../../shared/time.ts';

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
      <div className="sheet-lead">
        <span className="sheet-lead-key">来源</span>
        <span className="ellipsis">{String(props.title || props.srcId || '').slice(0, 60)}</span>
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
        <textarea className="textarea textarea-prose quote-box" value={quote} onChange={(e) => setQuote(e.target.value)} data-testid="annotate-quote" data-autofocus />
      </Field>
      <Field label="批注">
        <textarea className="textarea textarea-prose" value={note} onChange={(e) => setNote(e.target.value)} data-testid="annotate-note" placeholder="为什么划这句？" />
      </Field>
      <Field label="颜色">
        <div className="swatch-row">
          {([['yellow', '黄'], ['green', '绿'], ['blue', '蓝'], ['pink', '粉']] as const).map(([c, label]) => (
            <button
              key={c}
              className="swatch"
              data-color={c}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
            >
              <i aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </Field>
      <div className="sheet-lead" style={{ marginTop: 4 }}>
        <span className="sheet-lead-key">顺带</span>
        <button className="btn btn-sm btn-quiet" onClick={() => useUi.getState().openSheet('derive', { srcId: props.repId, title: '由批注衍生', body: `\n\n> ${quote}\n` })}>
          用这句衍生一篇笔记
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
  const [at, setAt] = useState(String(props.at ?? ''));
  const [flow, setFlow] = useState<'now' | 'next' | 'later'>('next');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!text.trim()) return toastFn('任务内容不能为空', 'err');
    const scheduled = parseScheduled(at);
    if (at.trim() && !scheduled) return toastFn('时间块要写成 14:00-15:30', 'err');
    if (scheduled && !due) return toastFn('先填到期日——时间块要落在某一天', 'err');
    setBusy(true);
    try {
      await endpoints.addAction({ text, due: due || undefined, scheduled, flow, projectId: props.projectId ? String(props.projectId) : undefined });
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
      desc="到期是承诺，安排是几点做"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy} data-testid="task-submit">{busy ? '写入中…' : '加入'}</button>
        </>
      }
    >
      <Field label="做什么">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} data-testid="task-text" data-autofocus placeholder="一句话说清结果，不要写过程" />
      </Field>
      <div className="grid grid-2">
        <Field label="什么时候到期" hint="不填就没有承诺，只是「以后做」">
          <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} data-testid="task-due" />
        </Field>
        <Field label="安排在什么时候" hint="可选，写成 14:00-15:30">
          <input className="input" placeholder="14:00-15:30" value={at} onChange={(e) => setAt(e.target.value)} data-testid="task-at" />
        </Field>
      </div>
      <Field label="推进节奏" hint="到期是承诺，节奏是你打算什么时候碰它">
        <div className="seg" role="group" aria-label="推进节奏">
          {([['now', '现在做'], ['next', '接着做'], ['later', '以后做']] as const).map(([v, label]) => (
            <button key={v} type="button" className="seg-item" aria-pressed={flow === v} onClick={() => setFlow(v)}>{label}</button>
          ))}
        </div>
      </Field>
      <div className="sheet-lead" style={{ marginTop: 2 }}>
        <span className="sheet-lead-key">会写进</span>
        <span className="mono">work/actions/tasks.md</span>
      </div>
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
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="event-title" data-autofocus placeholder="例：评审会 / 写周报 / 读书" />
      </Field>
      <div className="grid grid-3">
        <Field label="日期"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="event-date" /></Field>
        <Field label="开始"><input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="结束"><input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      <div className="sheet-lead">
        <span className="sheet-lead-key">时段</span>
        <span className="mono">{start}–{end}</span>
        <span className="muted">·</span>
        <span>{durationLabel(start, end)}</span>
        <span className="spacer" />
        <span className="muted">{date === todayStr() ? '今天' : date}</span>
      </div>
    </Sheet>
  );
}

/** 时长说人话：1 小时 30 分，比 90 分钟好懂 */
function durationLabel(start: string, end: string): string {
  const toMin = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
  };
  const d = toMin(end) - toMin(start);
  if (!Number.isFinite(d) || d <= 0) return '时长未定';
  const h = Math.floor(d / 60);
  const m = d % 60;
  return h && m ? `${h} 小时 ${m} 分` : h ? `${h} 小时` : `${m} 分钟`;
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
      <Field label="项目名"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="project-title" data-autofocus placeholder="例：把工作台迁到 Habitat" /></Field>
      <Field label="想要的结果" hint="项目要有终点：写成「什么样子算完成」，不是「做什么」">
        <textarea className="textarea textarea-prose" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="例：日常收件箱清零，周报能从这里直接生成" />
      </Field>
      <div className="sheet-lead">
        <span className="sheet-lead-key">会写进</span>
        <span className="mono">work/projects/</span>
        <span className="spacer" />
        <span className="muted">状态 active，之后可挂任务</span>
      </div>
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
      <div className="sheet-lead">
        <span className="sheet-lead-key">回顾对象</span>
        <span className="ellipsis">{String(props.title ?? '')}</span>
      </div>
      <Field label="这次想到什么" hint="不必写完整：一句话判断、一个反例、一个待验证的点都算">
        <textarea className="textarea textarea-prose" value={note} onChange={(e) => setNote(e.target.value)} data-testid="review-note" data-autofocus placeholder="它还成立吗？有没有被新东西推翻？" />
      </Field>
    </Sheet>
  );
}

/* ---------------- 冲突：三方对齐 ---------------- */

/** 最长公共子序列：返回 base 行号 → other 行号 的配对表 */
function lcsPairs(a: string[], b: string[]): Map<number, number> {
  const n = a.length;
  const m = b.length;
  const pairs = new Map<number, number>();
  if (!n || !m) return pairs;
  // 大文档降级成按位置对齐：O(n·m) 的动态规划在几百行以上不划算
  if (n * m > 260_000) {
    for (let i = 0; i < Math.min(n, m); i += 1) if (a[i] === b[i]) pairs.set(i, i);
    return pairs;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.set(i, j);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

interface ConflictRow { base?: string; mine?: string; theirs?: string }

type DiffBlock =
  | { kind: 'rows'; items: { row: ConflictRow; idx: number }[] }
  | { kind: 'fold'; count: number; from: number; rows: ConflictRow[] };

/** 连续未改动的行超过这个数就折起来——改一行不用滚两百行 */
const FOLD_MIN = 8;

function buildBlocks(rows: ConflictRow[]): DiffBlock[] {
  const same = (r: ConflictRow) => r.base !== undefined && r.mine === r.base && r.theirs === r.base;
  const out: DiffBlock[] = [];
  let i = 0;
  while (i < rows.length) {
    if (!same(rows[i])) {
      out.push({ kind: 'rows', items: [{ row: rows[i], idx: i }] });
      i += 1;
      continue;
    }
    let j = i;
    while (j < rows.length && same(rows[j])) j += 1;
    if (j - i >= FOLD_MIN) {
      out.push({ kind: 'fold', count: j - i, from: i, rows: rows.slice(i, j) });
    } else {
      out.push({ kind: 'rows', items: rows.slice(i, j).map((row, k) => ({ row, idx: i + k })) });
    }
    i = j;
  }
  return out;
}

/**
 * 三栏对齐：以「基准」为骨架，把我的改动和对方的改动各自落到同一行上。
 * 只做两份 base→side 的 diff，再按基准行号合并——不需要真正的三方合并算法，
 * 因为这里的目的不是自动合并，而是让人一眼看出「谁改了哪一行」。
 */
function alignThreeWay(baseText: string, mineText: string, theirsText: string): ConflictRow[] {
  const b = baseText.split('\n');
  const m = mineText.split('\n');
  const t = theirsText.split('\n');
  const pm = lcsPairs(b, m);
  const pt = lcsPairs(b, t);

  /** 没被配对上的行 = 插入行，按「插在第几行之后」归类 */
  const insertsOf = (other: string[], pairs: Map<number, number>) => {
    const rev = new Map<number, number>();
    for (const [bi, oi] of pairs) rev.set(oi, bi);
    const out = new Map<number, string[]>();
    let last = -1;
    for (let oi = 0; oi < other.length; oi += 1) {
      const bi = rev.get(oi);
      if (bi === undefined) {
        const gap = last + 1;
        const arr = out.get(gap) ?? [];
        arr.push(other[oi]);
        out.set(gap, arr);
      } else last = bi;
    }
    return out;
  };

  const im = insertsOf(m, pm);
  const it = insertsOf(t, pt);

  /**
   * 先给每一行基准找它的「替换行」。
   * 被改掉的那一行在 LCS 里是「删除 + 插入」，插入行落在 gap = i（它的位置），
   * 不是 i+1——所以要按 gap i 取，取到的就是「改成了什么」。
   */
  const mineFor: (string | undefined)[] = [];
  const theirsFor: (string | undefined)[] = [];
  for (let i = 0; i < b.length; i += 1) {
    const mi = pm.get(i);
    const ti = pt.get(i);
    let mine = mi !== undefined ? m[mi] : undefined;
    let theirs = ti !== undefined ? t[ti] : undefined;
    if (mine === undefined) {
      const arr = im.get(i);
      if (arr?.length) mine = arr.shift();
    }
    if (theirs === undefined) {
      const arr = it.get(i);
      if (arr?.length) theirs = arr.shift();
    }
    mineFor[i] = mine;
    theirsFor[i] = theirs;
  }

  const rows: ConflictRow[] = [];
  /** 纯插入行：两边都有就并成一行，只有一边就留空 */
  const pushGap = (gap: number) => {
    const a = im.get(gap) ?? [];
    const c = it.get(gap) ?? [];
    for (let k = 0; k < Math.max(a.length, c.length); k += 1) {
      rows.push({ mine: a[k], theirs: c[k] });
    }
    im.delete(gap);
    it.delete(gap);
  };

  pushGap(0);
  for (let i = 0; i < b.length; i += 1) {
    rows.push({ base: b[i], mine: mineFor[i], theirs: theirsFor[i] });
    pushGap(i + 1);
  }
  return rows;
}

const FM_RE = /^---\n[\s\S]*?\n---\n?/;
const stripFm = (s: string) => s.replace(FM_RE, '');

function ConflictSheet({ props }: { props: Record<string, unknown> }) {
  const close = useClose();
  const conflict = props.conflict as NonNullable<import('../services/api.ts').ConflictPayload>;
  const [view, setView] = useState<'diff' | 'mine' | 'theirs'>('diff');
  const [busy, setBusy] = useState(false);

  /**
   * 基准常常只有正文（编辑器打开笔记拿到的就是 body），而 mine/theirs 是整篇文档。
   * 三者不同构时，frontmatter 会整块被标成「改了」——所以只在正文层面比。
   */
  const baseRaw = conflict.base.content ?? '';
  const mineRaw = conflict.mine.content ?? '';
  const theirsRaw = conflict.theirs.content ?? '';
  const bodyOnly = !FM_RE.test(baseRaw) && (FM_RE.test(mineRaw) || FM_RE.test(theirsRaw));
  const rows = alignThreeWay(baseRaw, bodyOnly ? stripFm(mineRaw) : mineRaw, bodyOnly ? stripFm(theirsRaw) : theirsRaw);
  const blocks = buildBlocks(rows);
  const [openFolds, setOpenFolds] = useState<Set<number>>(new Set());
  const mineChanged = rows.filter((r) => r.mine !== r.base).length;
  const theirsChanged = rows.filter((r) => r.theirs !== r.base).length;

  const renderRow = (r: ConflictRow, key: string | number) => {
    const mineChg = r.mine !== r.base;
    const theirsChg = r.theirs !== r.base;
    return (
      <div key={key} className="cf-row" data-any={mineChg || theirsChg ? '1' : '0'}>
        <div className="cf-cell" data-col="base" data-empty={r.base === undefined ? '1' : '0'}>{r.base ?? ''}</div>
        <div className="cf-cell" data-col="mine" data-chg={mineChg ? '1' : '0'} data-empty={r.mine === undefined ? '1' : '0'}>{r.mine ?? ''}</div>
        <div className="cf-cell" data-col="theirs" data-chg={theirsChg ? '1' : '0'} data-empty={r.theirs === undefined ? '1' : '0'}>{r.theirs ?? ''}</div>
      </div>
    );
  };

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
          <span className="cf-legend">
            <span className="cf-dot" data-tone="mine" />我的改动
            <span className="cf-dot" data-tone="theirs" />对方的改动
          </span>
          <span className="spacer" />
          <button className="btn" onClick={() => void reload()} data-testid="conflict-reload">重新载入</button>
          <button className="btn" onClick={() => void saveCopy()} disabled={busy} data-testid="conflict-copy">
            {busy ? '另存中…' : '另存副本'}
          </button>
        </>
      }
    >
      <div className="cf-summary">
        <div className="cf-sum-item" data-tone="base">
          <span className="cf-sum-key">基准</span>
          <span className="mono">r{conflict.base.rev}</span>
          {bodyOnly && <span className="muted">只含正文，不比较元数据</span>}
        </div>
        <div className="cf-sum-item" data-tone="mine">
          <span className="cf-sum-key">我的</span>
          <span className="mono">{mineChanged} 行不同</span>
        </div>
        <div className="cf-sum-item" data-tone="theirs">
          <span className="cf-sum-key">当前</span>
          <span className="mono">r{conflict.theirs.rev} · {conflict.theirs.author}</span>
          <span className="muted">{conflict.theirs.updatedAt.slice(5, 16).replace('T', ' ')}</span>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {([['diff', '三方对比'], ['mine', '我要写的'], ['theirs', '当前的']] as const).map(([k, label]) => (
          <button key={k} className="tab" role="tab" aria-selected={view === k} onClick={() => setView(k)}>{label}</button>
        ))}
      </div>

      {view === 'diff' && (
        <div className="cf" data-testid="conflict-diff">
          <div className="cf-head">
            <div className="cf-hcell" data-col="base">基准 · r{conflict.base.rev}</div>
            <div className="cf-hcell" data-col="mine">
              我的
              <span className="cf-hcell-n">{mineChanged} 处</span>
            </div>
            <div className="cf-hcell" data-col="theirs">
              当前 · {conflict.theirs.author}
              <span className="cf-hcell-n">{theirsChanged} 处</span>
            </div>
          </div>
          <div className="cf-body">
            {blocks.map((b, bi) => {
              if (b.kind === 'rows') return b.items.map(({ row, idx }) => renderRow(row, idx));
              const open = openFolds.has(b.from);
              if (open) return b.rows.map((row, k) => renderRow(row, `f${bi}-${k}`));
              return (
                <button
                  key={`fold-${b.from}`}
                  className="cf-fold"
                  onClick={() => setOpenFolds((s) => new Set(s).add(b.from))}
                >
                  {b.count} 行未改动
                </button>
              );
            })}
          </div>
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
          <article key={n.id} className="notif" data-read={n.read ? '1' : '0'} data-testid="notif-item">
            <span className="notif-bar" data-level={n.level} aria-hidden="true" />
            <div className="notif-body">
              <div className="notif-head">
                <span className="hit-type">{n.level === 'danger' ? '要处理' : n.level === 'warn' ? '提醒' : '进展'}</span>
                <strong className="ellipsis">{n.title}</strong>
                <span className="mono muted">{n.at.slice(5, 16).replace('T', ' ')}</span>
              </div>
              {n.body && <p className="entry-desc">{n.body}</p>}
              {n.href && (
                <a className="btn btn-sm btn-quiet" style={{ marginTop: 6 }} href={n.href} onClick={close} data-testid="notif-go">
                  去看
                  <Icon name="arrow" size={12} />
                </a>
              )}
            </div>
          </article>
        ))}
    </Sheet>
  );
}

export type { Ctx };
