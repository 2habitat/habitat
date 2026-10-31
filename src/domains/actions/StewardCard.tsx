/* ---------------- 管家：这份数据有没有在腐烂 ---------------- */
import { useState } from 'react';
import { Card, Chip } from '../../components/ui.tsx';
import { endpoints } from '../../services/api.ts';
import { useUi } from '../../app/ui.ts';
import { useBrief, useRefresh } from '../../services/use.ts';

/**
 * 为什么今天页要放这一块：
 * 「整理」如果只在你想起来的时候做，数据等于没人管。
 * 这里把「积压了多少」摆出来——归档是确定的，一条命令的事，不需要 AI。
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

  async function tidy(apply: boolean) {
    setBusy(apply ? 'apply' : 'dry');
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
      title="管家"
      desc="不需要你做决定的部分，系统自己代谢；需要判断的仍然问你"
      data-testid="steward"
      actions={
        <>
          <button className="btn btn-sm" onClick={() => setOpen((v) => !v)} data-testid="steward-toggle">
            {open ? '收起简报' : '看简报'}
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void tidy(true)}
            disabled={busy !== '' || d.counts.doneOld === 0}
            data-testid="steward-tidy"
          >
            {busy === 'apply' ? '整理中…' : d.counts.doneOld ? `归档 ${d.counts.doneOld} 条已完成` : '没有待归档'}
          </button>
        </>
      }
    >
      <div className="row row-wrap small">
        <Chip tone={d.counts.doneOld ? 'warn' : 'ok'}>{d.counts.doneOld} 条已完成待归档</Chip>
        <Chip tone={staleInbox ? 'warn' : 'ok'}>收件箱 {d.inbox.length} 条{staleInbox ? `（${staleInbox} 条超 14 天）` : ''}</Chip>
        <Chip tone={d.reading.length ? 'info' : 'ok'}>{d.reading.length} 章读一半{stuck ? `（${stuck} 章超 14 天没动）` : ''}</Chip>
        <Chip tone={d.counts.brokenLinks ? 'warn' : 'ok'}>{d.counts.brokenLinks} 条断链</Chip>
        <span className="spacer" />
        <span className="muted">
          {issues === 0 ? '现在没有积压' : `${issues} 处需要处理`} · 数据更新于 {d.at.slice(11, 16)}
        </span>
      </div>

      {d.refresh.length > 0 && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }} data-testid="steward-refresh">
          <div className="small" style={{ marginBottom: 6 }}>
            冷掉但还没结灰的 {d.refresh.length} 条 —— 不是提醒你重读，是可能已经被新东西推翻
          </div>
          {d.refresh.slice(0, 3).map((x) => (
            <div key={x.id} className="row row-wrap" style={{ padding: '4px 0' }}>
              <span className="small" style={{ flex: 1, minWidth: 0 }}>
                {x.title} <span className="muted">（{x.idleDays} 天没碰）{x.why}</span>
              </span>
              <button className="btn btn-sm" onClick={() => void openRenew(x.id, x.title)} disabled={busy !== ''}>
                {busy === `renew:${x.id}` ? '载入…' : '看证据'}
              </button>
              <button className="btn btn-sm" onClick={() => void stillHolds(x.id)} disabled={busy !== ''}>
                仍然成立
              </button>
            </div>
          ))}
        </div>
      )}

      {open && (
        <pre
          className="small"
          style={{
            marginTop: 10,
            padding: 12,
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius)',
            whiteSpace: 'pre-wrap',
            maxHeight: 420,
            overflow: 'auto',
          }}
          data-testid="steward-brief"
        >
          {renewText || data?.brief}
        </pre>
      )}
    </Card>
  );
}
