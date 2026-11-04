/** 系统域：数据在哪、谁能写、花了多少、坏没坏 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, PageHead, StatBand, Chip, Empty, Spinner, PageSkeleton, ErrorBox, Bar, Field, fmtBytes } from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
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

/** 存储适配器能力：字段名是给程序看的，界面要说人话 */
const CAP_LABEL: Record<string, string> = {
  conditionalWrite: '条件写（CAS）',
  versioning: '版本历史',
  watch: '文件监听',
  rangeRead: '分片读取（Range）',
};

export function StoragePage() {  const { data, isLoading, error, refetch } = useSystem();
  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const cap = data.storage.capabilities;

  return (
    <div className="content-wide">
      <PageHead
        eyebrow="系统 · 空间"
        title="空间与存储"
        lede="一个空间一个根目录。文件是事实源，索引是可丢弃的派生：删掉 state/*.db，重启会从 Markdown 重建。"
      />
      <StatBand
        items={[
          { num: data.stats.works, label: '作品' },
          { num: data.stats.parts, label: '章节' },
          // 载体数界面上不出现这个数，它只在存储核算里
          { num: data.stats.reps, label: '载体' },
          { num: fmtBytes(data.stats.assetBytes), label: '附件体积' },
        ]}
      />

      <section className="section" style={{ marginTop: 'var(--sp-6)' }}>
        <h2 className="rubric">
          <span className="rubric-no">01</span>
          空间
          <span className="rubric-rule" />
          <span className="rubric-meta">一个进程一个空间</span>
        </h2>
        <dl className="kv">
          <div><dt>名称</dt><dd>{data.space.name}</dd></div>
          <div><dt>时区</dt><dd>{data.space.tz}</dd></div>
          <div className="kv-wide"><dt>根目录</dt><dd className="mono">{data.space.root}</dd></div>
          <div><dt>布局版本</dt><dd>layout 2</dd></div>
        </dl>
      </section>

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">02</span>
          存储适配
          <span className="rubric-rule" />
          <span className="rubric-meta mono">{data.storage.adapter}</span>
        </h2>
        <div className="caps" style={{ marginTop: 12 }}>
          {Object.entries(cap).map(([k, v]) => (
            <div key={k} className="cap" style={{ gridTemplateColumns: '44px minmax(0, 1fr) auto' }}>
              <span className="cap-flag" data-write={v ? '0' : '1'}>{v ? '支持' : '降级'}</span>
              <span>{CAP_LABEL[k] ?? k}</span>
              <span className="cap-event mono">{String(v)}</span>
            </div>
          ))}
        </div>
        <div className="notice" style={{ marginTop: 12 }}>
          <strong>WPS 同步盘的能力降级</strong>
          <span>{data.storage.wpsNotice}</span>
        </div>
      </section>

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">03</span>
          文件清单
          <span className="rubric-rule" />
          <span className="rubric-meta">{data.storage.assets.length} 个 · {fmtBytes(data.storage.assetBytes)}</span>
        </h2>
        {data.storage.assets.length === 0
          ? <Empty title="还没有附件" desc="上传的图片和原件会落在 assets/ 下，这里只是清单。" />
          : (
            <table className="table">
              <thead><tr><th>路径</th><th style={{ width: 90 }}>类型</th><th style={{ width: 90 }} className="mono">大小</th></tr></thead>
              <tbody>
                {data.storage.assets.map((a) => (
                  <tr key={a.path}>
                    <td className="mono ellipsis">{a.path}</td>
                    <td><span className="hit-type">{a.kind}</span></td>
                    <td className="mono muted">{fmtBytes(a.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>
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
      <PageHead
        eyebrow="系统 · 接入"
        title="Agent 接入"
        lede="能力表、事件流、未署名改动，三块缺一不可。外部 Agent 和人在界面上走的是同一套读写路径，不留暗门。"
        actions={
          <>
            <button className="btn btn-sm btn-quiet" onClick={() => openSheet('journal')} data-testid="agent-log">补一条事件</button>
            <button className="btn btn-sm btn-primary" onClick={() => void runReconcile()} disabled={busy} data-testid="agent-reconcile">
              {busy ? '对账中…' : '对账'}
            </button>
          </>
        }
      />

      <section className="section" style={{ marginTop: 'var(--sp-6)' }}>
        <h2 className="rubric">
          <span className="rubric-no">01</span>
          能力表
          <span className="rubric-rule" />
          <span className="rubric-meta">{mf?.manifest.capabilities.length ?? 0} 项</span>
        </h2>
        <p className="section-note">
          跑一句 <code>habitat agent manifest</code> 就能拿到这张表：每项写清了「人怎么点 / AI 怎么调 / 会不会写 / 留什么事件」。
        </p>
        <div className="caps">
          {(mf?.manifest.capabilities ?? []).map((c) => (
            <div key={c.id} className="cap" style={{ gridTemplateColumns: '44px 120px minmax(0,1fr) auto' }}>
              <span className="cap-flag" data-write={c.mutating ? '1' : '0'}>{c.mutating ? '会写' : '只读'}</span>
              <span className="cap-name">{c.name}</span>
              <span className="cap-agent mono ellipsis" title={c.command}>{c.command}</span>
              <span className="cap-event mono">{c.event}</span>
            </div>
          ))}
        </div>
      </section>

      {report && (
        <section className="section">
          <h2 className="rubric">
            <span className="rubric-no">02</span>
            对账结果
            <span className="rubric-rule" />
            <span className="rubric-meta">{report.at.slice(5, 16).replace('T', ' ')} · 查了 {report.checked} 个文件</span>
          </h2>
          {report.baseline ? (
            <p className="section-note">
              这是第一次对账，只建了基线（{report.checked} 个文件的 sha256 记下来了）。从下一次开始，谁绕过接口改了文件，这里能指出来。
            </p>
          ) : (
            <div className="ledger" style={{ margin: '12px 0 16px' }}>
              <div className="ledger-cell"><b className="ledger-num">{report.signed.length}</b><span className="ledger-label">署名改动</span></div>
              <div className="ledger-cell" data-zero={report.unsigned.length ? '0' : '1'}>
                <b className="ledger-num" data-tone={report.unsigned.length ? 'danger' : undefined}>{report.unsigned.length}</b>
                <span className="ledger-label">未署名</span>
              </div>
              <div className="ledger-cell"><b className="ledger-num">{report.added.length}</b><span className="ledger-label">新增</span></div>
              <div className="ledger-cell"><b className="ledger-num">{report.removed.length}</b><span className="ledger-label">删除</span></div>
            </div>
          )}
          {report.unsigned.map((u) => (
            <div key={u.path} className="part">
              <span className="chg-check" data-ok="0"><Icon name="close" size={12} /></span>
              <span className="part-title mono">{u.path}</span>
            </div>
          ))}
        </section>
      )}

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">03</span>
          事件流
          <span className="rubric-rule" />
          <select className="select" style={{ width: 148, height: 26, fontSize: 'var(--t-xs)' }} value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="journal-filter">
            <option value="">全部主体</option>
            <option value="human">只看我</option>
            <option value="agent:">只看 AI</option>
            <option value="system">只看系统</option>
            <option value="external:unknown">只看未署名</option>
          </select>
        </h2>
        <p className="section-note">事件只追加：对象可以被覆盖，事件不会。</p>
        {isLoading ? <PageSkeleton rows={4} title={false} /> : events.length === 0
          ? <Empty title="还没有事件" desc="任何写操作都会留一条。" />
          : <div className="stagger">{events.slice(0, 60).map((e) => <EventRow key={e.id} e={e} onClaim={() => void claim(e.id)} />)}</div>}
      </section>
    </div>
  );
}

function EventRow({ e, onClaim }: { e: JournalEventView; onClaim: () => void }) {
  return (
    <div className="ev" data-testid="journal-event">
      <span className="ev-time mono">{e.at.slice(5, 16).replace('T', ' ')}</span>
      <span className={`ev-dot ${actorClass(e.actor)}`} />
      <div className="ev-body">
        <div className="ev-line">
          <span className="ev-actor">{actorLabel(e.actor)}</span>
          <span className="ev-op">{OP_LABEL[e.op] ?? e.op}</span>
          {e.phase && <span className="ev-phase mono">{e.phase}</span>}
        </div>
        <div className="ev-summary ellipsis">{e.summary}</div>
        <div className="ev-target mono ellipsis">{e.target}</div>
        {e.actor === 'external:unknown' && !e.claimedBy && (
          <button className="btn btn-sm btn-quiet" onClick={onClaim} data-testid="claim-btn">认领这条改动</button>
        )}
        {e.claimedBy && <div className="ev-claimed">已被 {e.claimedBy} 认领（原记录保留）</div>}
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
      <PageHead
        eyebrow="系统 · 预算"
        title="权限与预算"
        lede="AI 提案过量，人就会关掉它。默认每天 ≤3 条，只约束 agent，不限制你自己。"
      />

      <section className="section" style={{ marginTop: 'var(--sp-6)' }}>
        <h2 className="rubric">
          <span className="rubric-no">01</span>
          今日配额
          <span className="rubric-rule" />
          <span className="rubric-meta">{data?.budget.usedToday ?? 0} / {data?.budget.dailyProposalLimit ?? 3}</span>
        </h2>
        <div className="quota">
          <div className="quota-num">
            {data?.budget.usedToday ?? 0}
            <small>/{data?.budget.dailyProposalLimit ?? 3}</small>
          </div>
          {/* 额度是个小数字，用格子比进度条诚实：剩几条一眼数得出来 */}
          <div className="quota-ticks" aria-hidden="true">
            {Array.from({ length: Math.max(1, data?.budget.dailyProposalLimit ?? 3) }).map((_, i) => (
              <i key={i} data-on={i < (data?.budget.usedToday ?? 0) ? '1' : '0'} />
            ))}
          </div>
          <p className="quota-note">
            超了不是报错，是不再推新的提案——已经有的一定让你看到。
          </p>
        </div>
      </section>

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">02</span>
          权限四档
          <span className="rubric-rule" />
        </h2>
        <div className="tiers">
          {perm.map((p, i) => (
            <div key={p.name} className="tier" data-tone={p.tone}>
              <span className="tier-no">{String(i + 1).padStart(2, '0')} · {p.need}</span>
              <strong>{p.name}</strong>
              <span className="tier-desc">{p.eg}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">03</span>
          会写东西的能力
          <span className="rubric-rule" />
          <span className="rubric-meta">只有这些入口会落盘</span>
        </h2>
        <div className="caps">
          {(mf?.manifest.capabilities ?? []).filter((c) => c.mutating).map((c) => (
            <div key={c.id} className="cap" style={{ gridTemplateColumns: '44px 120px minmax(0,1fr) auto' }}>
              <span className="cap-flag" data-write="1">会写</span>
              <span className="cap-name">{c.name}</span>
              <span className="cap-agent ellipsis">{c.writes}</span>
              <span className="cap-event mono">{c.event}</span>
            </div>
          ))}
        </div>
      </section>
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
      <PageHead
        eyebrow="系统 · 通知"
        title="通知渠道"
        lede="不看网页也能收到提醒：日程到点前 30 分钟、每天第一次发现逾期任务。密钥不回显，留空就沿用已保存的。"
        actions={
          <span className="mail-state" data-ok={okMail ? '1' : '0'} data-testid="notify-status">
            <span className="mail-dot" aria-hidden="true" />
            {okMail ? `已连通 → ${data?.to}` : `未配置${data?.missing?.length ? `（缺 ${data.missing.join('、')}）` : ''}`}
          </span>
        }
      />

      <section className="section" style={{ marginTop: 'var(--sp-6)' }}>
        <h2 className="rubric">
          <span className="rubric-no">01</span>
          SMTP 发信
          <span className="rubric-rule" />
          <span className="rubric-meta">QQ / 163 / 企业邮都能用</span>
        </h2>
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
      </section>

      {mailReport && (
        <section className="section" data-testid="mail-report">
          <h2 className="rubric">
            <span className="rubric-no">02</span>
            邮件投递预演
            <span className="rubric-rule" />
            <span className="rubric-meta">未读 {mailReport.fetched} · 会收 {mailReport.captured.length} · 挡掉 {mailReport.skipped.length}</span>
          </h2>
          {mailReport.captured.map((x, i) => (
            <div key={i} className="part">
              <span className="chg-check" data-ok="1"><Icon name="check" size={12} /></span>
              <span className="part-title">{x.subject}</span>
            </div>
          ))}
          {mailReport.skipped.slice(0, 5).map((x, i) => (
            <div key={`s${i}`} className="part">
              <span className="chg-check" data-ok="0"><Icon name="close" size={12} /></span>
              <span className="part-title muted">{x.subject}（{x.skipped}）</span>
            </div>
          ))}
          <p className="section-note">只看不收。要真的收下，跑 <code>habitat inbox-mail --fetch</code>。</p>
        </section>
      )}

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">03</span>
          这一轮会提醒什么
          <span className="rubric-rule" />
          <button className="btn btn-sm btn-quiet" onClick={() => void check()} disabled={busy !== ''} data-testid="notify-check">
            检查一次
          </button>
        </h2>
        <p className="section-note">只算不发，先看对不对；同一条日程只提醒一次。</p>
        {!report ? (
          <p className="section-note">点「检查一次」，看看现在有没有快到点的日程或逾期任务。</p>
        ) : report.sent.length === 0 ? (
          <p className="section-note">
            这一轮没有要提醒的。{report.skipped.length ? `（${report.skipped.join('；')}）` : ''}
          </p>
        ) : (
          report.sent.map((x, i) => (
            <div key={i} className="part">
              <span className="hit-type">{x.kind}</span>
              <span className="part-title">{x.title}</span>
            </div>
          ))
        )}
      </section>
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
      <PageHead
        eyebrow="系统 · 健康"
        title="健康与恢复"
        lede="坏没坏要能一眼看出来，而不是等它悄悄错下去。四项检查都是算的，不是猜的。"
        actions={
          <button className="btn btn-sm btn-primary" onClick={() => void reindex()} disabled={busy === 'reindex'}>
            {busy === 'reindex' ? '重建中…' : '重建索引'}
          </button>
        }
      />

      <div className="vitals">
        {checks.map((c) => (
          <div key={c.name} className="vital" data-ok={c.ok ? '1' : '0'} data-testid="health-check">
            <div className="vital-head">
              <span className="vital-dot" aria-hidden="true" />
              <strong>{c.name}</strong>
              <span className="vital-state">{c.ok ? '正常' : '要处理'}</span>
            </div>
            <p className="vital-detail">{c.detail}</p>
          </div>
        ))}
      </div>

      <section className="section">
        <h2 className="rubric">
          <span className="rubric-no">◍</span>
          断链
          <span className="rubric-rule" />
          <span className="rubric-meta">{links?.items.length ? `${links.items.length} 个目标缺失` : '没有断链'}</span>
        </h2>
        <div data-testid="broken-links">
          {!links?.items.length
            ? <p className="section-note">所有 [[…]] 都能解析到对象。这是索引健康的直接证据。</p>
            : links.items.map((it) => (
              <div key={it.target} className="part" style={{ padding: '9px 0' }}>
                <span className="mono" style={{ flex: 1, minWidth: 0 }}>[[{it.target}]]</span>
                <span className="small muted">{it.refs.length} 处引用</span>
                <button className="btn btn-sm btn-quiet" disabled={busy === it.target} onClick={() => void fixLink(it.target)} data-testid="fix-link">
                  {busy === it.target ? '建中…' : '补一条'}
                </button>
              </div>
            ))}
        </div>
      </section>

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
