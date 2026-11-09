/** 作品构建按钮：读 work.yaml 的 build 声明，触发、轮询、看日志。 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endpoints, type BuildRun } from '../services/api.ts';
import { Icon } from './icons.tsx';
import { useUi } from '../app/ui.ts';

const LABEL: Record<BuildRun['status'], string> = {
  queued: '排队中',
  running: '构建中',
  success: '构建成功',
  failed: '构建失败',
  timeout: '构建超时',
  interrupted: '已中断',
};

function time(iso?: string): string {
  if (!iso) return '';
  return iso.slice(0, 19).replace('T', ' ');
}

export function BuildButton({ workId, compact = false, showStatus = true }: { workId: string; compact?: boolean; showStatus?: boolean }) {
  const toast = useUi((s) => s.toast);
  const { data, isLoading } = useQuery({
    queryKey: ['build', workId],
    queryFn: () => endpoints.buildInfo(workId),
    staleTime: 15_000,
  });
  const [run, setRun] = useState<BuildRun | null>(null);
  const [actionId, setActionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const actions = data?.actions ?? [];
  if (isLoading || !actions.length) return null;
  const action = actions.find((a) => a.id === actionId) ?? actions[0];
  const current = run ?? data?.lastRun ?? null;

  async function poll(id: string) {
    try {
      const r = await endpoints.buildRun(id);
      if (!alive.current) return;
      setRun(r.run);
      if (r.run.status === 'queued' || r.run.status === 'running') {
        timer.current = setTimeout(() => void poll(id), 700);
      } else {
        setBusy(false);
        if (r.run.status === 'success') toast('构建完成，页面已可刷新', 'ok');
        else toast(`${LABEL[r.run.status]}，点「日志」看原因`, 'err');
      }
    } catch (e) {
      if (!alive.current) return;
      setBusy(false);
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  async function start() {
    if (busy) return;
    setBusy(true);
    setOpen(true);
    try {
      const { run: r } = await endpoints.startBuild(workId, action.id);
      setRun(r);
      timer.current = setTimeout(() => void poll(r.id), 500);
    } catch (e) {
      setBusy(false);
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  const status = busy ? 'running' : current?.status;

  return (
    <>
      {actions.length > 1 && (
        <select className="input" style={{ height: 30, maxWidth: 160 }} value={action.id} onChange={(e) => setActionId(e.target.value)} aria-label="选择构建动作">
          {actions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      )}
      <button
        className={`btn btn-sm${compact ? '' : ' btn-primary'}`}
        onClick={() => void start()}
        disabled={busy}
        title={`${action.label}：${action.command} ${action.args.join(' ')}`}
        data-testid="work-build"
      >
        <Icon name="play" size={13} />
        {busy ? '构建中…' : compact ? '构建' : action.label}
      </button>
      {current && showStatus && (
        <button className="link-btn" onClick={() => setOpen(true)} data-testid="work-build-log">
          {LABEL[status ?? current.status]}
        </button>
      )}
      {open && current && (
        <div className="build-overlay" onClick={() => setOpen(false)}>
          <div className="build-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="构建日志">
            <header>
              <div>
                <b>{current.label}</b>
                <span className={`build-status ${current.status}`}>{LABEL[current.status]}</span>
              </div>
              <button className="btn btn-sm btn-quiet" onClick={() => setOpen(false)}>关闭</button>
            </header>
            <div className="build-meta">
              <span className="mono">{current.command} {current.args.join(' ')}</span>
              <span>开始 {time(current.startedAt)}</span>
              {current.finishedAt && <span>结束 {time(current.finishedAt)}</span>}
              {current.exitCode !== undefined && <span>exit {current.exitCode}</span>}
            </div>
            <pre className="build-log">{current.stdout || '（还没有输出）'}{current.stderr ? `\n--- stderr ---\n${current.stderr}` : ''}</pre>
            <footer>
              <span className="small muted">构建会写作品目录与 assets/exports；成功后平台会重扫索引。</span>
              <button className="btn btn-sm" onClick={() => void start()} disabled={busy}>再构建一次</button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
