/* ---------------- 管家：这份数据有没有在腐烂 ---------------- */
import { useState } from 'react';
import { Card, Chip } from '../../components/ui.tsx';
import { Icon } from '../../components/icons.tsx';
import { endpoints } from '../../services/api.ts';
import { useUi } from '../../app/ui.ts';
import { useBrief, useRefresh } from '../../services/use.ts';

/**
 * 为什么今天页要放这一块：
 * 「整理」如果只在你想起来的时候做，数据等于没人管。
 * 这里把「积压了多少」摆出来——归档是确定的，一条命令的事，不需要 AI。
 *
 * 版式上它是一个「状态仪表」：一个大数字说明有几处要处理，下面是四项明细。
 * 不是把四个 chip 摊在标题旁边——那样没有主次，读的人不知道先看哪。
 */
export function StewardCard() {
  const { data, refetch } = useBrief();
  const toast = useUi((s) => s.toast);
  const refresh = useRefresh();
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState(false);
  const [renewText, setRenewText] = useState('');

  const d = data?.data;
  if (!d) return null;

  const staleInbox = d.inbox.filter((x) => x.days >= 14).length;
  const stuck = d.reading.filter((r) => r.staleDays >= 14).length;
  const issues =
    (d.counts.doneOld > 0 ? 1 : 0) + (staleInbox > 0 ? 1 : 0) + (d.counts.brokenLinks > 0 ? 1 : 0) + (stuck > 0 ? 1 : 0);

  /** 拿证据包：它主张什么 + 库里哪几条可能撞上（判定仍然是人的事） */
  async function openRenew(id: string, title: string) {
    setBusy(`renew:${id}`);
    try {
      const r = await endpoints.renew(id);
      setRenewText(r.text);
      setOpen(true);
      toast(`「${title}」的证据包已载入`, 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function stillHolds(id: string) {
    setBusy(`ok:${id}`);
    try {
      const r = await endpoints.reviewNote(id, true);
      toast(`确认仍然成立，${r.nextIn} 天后再看`, 'ok');
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  /** 当日对账说「可能已完成」时，确认动作仍在这里发生——服务端不替人勾任务 */
  async function confirmDone(id: string, text: string) {
    setBusy(`done:${id}`);
    try {
      await endpoints.dayConfirm(id);
      toast(`已勾掉：${text.slice(0, 14)}`, 'ok');
      await refetch();
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function tidy(apply: boolean) {    setBusy(apply ? 'apply' : 'dry');
    try {
      const r = await endpoints.tidy(apply);
      if (apply) {
        toast(r.report.archived ? `已归档 ${r.report.archived} 条（可在变更页撤销）` : '没有可归档的', 'ok');
        await refetch();
        refresh();
      } else {
        setOpen(true);
        toast(r.report.candidates ? `有 ${r.report.candidates} 条可归档` : '没有可归档的', 'info');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  return (
    <Card
      className="panel steward"
      title="管家"
      data-testid="steward"
      actions={
        <button className="btn btn-sm btn-quiet" onClick={() => setOpen((v) => !v)} data-testid="steward-toggle">
          {open ? '收起' : '简报'}
        </button>
      }
    >
      <div className="steward-head">
        <b className="steward-num" data-tone={issues ? 'warn' : 'ok'}>{issues}</b>
        <span className="steward-unit">
          {issues ? '处需要处理' : '没有积压'}
          <em>数据更新于 {d.at.slice(11, 16)}</em>
        </span>
      </div>

      <dl className="steward-list">
        <div>
          <dt>已完成待归档</dt>
          <dd data-zero={d.counts.doneOld === 0 ? '1' : '0'}>{d.counts.doneOld}</dd>
        </div>
        <div>
          <dt>收件箱</dt>
          <dd data-zero={d.inbox.length === 0 ? '1' : '0'}>
            {d.inbox.length}
            {staleInbox > 0 && <span className="steward-warn"> · {staleInbox} 条超 14 天</span>}
          </dd>
        </div>
        <div>
          <dt>读一半</dt>
          <dd data-zero={d.reading.length === 0 ? '1' : '0'}>
            {d.reading.length}
            {stuck > 0 && <span className="steward-warn"> · {stuck} 章停滞</span>}
          </dd>
        </div>
        <div>
          <dt>断链</dt>
          <dd data-zero={d.counts.brokenLinks === 0 ? '1' : '0'}>{d.counts.brokenLinks}</dd>
        </div>
      </dl>

      {d.counts.doneOld > 0 ? (
        <button
          className="btn btn-sm btn-block"
          onClick={() => void tidy(true)}
          disabled={busy !== ''}
          data-testid="steward-tidy"
        >
          {busy === 'apply' ? '整理中…' : `归档 ${d.counts.doneOld} 条已完成`}
        </button>
      ) : (
        <p className="steward-idle" data-testid="steward-tidy">没有待归档的条目</p>
      )}

      {d.day?.counts.covered === 0 && d.day.counts.unplanned > 0 && (
        <p className="steward-idle" data-testid="steward-drift">
          今天没有按计划走：{d.day.counts.idle} 条待办没碰，{d.day.counts.unplanned} 个计划外投入
        </p>
      )}

      {d.day?.counts.covered > 0 && (
        <div className="steward-refresh" data-testid="steward-covered">
          <div className="steward-refresh-head">
            <Icon name="check" size={12} />
            今天可能已完成 {d.day.counts.covered} 条
          </div>
          {d.day.planned
            .filter((x) => x.status === 'covered')
            .slice(0, 3)
            .map((p) => (
              <div key={p.id} className="steward-refresh-item">
                <div className="small">
                  {p.text}
                  <span className="muted"> · {p.evidence[0]?.title ?? '今天动过相关资料'}</span>
                </div>
                <button
                  className="btn btn-sm btn-quiet"
                  onClick={() => void confirmDone(p.id, p.text)}
                  disabled={busy !== ''}
                  data-testid="steward-confirm"
                >
                  {busy === `done:${p.id}` ? '提交…' : '勾掉'}
                </button>
              </div>
            ))}
        </div>
      )}

      {d.refresh.length > 0 && (
        <div className="steward-refresh" data-testid="steward-refresh">
          <div className="steward-refresh-head">
            <Icon name="clock" size={12} />
            冷掉但没结灰的 {d.refresh.length} 条
          </div>
          {d.refresh.slice(0, 2).map((x) => (
            <div key={x.id} className="steward-refresh-item">
              <div className="small">
                {x.title}
                <span className="muted"> · {x.idleDays} 天没碰</span>
              </div>
              <div className="row" style={{ gap: 4, marginTop: 4 }}>
                <button className="btn btn-sm btn-quiet" onClick={() => void openRenew(x.id, x.title)} disabled={busy !== ''}>
                  {busy === `renew:${x.id}` ? '载入…' : '看证据'}
                </button>
                <button className="btn btn-sm btn-quiet" onClick={() => void stillHolds(x.id)} disabled={busy !== ''}>
                  仍然成立
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <pre className="steward-brief" data-testid="steward-brief">
          {renewText || data?.brief}
        </pre>
      )}
    </Card>
  );
}
