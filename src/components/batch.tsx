/**
 * 批量操作：多选若干个对象，一次提交成一个 ChangeSet。
 *
 * 为什么放在这里而不是各页面自己拼：
 * 「批量」最容易变成 N 次单条写入——那样要么半途失败留一半，要么刷出 N 条变更记录。
 * 这里统一走 propose(多 ops) → commit，一次事务、一条事件流、可整批撤销。
 */
import { useState } from 'react';
import { endpoints } from '../services/api.ts';
import { useUi } from '../app/ui.ts';
import { useRefresh } from '../services/use.ts';

export function useBatch() {
  const [ids, setIds] = useState<string[]>([]);
  const has = (id: string) => ids.includes(id);
  const toggle = (id: string) => setIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const clear = () => setIds([]);
  return { ids, has, toggle, clear, all: (list: string[]) => setIds(list) };
}

export function BatchBar({ ids, onDone, label = '对象' }: { ids: string[]; onDone: () => void; label?: string }) {
  const toast = useUi((s) => s.toast);
  const refresh = useRefresh();
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);

  if (ids.length === 0) return null;

  /** 打标签是「追加」不是「覆盖」——批量覆盖会把别人原有的标签抹掉 */
  async function tagOps(t: string) {
    const { objects } = await endpoints.objects();
    const byId = new Map(objects.map((o) => [String((o as { id: string }).id), o as { tags?: string[] }]));
    return ids.map((id) => {
      const cur = byId.get(id)?.tags ?? [];
      const next = cur.includes(t) ? cur : [...cur, t];
      return { t: 'update' as const, id, patch: { tags: next } };
    });
  }

  async function applyTag() {
    setBusy(true);
    try {
      const ops = await tagOps(tag.trim());
      const { changeset } = await endpoints.propose(ops, `打标签「${tag.trim()}」（${ids.length} 个${label}）`);
      const r = await endpoints.commit(changeset.id);
      if (!r.ok) toast('有对象被别人改过，整批没有落盘。刷新后重试。', 'err');
      else toast(`已给 ${ids.length} 个${label}加上「${tag.trim()}」`, 'ok');
      refresh();
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  async function apply(patch: Record<string, unknown>, reason: string) {
    setBusy(true);
    try {
      // 一次提案带上全部 ops：要么全成，要么全不成
      const ops = ids.map((id) => ({ t: 'update', id, patch }));
      const { changeset } = await endpoints.propose(ops, `${reason}（${ids.length} 个${label}）`);
      const r = await endpoints.commit(changeset.id);
      if (!r.ok) {
        toast('有对象被别人改过，整批没有落盘。刷新后重试。', 'err');
      } else {
        toast(`已${reason} ${ids.length} 个${label}，可在变更页整批撤销`, 'ok');
      }
      refresh();
      onDone();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="batch-bar" role="region" aria-label="批量操作" data-testid="batch-bar">
      <span className="small">已选 <strong>{ids.length}</strong> 个{label}</span>
      <span className="spacer" />
      <input
        className="input"
        style={{ width: 132 }}
        placeholder="加标签…"
        value={tag}
        data-testid="batch-tag-input"
        onChange={(e) => setTag(e.target.value)}
      />
      <button
        className="btn btn-sm"
        disabled={busy || !tag.trim()}
        data-testid="batch-tag"
        onClick={() => void applyTag()}
      >打标签</button>
      <button className="btn btn-sm" disabled={busy} data-testid="batch-evergreen" onClick={() => void apply({ status: 'evergreen' }, '标记定稿')}>标记定稿</button>
      <button className="btn btn-sm" disabled={busy} data-testid="batch-archive" onClick={() => void apply({ archivedAt: new Date().toISOString() }, '归档')}>归档</button>
      <button className="btn btn-sm btn-ghost" onClick={onDone} data-testid="batch-clear">取消</button>
    </div>
  );
}
