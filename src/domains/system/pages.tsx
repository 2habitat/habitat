/** 系统域：数据在哪、谁能写、花了多少、坏没坏 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, Stat, Chip, Empty, Spinner, ErrorBox, Bar, Field, fmtBytes } from '../../components/ui.tsx';
import { useSystem, useManifest, useJournal, useRefresh } from '../../services/use.ts';
import { endpoints, type ReconcileView, type JournalEventView } from '../../services/api.ts';
import { useUi } from '../../app/ui.ts';

const ACTOR_LABEL: Record<string, string> = {
  human: '我', system: '系统', 'external:unknown': '未署名',
};

function actorLabel(a: string): string {
  if (ACTOR_LABEL[a]) return ACTOR_LABEL[a];
  if (a.startsWith('agent:')) return `AI · ${a.slice(6)}`; // 与服务端 actorLabel 保持一致
  return a;
}

function actorClass(a: string): string {
  if (a === 'human') return 'ev-human';
  if (a === 'system') return 'ev-system';
  if (a === 'external:unknown') return 'ev-external';
  return 'ev-agent';
}

const OP_LABEL: Record<string, string> = {
  capture: '采集', ingest: '入库', read: '阅读', annotate: '批注', derive: '衍生', edit: '编辑',
  propose: '提案', review: '回顾', settle: '沉淀', commit: '提交', build: '构建', import: '导入',
  revert: '撤销', external_edit: '未署名改动', reconcile: '对账',
};

export function StoragePage() {
  const { data, isLoading, error, refetch } = useSystem();
  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const cap = data.storage.capabilities;

  return (
    <div className="content-wide">
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat num={data.stats.works} label="作品" />
        <Stat num={data.stats.parts} label="章节" />
        <Stat num={data.stats.reps} label="载体" hint="界面上不出现这个数，它只在存储核算里" />
        <Stat num={fmtBytes(data.stats.assetBytes)} label="附件体积" />
      </div>

      <Card title="空间" desc="一个空间一个根目录，WPS 同步的仍是这个根">
        <div className="grid grid-2">
          <div><span className="small muted">名称</span><div>{data.space.name}</div></div>
          <div><span className="small muted">根目录</span><div className="mono">{data.space.root}</div></div>
          <div><span className="small muted">时区</span><div>{data.space.tz}</div></div>
          <div><span className="small muted">布局版本</span><div>layout 2</div></div>
        </div>
      </Card>

      <Card title="存储适配" desc="两个实现：本地目录（条件写）与 WPS 同步盘（能力降级）">
        <div className="row row-wrap" style={{ marginBottom: 8 }}>
          {Object.entries(cap).map(([k, v]) => (
            <Chip key={k} tone={v ? 'ok' : 'warn'}>{k}: {String(v)}</Chip>
          ))}
        </div>
        <div className="small" style={{ marginBottom: 8 }}>当前适配器：<strong>{data.storage.adapter}</strong></div>
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          <div className="small">{data.storage.wpsNotice}</div>
        </div>
      </Card>

      <Card title="文件清单" desc={`${data.storage.assets.length} 个 · ${fmtBytes(data.storage.assetBytes)}`}>
        {data.storage.assets.length === 0
          ? <Empty title="还没有附件" />
          : (
            <table className="table">
              <thead><tr><th>路径</th><th>类型</th><th style={{ width: 100 }}>大小</th></tr></thead>
              <tbody>
                {data.storage.assets.map((a) => (
                  <tr key={a.path}>
                    <td className="mono ellipsis">{a.path}</td>
                    <td><Chip>{a.kind}</Chip></td>
                    <td className="small muted">{fmtBytes(a.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>
    </div>
  );
}

export function AgentPage() {
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState({ limit: '100' });
  const { data, isLoading, refetch } = useJournal(q);
  const { data: mf } = useManifest();
  const [report, setReport] = useState<ReconcileView | null>(null);
  const toast = useUi((s) => s.toast);
  const refresh = useRefresh();
  const openSheet = useUi((s) => s.openSheet);
  const [busy, setBusy] = useState(false);

  const events = (data?.events ?? []).filter((e) => (filter ? e.actor.startsWith(filter) : true));

  async function runReconcile() {
    setBusy(true);
    try {
      const r = await endpoints.reconcile();
      setReport(r.report);
      toast(r.report.unsigned.length ? `发现 ${r.report.unsigned.length} 处未署名改动` : '一切正常，没有未署名改动', r.report.unsigned.length ? 'err' : 'ok');
      refresh();
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function claim(id: string) {
    await endpoints.claim(id, 'human');
    toast('已认领（原来的未署名记录仍然保留）', 'ok');
    refetch();
  }

  return (
    <div className="content-wide">
      <Card
        title="Agent 接入"
        desc="能力表、事件流、未署名改动，三块缺一不可"
        actions={
          <>
            <button className="btn btn-sm" onClick={() => openSheet('journal')} data-testid="agent-log">补一条事件</button>
            <button className="btn btn-sm btn-primary" onClick={() => void runReconcile()} disabled={busy} data-testid="agent-reconcile">
              {busy ? '对账中…' : '对账'}
            </button>
          </>
        }
      >
        <div className="small muted" style={{ marginBottom: 10 }}>
          外部 Agent（Claude Code、Codebuddy……）不用猜接口，先跑一条
          <code> habitat agent manifest </code>
          就能拿到下面这张能力表：每项都写清了「人怎么点 / AI 怎么调 / 会不会写 / 留什么事件」。
          全流程和人在界面上走的是同一套，不留暗门。
        </div>
        <div className="grid grid-3">
          {(mf?.manifest.capabilities ?? []).map((c) => (
            <div key={c.id} className="card">
              <div className="row"><strong>{c.name}</strong><span className="spacer" /><Chip tone={c.mutating ? 'warn' : 'ok'}>{c.mutating ? '会写' : '只读'}</Chip></div>
              <div className="small muted" style={{ marginTop: 4 }}>人：{c.human}</div>
              <div className="small muted">AI：{c.agent}</div>
              <div className="small muted">写：{c.writes}</div>
              <div className="small muted">事件：{c.event}</div>
              <code className="small" style={{ display: 'block', marginTop: 6, wordBreak: 'break-all' }}>{c.command}</code>
            </div>
          ))}
        </div>
      </Card>

      {report && (
        <Card title="对账结果" desc={`${report.at.slice(0, 16)} · 查了 ${report.checked} 个文件`}>
          {report.baseline ? (
            <div className="small" style={{ marginBottom: 8 }}>
              这是第一次对账，只建了基线（{report.checked} 个文件的 sha256 记下来了）。
              从下一次开始，谁绕过接口改了文件，这里能指出来。
            </div>
          ) : (
            <div className="row row-wrap" style={{ marginBottom: 8 }}>
              <Chip tone="ok">署名改动 {report.signed.length}</Chip>
              <Chip tone={report.unsigned.length ? 'danger' : 'ok'}>未署名 {report.unsigned.length}</Chip>
              <Chip>新增 {report.added.length}</Chip>
              <Chip>删除 {report.removed.length}</Chip>
            </div>
          )}
          {report.unsigned.map((u) => (
            <div key={u.path} className="small mono" style={{ color: 'var(--danger)' }}>⚠ {u.path}</div>
          ))}
        </Card>
      )}

      <Card
        title="事件流"
        desc="事件只追加：对象可以被覆盖，事件不会"
        actions={
          <select className="select" style={{ width: 150 }} value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="journal-filter">
            <option value="">全部主体</option>
            <option value="human">只看我</option>
            <option value="agent:">只看 AI</option>
            <option value="system">只看系统</option>
            <option value="external:unknown">只看未署名</option>
          </select>
        }
      >
        {isLoading ? <Spinner /> : events.length === 0
          ? <Empty title="还没有事件" desc="任何写操作都会留一条" />
          : events.slice(0, 60).map((e) => <EventRow key={e.id} e={e} onClaim={() => void claim(e.id)} />)}
      </Card>
    </div>
  );
}

function EventRow({ e, onClaim }: { e: JournalEventView; onClaim: () => void }) {
  return (
    <div className="ev" data-testid="journal-event">
      <span className={`ev-dot ${actorClass(e.actor)}`} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row">
          <strong className="small">{actorLabel(e.actor)}</strong>
          <Chip>{OP_LABEL[e.op] ?? e.op}</Chip>
          <Chip>{e.phase}</Chip>
          <span className="spacer" />
          <span className="small muted">{e.at.slice(0, 16)}</span>
        </div>
        <div className="small ellipsis">{e.summary}</div>
        <div className="small muted mono ellipsis">{e.target}</div>
        {e.actor === 'external:unknown' && !e.claimedBy && (
          <button className="btn btn-sm" onClick={onClaim} data-testid="claim-btn">认领这条改动</button>
        )}
        {e.claimedBy && <div className="small" style={{ color: 'var(--ok)' }}>已被 {e.claimedBy} 认领（原记录保留）</div>}
      </div>
    </div>
  );
}

export function BudgetPage() {
  const { data, isLoading } = useSystem();
  const { data: mf } = useManifest();
  if (isLoading) return <Spinner />;

  const perm = [
    { name: '派生自动', eg: '建立索引、去重、解析链接', need: '不需要', tone: 'ok' as const },
    { name: '授权内新增', eg: '元数据草稿、摘要候选', need: '授权一次', tone: 'info' as const },
    { name: '改语义逐条确认', eg: '改结论、合并、归档', need: '逐条确认', tone: 'warn' as const },
    { name: '外部副作用禁止', eg: '外发、支付、删除', need: '一律不做', tone: 'danger' as const },
  ];

  return (
    <div className="content-wide">
      <Card title="预算" desc="AI 提案过量，人就会关掉它。默认每天 ≤3 条，只约束 agent，不限制你自己">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="small muted" style={{ width: 120 }}>今天已用</span>
          <div style={{ width: 200 }}>
            <Bar value={(data?.budget.usedToday ?? 0) / Math.max(1, data?.budget.dailyProposalLimit ?? 3)} />
          </div>
          <span className="small mono">{data?.budget.usedToday ?? 0} / {data?.budget.dailyProposalLimit ?? 3}</span>
        </div>
        <div className="small muted">
          超了不是报错，是不再推新的提案——已经有的一定让你看到。
        </div>
      </Card>

      <Card title="权限四档">
        {perm.map((p) => (
          <div key={p.name} className="row" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
            <Chip tone={p.tone}>{p.need}</Chip>
            <strong style={{ width: 130 }}>{p.name}</strong>
            <span className="small muted" style={{ flex: 1 }}>{p.eg}</span>
          </div>
        ))}
      </Card>

      <Card title="会写东西的能力" desc="只有这些入口会落盘">
        {(mf?.manifest.capabilities ?? []).filter((c) => c.mutating).map((c) => (
          <div key={c.id} className="row" style={{ padding: '5px 0' }}>
            <strong style={{ width: 100 }}>{c.name}</strong>
            <span className="small muted" style={{ flex: 1 }}>{c.writes}</span>
            <Chip>{c.event}</Chip>
          </div>
        ))}
      </Card>
    </div>
  );
}

/* ---------------- 通知渠道 ---------------- */

