/* ---------------- 文件 ---------------- */

/**
 * 文件浏览。
 *
 * 刻意不做成系统资源管理器：这里没有"删除"按钮。
 * 这套系统的铁律是不删除只归档——删一个 .md，指向它的链接就全断了，还没法追。
 * 所以这里的操作是：看、预览、上传、新建目录、改名、归档。
 * 改名也会先告诉你"会断几条链"，让你看见代价。
 */
import { useState } from 'react';
import { Card, Chip, Empty, Spinner } from '../../components/ui.tsx';
import { api, endpoints } from '../../services/api.ts';
import { useUi } from '../../app/ui.ts';
import { useQuery } from '@tanstack/react-query';

const iconOf = (kind: string) =>
  ({ dir: '▸', markdown: 'M', text: '≡', image: '▣', pdf: 'P', other: '·' })[kind] ?? '·';

function fmtSize(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function FilesPage() {
  const toast = useUi((s) => s.toast);
  const [path, setPath] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState('');
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [newDir, setNewDir] = useState('');

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['fs', path, showHidden],
    queryFn: () => endpoints.fsList(path, showHidden),
  });

  const { data: preview } = useQuery({
    queryKey: ['fs-file', selected],
    queryFn: () => endpoints.fsFile(selected),
    enabled: !!selected,
  });

  async function run(key: string, fn: () => Promise<unknown>, okMsg: string) {
    setBusy(key);
    try {
      await fn();
      toast(okMsg, 'ok');
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function upload(file: File) {
    setBusy('upload');
    try {
      await api.put(`/api/fs/upload?dir=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}`, file, file.type || 'application/octet-stream');
      toast(`已上传 ${file.name}`, 'ok');
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  async function doRename() {
    if (!renaming) return;
    const dir = renaming.path.includes('/') ? renaming.path.slice(0, renaming.path.lastIndexOf('/')) : '';
    const target = dir ? `${dir}/${renaming.value}` : renaming.value;
    setBusy('rename');
    try {
      // 先不带 force 试一次：已入库且被引用的文件会被拦下来，并告诉你会断几条链
      const r = await endpoints.fsMove(renaming.path, target, false);
      if (!r.ok) {
        const go = window.confirm(`${r.needConfirm}\n\n继续改名？`);
        if (!go) {
          setRenaming(null);
          return;
        }
        await endpoints.fsMove(renaming.path, target, true);
      }
      toast(r.brokenLinks ? `已改名，${r.brokenLinks} 条链接需要修复` : '已改名', r.brokenLinks ? 'info' : 'ok');
      setRenaming(null);
      setSelected('');
      await refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  if (isLoading) return <Spinner />;
  if (!data) return <Empty title="读不到目录" desc="检查空间根是否可访问" />;

  return (
    <div className="content-wide">
      <Card
        title="文件"
        desc="这里是你的数据目录。能看、能上传、能改名；删除改成了归档——文件不会消失，只是挪到 archive/fs/"
        actions={
          <>
            <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
              上传
              <input
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.currentTarget.value = '';
                  if (f) void upload(f);
                }}
              />
            </label>
            <button className="btn btn-sm" onClick={() => setNewDir(newDir === '' ? ' ' : '')}>
              新建文件夹
            </button>
            <button className="btn btn-sm" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? '隐藏系统目录' : '显示系统目录'}
            </button>
            <button className="btn btn-sm" onClick={() => void refetch()}>
              刷新
            </button>
          </>
        }
      >
        <div className="row row-wrap small" data-testid="fs-crumbs">
          {data.crumbs.map((c, i) => (
            <span key={c.path} className="row" style={{ gap: 4 }}>
              {i > 0 && <span className="muted">/</span>}
              <button className="btn btn-sm" onClick={() => { setPath(c.path); setSelected(''); }}>
                {c.name}
              </button>
            </span>
          ))}
          <span className="spacer" />
          <span className="muted">
            {data.totals.dirs} 个目录 · {data.totals.files} 个文件 · {fmtSize(data.totals.bytes)}
            {data.totals.unindexed ? ` · ${data.totals.unindexed} 个未入库` : ''}
            {data.hiddenSkipped ? ` · 隐藏了 ${data.hiddenSkipped} 个系统目录` : ''}
          </span>
        </div>

        {newDir !== '' && (
          <div className="row" style={{ marginTop: 8 }}>
            <input
              className="input"
              autoFocus
              placeholder="新文件夹名"
              value={newDir.trim()}
              onChange={(e) => setNewDir(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setNewDir('');
                if (e.key === 'Enter' && newDir.trim()) {
                  const rel = path ? `${path}/${newDir.trim()}` : newDir.trim();
                  void run('mkdir', () => endpoints.fsMkdir(rel), '已创建').then(() => setNewDir(''));
                }
              }}
              data-testid="fs-newdir"
            />
            <button
              className="btn btn-sm"
              disabled={!newDir.trim() || busy !== ''}
              onClick={() => {
                const rel = path ? `${path}/${newDir.trim()}` : newDir.trim();
                void run('mkdir', () => endpoints.fsMkdir(rel), '已创建').then(() => setNewDir(''));
              }}
            >
              创建
            </button>
            <button className="btn btn-sm" onClick={() => setNewDir('')}>
              取消
            </button>
          </div>
        )}

        {data.dirs.length === 0 && data.files.length === 0 ? (
          <Empty title="空目录" desc="可以上传文件，或新建子目录" />
        ) : (
          <div style={{ marginTop: 10, borderTop: '1px solid var(--border)' }}>
            {data.dirs.map((d) => (
              <div
                key={d.path}
                className="row"
                style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                onClick={() => { setPath(d.path); setSelected(''); }}
                data-testid="fs-dir"
              >
                <span style={{ width: 18, color: 'var(--muted)' }}>{iconOf('dir')}</span>
                <span className="ellipsis" style={{ flex: 1 }}>{d.name}</span>
                <span className="small muted">目录</span>
              </div>
            ))}

            {data.files.map((f) => (
              <div key={f.path}>
                <div
                  className="row"
                  style={{
                    padding: '6px 0',
                    borderBottom: '1px solid var(--border)',
                    background: selected === f.path ? 'var(--surface-2)' : undefined,
                  }}
                  data-testid="fs-file"
                >
                  <span style={{ width: 18, color: 'var(--muted)' }}>{iconOf(f.kind)}</span>
                  {renaming?.path === f.path ? (
                    <input
                      className="input"
                      autoFocus
                      value={renaming.value}
                      onChange={(e) => setRenaming({ path: f.path, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setRenaming(null);
                        if (e.key === 'Enter') void doRename();
                      }}
                      style={{ flex: 1 }}
                    />
                  ) : (
                    <button
                      className="btn btn-sm"
                      style={{ flex: 1, justifyContent: 'flex-start', textAlign: 'left' }}
                      onClick={() => setSelected(selected === f.path ? '' : f.path)}
                    >
                      <span className="ellipsis">{f.name}</span>
                    </button>
                  )}

                  {f.locked && <Chip tone="warn">原件</Chip>}
                  {f.indexed ? (
                    <Chip tone="info">{f.objectType}</Chip>
                  ) : (
                    <Chip>未入库</Chip>
                  )}
                  {!!f.inbound && <Chip tone="ok">{f.inbound} 引用</Chip>}

                  <span className="small muted" style={{ width: 64, textAlign: 'right' }}>{fmtSize(f.bytes)}</span>
                  <span className="small muted" style={{ width: 96, textAlign: 'right' }}>{f.mtime.slice(5, 16).replace('T', ' ')}</span>

                  <button
                    className="btn btn-sm"
                    onClick={() => setRenaming({ path: f.path, value: f.name })}
                    data-testid="fs-rename"
                  >
                    改名
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      if (!window.confirm(`归档「${f.name}」？\n\n文件不会被删除，会移到 archive/fs/ 下，之后还能找回来。`)) return;
                      void run(`arch:${f.path}`, () => endpoints.fsArchive([f.path]), '已归档');
                    }}
                    data-testid="fs-archive"
                  >
                    归档
                  </button>
                </div>

                {selected === f.path && preview && (
                  <div style={{ padding: 10, background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' }} data-testid="fs-preview">
                    {preview.kind === 'image' ? (
                      <img src={preview.url} alt={f.name} style={{ maxWidth: '100%', maxHeight: 420, borderRadius: 'var(--radius)' }} />
                    ) : preview.text !== undefined ? (
                      <>
                        <pre
                          className="small"
                          style={{ whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto', margin: 0 }}
                        >
                          {preview.text}
                        </pre>
                        {preview.truncated && <div className="small muted">（文件较大，只显示前 200 KB）</div>}
                      </>
                    ) : (
                      <div className="row row-wrap small">
                        <span className="muted">这类文件不预览。</span>
                        {preview.url && (
                          <a className="btn btn-sm" href={preview.url} target="_blank" rel="noreferrer">
                            打开
                          </a>
                        )}
                      </div>
                    )}
                    {preview.objectId && (
                      <div className="small muted" style={{ marginTop: 6 }}>
                        已入库（{preview.objectId}）。改内容请用编辑器，这里只读。
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {renaming && (
          <div className="row row-wrap small" style={{ marginTop: 8 }}>
            <span className="muted">回车确认、Esc 取消。已入库的文件改名会断链，会先问你。</span>
            <span className="spacer" />
            <button className="btn btn-sm btn-primary" onClick={() => void doRename()} disabled={busy !== ''} data-testid="fs-rename-confirm">
              确认改名
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
