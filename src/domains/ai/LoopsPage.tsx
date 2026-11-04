/**
 * 闭环页：自动化到底有没有在转，一眼看完。
 *
 * 这里不重复「自动化」页的规则配置；它回答的是另外三个问题：
 *   - 哪条停了（down / late / blocked）
 *   - 谁在跑、跑出了什么（回执 / 认领 / 租约）
 *   - 判断类现在该做什么（工单）
 */
import { useState } from 'react';
import { Card, Chip, Empty, ErrorBox, PageHead, Spinner, StatBand } from '../../components/ui.tsx';
import { endpoints, type LoopCheckView, type LoopDefView, type LoopStateView } from '../../services/api.ts';
import { useLoops } from '../../services/use.ts';
import { useUi } from '../../app/ui.ts';

const STATE_LABEL: Record<LoopStateView['state'], string> = {
  ok: '正常',
  late: '迟到',
  down: '停了',
  never: '未运行',
  paused: '已停用',
  blocked: '缺依赖',
  manual: '按需',
};

const STATE_TONE: Record<LoopStateView['state'], '' | 'ok' | 'warn' | 'danger' | 'info' | 'accent'> = {
  ok: 'ok',
  late: 'warn',
  down: 'danger',
  never: 'info',
  paused: '',
  blocked: 'warn',
  manual: '',
};

const MODE_LABEL: Record<LoopDefView['mode'], string> = {
  auto: '自动',
  assist: '备料 + 判断',
  gate: '人工确认',
  verify: '只验证',
};

const FAMILY_LABEL: Record<LoopDefView['family'], string> = {
  maintain: '维持',
  digest: '消化',
  decide: '判断',
  deliver: '交付',
};

const EXECUTOR_LABEL: Record<string, string> = {
  server: '服务端',
  'platform-agent': '平台 Agent',
  'external-harness': '外部 harness',
  human: '人',
};

const DEGRADE_LABEL: Record<string, string> = {
  noModel: '没有模型',
  noSchedule: '没有调度器',
  noMail: '没有邮件',
  noShell: '没有 Shell',
};

const STATE_RANK: Record<LoopStateView['state'], number> = {
  down: 0,
  blocked: 1,
  late: 2,
  never: 3,
  ok: 4,
  paused: 5,
  manual: 6,
};

const BACKLOG_LABEL: Record<string, string> = {
  inbox: '收件箱',
  agentReady: 'AI 欠账',
  unresolved: '断链',
  reviewDue: '到期复核',
  proposal: '待确认提案',
  job: '未完成作业',
};

function atLabel(s?: string): string {
  if (!s) return '从未';
  return `${s.slice(5, 10)} ${s.slice(11, 16)}`;
}

