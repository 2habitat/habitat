/** AI 域：变更与作业必须可见，否则 AI 就是在背后偷偷改 */
import { useState } from 'react';
import { Card, PageHead, Chip, Empty, Spinner, PageSkeleton, ErrorBox, Field, Bar } from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
import { CHANGE_STATE, JOB_STATE } from '../../app/labels.ts';
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

  const entries = [
    { icon: 'assistant' as const, title: '页内助手', desc: '右下角唤出。带入当前对象，回答必须带依据；检索为空就直说。', action: () => openAi(), cta: '现在问' },
    { icon: 'jobs' as const, title: '协作中心', desc: '多步目标走「作业」，有检查点，中断了能续。等待不是失败。', action: () => navigate('jobs'), cta: '看作业' },
    { icon: 'automation' as const, title: '自动化', desc: '定时扫描、生成候选。每天默认不超过 3 条提案。', action: () => navigate('automation'), cta: '看规则' },
  ];

  const tiers = [
    { no: '01', tone: 'ok', title: '派生自动', desc: '建索引、去重、解析链接 —— 不改语义，直接做' },
    { no: '02', tone: 'info', title: '授权内新增', desc: '元数据草稿、摘要候选 —— 新增，不覆盖' },
    { no: '03', tone: 'warn', title: '改语义逐条确认', desc: '改结论、合并、归档 —— 必须你一条条点' },
    { no: '04', tone: 'danger', title: '外部副作用禁止', desc: '外发、支付、删除 —— 一律不做' },
  ];

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="AI · 助手"
        title="助手"
        lede="三个入口，一套权限：页内助手看当前对象，协作中心跑多步目标，自动化按规则触发。它只能提案，改语义要你点头。"
        actions={<button className="btn btn-sm btn-primary" onClick={() => openAi()} data-testid="assistant-open">唤起助手面板</button>}
      />

      <div className="mode-grid">
        {entries.map((e) => (
          <button key={e.title} className="mode-card" onClick={e.action}>
            <span className="mode-icon"><Icon name={e.icon} size={18} /></span>
            <strong>{e.title}</strong>
            <span className="mode-desc">{e.desc}</span>
            <span className="mode-cta">{e.cta} <Icon name="arrow" size={12} /></span>
          </button>
        ))}
      </div>

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">01</span>
          权限四档
          <span className="rubric-rule" />
          <span className="rubric-meta">写在这里，不靠猜</span>
        </h2>
        <div className="tiers">
          {tiers.map((t) => (
            <div key={t.no} className="tier" data-tone={t.tone}>
              <span className="tier-no">{t.no}</span>
              <strong>{t.title}</strong>
              <span className="tier-desc">{t.desc}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">02</span>
          能力清单
          <span className="rubric-rule" />
          <span className="rubric-meta">{data?.manifest.capabilities.length ?? 0} 项</span>
        </h2>
        <p className="section-note">清单是唯一事实，AGENTS.md 只是人读的版本。</p>
        <div className="caps">
          {(data?.manifest.capabilities ?? []).map((c) => (
            <div key={c.id} className="cap">
              <span className="cap-flag" data-write={c.mutating ? '1' : '0'}>{c.mutating ? '会写' : '只读'}</span>
              <span className="cap-name mono">{c.name}</span>
              <span className="cap-agent ellipsis">{c.agent}</span>
              <span className="cap-event mono">{c.event}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">03</span>
          生成一条提案
          <span className="rubric-rule" />
        </h2>
        <p className="section-note">AI 不直接写正文 —— 先产出提案，你逐条确认后才落盘。一天默认 3 条上限。</p>
        <button className="btn" style={{ marginTop: 12 }} onClick={() => openSheet('proposal', { title: '批量补充状态' })} data-testid="assistant-propose">
          生成提案
        </button>
      </section>
    </div>
  );
}

/* ---------------- 变更页 ---------------- */

export function ChangesPage() {
  const [tab, setTab] = useState<'changes' | 'flow'>('changes');
  return (
    <div className="content-wide">
      <PageHead
        eyebrow="AI · 变更"
        title="变更"
        lede="一张卡片 = 一次事务：做什么 / 为什么 / 影响 / 差异 / 四项校验 / 提交 / 撤销。所有写操作都先变成变更，提交后才落盘。"
      />
      <div className="tabs" role="tablist" style={{ marginTop: 'var(--sp-5)' }}>
        <button className="tab" role="tab" aria-selected={tab === 'changes'} onClick={() => setTab('changes')} data-testid="tab-changes">变更记录</button>
        <button className="tab" role="tab" aria-selected={tab === 'flow'} onClick={() => setTab('flow')} data-testid="tab-flow">生命周期</button>
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
      <Card data-testid="changes-list">
        {list.length === 0
          ? <Empty title="还没有变更" desc="所有写操作都会先变成一条变更，提交后才落盘。这里是账本，不是日志。" />
          : list.map((cs) => <ChangeCard key={cs.id} cs={cs} busy={busy === cs.id} onValidate={() => void validate(cs)} onCommit={() => void commit(cs)} onRevert={() => void revert(cs)} />)}
      </Card>

      <Card title="提案" desc="AI 提的，等人逐条确认。没有确认这一步，它就只能读">
        {!(props?.proposals ?? []).length
          ? <Empty title="没有待处理的提案" />
          : (props?.proposals ?? []).map((p) => (
            <div key={p.id} className="entry">
              <div className="entry-main">
                <div className="entry-title">
                  <h3>{p.title}</h3>
                  <Chip tone={p.state === 'applied' ? 'ok' : p.state === 'rejected' ? 'danger' : 'warn'}>{p.state}</Chip>
                  <Chip>{p.risk}</Chip>
                  <Chip>¥{p.budgetCny ?? 0}</Chip>
                </div>
                {p.rationale && <p className="entry-desc">{p.rationale}</p>}
                <div className="entry-meta">影响范围：{p.scope || '（未填写）'} · 依据 {p.evidence?.length ?? 0} 条</div>
              </div>
              <div className="entry-side">
                <button className="btn btn-sm btn-primary" onClick={() => void apply(p)} disabled={p.state === 'applied'} data-testid="proposal-apply">应用</button>
              </div>
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
  const ok = cs.checks?.every((c) => c.ok);

  return (
    <article className="chg" data-testid="changeset-card" data-state={cs.state}>
      <span className="chg-rail" aria-hidden="true" />
      <div className="chg-main">
        <header className="chg-head">
          <span className="chg-state" data-state={cs.state}>{CHANGE_STATE[cs.state] ?? cs.state}</span>
          <h3 className="chg-reason ellipsis">{cs.reason || '（没写原因）'}</h3>
          <span className="chg-meta mono">{cs.author === 'human' ? '我' : cs.author} · {cs.createdAt.slice(5, 16).replace('T', ' ')}</span>
        </header>

        <div className="chg-ops">{cs.ops.map((o) => opLabel(o)).join('；')}</div>

        <div className="chg-facts">
          <span><b>{Object.keys(cs.baseRevisions).length}</b> 个对象受影响</span>
          {cs.checks && (
            <span className="chg-checks" data-testid="checks">
              {cs.checks.map((c) => (
                <span key={c.name} className="chg-check" data-ok={c.ok ? '1' : '0'} title={c.detail}>
                  <Icon name={c.ok ? 'check' : 'close'} size={12} />
                  {c.label}
                </span>
              ))}
            </span>
          )}
        </div>

        {snap && showDiff && (
          <div className="diff" style={{ marginTop: 10 }}>
            {snap[1].base.split('\n').slice(0, 40).map((l, i) => (
              <div key={i} className="diff-del">- {l}</div>
            ))}
            {snap[1].mine.split('\n').slice(0, 40).map((l, i) => (
              <div key={i} className="diff-add">+ {l}</div>
            ))}
          </div>
        )}

        <footer className="chg-foot">
          {snap && (
            <button className="btn btn-sm btn-quiet" onClick={() => setShowDiff((v) => !v)} data-testid="toggle-diff">
              {showDiff ? '收起差异' : '看差异'}
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-sm btn-quiet" onClick={onValidate} disabled={busy} data-testid="cs-validate">重新校验</button>
          {cs.state !== 'committed' && cs.state !== 'reverted' && (
            <button className="btn btn-sm btn-primary" onClick={onCommit} disabled={busy || ok === false} data-testid="cs-commit">提交</button>
          )}
          {cs.state === 'committed' && (
            <button className="btn btn-sm btn-danger" onClick={onRevert} disabled={busy} data-testid="cs-revert">撤销</button>
          )}
          {busy && <span className="spin" />}
        </footer>
      </div>
    </article>
  );
}

function opLabel(o: { t: string; id?: string; patch?: Record<string, unknown>; body?: string; archived?: boolean }): string {
  switch (o.t) {
    case 'create': return `新建 ${String((o as { obj?: { type?: string } }).obj?.type ?? '对象')}`;
    case 'update': return `改 ${o.id?.slice(0, 10)} · ${Object.keys(o.patch ?? {}).join('/')}`;
    case 'setBody': return `改写正文 ${o.id?.slice(0, 10)}`;
    case 'append': return `追加 ${o.id?.slice(0, 10)}`;
    case 'archive': return o.archived ? '归档' : '取消归档';
    case 'remove': return '删批注';
    case 'move': return '移动';
    default: return o.t;
  }
}

/* ---------------- 流转看板 ---------------- */

function FlowBoard() {
  const { data, isLoading } = useFlow();
  const openSheet = useUi((s) => s.openSheet);
  const openAi = useUi((s) => s.openAi);
  if (isLoading) return <PageSkeleton rows={3} title={false} />;

  return (
    <>
      <section className="section" style={{ marginTop: 0 }}>
        <h2 className="rubric">
          <span className="rubric-no">01</span>
          五道闸门
          <span className="rubric-rule" />
          <span className="rubric-meta">算出来的，不是手打的标签</span>
        </h2>
        <div className="kanban" data-testid="kanban">
          {STAGES.map((s, i) => {
            const cards = data?.byStage[s.key] ?? [];
            return (
              <div key={s.key} className="kanban-col" data-testid={`kanban-${s.key}`}>
                <div className="kanban-head">
                  <span className="kanban-no">{String(i + 1).padStart(2, '0')}</span>
                  <span>{s.name}</span>
                  <span className="kanban-n">{cards.length}</span>
                </div>
                <div className="kanban-hint">{s.hint}</div>
                {cards.map((c) => (
                  <div key={c.id} className="kanban-card">
                    <div className="ellipsis" style={{ fontWeight: 600 }}>{c.title}</div>
                    <div className="small muted">读 {Math.round(c.readPct * 100)}% · 衍生 {c.derived}</div>
                  </div>
                ))}
                {cards.length === 0 && <div className="kanban-empty">空</div>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">02</span>
          卡住的
          <span className="rubric-rule" />
          <span className="rubric-meta">{data?.stuck.length ?? 0} 条</span>
        </h2>
        <p className="section-note">每一样都给出「下一步做什么」，不是空话。</p>
        {!data?.stuck.length
          ? <Empty title="没有卡住的条目" desc="所有在跑的东西都有明确的下一步。" />
          : data.stuck.map((c) => (
            <div key={c.id} className="part" style={{ padding: '10px 0' }}>
              <span className="hit-type">{c.kind}</span>
              <span className="part-title ellipsis">{c.title}</span>
              <span className="small muted">卡在「{STAGES.find((s) => s.key === c.next?.key)?.name}」：{c.next?.text}</span>
              <button
                className="btn btn-sm btn-quiet"
                data-testid="flow-advance"
                onClick={() => {
                  if (c.next?.key === 'review') openSheet('review', { id: c.id, title: c.title });
                  else if (c.next?.key === 'derive') openSheet('derive', { srcId: c.id, title: `${c.title} · 衍生` });
                  else openAi({ kind: 'work', id: c.id, title: c.title });
                }}
              >
                推进
                <Icon name="arrow" size={12} />
              </button>
            </div>
          ))}
      </section>
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
      <PageHead
        eyebrow="AI · 作业"
        title="作业"
        lede="作业是长流程，不是一次请求：排队 → 执行 → 待人确认 → 完成。等待不是失败，但也不能被绕过。"
        actions={
          <button className="btn btn-sm btn-primary" onClick={() => void create()} disabled={busy === 'new'} data-testid="job-create">
            <Icon name="plus" size={13} />
            跑一次演示作业
          </button>
        }
      />

      {isLoading ? <PageSkeleton rows={3} title={false} /> : jobs.length === 0
        ? <Empty title="还没有作业" desc="作业会留下检查点，中断了能从检查点继续，不重复副作用。" />
        : (
          <div className="stagger">
            {jobs.map((j) => (
              <article key={j.id} className="job" data-state={j.state} data-testid="job-card">
                <header className="job-head">
                  <span className="job-zh" data-state={j.state}>{JOB_STATE[j.state] ?? j.state}</span>
                  <span className="job-state mono" data-testid="job-state">{j.state}</span>
                  <h3 className="job-name ellipsis">{j.name}</h3>
                  <span className="mono muted">{String(j.updatedAt ?? "").slice(5, 16).replace("T", " ")}</span>
                </header>

                <div className="job-steps">
                  {j.steps.map((s, i) => (
                    <span key={i} className="job-step" data-done={s.state === 'done' ? '1' : '0'}>
                      <i className="job-dot" aria-hidden="true" />
                      {s.name}
                    </span>
                  ))}
                </div>

                {j.waitingReason && (
                  <div className="job-note" data-tone="warn" data-testid="job-wait-reason">等待原因：{j.waitingReason}</div>
                )}
                {(j.attempts || j.lastError) && (
                  <div className="job-note" data-tone={j.state === 'failed' ? 'danger' : 'warn'} data-testid="job-retry">
                    失败 {j.attempts ?? 0} 次{j.lastError ? `：${j.lastError}` : ''}
                    {j.nextTryAt ? ` · 退避到 ${String(j.nextTryAt).slice(11, 16)} 再试` : ''}
                    {j.state === 'failed' ? ' · 已判永久失败，不再自动重试' : ''}
                  </div>
                )}

                <footer className="job-foot">
                  <span className="job-keys mono">检查点 {j.checkpoint} · 幂等键 {j.idempotencyKey}</span>
                  <span className="spacer" />
                  {j.state !== 'done' && j.state !== 'failed' && (
                    <button className="btn btn-sm btn-quiet" onClick={() => void markFail(j)} disabled={busy === j.id} data-testid="job-fail">记为失败</button>
                  )}
                  {j.state !== 'done' && j.state !== 'failed' && (
                    <button className="btn btn-sm btn-primary" onClick={() => void advance(j.id)} disabled={busy === j.id} data-testid="job-advance">
                      {j.state === 'waiting-approval' ? '确认并继续' : '推进一步'}
                    </button>
                  )}
                </footer>
              </article>
            ))}
          </div>
        )}
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
      <PageHead
        eyebrow="AI · 自动化"
        title="自动化"
        lede="服务每 5 分钟评估一次；只产出通知，不自动改正文。同一规则每天最多提醒一次。"
        actions={
          <button className="btn btn-sm btn-primary" onClick={() => void runNow()} disabled={running} data-testid="rules-run">
            {running ? '评估中…' : '现在跑一次'}
          </button>
        }
      />

      <section className="section" style={{ marginTop: 'var(--sp-5)' }}>
        <h2 className="rubric">
          <span className="rubric-no">01</span>
          规则
          <span className="rubric-rule" />
          <span className="rubric-meta">{rules.filter((r) => r.enabled).length} 条在跑</span>
        </h2>
        {rules.length === 0
          ? <Empty title="还没有规则" desc="规则只会产出通知，不会直接改正文。下面加一条试试。" />
          : (
            <div className="stagger">
              {rules.map((r) => (
                <div key={r.id} className="rule" data-enabled={r.enabled ? '1' : '0'}>
                  <span className="rule-dot" aria-hidden="true" />
                  <span className="rule-name ellipsis">{r.name}</span>
                  <span className="hit-type">{KIND_LABEL[r.kind ?? 'custom'] ?? r.kind}</span>
                  <span className="rule-desc ellipsis">
                    {r.kind === 'custom' ? '自由文本规则：不自动执行，需要你手动跟进' : `阈值 ${r.threshold} · ${r.when || '每 5 分钟'}`}
                  </span>
                  <span className="mono muted nowrap">≤{r.limit} 条/天</span>
                  <button className="btn btn-sm btn-quiet" onClick={() => void toggle(r.id)} data-testid="rule-toggle">
                    {r.enabled ? '停用' : '启用'}
                  </button>
                </div>
              ))}
            </div>
          )}
      </section>

      {report && (
        <section className="section" data-testid="rules-report">
          <h2 className="rubric">
            <span className="rubric-no">02</span>
            上一轮结果
            <span className="rubric-rule" />
            <span className="rubric-meta">{report.at.slice(5, 16).replace('T', ' ')} · 评估 {report.evaluated} 条</span>
          </h2>
          {report.fired.length === 0
            ? <p className="section-note">没有触发。条件未到，或今天已经提醒过。</p>
            : report.fired.map((f, i) => (
              <div key={i} className="part">
                <span className="chg-check" data-ok="1"><Icon name="check" size={12} /></span>
                <span className="part-title">{f.rule}</span>
                <span className="small muted">{f.title}</span>
              </div>
            ))}
          {report.skipped.map((k, i) => (
            <div key={`s${i}`} className="part">
              <span className="chg-check" data-ok="0"><Icon name="close" size={12} /></span>
              <span className="part-title muted">{k}</span>
            </div>
          ))}
        </section>
      )}

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">03</span>
          加一条规则
          <span className="rubric-rule" />
        </h2>
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="grid grid-2">
            <Field label="名字"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="rule-name" /></Field>
            <Field label="触发条件" hint="只有前三种会被自动执行">
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
        </div>
      </section>
    </div>
  );
}

void Bar;
