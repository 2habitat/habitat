/** AI 域：变更与作业必须可见，否则 AI 就是在背后偷偷改 */
import { useState } from 'react';
import { Card, Chip, Empty, Spinner, ErrorBox, Field, Bar } from '../../components/ui.tsx';
import { useChanges, useProposals, useJobs, useFlow, useRefresh, useManifest } from '../../services/use.ts';
import { endpoints, ApiError, type ChangeSetView } from '../../services/api.ts';
import { useUi } from '../../app/ui.ts';
import { navigate } from '../../app/router.ts';

const STAGES = [
  { key: 'capture', name: '采集', hint: '已入库且有来源' },
  { key: 'derive', name: '衍生', hint: '产生了批注或衍生笔记' },
  { key: 'digest', name: '消化', hint: '读过 99% 且至少 1 条衍生' },
  { key: 'review', name: '回顾', hint: '有过一次回顾事件' },
  { key: 'settle', name: '沉淀', hint: '已定稿且被引用 ≥2 处' },
];

/* ---------------- 助手页 ---------------- */

export function AssistantPage() {
  const { data } = useManifest();
  const openAi = useUi((s) => s.openAi);
  const openSheet = useUi((s) => s.openSheet);

  return (
    <div className="content-wide">
      <Card
        title="助手"
        desc="三个入口，一套权限：页内助手看当前对象，协作中心跑多步目标，自动化按规则触发"
        actions={<button className="btn btn-sm btn-primary" onClick={() => openAi()} data-testid="assistant-open">唤起助手面板</button>}
      >
        <div className="grid grid-3">
          <div className="card">
            <strong>页内助手</strong>
            <div className="small muted">右下角 ✦ 唤出。带入当前对象，回答必须带依据。</div>
          </div>
          <div className="card">
            <strong>协作中心</strong>
            <div className="small muted">多步目标走「作业」，有检查点，等待不是失败。</div>
            <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => navigate('jobs')}>看作业</button>
          </div>
          <div className="card">
            <strong>自动化</strong>
            <div className="small muted">定时扫描、生成候选。每天默认不超过 3 条提案。</div>
            <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => navigate('automation')}>看规则</button>
          </div>
        </div>
      </Card>

      <Card title="权限四档" desc="AI 能做什么，写在这里，不靠猜">
        <ul>
          <li><strong>派生自动</strong>：建立索引、去重、解析链接 —— 不改语义，直接做。</li>
          <li><strong>授权内新增</strong>：元数据草稿、摘要候选 —— 新增，不覆盖。</li>
          <li><strong>改语义逐条确认</strong>：改结论、合并、归档 —— 必须你一条条点。</li>
          <li><strong>外部副作用禁止</strong>：外发、支付、删除 —— 一律不做。</li>
        </ul>
      </Card>

      <Card title="能力清单" desc="清单是唯一事实，AGENTS.md 只是人读的版本">
        {(data?.manifest.capabilities ?? []).map((c) => (
          <div key={c.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <Chip tone={c.mutating ? 'warn' : 'ok'}>{c.mutating ? '会写' : '只读'}</Chip>
            <strong style={{ width: 90 }}>{c.name}</strong>
            <span className="small muted ellipsis" style={{ flex: 1 }}>{c.agent}</span>
            <span className="small muted nowrap">{c.event}</span>
          </div>
        ))}
      </Card>

      <Card title="生成一条提案" desc="AI 不直接写正文，先产出提案给你确认">
        <button className="btn" onClick={() => openSheet('proposal', { title: '批量补充状态' })} data-testid="assistant-propose">生成提案</button>
      </Card>
    </div>
  );
}

/* ---------------- 变更页 ---------------- */

export function ChangesPage() {
  const [tab, setTab] = useState<'changes' | 'flow'>('changes');
  return (
    <div className="content-wide">
      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')} data-testid="tab-changes">变更</button>
        <button className="tab" role="tab" aria-selected={tab === 'flow'} onClick={() => setTab('flow')} data-testid="tab-flow">流转（生命周期）</button>
      </div>
      {tab === 'changes' ? <ChangesList /> : <FlowBoard />}
    </div>
  );
}

