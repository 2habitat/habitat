/** 作品内的 JSON 数据：表格 / 表单 / 源码三种视图，保存走平台 API。 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endpoints } from '../../services/api.ts';
import { useWork } from '../../services/use.ts';
import { useUi } from '../../app/ui.ts';
import { navigate } from '../../app/router.ts';
import { BuildButton } from '../../components/BuildButton.tsx';
import { Icon } from '../../components/icons.tsx';
import { Empty, Spinner } from '../../components/ui.tsx';

type Row = Record<string, unknown>;
type Shape = { root: unknown; key: string | null; rows: Row[] };

const PREFERRED = ['id', 'title', 'type', 'priority', 'star', 'topic', 'element', 'target', 'clusterName'];
const LONG = new Set(['question', 'answer', 'followup', 'anchor', 'redline', 'summary', 'desc', 'body']);

function shapeOf(json: unknown): Shape | null {
  if (Array.isArray(json)) return { root: json, key: null, rows: json as Row[] };
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const key = 'items' in obj && Array.isArray(obj.items)
      ? 'items'
      : Object.keys(obj).find((k) => Array.isArray(obj[k]));
    if (key) return { root: obj, key, rows: obj[key] as Row[] };
  }
  return null;
}

function preview(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') return '{…}';
  return String(v);
}

export function DataPage({ work: workId, path }: { work?: string; path?: string }) {
  const toast = useUi((s) => s.toast);
  const { data: work } = useWork(workId ?? '');
  const { data: filesData, isLoading: loadingFiles } = useQuery({
    queryKey: ['work-data', workId],
    queryFn: () => endpoints.workData(workId!),
    enabled: !!workId,
  });
  const files = filesData?.files ?? [];
  const currentPath = path || files[0]?.path || '';
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['work-data-file', workId, currentPath],
    queryFn: () => endpoints.workDataFile(workId!, currentPath),
    enabled: !!workId && !!currentPath,
  });

  const [rows, setRows] = useState<Row[]>([]);
  const [raw, setRaw] = useState('');
  const [mode, setMode] = useState<'table' | 'raw'>('table');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);

  const shape = useMemo(() => (data ? shapeOf(data.json) : null), [data]);

  useEffect(() => {
    if (!data) return;
    setDirty(false);
    setEditing(null);
    setPage(0);
    setQ('');
    if (shape) {
      setRows(shape.rows.map((r) => ({ ...r })));
      setRaw(JSON.stringify(shape.root, null, 2));
      setMode('table');
    } else {
      setRows([]);
      setRaw(JSON.stringify(data.json, null, 2));
      setMode('raw');
    }
  }, [data, shape]);

  const columns = useMemo(() => {
    const keys = new Set<string>();
    rows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
    const preferred = PREFERRED.filter((k) => keys.has(k));
    const rest = [...keys].filter((k) => !preferred.includes(k));
    return [...preferred, ...rest].slice(0, 8);
  }, [rows]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(s));
  }, [rows, q]);

  const pageSize = 40;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = filtered.slice(page * pageSize, (page + 1) * pageSize);

  function payload(): unknown {
    if (mode === 'raw') return JSON.parse(raw);
    if (!shape) return JSON.parse(raw);
    if (shape.key) return { ...(shape.root as Record<string, unknown>), [shape.key]: rows };
    return rows;
  }

  async function save() {
    if (!workId || !currentPath) return;
    setSaving(true);
    try {
      const json = payload();
      await endpoints.saveWorkData(workId, currentPath, json);
      toast('已保存到 data/；需要更新 HTML 就点「构建」', 'ok');
      setDirty(false);
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setSaving(false);
    }
  }

  function toTable() {
    if (mode === 'raw') {
      try {
        const parsed = JSON.parse(raw);
        const next = shapeOf(parsed);
        if (!next) { toast('顶层需要是数组，或含数组字段的对象', 'err'); return; }
        setRows(next.rows.map((r) => ({ ...r })));
      } catch {
        toast('JSON 解析失败，先修好再切表格', 'err');
        return;
      }
    }
    setMode('table');
  }

  function formatRaw() {
    try {
      if (mode === 'raw') setRaw(JSON.stringify(JSON.parse(raw), null, 2));
      else { setRaw(JSON.stringify(payload(), null, 2)); setMode('raw'); }
      setDirty(true);
    } catch {
      toast('JSON 解析失败', 'err');
    }
  }

  function setField(index: number, key: string, value: unknown) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
    setDirty(true);
  }

  function addRow() {
    const next = [...rows, { id: '', title: '新条目' }];
    setRows(next);
    setEditing(next.length - 1);
    setDirty(true);
  }

  function removeRow(index: number) {
    if (!confirm('删除这一行？保存后才会写入文件。')) return;
    setRows((prev) => prev.filter((_, i) => i !== index));
    setEditing(null);
    setDirty(true);
  }

  if (!workId) {
    return (
      <div className="content-wide">
        <Empty title="从书架选一部作品" desc="数据文件在作品的 data/ 目录下，先打开一部作品。" action={<button className="btn" onClick={() => navigate('shelf')}>打开书架</button>} />
      </div>
    );
  }

  return (
    <div className="content-wide">
      <div className="data-head">
        <div>
          <div className="eyebrow">知识 · 数据</div>
          <h1 className="data-title">数据 <span className="muted">· {work?.work.title ?? workId}</span></h1>
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            编辑作品 <code>data/</code> 下的 JSON；保存后点「构建」，平台按 <code>work.yaml</code> 的声明重建产物。
          </p>
        </div>
        <div className="row row-wrap">
          {files.length > 1 && (
            <select className="input" value={currentPath} onChange={(e) => navigate('data', { work: workId, path: e.target.value })} aria-label="选择数据文件">
              {files.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
            </select>
          )}
          <BuildButton workId={workId} compact />
        </div>
      </div>

      {loadingFiles ? <Spinner /> : files.length === 0 ? (
        <Empty title="还没有数据文件" desc="在作品目录下建 data/*.json，保存后这里会出现。" />
      ) : isLoading ? <Spinner /> : error ? (
        <Empty title="读不到这个文件" desc={error instanceof Error ? error.message : String(error)} action={<button className="btn" onClick={() => void refetch()}>重试</button>} />
      ) : (
        <>
          <div className="data-toolbar">
            <div className="view-switch" role="group" aria-label="数据视图">
              <button aria-pressed={mode === 'table'} onClick={toTable} disabled={!shape}>表格</button>
              <button aria-pressed={mode === 'raw'} onClick={() => {
                if (mode === 'table') setRaw(JSON.stringify(payload(), null, 2));
                setMode('raw');
              }}>源码</button>
            </div>
            <input className="input" placeholder="过滤当前数据…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} style={{ maxWidth: 280 }} />
            <span className="small muted">{filtered.length} / {rows.length} 行{shape?.key ? ` · ${shape.key}` : ''}</span>
            <span style={{ flex: 1 }} />
            {mode === 'table' && <button className="btn btn-sm" onClick={addRow}><Icon name="plus" size={12} />新增行</button>}
            <button className="btn btn-sm" onClick={formatRaw}>格式化</button>
            <button className="btn btn-sm btn-primary" onClick={() => void save()} disabled={saving || (!dirty && mode === 'table')} data-testid="data-save">
              {saving ? '保存中…' : dirty ? '保存' : '已保存'}
            </button>
          </div>

          {mode === 'raw' ? (
            <div className="data-raw-wrap">
              <textarea className="data-raw" value={raw} onChange={(e) => { setRaw(e.target.value); setDirty(true); }} spellCheck={false} />
              <p className="small muted">源码模式保存前会先 JSON.parse；解析失败不会写盘。</p>
            </div>
          ) : (
            <div className="data-split">
              <div className="data-table-wrap">
                <table className="table data-table">
                  <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>
                    {current.map((r, i) => {
                      const index = page * pageSize + i;
                      return (
                        <tr key={String(r.id ?? index)} onClick={() => setEditing(index)} data-selected={editing === index ? '1' : undefined}>
                          {columns.map((c) => <td key={c} className={c === 'id' ? 'mono' : undefined}>{preview(r[c])}</td>)}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filtered.length === 0 && <div className="empty small">没有匹配的行。</div>}
                <div className="data-pager">
                  <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>上一页</button>
                  <span className="small muted">{page + 1} / {pageCount}</span>
                  <button className="btn btn-sm" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>下一页</button>
                </div>
              </div>

              <aside className="data-editor">
                {editing === null ? (
                  <div className="small muted" style={{ padding: 12 }}>点一行编辑；数组/对象字段用 JSON 文本编辑。</div>
                ) : (
                  <>
                    <div className="data-editor-head">
                      <b>{String(rows[editing]?.id ?? `第 ${editing + 1} 行`)}</b>
                      <button className="link-btn" onClick={() => setEditing(null)}>收起</button>
                    </div>
                    <div className="data-fields">
                      {Object.keys(rows[editing] ?? {}).map((k) => {
                        const v = rows[editing][k];
                        const long = typeof v === 'string' && (v.length > 80 || LONG.has(k));
                        return (
                          <label className="data-field" key={k}>
                            <span>{k}</span>
                            {typeof v === 'boolean' ? (
                              <input type="checkbox" checked={v} onChange={(e) => setField(editing, k, e.target.checked)} />
                            ) : typeof v === 'number' ? (
                              <input className="input" type="number" value={v} onChange={(e) => setField(editing, k, Number(e.target.value))} />
                            ) : typeof v === 'object' && v !== null ? (
                              <textarea className="input data-json" defaultValue={JSON.stringify(v, null, 2)} onBlur={(e) => {
                                try { setField(editing, k, JSON.parse(e.target.value)); }
                                catch { toast(`${k} 不是合法 JSON`, 'err'); }
                              }} />
                            ) : long ? (
                              <textarea className="input data-text" value={String(v ?? '')} onChange={(e) => setField(editing, k, e.target.value)} />
                            ) : (
                              <input className="input" value={String(v ?? '')} onChange={(e) => setField(editing, k, e.target.value)} />
                            )}
                          </label>
                        );
                      })}
                    </div>
                    <div className="row" style={{ marginTop: 10 }}>
                      <button className="btn btn-sm" onClick={() => removeRow(editing)}>删除这一行</button>
                      <span style={{ flex: 1 }} />
                      <button className="btn btn-sm btn-primary" onClick={() => setEditing(null)}>完成</button>
                    </div>
                  </>
                )}
              </aside>
            </div>
          )}
        </>
      )}
    </div>
  );
}