/**
 * 邮件通道配置。
 * 这里只做「让人能自己填对」：状态说清缺什么、授权码怎么拿、发一封测试信当场验。
 * 密钥不回显——pass 留空表示沿用已保存的。
 */
export function ChannelsPage() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['notify-status'],
    queryFn: () => endpoints.notifyStatus(),
  });
  const toast = useUi((s) => s.toast);
  const [form, setForm] = useState({
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: '',
    pass: '',
    to: '',
    fromName: 'Habitat 知识库',
    allowFrom: '',
  });
  const [busy, setBusy] = useState('');
  const [report, setReport] = useState<{ sent: { kind: string; title: string }[]; skipped: string[] } | null>(null);
  const [mailReport, setMailReport] = useState<{ fetched: number; captured: { subject: string }[]; skipped: { subject: string; skipped?: string }[] } | null>(null);
  const [seeded, setSeeded] = useState(false);

  // 首次拿到状态后回填（pass 永远留空，不回显）
  if (data && !seeded) {
    setSeeded(true);
    // 分别回填：发件和收件可以不是同一个邮箱
    setForm((f) => ({
      ...f,
      host: data.host ?? f.host,
      port: data.port ?? f.port,
      secure: data.secure ?? f.secure,
      fromName: data.fromName ?? f.fromName,
      user: data.user ?? f.user,
      to: data.to ?? f.to,
      allowFrom: (data.allowFrom ?? []).join(', '),
    }));
  }

  async function save() {
    setBusy('save');
    try {
      await endpoints.saveNotifyConfig({
        host: form.host.trim(),
        port: Number(form.port) || 465,
        secure: form.secure,
        user: form.user.trim(),
        // 空就不传，服务端沿用已保存的——界面不该要求每次重填密钥
        pass: form.pass.trim() || undefined,
        to: form.to.trim(),
        fromName: form.fromName.trim(),
        allowFrom: form.allowFrom.split(',').map((x) => x.trim()).filter(Boolean),
      });
      setForm((f) => ({ ...f, pass: '' }));
      toast('已保存', 'ok');
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function test() {
    setBusy('test');
    try {
      const r = await endpoints.testNotify();
      toast(r.ok ? `测试信已发出（${r.messageId ?? ''}）` : `没发出去：${r.error}`, r.ok ? 'ok' : 'err');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  /** 只看不收：连 IMAP 数一下有什么、哪些会被白名单挡掉 */
  async function peekMail() {
    setBusy('peek');
    try {
      const r = await endpoints.checkMail(true);
      const rep = r.report;
      if (rep.error) {
        toast(`连不上：${rep.error}`, 'err');
      } else {
        toast(`未读 ${rep.fetched} 封，会收 ${rep.captured.length}，挡掉 ${rep.skipped.length}`, 'info');
        setMailReport(rep);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function check() {
    setBusy('check');
    try {
      const r = await endpoints.runNotify(true);
      setReport(r.report);
      toast(r.report.sent.length ? `这一轮会提醒 ${r.report.sent.length} 条` : '这一轮没有要提醒的', 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  if (isLoading) return <Spinner />;
  const okMail = data?.configured ?? false;

  return (
    <div className="content-wide">
      <Card
        title="邮件通道"
        desc="不看网页也能收到提醒：日程到点前 30 分钟、每天第一次发现逾期任务"
        actions={
          <Chip tone={okMail ? 'ok' : 'warn'} data-testid="notify-status">
            {okMail ? `已连通 → ${data?.to}` : `未配置${data?.missing?.length ? `（缺 ${data.missing.join('、')}）` : ''}`}
          </Chip>
        }
      >
        <div className="grid grid-2">
          <Field label="发件邮箱" hint="用它的 SMTP 服务发信">
            <input
              className="input"
              value={form.user}
              onChange={(e) => setForm({ ...form, user: e.target.value })}
              placeholder="you@example.com"
              data-testid="notify-user"
            />
          </Field>
          <Field label="授权码" hint="不是登录密码；留空表示沿用已保存的">
            <input
              className="input"
              type="password"
              value={form.pass}
              onChange={(e) => setForm({ ...form, pass: e.target.value })}
              placeholder={okMail ? '已保存，留空即可' : 'QQ 邮箱 → 设置 → 账号 → 开启 IMAP/SMTP 后生成'}
              data-testid="notify-pass"
            />
          </Field>
          <Field label="收件邮箱" hint="提醒发到这里；多个用逗号分隔">
            <input
              className="input"
              value={form.to}
              onChange={(e) => setForm({ ...form, to: e.target.value })}
              placeholder="you@example.com"
              data-testid="notify-to"
            />
          </Field>
          <Field label="发件显示名">
            <input className="input" value={form.fromName} onChange={(e) => setForm({ ...form, fromName: e.target.value })} />
          </Field>
          <Field label="投递白名单" hint="只收这些发件人；留空=只认自己的发件地址。支持 @domain">
            <input
              className="input"
              value={form.allowFrom}
              onChange={(e) => setForm({ ...form, allowFrom: e.target.value })}
              placeholder="boss@example.com, @example.org"
              data-testid="notify-allow"
            />
          </Field>
          <Field label="SMTP 主机">
            <input
              className="input"
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              placeholder="smtp.qq.com"
              data-testid="notify-host"
            />
          </Field>
          <Field label="端口 / 加密">
            <div className="row">
              <input
                className="input"
                style={{ width: 100 }}
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              />
              <label className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={form.secure} onChange={(e) => setForm({ ...form, secure: e.target.checked })} />
                用 TLS
              </label>
            </div>
          </Field>
        </div>

        <div className="row row-wrap" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy !== ''} data-testid="notify-save">
            {busy === 'save' ? '保存中…' : '保存'}
          </button>
          <button className="btn" onClick={() => void test()} disabled={busy !== '' || !okMail} data-testid="notify-test-btn">
            {busy === 'test' ? '发送中…' : '发一封测试信'}
          </button>
          <button className="btn" onClick={() => void peekMail()} disabled={busy !== '' || !okMail} data-testid="notify-peek">
            {busy === 'peek' ? '连接中…' : '看收件箱'}
          </button>
          <span className="small muted">配置存在 {data?.configPath}（不在知识库里，免得跟着云盘同步）</span>
        </div>
      </Card>

      {mailReport && (
        <Card title="邮件投递预演" desc={`未读 ${mailReport.fetched} 封 · 会收 ${mailReport.captured.length} · 挡掉 ${mailReport.skipped.length}`} data-testid="mail-report">
          {mailReport.captured.map((x, i) => (
            <div key={i} className="small">✓ {x.subject}</div>
          ))}
          {mailReport.skipped.slice(0, 5).map((x, i) => (
            <div key={`s${i}`} className="small muted">· {x.subject}（{x.skipped}）</div>
          ))}
          <div className="small muted" style={{ marginTop: 6 }}>只看不收。要真的收下，跑 <code>habitat inbox-mail --fetch</code>。</div>
        </Card>
      )}

      <Card
        title="这一轮会提醒什么"
        desc="只算不发，先看对不对；同一条日程只提醒一次"
        actions={
          <button className="btn btn-sm" onClick={() => void check()} disabled={busy !== ''} data-testid="notify-check">
            检查一次
          </button>
        }
      >
        {!report ? (
          <div className="small muted">点「检查一次」，看看现在有没有快到点的日程或逾期任务。</div>
        ) : report.sent.length === 0 ? (
          <div className="small muted">
            这一轮没有要提醒的。{report.skipped.length ? `（${report.skipped.join('；')}）` : ''}
          </div>
        ) : (
          report.sent.map((x, i) => (
            <div key={i} className="small">
              · {x.kind}：{x.title}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

export function HealthPage() {
  const { data, isLoading, refetch } = useSystem();
  const toast = useUi((s) => s.toast);
  const refresh = useRefresh();
  const [busy, setBusy] = useState('');
  const { data: links, refetch: refetchLinks } = useQuery({
    queryKey: ['unresolved-links'],
    queryFn: () => endpoints.unresolvedLinks(),
    staleTime: 20_000,
  });

  /** 补一条同名条目，那条 [[链接]] 就解析得上了。这是真解决，不是把分母改小。 */
  async function fixLink(target: string) {
    setBusy(target);
    try {
      await endpoints.capture({ title: target, body: '（占位：这条是被 `[[…]]` 引用出来的缺口，补内容或删掉引用都行）', target: 'notes' });
      toast(`已建「${target}」，链接现在能解析了`, 'ok');
      await refetchLinks();
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  if (isLoading) return <Spinner />;

  const checks = [
    {
      name: '链接解析率',
      ok: (data?.health.resolveRate ?? 0) >= 0.8,
      detail: `${data?.health.links ?? 0} 条链接，${data?.health.unresolvedLinks ?? 0} 条解析不到（${Math.round((data?.health.resolveRate ?? 0) * 100)}%）`,
    },
    {
      name: '索引完整',
      ok: (data?.health.indexDocs ?? 0) > 0,
      detail: `索引里有 ${data?.health.indexDocs ?? 0} 条对象；索引是派生的，随时可以重建`,
    },
    {
      name: '存储可写',
      ok: !!data?.storage.capabilities.conditionalWrite,
      detail: data?.storage.capabilities.conditionalWrite ? '支持条件写，并发冲突能被拦下' : '不支持条件写，会有覆盖风险',
    },
    {
      name: '空间存在',
      ok: !!data?.space.root,
      detail: data?.space.root ?? '',
    },
  ];

  async function reindex() {
    setBusy('reindex');
    try {
      await endpoints.reindex();
      toast('索引已重建', 'ok');
      refresh();
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="content-wide">
      <Card title="健康" desc="坏没坏要能一眼看出来，而不是等它悄悄错下去">
        {checks.map((c) => (
          <div key={c.name} className="check-row" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }} data-testid="health-check">
            <span className="check-mark">{c.ok ? '✓' : '✕'}</span>
            <strong style={{ width: 120 }}>{c.name}</strong>
            <span className="small muted" style={{ flex: 1 }}>{c.detail}</span>
            <Chip tone={c.ok ? 'ok' : 'danger'}>{c.ok ? '正常' : '要处理'}</Chip>
          </div>
        ))}
      </Card>

      <Card
        title="断链"
        desc={links?.items.length ? `${links.items.length} 个目标被引用但还不存在；补一条就通` : '没有断链'}
        data-testid="broken-links"
      >
        {!links?.items.length
          ? <div className="small muted">所有 [[…]] 都能解析到对象。</div>
          : links.items.map((it) => (
            <div key={it.target} className="row row-wrap" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span className="small mono" style={{ flex: 1, minWidth: 0 }}>[[{it.target}]]</span>
              <span className="small muted">{it.refs.length} 处引用</span>
              <button className="btn btn-sm" disabled={busy === it.target} onClick={() => void fixLink(it.target)} data-testid="fix-link">
                {busy === it.target ? '建中…' : '补一条'}
              </button>
            </div>
          ))}
      </Card>

      <Card title="恢复" desc="文件是事实源，所以恢复的手段都很朴素">
        <div className="grid grid-2">
          <div className="card">
            <strong>重建索引</strong>
            <div className="small muted">SQLite 是派生的：删掉重建不会丢任何内容，只会慢一次。</div>
            <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => void reindex()} disabled={busy === 'reindex'} data-testid="health-reindex">
              {busy === 'reindex' ? '重建中…' : '重建索引'}
            </button>
          </div>
          <div className="card">
            <strong>对账</strong>
            <div className="small muted">有人绕过接口改了文件？对账会把它标成未署名，事后可认领。</div>
            <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => { void endpoints.reconcile().then((r) => toast(`未署名 ${r.report.unsigned.length} 处`, r.report.unsigned.length ? 'err' : 'ok')); refresh(); }} data-testid="health-reconcile">
              对账一次
            </button>
          </div>
          <div className="card">
            <strong>保存前快照</strong>
            <div className="small muted">每次覆盖前，旧版本会留一份到 <code>.habitat/backup/</code>。</div>
          </div>
          <div className="card">
            <strong>撤销</strong>
            <div className="small muted">撤销是反向提交，不是删除历史；事件流只增不减。</div>
            <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => toast('在「AI · 变更」页，每条已提交的变更都有撤销按钮', 'info')}>
              去撤销
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