export function LoopsPage() {
  const { data, isLoading, error, refetch } = useLoops();
  const toast = useUi((s) => s.toast);
  const [filter, setFilter] = useState<'attention' | 'all' | 'assist' | 'deliver'>('attention');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [output, setOutput] = useState<{ id: string; title: string; text: string; result: string } | null>(null);
  const [check, setCheck] = useState<LoopCheckView | null>(null);

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorBox error={error ?? new Error('读不到闭环状态')} onRetry={() => void refetch()} />;

  const byId = new Map(data.loops.map((d) => [d.id, d]));
  const needsAttention = (s: LoopStateView) => s.state === 'down' || s.state === 'late' || s.state === 'blocked';

  const rows = data.states
    .filter((s) => {
      const def = byId.get(s.id);
      if (!def) return false;
      if (filter === 'attention') return needsAttention(s) || s.state === 'never';
      if (filter === 'assist') return def.mode === 'assist' || def.mode === 'gate';
      if (filter === 'deliver') return def.family === 'deliver';
      return true;
    })
    // 「需要处理」按严重程度排，别让 never 把 down 挤到下面
    .sort((a, b) => (filter === 'attention' ? STATE_RANK[a.state] - STATE_RANK[b.state] : 0));

  const attention = data.states.filter(needsAttention).length;
  const backlogTotal = Object.values(data.backlog).reduce((a, b) => a + b, 0);

  async function run(id: string) {
    const def = byId.get(id);
    setBusy(`run:${id}`);
    try {
      const r = await endpoints.runLoop(id);
      setOutput({ id, title: def?.name ?? id, text: r.output, result: r.result });
      toast(r.deduped ? `${def?.name ?? id}：${r.output.split('\n')[0]}` : `${def?.name ?? id} → ${r.result}`, r.result === 'fail' ? 'err' : 'ok');
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function toggle(id: string, enabled: boolean) {
    setBusy(`cfg:${id}`);
    try {
      await endpoints.setLoopConfig(id, { enabled });
      toast(enabled ? '已启用' : '已停用', 'ok');
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function selfCheck() {
    setBusy('check');
    try {
      const r = await endpoints.checkLoops();
      setCheck(r);
      toast(r.passed ? '自检通过' : `自检未通过：${r.silent.length} 条中断`, r.passed ? 'ok' : 'err');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function brief() {
    setBusy('brief');
    try {
      const r = await endpoints.loopsBrief();
      setOutput({ id: 'brief', title: '交接单', text: r.brief, result: 'ok' });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function alert() {
    setBusy('alert');
    try {
      const r = await endpoints.alertLoops(false);
      toast(r.report.alerted.length ? `已推 ${r.report.alerted.length} 条告警` : '没有需要告警的闭环', 'ok');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="AI · 闭环"
        title="闭环"
        lede="自动化最怕的不是没实现，是停了没人知道。每条闭环都有上限：超过上限没有回执，就会变成迟到或停了这个状态。"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={() => void brief()} disabled={!!busy} data-testid="loops-brief">
              交接单
            </button>
            <button className="btn btn-sm" onClick={() => void alert()} disabled={!!busy} data-testid="loops-alert">
              推一次告警
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => void selfCheck()} disabled={!!busy} data-testid="loops-check">
              {busy === 'check' ? '自检中…' : '自检'}
            </button>
          </div>
        }
      />

      <StatBand
        items={[
          { num: data.summary.ok ?? 0, label: '正常' },
          { num: data.summary.late ?? 0, label: '迟到', tone: 'accent' },
          { num: data.summary.down ?? 0, label: '停了', tone: 'danger' },
          { num: data.summary.never ?? 0, label: '从未运行' },
          { num: data.summary.blocked ?? 0, label: '缺依赖' },
          { num: backlogTotal, label: '总积压' },
        ]}
      />

      {attention > 0 && (
        <div className="notice" data-tone="warn" style={{ marginTop: 'var(--sp-5)' }} data-testid="loops-attention">
          <strong>{attention} 条需要处理。</strong>
          <span>先看「停了」和「缺依赖」；「迟到」多半是调度器漏了一轮。修不了就明确停用，别让它一直红着。</span>
        </div>
      )}

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">01</span>
          状态
          <span className="rubric-rule" />
          <span className="rubric-meta">{rows.length} / {data.states.length} 条</span>
        </h2>

        <div className="tabs" style={{ marginTop: 8 }}>
          {([
            ['attention', '需要处理'],
            ['all', '全部'],
            ['assist', '判断 / 确认'],
            ['deliver', '交付'],
          ] as const).map(([k, label]) => (
            <button key={k} className="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>

        {rows.length === 0 ? (
          <Empty title="这一类没有闭环" desc="换成「全部」看看，或者这条闭环还没接。" />
        ) : (
          <div className="stagger" data-testid="loops-list">
            {rows.map((s) => {
              const def = byId.get(s.id)!;
              const open = expanded === s.id;
              const configured = data.config.loops[s.id]?.enabled !== false;
              return (
                <div key={s.id}>
                  <div className="rule" data-enabled={s.state === 'ok' ? '1' : '0'} data-testid="loop-row">
                    <span className="rule-dot" aria-hidden="true" />
                    <span className="rule-name" style={{ width: 190 }}>
                      <span className="ellipsis" style={{ display: 'block' }}>{def.name}</span>
                      <code className="mono muted" style={{ fontSize: 'var(--t-micro)' }}>{def.id}</code>
                    </span>
                    <Chip tone={STATE_TONE[s.state]}>{STATE_LABEL[s.state]}</Chip>
                    <span className="hit-type">{MODE_LABEL[def.mode]}</span>
                    <span className="rule-desc ellipsis">
                      {s.reason} · 上次 {atLabel(s.lastAt)}
                    </span>
                    <span className="mono muted nowrap" title={def.backlog ? `积压指标：${BACKLOG_LABEL[def.backlog] ?? def.backlog}` : ''}>
                      {s.backlog != null ? `积压 ${s.backlog}` : '—'}
                    </span>
                    <button
                      className="btn btn-sm btn-quiet"
                      onClick={() => void run(s.id)}
                      disabled={!!busy}
                      data-testid="loop-run"
                    >
                      {busy === `run:${s.id}` ? '跑…' : def.mode === 'assist' ? '拿工单' : '跑一次'}
                    </button>
                    <button
                      className="btn btn-sm btn-quiet"
                      onClick={() => void toggle(s.id, !configured)}
                      disabled={!!busy}
                    >
                      {configured ? '停用' : '启用'}
                    </button>
                    <button
                      className="btn btn-sm btn-quiet"
                      onClick={() => setExpanded(open ? null : s.id)}
                      aria-expanded={open}
                      data-testid="loop-expand"
                    >
                      {open ? '收起' : '详情'}
                    </button>
                  </div>

                  {open && (
                    <div className="panel" style={{ margin: '4px 0 12px' }} data-testid="loop-detail">
                      <p className="small" style={{ marginTop: 0 }}>{def.intent}</p>
                      <dl className="kv">
                        <div>
                          <dt>触发</dt>
                          <dd>{triggerText(def)}</dd>
                        </div>
                        <div>
                          <dt>存活上限</dt>
                          <dd>{def.maxSilenceMinutes ? `${def.maxSilenceMinutes} 分钟` : '不做存活判定'}</dd>
                        </div>
                        <div>
                          <dt>执行者</dt>
                          <dd>{def.executors.map((e) => EXECUTOR_LABEL[e] ?? e).join(' / ')}</dd>
                        </div>
                        <div>
                          <dt>默认归属</dt>
                          <dd>{def.ownerHint}</dd>
                        </div>
                        <div className="kv-wide">
                          <dt>入口</dt>
                          <dd className="mono small">
                            {[def.entry.cli, def.entry.api, def.entry.mcp ? `MCP ${def.entry.mcp}` : '', def.entry.command]
                              .filter(Boolean)
                              .join(' ｜ ') || '只走 UI'}
                          </dd>
                        </div>
                        <div className="kv-wide">
                          <dt>步骤</dt>
                          <dd>
                            <ol className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                              {def.steps.map((x) => <li key={x}>{x}</li>)}
                            </ol>
                          </dd>
                        </div>
                        <div>
                          <dt>产物</dt>
                          <dd className="small">{def.outputs.join('；')}</dd>
                        </div>
                        <div>
                          <dt>证据</dt>
                          <dd className="small">{def.evidence.join('；')}</dd>
                        </div>
                        <div className="kv-wide">
                          <dt>幂等</dt>
                          <dd className="small">{def.idempotency}</dd>
                        </div>
                        {Object.entries(def.degrade).length > 0 && (
                          <div className="kv-wide">
                            <dt>降级</dt>
                            <dd className="small">
                              {Object.entries(def.degrade).map(([k, v]) => `${DEGRADE_LABEL[k] ?? k} → ${v}`).join('；')}
                            </dd>
                          </div>
                        )}
                      </dl>
                      {def.note && <p className="small muted">{def.note}</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <p className="section-note">
          判断类（备料 + 判断）点「拿工单」只会列出该处理什么，不会替你改；做完要用 <code className="mono">loops beat</code> 交账。
        </p>
      </section>

      {output && (
        <section className="section" data-testid="loop-output">
          <h2 className="rubric">
            <span className="rubric-no">02</span>
            {output.title}
            <span className="rubric-rule" />
            <span className="rubric-meta">{output.result} · {output.id}</span>
          </h2>
          <Card>
            <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 420, overflow: 'auto' }}>
              {output.text}
            </pre>
          </Card>
        </section>
      )}

      {check && (
        <section className="section" data-testid="loop-check">
          <h2 className="rubric">
            <span className="rubric-no">03</span>
            自检
            <span className="rubric-rule" />
            <span className="rubric-meta">{check.passed ? '通过' : '未通过'}</span>
          </h2>
          <Card>
            <dl className="kv">
              <div>
                <dt>迟到 / 中断</dt>
                <dd>{check.silent.length ? check.silent.map((x) => `${x.id}（${x.state}）`).join('、') : '无'}</dd>
              </div>
              <div>
                <dt>从未运行</dt>
                <dd>{check.never.length ? `${check.never.length} 条` : '无'}</dd>
              </div>
              <div>
                <dt>没有归属</dt>
                <dd>{check.unowned.length ? check.unowned.join('、') : '无'}</dd>
              </div>
              <div>
                <dt>重复执行</dt>
                <dd>{check.double.length ? check.double.join('、') : '无'}</dd>
              </div>
              <div className="kv-wide">
                <dt>归属不符</dt>
                <dd>{check.mismatch.length ? check.mismatch.map((m) => `${m.id}（声明 ${m.owner} / 实际 ${m.lastBy}）`).join('、') : '无'}</dd>
              </div>
            </dl>
          </Card>
        </section>
      )}

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">04</span>
          积压
          <span className="rubric-rule" />
          <span className="rubric-meta">该做但没做</span>
        </h2>
        <div className="ledger">
          {Object.entries(data.backlog).map(([k, n]) => (
            <div key={k} className="ledger-cell" data-zero={n === 0 ? '1' : '0'}>
              <div className="ledger-num" data-tone={n > 0 ? 'accent' : undefined}>{n}</div>
              <div className="ledger-label">{BACKLOG_LABEL[k] ?? k}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function triggerText(def: LoopDefView): string {
  const t = def.trigger;
  if (t.kind === 'daily') return `每天 ${t.at ?? ''}`;
  if (t.kind === 'interval') {
    const m = t.minutes ?? 0;
    return m < 1 ? `每 ${Math.round(m * 60)} 秒` : m < 60 ? `每 ${m} 分钟` : `每 ${Math.round(m / 60)} 小时`;
  }
  if (t.kind === 'event') return `事件：${t.on ?? ''}`;
  return t.note ?? '按需';
}