function ChangesList() {
  const { data, isLoading, error } = useChanges();
  const { data: props } = useProposals();
  const refresh = useRefresh();
  const toast = useUi((s) => s.toast);
  const openSheet = useUi((s) => s.openSheet);
  const [busy, setBusy] = useState('');

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  async function validate(cs: ChangeSetView) {
    setBusy(cs.id);
    try {
      const r = await endpoints.validate(cs.id);
      toast(r.checks.filter((c) => !c.ok).length ? '有校验没过，看卡片' : '四项校验全过', r.checks.every((c) => c.ok) ? 'ok' : 'err');
      refresh();
    } finally {
      setBusy('');
    }
  }

  async function commit(cs: ChangeSetView) {
    setBusy(cs.id);
    try {
      const r = await endpoints.commit(cs.id);
      if (!r.ok) throw new Error('撞车了');
      toast(`已提交，${r.events.length} 条事件`, 'ok');
      refresh();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.detail?.blocked) {
          toast(`不能提交：${e.detail.blocked.filter((b) => !b.ok).map((b) => `${b.label}（${b.detail}）`).join('；')}`, 'err');
        } else if (e.detail?.conflict) {
          openSheet('conflict', { conflict: e.detail.conflict, title: cs.reason ?? '' });
        } else {
          toast(e.message, 'err');
        }
      } else {
        toast(e instanceof Error ? e.message : String(e), 'err');
      }
      refresh();
    } finally {
      setBusy('');
    }
  }

  async function revert(cs: ChangeSetView) {
    setBusy(cs.id);
    try {
      await endpoints.revert(cs.id);
      toast('已撤销（撤销本身也是一次提交，会留事件）', 'ok');
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function apply(p: { id: string; changesetId?: string }) {
    if (!p.changesetId) return toast('这条提案没有绑定变更', 'err');
    setBusy(p.id);
    try {
      await endpoints.applyProposal(p.id);
      toast('提案已应用', 'ok');
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.detail?.conflict) openSheet('conflict', { conflict: e.detail.conflict });
      else toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  const list = data?.changesets ?? [];
  return (
    <>
      <Card title="变更" desc="一张卡片 = 一次事务：做什么 / 为什么 / 影响 / 差异 / 四项校验 / 提交 / 撤销">
        {list.length === 0
          ? <Empty title="还没有变更" desc="所有写操作都会先变成一条变更，提交后才落盘" />
          : list.map((cs) => <ChangeCard key={cs.id} cs={cs} busy={busy === cs.id} onValidate={() => void validate(cs)} onCommit={() => void commit(cs)} onRevert={() => void revert(cs)} />)}
      </Card>

      <Card title="提案" desc="AI 提的，等人逐条确认">
        {!(props?.proposals ?? []).length
          ? <Empty title="没有待处理的提案" />
          : (props?.proposals ?? []).map((p) => (
            <div key={p.id} className="card" style={{ marginBottom: 8 }}>
              <div className="row">
                <strong>{p.title}</strong>
                <Chip tone={p.state === 'applied' ? 'ok' : p.state === 'rejected' ? 'danger' : 'warn'}>{p.state}</Chip>
                <Chip>{p.risk}</Chip>
                <Chip>¥{p.budgetCny ?? 0}</Chip>
                <span className="spacer" />
                <button className="btn btn-sm" onClick={() => void apply(p)} disabled={p.state === 'applied'} data-testid="proposal-apply">应用</button>
              </div>
              {p.rationale && <div className="small muted" style={{ marginTop: 4 }}>{p.rationale}</div>}
              <div className="small" style={{ marginTop: 4 }}>影响范围：{p.scope || '（未填写）'} · 依据 {p.evidence?.length ?? 0} 条</div>
            </div>
          ))}
      </Card>
    </>
  );
}

function ChangeCard({ cs, busy, onValidate, onCommit, onRevert }: {
  cs: ChangeSetView; busy: boolean; onValidate: () => void; onCommit: () => void; onRevert: () => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const snap = cs.snapshot ? Object.entries(cs.snapshot)[0] : null;
  const stateTone = cs.state === 'committed' ? 'ok' : cs.state === 'conflict' ? 'danger' : cs.state === 'reverted' ? 'warn' : '';

  return (
    <div className="card" style={{ marginBottom: 10 }} data-testid="changeset-card">
      <div className="row">
        <strong className="ellipsis">{cs.reason || '（没写原因）'}</strong>
        <Chip tone={stateTone}>{cs.state}</Chip>
        <Chip>{cs.author === 'human' ? '我' : cs.author}</Chip>
        <span className="spacer" />
        <span className="small muted">{cs.createdAt.slice(0, 16)}</span>
      </div>

      <div className="small" style={{ marginTop: 6 }}>
        做什么：{cs.ops.map((o) => opLabel(o)).join('；')}
      </div>
      <div className="small muted">影响：{Object.keys(cs.baseRevisions).length} 个对象</div>

      {cs.checks && (
        <div style={{ marginTop: 6 }} data-testid="checks">
          {cs.checks.map((c) => (
            <div key={c.name} className="check-row">
              <span className="check-mark">{c.ok ? (c.level === 'warn' ? '⚠' : '✓') : '✕'}</span>
              <strong>{c.label}</strong>
              <span className="small muted" style={{ flex: 1 }}>{c.detail}</span>
            </div>
          ))}
        </div>
      )}

      {snap && (
        <div style={{ marginTop: 6 }}>
          <button className="btn btn-sm btn-ghost" onClick={() => setShowDiff((v) => !v)} data-testid="toggle-diff">
            {showDiff ? '收起差异' : '看差异'}
          </button>
          {showDiff && (
            <div className="diff" style={{ marginTop: 6 }}>
              {snap[1].base.split('\n').slice(0, 40).map((l, i) => (
                <div key={i} className="diff-del">- {l}</div>
              ))}
              {snap[1].mine.split('\n').slice(0, 40).map((l, i) => (
                <div key={i} className="diff-add">+ {l}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn btn-sm" onClick={onValidate} disabled={busy} data-testid="cs-validate">校验</button>
        {cs.state !== 'committed' && cs.state !== 'reverted' && (
          <button className="btn btn-sm btn-primary" onClick={onCommit} disabled={busy} data-testid="cs-commit">提交</button>
        )}
        {cs.state === 'committed' && (
          <button className="btn btn-sm btn-danger" onClick={onRevert} disabled={busy} data-testid="cs-revert">撤销</button>
        )}
        {busy && <span className="spin" />}
      </div>
    </div>
  );
}

function opLabel(o: { t: string; id?: string; patch?: Record<string, unknown>; body?: string; archived?: boolean }): string {
  switch (o.t) {
    case 'create': return `新建 ${String((o as { obj?: { type?: string } }).obj?.type ?? '对象')}`;
    case 'update': return `改 ${o.id?.slice(0, 10)} · ${Object.keys(o.patch ?? {}).join('/')}`;
    case 'setBody': return `改写正文 ${o.id?.slice(0, 10)}`;
    case 'append': return `追加 ${o.id?.slice(0, 10)}`;
    case 'archive': return o.archived ? '归档' : '取消归档';
    case 'move': return '移动';
    default: return o.t;
  }
}

/* ---------------- 流转看板 ---------------- */

function FlowBoard() {
  const { data, isLoading } = useFlow();
  const openSheet = useUi((s) => s.openSheet);
  const openAi = useUi((s) => s.openAi);
  if (isLoading) return <Spinner />;

  return (
    <>
      <Card title="流转" desc="五道闸门是算出来的，不是手打的标签。卡片停在哪个格子，就是真实进度">
        <div className="kanban" data-testid="kanban">
          {STAGES.map((s) => {
            const cards = data?.byStage[s.key] ?? [];
            return (
              <div key={s.key} className="kanban-col" data-testid={`kanban-${s.key}`}>
                <div className="kanban-head">
                  <strong>{s.name}</strong>
                  <span className="small muted">{cards.length}</span>
                </div>
                <div className="small muted" style={{ marginBottom: 6 }}>{s.hint}</div>
                {cards.map((c) => (
                  <div key={c.id} className="kanban-card">
                    <div className="ellipsis"><strong>{c.title}</strong></div>
                    <div className="small muted">读 {Math.round(c.readPct * 100)}% · 衍生 {c.derived}</div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="卡住的" desc="每一样都给出「下一步做什么」，不是空话">
        {!data?.stuck.length
          ? <Empty title="没有卡住的条目" />
          : data.stuck.map((c) => (
            <div key={c.id} className="row" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
              <Chip>{c.kind}</Chip>
              <span className="ellipsis" style={{ flex: 1 }}>{c.title}</span>
              <span className="small muted">卡在「{STAGES.find((s) => s.key === c.next?.key)?.name}」：{c.next?.text}</span>
              <button
                className="btn btn-sm"
                data-testid="flow-advance"
                onClick={() => {
                  if (c.next?.key === 'review') openSheet('review', { id: c.id, title: c.title });
                  else if (c.next?.key === 'derive') openSheet('derive', { srcId: c.id, title: `${c.title} · 衍生` });
                  else openAi({ kind: 'work', id: c.id, title: c.title });
                }}
              >
                推进
              </button>
            </div>
          ))}
      </Card>
    </>
  );
}

/* ---------------- 作业 ---------------- */

export function JobsPage() {
  const { data, isLoading, refetch } = useJobs();
  const refresh = useRefresh();
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState('');

  const jobs = (data?.jobs ?? []) as unknown as import('../../services/api.ts').JobView[];

  async function create() {
    setBusy('new');
    try {
      // 名字带时间：幂等键默认是「名字+日期」，同名同日再点会被去重，
      // 人会以为按钮没反应。手动跑一次就该是一条新作业。
      const stamp = new Date().toTimeString().slice(0, 5);
      await endpoints.createJob({ name: `扫描收件箱并生成衍生候选 ${stamp}`, trigger: 'manual' });
      toast('作业已排队', 'ok');
      refresh();
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function markFail(j: import('../../services/api.ts').JobView) {
    setBusy(j.id);
    try {
      const r = await endpoints.failJob(j.id, '人在界面上标记为失败');
      toast(r.permanent ? '已记 3 次失败，判永久失败' : '已记一次失败，退避后可重试', r.permanent ? 'err' : 'info');
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function advance(id: string) {
    setBusy(id);
    try {
      await endpoints.advanceJob(id, true);
      refresh();
      refetch();
    } catch (e) {
      if (e instanceof ApiError) toast(`${e.message}（${String((e as unknown as { detail?: unknown }).detail ?? '')}）`, 'err');
      else toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="content-wide">
      <Card
        title="作业"
        desc="作业是长流程，不是一次请求：queued → running → waiting-approval → done。等待不是失败"
        actions={<button className="btn btn-sm btn-primary" onClick={() => void create()} disabled={busy === 'new'} data-testid="job-create">跑一次演示作业</button>}
      >
        {isLoading ? <Spinner /> : jobs.length === 0
          ? <Empty title="还没有作业" desc="作业会留下检查点，中断了能从检查点继续，不重复副作用" />
          : jobs.map((j) => (
            <div key={j.id} className="card" style={{ marginBottom: 8 }} data-testid="job-card">
              <div className="row">
                <strong>{j.name}</strong>
                <Chip tone={j.state === 'done' ? 'ok' : j.state === 'waiting-approval' ? 'warn' : j.state === 'failed' ? 'danger' : 'info'} data-testid="job-state">{j.state}</Chip>
                <span className="spacer" />
                <span className="small muted">检查点：{j.checkpoint}</span>
                {j.state !== 'done' && j.state !== 'failed' && (
                  <button className="btn btn-sm" onClick={() => void advance(j.id)} disabled={busy === j.id} data-testid="job-advance">
                    {j.state === 'waiting-approval' ? '确认并继续' : '推进一步'}
                  </button>
                )}
                {j.state !== 'done' && j.state !== 'failed' && (
                  <button className="btn btn-sm btn-ghost" onClick={() => void markFail(j)} disabled={busy === j.id} data-testid="job-fail">记为失败</button>
                )}
              </div>
              {j.waitingReason && <div className="small" style={{ marginTop: 4, color: 'var(--warn)' }} data-testid="job-wait-reason">等待原因：{j.waitingReason}</div>}
              {(j.attempts || j.lastError) && (
                <div className="small" style={{ marginTop: 4, color: j.state === 'failed' ? 'var(--danger)' : 'var(--warn)' }} data-testid="job-retry">
                  失败 {j.attempts ?? 0} 次{j.lastError ? `：${j.lastError}` : ''}
                  {j.nextTryAt ? ` · 退避到 ${String(j.nextTryAt).slice(11, 16)} 再试` : ''}
                  {j.state === 'failed' ? ' · 已判永久失败，不再自动重试' : ''}
                </div>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                {j.steps.map((s, i) => (
                  <span key={i} className="row small">
                    <Chip tone={s.state === 'done' ? 'ok' : ''}>{s.state === 'done' ? '✓' : '·'} {s.name}</Chip>
                  </span>
                ))}
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>
                幂等键：{j.idempotencyKey}（同一把钥匙不会重复排队）
              </div>
            </div>
          ))}
      </Card>
    </div>
  );
}

/* ---------------- 自动化 ---------------- */

const KIND_LABEL: Record<string, string> = {
  'inbox-overflow': '收件箱积压',
  'overdue-actions': '任务逾期',
  'stale-reading': '读一半停住',
  custom: '自定义（不执行）',
};

export function AutomationPage() {
  const [rules, setRules] = useState<import('../../services/api.ts').RuleView[] | null>(null);
  const toast = useUi((s) => s.toast);
  const [form, setForm] = useState({ name: '', kind: 'inbox-overflow', threshold: 10, limit: 3, when: '', do: '' });
  const [report, setReport] = useState<import('../../services/api.ts').RuleRunView | null>(null);
  const [running, setRunning] = useState(false);

  if (rules === null) {
    endpoints.rules().then((r) => setRules(r.rules as import('../../services/api.ts').RuleView[])).catch(() => setRules([]));
    return <Spinner />;
  }

  async function add() {
    if (!form.name.trim()) return toast('规则名不能为空', 'err');
    try {
      const r = await endpoints.createRule(form);
      setRules([...(rules ?? []), r.rule]);
      setForm({ ...form, name: '' });
      toast('规则已保存', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  async function toggle(id: string) {
    await endpoints.toggleRule(id);
    setRules((rules ?? []).map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  }

  async function runNow() {
    setRunning(true);
    try {
      const r = await endpoints.runRules(false);
      setReport(r.report);
      toast(
        r.report.fired.length ? `触发了 ${r.report.fired.length} 条，去通知里看` : '这轮没有触发（条件没到，或今天已经提醒过）',
        r.report.fired.length ? 'ok' : 'info',
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="content-wide">
      <Card
        title="自动化"
        desc="服务每 5 分钟评估一次；只产出通知，不自动改正文。同一规则每天最多提醒一次"
        actions={<button className="btn btn-sm" onClick={() => void runNow()} disabled={running} data-testid="rules-run">现在跑一次</button>}
      >
        {rules.length === 0
          ? <Empty title="还没有规则" desc="规则只会产出提案，不会直接改正文" />
          : rules.map((r) => (
            <div key={r.id} className="row row-wrap" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
              <strong style={{ width: 160 }} className="ellipsis">{r.name}</strong>
              <Chip tone={r.kind === 'custom' ? 'warn' : 'info'}>{KIND_LABEL[r.kind ?? 'custom'] ?? r.kind}</Chip>
              <span className="small muted" style={{ flex: 1 }}>
                {r.kind === 'custom' ? '自由文本规则：不自动执行，需要你手动跟进' : `阈值 ${r.threshold} · ${r.when || ''}`}
              </span>
              <Chip>≤{r.limit} 条/天</Chip>
              <button className="btn btn-sm" onClick={() => void toggle(r.id)} data-testid="rule-toggle">{r.enabled ? '停用' : '启用'}</button>
            </div>
          ))}
      </Card>

      {report && (
        <Card title="上一轮结果" desc={`${report.at.slice(0, 16)} · 评估 ${report.evaluated} 条`} data-testid="rules-report">
          {report.fired.length === 0
            ? <div className="small muted">没有触发。条件未到，或今天已经提醒过。</div>
            : report.fired.map((f, i) => (
              <div key={i} className="small">✔ {f.rule}：{f.title}</div>
            ))}
          {report.skipped.map((k, i) => <div key={`s${i}`} className="small muted">· {k}</div>)}
        </Card>
      )}

      <Card title="加一条规则">
        <div className="grid grid-2">
          <Field label="名字"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="rule-name" /></Field>
          <Field label="触发条件" hint="只有这三种会被自动执行">
            <select className="select" value={form.kind} data-testid="rule-kind" onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="inbox-overflow">收件箱积压超过 N 条</option>
              <option value="overdue-actions">逾期任务达到 N 条</option>
              <option value="stale-reading">读到一半超过 N 天没动</option>
              <option value="custom">自定义（只记录，不自动跑）</option>
            </select>
          </Field>
          <Field label="阈值 N"><input className="input" type="number" value={form.threshold} data-testid="rule-threshold" onChange={(e) => setForm({ ...form, threshold: Number(e.target.value) })} /></Field>
          <Field label="每天最多几条"><input className="input" type="number" value={form.limit} onChange={(e) => setForm({ ...form, limit: Number(e.target.value) })} /></Field>
        </div>
        <button className="btn btn-primary" onClick={() => void add()} data-testid="rule-add">保存规则</button>
      </Card>
    </div>
  );
}

void Bar;
