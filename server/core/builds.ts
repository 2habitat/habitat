/**
 * 声明式构建：作品在 work.yaml 里写 build，平台按声明执行。
 *
 * 安全边界：
 *  - 只接受 work.yaml 里的显式声明，不接受任意命令
 *  - command 走白名单，shell:false，args 数组直传
 *  - cwd 必须落在作品目录内
 *  - 超时、输出上限、同一作品同时只跑一个
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as yamlParse } from 'yaml';
import { newId, nowISO } from '../../shared/id.ts';
import type { Author } from '../../shared/types.ts';
import type { Habitat } from './space.ts';

export type BuildStatus = 'queued' | 'running' | 'success' | 'failed' | 'timeout' | 'interrupted';

export interface BuildAction {
  id: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  outputs: string[];
  env: Record<string, string>;
}

export interface BuildRun {
  id: string;
  workId: string;
  slug: string;
  actionId: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  status: BuildStatus;
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
  stdout: string;
  stderr: string;
}

const MAX_OUT = 120_000;
const MAX_RUNS = 50;
const ALLOWED_COMMANDS = new Set(['python', 'python3', 'node', 'nodejs', 'bash', 'sh']);
const ENV_KEEP = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'TEMP', 'TMP', 'PYTHONIOENCODING'];

function safeEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_KEEP) if (process.env[k]) out[k] = process.env[k];
  for (const [k, v] of Object.entries(extra)) {
    // 不允许 build.env 覆盖 PATH，否则白名单 command 可以被同名假二进制劫持
    if (k === 'PATH' || k === 'Path') continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && v.length < 2000) out[k] = v;
  }
  return out;
}

function trim(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…（输出已截断）` : s;
}

export async function readBuildActions(spaceRoot: string, workPath: string): Promise<BuildAction[]> {
  const workDir = path.dirname(path.join(spaceRoot, workPath));
  const file = path.join(workDir, 'work.yaml');
  let doc: unknown;
  try {
    doc = yamlParse(await fsp.readFile(file, 'utf8'));
  } catch {
    return [];
  }
  const b = (doc as { build?: unknown } | null)?.build;
  if (!b) return [];
  const rawList = Array.isArray((b as { actions?: unknown }).actions)
    ? ((b as { actions: unknown[] }).actions)
    : (b as { command?: unknown }).command
      ? [b]
      : [];
  const out: BuildAction[] = [];
  for (const raw of rawList) {
    const r = raw as Record<string, unknown>;
    const command = String(r.command ?? '').trim();
    const base = path.basename(command).toLowerCase();
    if (!ALLOWED_COMMANDS.has(base)) {
      throw new Error(`build.command 不在白名单：${command || '(空)'}`);
    }
    const args = Array.isArray(r.args) ? r.args.map((x) => String(x)) : [];
    if (args.length > 40 || args.some((x) => x.length > 2000)) throw new Error('build.args 过长');
    const cwdRel = String(r.cwd ?? '.').trim() || '.';
    const cwdAbs = path.resolve(workDir, cwdRel);
    const rel = path.relative(workDir, cwdAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`build.cwd 越出作品目录：${cwdRel}`);
    }
    const timeoutMs = Math.min(600_000, Math.max(5_000, Number(r.timeoutMs ?? 180_000) || 180_000));
    const envRaw = (r.env ?? {}) as Record<string, unknown>;
    const env = Object.fromEntries(
      Object.entries(envRaw).filter(([, v]) => typeof v === 'string').slice(0, 20).map(([k, v]) => [k, String(v)]),
    );
    out.push({
      id: String(r.id ?? 'build').replace(/[^a-zA-Z0-9_-]/g, '') || 'build',
      label: String(r.label ?? '构建').slice(0, 40),
      command: base,
      args,
      cwd: cwdRel,
      timeoutMs,
      outputs: Array.isArray(r.outputs) ? r.outputs.map(String) : [],
      env,
    });
  }
  return out;
}

export class BuildManager {
  private runs = new Map<string, BuildRun>();
  private active = new Map<string, string>();
  private file: string;
  private loaded = false;

  constructor(private hab: Habitat) {
    this.file = path.join(hab.store.root, '.habitat/state/builds.json');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8')) as { runs?: BuildRun[] };
      for (const run of raw.runs ?? []) {
        // 进程重启时，上一次还在跑的任务已经没有子进程了，标成 interrupted 而不是永远 running
        if (run.status === 'running' || run.status === 'queued') run.status = 'interrupted';
        this.runs.set(run.id, run);
      }
    } catch {
      /* 没有历史就空着 */
    }
  }

  private async save(): Promise<void> {
    const runs = [...this.runs.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, MAX_RUNS);
    await fsp.mkdir(path.dirname(this.file), { recursive: true }).catch(() => undefined);
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ runs }, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
  }

  private work(workId: string) {
    const wv = this.hab.workView(workId);
    if (!wv) throw new Error(`作品不存在：${workId}`);
    if (!wv.work.path) throw new Error('作品缺少路径');
    return wv;
  }

  async info(workId: string): Promise<{ actions: BuildAction[]; lastRun: BuildRun | null }> {
    await this.load();
    const wv = this.work(workId);
    const actions = await readBuildActions(this.hab.store.root, wv.work.path!);
    const lastRun = [...this.runs.values()]
      .filter((r) => r.workId === workId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] ?? null;
    return { actions, lastRun };
  }

  async list(workId: string): Promise<BuildRun[]> {
    await this.load();
    return [...this.runs.values()].filter((r) => r.workId === workId).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  async get(runId: string): Promise<BuildRun | null> {
    await this.load();
    return this.runs.get(runId) ?? null;
  }

  async start(workId: string, actionId: string | undefined, actor: Author): Promise<BuildRun> {
    await this.load();
    const wv = this.work(workId);
    const actions = await readBuildActions(this.hab.store.root, wv.work.path!);
    if (!actions.length) throw new Error('这个作品没有声明 build');
    const action = actionId ? actions.find((a) => a.id === actionId) : actions[0];
    if (!action) throw new Error(`没有这个构建动作：${actionId}`);
    if (this.active.has(workId)) throw new Error('这个作品已有构建在跑，等它结束再试');

    const workDir = path.dirname(path.join(this.hab.store.root, wv.work.path!));
    const cwd = path.resolve(workDir, action.cwd);
    const run: BuildRun = {
      id: newId('build'),
      workId,
      slug: wv.work.slug,
      actionId: action.id,
      label: action.label,
      command: action.command,
      args: action.args,
      cwd: action.cwd,
      status: 'running',
      startedAt: nowISO(),
      stdout: '',
      stderr: '',
    };
    this.runs.set(run.id, run);
    this.active.set(workId, run.id);
    await this.save();

    await this.hab.journal.add({
      actor,
      op: 'build',
      phase: 'intent',
      target: wv.work.path!,
      summary: `开始构建：${action.label}`,
      payload: { runId: run.id, actionId: action.id, command: action.command, args: action.args },
    }).catch(() => undefined);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(action.command, action.args, {
        cwd,
        env: safeEnv(action.env),
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      await this.finish(run, 'failed', undefined, actor, String(e));
      return run;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      run.stderr += `\n[timeout] 超过 ${Math.round(action.timeoutMs / 1000)}s，已终止`;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 1500).unref?.();
    }, action.timeoutMs);

    child.stdout.on('data', (buf: Buffer) => { run.stdout = trim(run.stdout + buf.toString('utf8')); });
    child.stderr.on('data', (buf: Buffer) => { run.stderr = trim(run.stderr + buf.toString('utf8')); });
    child.on('error', (e) => { void this.finish(run, 'failed', undefined, actor, String(e)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const status: BuildStatus = run.stderr.includes('[timeout]') ? 'timeout' : code === 0 ? 'success' : 'failed';
      void this.finish(run, status, code ?? undefined, actor, signal ? `signal=${signal}` : undefined);
    });
    return run;
  }

  private async finish(run: BuildRun, status: BuildStatus, exitCode: number | undefined, actor: Author, note?: string): Promise<void> {
    if (run.status === 'success' || run.status === 'failed' || run.status === 'timeout') return;
    run.status = status;
    run.exitCode = exitCode;
    run.finishedAt = nowISO();
    this.active.delete(run.workId);
    await this.save();

    await this.hab.journal.add({
      actor,
      op: 'build',
      phase: 'done',
      target: `knowledge/works/${run.slug}/`,
      summary: `构建${status === 'success' ? '成功' : status === 'timeout' ? '超时' : '失败'}：${run.label}${exitCode !== undefined ? `（exit ${exitCode}）` : ''}`,
      payload: { runId: run.id, status, exitCode, note },
    }).catch(() => undefined);

    // 构建可能写了新的 md/html；重新扫一遍，读端立刻能看到。失败也扫，日志和半成品都算现场。
    try {
      await this.hab.rescan();
      await this.hab.reindex();
    } catch {
      /* 索引失败不改变构建结论 */
    }
  }
}
