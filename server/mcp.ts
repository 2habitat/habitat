/**
 * MCP 服务（stdio，换行分隔的 JSON-RPC 2.0）。
 *
 * 这是「外部 Agent 四层接入」里最后那一层：目录约定 → 技能 → CLI → MCP。
 * 前三层靠约定，这一层靠协议，Claude Desktop / Cursor 这类客户端能直接挂上。
 *
 * 只暴露「读 / 检索 / 采集 / 提案」四类。故意不暴露删除与直接改正文：
 * 那两条要么违反「不删只归档」，要么绕开「改语义要人确认」。
 *
 * 启动：habitat mcp [--root <空间>]
 * 注册（以 Claude Desktop 为例）：
 *   {"mcpServers":{"habitat":{"command":"node",
 *     "args":["/绝对路径/habitat/scripts/habitat.mjs","mcp"],"env":{"HABITAT_SPACE":"/绝对路径/你的空间"}}}
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { Habitat } from './core/space.ts';
import { touch, flush } from './core/usage.ts';
import { computeStatuses, runLoop, beat, checkAutomation, agentBrief, renderStatuses } from './core/loops.ts';
import { LOOPS, loopById } from '../shared/loops.ts';

interface RpcReq {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const PROTOCOL = '2024-11-05';

function text(t: string, isError = false) {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) };
}

const TOOLS = [
  {
    name: 'kb_status',
    description: '空间概览：作品/章节/笔记/任务数、链接解析率。任何操作前先跑它确认连的是哪个空间。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'kb_search',
    description: '全库检索（中文 2-gram + 英文分词）。返回命中的对象 id、类型、标题与摘要。搜不到就是搜不到。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词，中文查两字以上更准' },
        type: { type: 'string', description: '可选：note / rep / part / project / area' },
        limit: { type: 'number', description: '默认 8' },
      },
      required: ['q'],
      additionalProperties: false,
    },
  },
  {
    name: 'kb_read',
    description: '读一份正文。repId 来自 kb_search 的结果；返回前 8000 字，长文请分段。',
    inputSchema: {
      type: 'object',
      properties: { repId: { type: 'string' } },
      required: ['repId'],
      additionalProperties: false,
    },
  },
  {
    name: 'kb_capture',
    description: '采集一条碎片到收件箱（或 notes）。这是新增内容的正规入口，会留事件。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        target: { type: 'string', description: 'inbox（默认）或 notes' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'kb_propose',
    description:
      '对已有对象提变更。默认只出提案不落盘；commit=true 才写。' +
      'ops 形如 [{"t":"update","id":"note-xxx","patch":{"status":"evergreen"}}] 或 [{"t":"setBody","id":"...","body":"..."}]。' +
      '撞车会返回三方内容且不覆盖。',
    inputSchema: {
      type: 'object',
      properties: {
        ops: { type: 'array', description: '操作数组', items: { type: 'object' } },
        reason: { type: 'string', description: '为什么改' },
        commit: { type: 'boolean', description: 'true 才真正写盘' },
      },
      required: ['ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'kb_reconcile',
    description: '对账：比对 sha256 快照，找出没留痕的改动（external_edit）。第一次跑只建基线。',
    inputSchema: { type: 'object', properties: { apply: { type: 'boolean' } }, additionalProperties: false },
  },
  {
    name: 'kb_loops',
    description:
      '自动化闭环清单与健康：action=list 看有哪些闭环；status 看谁该跑/跑没跑/积压多少；' +
      'show 看一条的契约；check 自检（静默、无归属、重复执行）；brief 拿一份交接单。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status', 'show', 'check', 'brief'] },
        id: { type: 'string', description: 'show 时必填' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'kb_loop_run',
    description:
      '执行一条闭环。判断类（triage-inbox / digest-source / connect-notes / challenge-supersede）只返回工单，' +
      '不会假装完成；确定性闭环会真的跑。dryRun=true 只看不写。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        dryRun: { type: 'boolean' },
        force: { type: 'boolean', description: '跳过同窗口去重' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'kb_loop_report',
    description:
      '给一条闭环记回执：跑完必须调用，否则系统会认为它没跑。produced 写清这次产出的对象/变更集 id。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ok: { type: 'boolean', description: '默认 true；失败传 false 并写 note' },
        note: { type: 'string' },
        produced: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

export async function runMcp(root: string, opts: { log?: (s: string) => void } = {}): Promise<void> {
  const log = opts.log ?? ((s: string) => process.stderr.write(`[habitat-mcp] ${s}\n`));
  const hab = await Habitat.open(root, { fresh: true });
  log(`已连接空间 ${root}`);

  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

  async function callTool(name: string, args: Record<string, unknown>) {
    switch (name) {
      case 'kb_status': {
        const s = hab.stats();
        return text(
          [
            `空间：${hab.store.space.name}（${hab.store.root}）`,
            `作品 ${s.works} · 章节 ${s.parts} · 载体 ${s.reps} · 笔记 ${s.notes} · 批注 ${s.annotations}`,
            `任务 ${s.actions} · 日程 ${s.events} · 链接 ${s.links}（未解析 ${s.unresolved}）`,
          ].join('\n'),
        );
      }
      case 'kb_search': {
        const q = String(args.q ?? '').trim();
        if (!q) return text('q 不能为空', true);
        const hits = hab.index.search(q, args.type ? { type: String(args.type) } : undefined).slice(0, Number(args.limit ?? 8));
        if (!hits.length) return text(`没有命中「${q}」。换个说法，或这个词还没进库。`);
        return text(
          hits.map((h) => `${h.type}\t${h.id}\t${h.title}\n  ${(h.snippet ?? '').replace(/\s+/g, ' ').slice(0, 140)}`).join('\n'),
        );
      }
      case 'kb_read': {
        const id = String(args.repId ?? '');
        const rep = hab.store.get(id);
        if (!rep) return text(`对象不存在：${id}`, true);
        const body = await hab.store.body(id);
        touch(hab.store, id, 'ai');
        const cut = body.length > 8000 ? `${body.slice(0, 8000)}\n\n…（已截断，共 ${body.length} 字）` : body;
        return text(cut);
      }
      case 'kb_capture': {
        const r = await hab.capture({
          title: String(args.title ?? '未命名'),
          body: String(args.body ?? ''),
          target: (args.target === 'notes' ? 'notes' : 'inbox') as 'inbox' | 'notes',
          actor: 'agent:mcp',
        });
        return text(`已采集 ${r.id}，事件 ${r.events.length} 条`);
      }
      case 'kb_propose': {
        const ops = Array.isArray(args.ops) ? args.ops : [];
        if (!ops.length) return text('ops 不能为空', true);
        const cs = await hab.changes.propose({
          ops: ops as never,
          reason: String(args.reason ?? 'MCP 提案'),
          actor: 'agent:mcp',
        } as never);
        const checks = await hab.changes.validate(cs);
        const bad = checks.filter((c) => !c.ok && c.level === 'error');
        const lines = [`提案 ${cs.id}`, ...checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}：${c.detail}`)];
        if (bad.length) return text(`${lines.join('\n')}\n校验没过，没有落盘。`, true);
        if (args.commit !== true) return text(`${lines.join('\n')}\n只提了提案。要落盘再调一次并传 commit=true。`);
        const r = await hab.changes.commit(cs.id);
        if (r.blocked?.length) return text(`被拦下：${r.blocked.map((b) => b.label).join('；')}`, true);
        if (!r.ok) {
          return text(`撞车了，没有覆盖。三方内容：\n${JSON.stringify(r.conflict, null, 2).slice(0, 3000)}`, true);
        }
        return text(`已落盘，修订 ${(r.changeset as { rev?: number })?.rev ?? '?'}，事件 ${r.events.length} 条`);
      }
      case 'kb_reconcile': {
        const r = await hab.doReconcile();
        if (r.baseline) return text(`已建基线：${r.checked} 个文件（下一次才能对账）`);
        return text(
          `对账 ${r.checked} 个文件：新增 ${r.added.length} · 删除 ${r.removed.length} · 改动 ${r.changed.length}\n` +
            `署名 ${r.signed.length} 处，未署名 ${r.unsigned.length} 处` +
            (r.unsigned.length ? `\n${r.unsigned.map((u) => `⚠ ${u.path}`).join('\n')}` : ''),
        );
      }
      case 'kb_loops': {
        const action = String(args.action ?? 'status');
        if (action === 'list') {
          return text(LOOPS.map((d) => `${d.id}\t${d.name}\t${d.mode}\t${d.entry.cli ?? d.entry.api ?? ''}`).join('\n'));
        }
        if (action === 'show') {
          const d = loopById(String(args.id ?? ''));
          if (!d) return text(`没有这条闭环：${String(args.id ?? '')}`, true);
          return text(JSON.stringify(d, null, 2));
        }
        if (action === 'check') {
          const r = await checkAutomation(hab);
          return text(`${r.passed ? '通过' : '未通过'}\n${JSON.stringify(r, null, 2)}`);
        }
        if (action === 'brief') return text(await agentBrief(hab));
        return text(renderStatuses(await computeStatuses(hab)));
      }
      case 'kb_loop_run': {
        const id = String(args.id ?? '');
        if (!loopById(id)) return text(`没有这条闭环：${id}`, true);
        const r = await runLoop(hab, id, { dryRun: args.dryRun === true, force: args.force === true, actor: 'agent:mcp' });
        const head = r.deduped ? '（去重：窗口内已有回执）' : `${r.result}`;
        return text(`${head}\n\n${r.output}${r.counts ? `\n\n计数：${JSON.stringify(r.counts)}` : ''}`);
      }
      case 'kb_loop_report': {
        const id = String(args.id ?? '');
        if (!loopById(id)) return text(`没有这条闭环：${id}`, true);
        const r = await beat(hab, id, {
          ok: args.ok !== false,
          note: args.note ? String(args.note) : undefined,
          produced: Array.isArray(args.produced) ? args.produced.map(String) : undefined,
          actor: 'agent:mcp',
        });
        return text(`已记回执：${r.loop} ${r.result} ${r.at}`);
      }
      default:
        return text(`没有这个工具：${name}`, true);
    }
  }

  async function handle(req: RpcReq) {
    const reply = (result: unknown) => req.id !== undefined && send({ jsonrpc: '2.0', id: req.id, result });
    const fail = (code: number, message: string) =>
      req.id !== undefined && send({ jsonrpc: '2.0', id: req.id, error: { code, message } });

    switch (req.method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'habitat', version: '1.0.0' },
          instructions: '这是本地个人知识库。先 kb_status 确认空间，再 kb_search 找，kb_read 读，kb_capture 采集，kb_propose 改。',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // 通知没有回复
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const p = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (!p.name) return fail(-32602, '缺少工具名');
        try {
          return reply(await callTool(p.name, p.arguments ?? {}));
        } catch (e) {
          return reply(text(`${(e as Error).message}`, true));
        }
      }
      default:
        return fail(-32601, `不支持的方法：${req.method}`);
    }
  }

  const rl = readline.createInterface({ input: process.stdin });
  // 挂起中的调用：stdin 一关就退出会把还没跑完的 capture/propose 丢掉，
  // 客户端看到的是「调用没回」，实际上写了一半。
  const pending = new Set<Promise<unknown>>();
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let req: RpcReq;
    try {
      req = JSON.parse(s) as RpcReq;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '不是合法 JSON' } });
      return;
    }
    const task = handle(req).catch((e) => {
      log(`处理 ${req.method} 出错：${(e as Error).message}`);
      if (req.id !== undefined) send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: (e as Error).message } });
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });

  const done = async () => {
    // 先把手上的活干完，再关库
    if (pending.size) await Promise.allSettled([...pending]);
    await flush(hab.store);
    hab.close();
  };
  await new Promise<void>((resolve) => {
    rl.on('close', () => void done().then(() => resolve()));
    process.on('SIGINT', () => void done().then(() => resolve()));
  });
}

/** 给「客户端挂了就退出」兜底：stdin 关掉时不要留僵尸进程 */
export function mcpRootFromArgv(argv: string[], fallback: string): string {
  const i = argv.indexOf('--root');
  const r = i >= 0 ? argv[i + 1] : undefined;
  if (r && fs.existsSync(r)) return r;
  return fallback;
}
