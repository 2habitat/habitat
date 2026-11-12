/**
 * HTTP 接口（设计方案 §8.4）
 * 人和 AI 走同一套：所有写接口返回 { ok, revision, changeset, events[] }，冲突返回 409 { conflict:{base,mine,theirs} }
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Action, Author, Id, JournalOp, Note, Op } from '../../shared/types.ts';
import { newId, nowISO } from '../../shared/id.ts';
import { Habitat } from '../core/space.ts';
import { STATE } from '../core/store.ts';
import { safeJoin } from '../core/storage.ts';
import { gatesOf, stageOf, nextAction } from '../../shared/lifecycle.ts';
import { Notifier } from '../core/notify.ts';
import { findWorkCandidates } from '../core/candidates.ts';
import { saveAsset, assetUrl, assetMarkdown } from '../core/assets.ts';
import { loadMailConfig, mailStatus, sendMail, type MailConfig } from '../core/mailer.ts';
import { configPath } from '../core/mailer.ts';
import { parseDoc } from '../../shared/frontmatter.ts';
import { runReminders } from '../core/reminders.ts';
import { ingestMail } from '../core/inbox-mail.ts';
import { collectBrief, renderBrief, runTidy } from '../core/tidy.ts';
import { reconcileDay, renderDayLines } from '../core/activity.ts';
import { lifeSnapshot, lifeViewOf } from '../core/lifecycle.ts';
import { touch, flush } from '../core/usage.ts';
import { renewPack, renderRenew, markReviewed } from '../core/renew.ts';
import { listDir, preview, moveFile, makeDir, archiveFiles } from '../core/fs.ts';
import { BuildManager } from '../core/builds.ts';
import { listWorkData, readWorkData, writeWorkData } from '../core/workdata.ts';
import { loadRules, saveRules, normalizeRule, runRules } from '../core/rules.ts';
import {
  computeStatuses, runLoop, beat, loadAutomation, saveAutomation, checkAutomation,
  conformance, agentBrief, readReceipts, latestByLoop, appendReceipt,
  claimTarget, releaseClaims, listClaims, listLeases, runLoopAlerts,
} from '../core/loops.ts';
import { LOOPS, loopById, renderManual, renderSpaceGuide, type HarnessProfile } from '../../shared/loops.ts';
import { AgentService } from '../agent/service.ts';
import { registerAgentRoutes } from './agent.ts';
import { registerShareRoutes } from './share.ts';

export interface ApiOpts {
  root: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** 当前空间。退出时要靠它把 SQLite 正常关掉，不能让 WAL 留在盘上 */
    habitat: Habitat;
    /** Agent 会话/任务执行器。定时自动化用它跑判断类闭环，不依赖外部 harness 平台 */
    habitatAgent: AgentService;
  }
}

function actorOf(body: unknown, headers: unknown): Author {
  const h = (headers ?? {}) as Record<string, string | undefined>;
  const fromHeader = h['x-habitat-actor'];
  if (fromHeader && fromHeader !== 'human') return `agent:${fromHeader}` as Author;
  const b = (body ?? {}) as { actor?: string };
  if (b.actor && b.actor !== 'human') return b.actor as Author;
  return 'human';
}

// 用 fastify-plugin 包一层：否则 app.decorate('habitat') 只会落在插件的封装上下文里，
// 根实例上拿不到——服务端就关不掉 SQLite，轮询也读不到空间。
/** 今天的变更集（按创建时间）。提案不写事件，所以预算只能按变更集算，不能按 journal 算 */
async function changesetsToday(store: { adapter: { read(rel: string): Promise<string> } }, today: string) {
  const raw = await store.adapter.read(STATE.changesets).catch(() => '');
  const out: { id: string; author?: string; createdAt?: string }[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const cs = JSON.parse(line) as { id: string; author?: string; createdAt?: string };
      if ((cs.createdAt ?? '').startsWith(today)) out.push(cs);
    } catch {
      // 坏行跳过：一行坏了不该把整天的用量算成 0
    }
  }
  return out;
}

export const api = fp<ApiOpts>(async (app: FastifyInstance, opts: ApiOpts) => {
  let hab: Habitat;
  try {
    hab = await Habitat.open(opts.root);
  } catch (e) {
    app.log.error(`空间打开失败：${opts.root} ${String(e)}`);
    throw e;
  }
  app.decorate('habitat', hab);
  const builds = new BuildManager(hab);

  /** 传 ids 走增量索引；不传就整库重建（外部改动、批量操作时用） */
  const rescan = async (ids?: string[]) => {
    await hab.rescan(ids);
  };

  // Agent 会话层：harness 进程由它管，写入口仍然是 hab.changes / hab.annotate。
  const agent = new AgentService(hab, {
    root: opts.root,
    baseUrl: () => {
      const addr = app.server.address();
      const port = addr && typeof addr === 'object' ? addr.port : Number(process.env.HABITAT_PORT ?? 8787);
      return `http://127.0.0.1:${port}`;
    },
  });
  app.decorate('habitatAgent', agent);
  registerAgentRoutes(app, { hab, agent });
  // 对外只读页与分享管理：公开面只有 /s/:token，其余仍在鉴权闸门后面
  registerShareRoutes(app, { hab });
  app.addHook('onClose', async () => { await agent.closeAll(); });

  /* ---------------- 读 ---------------- */

/**
 * 把请求体归一化成 Buffer。
 * Fastify 对 text/* 有自己的解析器会给 string，二进制类型才给 Buffer——
 * 上传口两边都可能收到，不归一化就会出现"传文本文件报 body 为空"。
 */
function asBuffer(body: unknown): Buffer | null {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return null;
}

  app.get('/api/space', async () => ({
    space: hab.store.space,
    stats: hab.stats(),
    layout: {
      root: hab.store.root,
      works: hab.store.all('work').length,
      parts: hab.store.all('part').length,
    },
  }));

  /** 笔记清单：只回列表需要的字段，不把 100 多篇正文一起塞给书架 */
  app.get('/api/notes', async (req) => {
    const q = req.query as { q?: string; limit?: string };
    let list = hab.store.all<Note>('note').filter((n) => !n.archivedAt);
    if (q.q) {
      const s = q.q.toLowerCase();
      list = list.filter((n) =>
        `${n.title} ${(n.tags ?? []).join(' ')} ${n.path ?? ''}`.toLowerCase().includes(s),
      );
    }
    list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const limit = Math.min(300, Math.max(1, Number(q.limit ?? 200) || 200));
    return {
      notes: list.slice(0, limit).map((n) => ({
        id: n.id,
        title: n.title,
        path: n.path ?? '',
        status: n.status,
        kind: n.kind,
        tags: n.tags ?? [],
        updatedAt: n.updatedAt,
      })),
      total: list.length,
    };
  });

  app.get('/api/objects', async (req) => {
    const q = req.query as { type?: string; q?: string; limit?: string; includeArchived?: string };
    // 归档的东西默认不出现：归档的意义就是「从日常视图里拿掉，但文件还在」
    let list = (hab.store.all(q.type as never) as unknown as { archivedAt?: string }[]).filter(
      (o) => q.includeArchived === '1' || !o.archivedAt,
    ) as unknown as ReturnType<typeof hab.store.all>;
    if (q.q) {
      const s = q.q.toLowerCase();
      list = list.filter((o) => JSON.stringify(o).toLowerCase().includes(s));
    }
    const lim = Number(q.limit ?? 200);
    return { objects: list.slice(0, lim), total: list.length };
  });

  /**
   * 单个对象的完整视图。列表里的每一行点开都走这里——
   * 它必须能回答「我在哪、我属于谁、最近谁动过我」，否则点开也只是换个地方看标题。
   */
  app.get('/api/object/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await hab.loadRecent();
    const v = hab.objectView(id);
    if (!v) return reply.code(404).send({ error: `对象不存在：${id}` });
    return v;
  });

  app.get('/api/works', async () => ({ works: hab.works() }));
  app.get('/api/works/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const v = hab.workView(id);
    if (!v) return reply.code(404).send({ error: `作品不存在：${id}` });
    const parts = v.parts.map((p) => ({
      part: p,
      reps: v.reps.filter((r) => r.partId === p.id),
      annotations: hab.annotationsOf(p.id).length,
    }));
    return { ...v, parts, derived: hab.derivedOf(id) };
  });

  /* ---------------- 声明式构建 ---------------- */

  app.get('/api/works/:id/build', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await builds.info(id);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/works/:id/build', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { action?: string };
    try {
      const run = await builds.start(id, b.action, actorOf(b, req.headers));
      return reply.code(202).send({ ok: true, run });
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(msg.includes('已有构建') ? 409 : 400).send({ error: msg });
    }
  });

  app.get('/api/works/:id/build/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { runs: await builds.list(id) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/builds/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = await builds.get(runId);
    if (!run) return reply.code(404).send({ error: `构建记录不存在：${runId}` });
    return { run };
  });

  /* ---------------- 作品 JSON 数据 ---------------- */

  app.get('/api/works/:id/data', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { files: await listWorkData(hab, id) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/works/:id/data/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string };
    try {
      return await readWorkData(hab, id, String(q.path ?? ''));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.patch('/api/works/:id/data/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string };
    const b = (req.body ?? {}) as { json?: unknown };
    if (!('json' in b)) return reply.code(400).send({ error: 'body 需要 { json }' });
    try {
      const saved = await writeWorkData(hab, id, String(q.path ?? ''), b.json, actorOf(b, req.headers));
      return { ok: true, ...saved };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /* ---------------- 文件浏览（受管） ---------------- */

  /**
   * 目录列表。
   * 刻意不做成"资源管理器"：写入仍然要走变更集，删除改成归档。
   */
  app.get('/api/fs', async (req, reply) => {
    const q = req.query as { path?: string; hidden?: string };
    try {
      return await listDir(hab, String(q.path ?? ''), { showHidden: q.hidden === '1' });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/fs/file', async (req, reply) => {
    const q = req.query as { path?: string };
    try {
      return await preview(hab, String(q.path ?? ''));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/fs/mkdir', async (req, reply) => {
    const b = (req.body ?? {}) as { path?: string };
    try {
      return await makeDir(hab, String(b.path ?? ''), actorOf(b as never, req.headers));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 改名 / 移动。已入库且被引用的文件需要 force——先让人看见会断几条链 */
  app.post('/api/fs/move', async (req, reply) => {
    const b = (req.body ?? {}) as { from?: string; to?: string; force?: boolean };
    try {
      return await moveFile(hab, String(b.from ?? ''), String(b.to ?? ''), {
        force: b.force === true,
        actor: actorOf(b as never, req.headers),
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 归档（不是删除）：移到 archive/fs/<日期>/ 下 */
  app.post('/api/fs/archive', async (req, reply) => {
    const b = (req.body ?? {}) as { paths?: string[] };
    try {
      return await archiveFiles(hab, Array.isArray(b.paths) ? b.paths : [], actorOf(b as never, req.headers));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** 上传到任意目录（浏览页用；assets 之外也允许） */
  app.put('/api/fs/upload', async (req, reply) => {
    const q = req.query as { dir?: string; name?: string };
    const buf = asBuffer(req.body);
    if (!buf || buf.byteLength === 0) {
      return reply.code(400).send({ error: 'body 要是文件内容' });
    }
    const dir = String(q.dir ?? '').replace(/^\/+|\/+$/g, '');
    const name = path.basename(String(q.name ?? '')).replace(/[\/]/g, '_') || `file-${Date.now()}`;
    const rel = dir ? `${dir}/${name}` : name;
    try {
      const abs = safeJoin(hab.store.root, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, buf);
      await hab.journal.add({
        actor: actorOf(req.body as never, req.headers),
        op: 'import',
        phase: 'done',
        target: rel,
        summary: `上传文件：${rel}（${(buf.byteLength / 1024).toFixed(0)} KB）`,
        payload: { bytes: buf.byteLength },
      });
      await hab.rescan();
      return reply.code(201).send({ ok: true, path: rel, bytes: buf.byteLength });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /* ---------------- 附件上传 ---------------- */

  /**
   * 上传二进制（图片 / PDF / 任意文件）。
   *
   * 用 PUT + 裸 body 而不是 multipart：Fastify 不装插件就能收，任何 Agent / curl / 手机浏览器
   * 都能直接 PUT，不需要理解表单边界。文件名走 query，内容就是 body。
   */
  app.put('/api/assets', async (req, reply) => {
    const q = req.query as { name?: string; dir?: string };
    const buf = asBuffer(req.body);
    if (!buf || buf.byteLength === 0) {
      return reply.code(400).send({ error: 'body 要是文件内容（Content-Type: application/octet-stream）' });
    }
    const maxMb = Number(process.env.HABITAT_MAX_UPLOAD_MB ?? 64);
    if (buf.byteLength > maxMb * 1024 * 1024) return reply.code(413).send({ error: `文件超过 ${maxMb} MB` });

    const r = await saveAsset(hab.store, buf, { name: String(q.name ?? ''), dir: q.dir });
    if (!r.deduped) {
      await hab.journal.add({
        actor: actorOf(req.body as never, req.headers),
        op: 'import',
        phase: 'done',
        target: r.rel,
        summary: `上传附件：${r.rel.split('/').pop()}（${(r.bytes / 1024).toFixed(0)} KB）`,
        payload: { bytes: r.bytes },
      });
    }
    return reply.code(r.deduped ? 200 : 201).send({
      ok: true,
      path: r.rel,
      url: assetUrl(r.rel),
      markdown: assetMarkdown(r.rel, r.rel.split('/').pop() ?? 'file'),
      bytes: r.bytes,
      deduped: r.deduped,
    });
  });

  /** 取附件（图片直接 <img src>，PDF 能在新标签打开） */
  app.get('/api/assets', async (req, reply) => {
    const q = req.query as { path?: string };
    const rel = String(q.path ?? '');
    if (!rel.startsWith('assets/')) return reply.code(400).send({ error: '只能取 assets/ 下的文件' });
    const abs = safeJoin(hab.store.root, rel);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) return reply.code(404).send({ error: `文件不存在：${rel}` });
    const ext = (rel.split('.').pop() ?? '').toLowerCase();
    const type =
      ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
         svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
         md: 'text/plain; charset=utf-8', json: 'application/json' } as Record<string, string>)[ext] ??
      'application/octet-stream';
    return reply
      .headers({ 'content-type': type, 'content-length': String(st.size), 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=300' })
      .send(fs.createReadStream(abs));
  });

  /**
   * 原始文件流：PDF / EPUB / 图片走这条。
   * 必须支持 Range，否则浏览器内置 PDF 阅读器不能翻页，只会整本下完再显示。
   */
  app.get('/api/reps/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rep = hab.store.get(id);
    if (!rep || rep.type !== 'rep') return reply.code(404).send({ error: `载体不存在：${id}` });
    const rel = hab.store.file(id);
    if (!rel) return reply.code(404).send({ error: '这个载体没有对应文件' });
    const abs = safeJoin(hab.store.root, rel);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) return reply.code(404).send({ error: `文件不存在：${rel}` });

    const type =
      ({ pdf: 'application/pdf', epub: 'application/epub+zip', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8' } as Record<string, string>)[
        rep.carrier
      ] ?? 'application/octet-stream';

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) {
          return reply.code(416).header('content-range', `bytes */${st.size}`).send();
        }
        return reply
          .code(206)
          .headers({
            'content-type': type,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${st.size}`,
            'accept-ranges': 'bytes',
            'cache-control': 'private, max-age=60',
          })
          .send(fs.createReadStream(abs, { start, end }));
      }
    }
    return reply
      .headers({
        'content-type': type,
        'content-length': String(st.size),
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=60',
        // PDF 在浏览器里内嵌显示，不要触发下载
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(rel.split('/').pop() ?? 'file')}`,
      })
      .send(fs.createReadStream(abs));
  });

  app.get('/api/reps/:id/content', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rep = hab.store.get(id);
    if (!rep) return reply.code(404).send({ error: `载体不存在：${id}` });
    // 有文件就读文件：编辑器要看到的是「这一份 Markdown」，含 frontmatter。
    // 只回正文会让元数据表单对着空对象编辑——改了保存不上，等于在骗人。
    const rel = hab.store.file(id);
    let content: string;
    try {
      content = rel ? await hab.store.adapter.read(rel) : await hab.store.body(id);
    } catch {
      content = await hab.store.body(id);
    }
    touch(hab.store, id, 'open');
    const cursor = hab.store.cursors.get(id);
    // hash + rev 一起回给客户端：它保存时要拿这个当基准，服务端才知道有没有人抢先改过
    const st = rel ? await hab.store.adapter.stat(rel) : undefined;
    // 正文由服务端解析后一起给：文件可能是 CRLF，前端再自己正则切分迟早出错
    const body = rel && rel.endsWith('.md') ? parseDoc(content).body : content;
    return {
      rep,
      content,
      body,
      hash: st?.hash ?? 'new',
      locked: (rep as { locked?: boolean }).locked ?? false,
      cursor: cursor ?? { repId: id, current: 0, furthest: 0, updatedAt: '' },
    };
  });

  app.get('/api/annotations', async (req) => {
    const q = req.query as { rep?: string };
    let list = hab.store.all('annotation') as never as {
      id: string; targetRepId: string; quote: string; note?: string; color: string; locator: unknown;
    }[];
    if (q.rep) list = list.filter((a) => a.targetRepId === q.rep);
    return { annotations: list };
  });

  app.get('/api/inbox', async () => ({ notes: hab.inbox() }));

  app.get('/api/today', async (req) => {
    const q = req.query as { date?: string };
    await hab.loadRecent();
    return hab.today(q.date);
  });

  app.get('/api/projects', async () => ({ projects: hab.projects() }));

  /** 生命周期看板：五列 + 卡住的条目 */
  app.get('/api/flow', async () => {
    await hab.loadRecent();
    const items = [
      ...hab.store.all('work').map((o) => ({ id: o.id, kind: 'work' as const, title: (o as { title: string }).title })),
      ...hab.store
        .all('note')
        .filter((n) => !(hab.store.file(n.id) ?? '').startsWith('inbox/'))
        .map((o) => ({ id: o.id, kind: 'note' as const, title: (o as { title: string }).title })),
    ];
    const cards = items.map((it) => {
      const f = hab.facts(it.id);
      return {
        ...it,
        path: hab.store.file(it.id),
        readPct: f.readPct,
        derived: f.derivedCount,
        gates: gatesOf(f),
        stage: stageOf(f),
        next: nextAction(f),
      };
    });
    const byStage: Record<string, typeof cards> = { capture: [], derive: [], digest: [], review: [], settle: [] };
    for (const c of cards) if (c.stage) byStage[c.stage].push(c);
    return { cards, byStage, stuck: cards.filter((c) => c.next).sort((a, b) => b.readPct - a.readPct) };
  });

  app.get('/api/tags', async () => ({
    tags: (() => {
      const m = new Map<string, string[]>();
      for (const o of hab.store.objects.values()) {
        const tags = (o as { tags?: string[] }).tags ?? [];
        for (const t of tags) m.set(t, [...(m.get(t) ?? []), o.id]);
      }
      return [...m.entries()].map(([tag, ids]) => ({ tag, ids })).sort((a, b) => b.ids.length - a.ids.length);
    })(),
    facets: hab.index.facets(),
  }));

  app.get('/api/graph', async (req) => {
    const q = req.query as { limit?: string };
    const lim = Number(q.limit ?? 200);
    const nodes = hab.store
      .all()
      .filter((o) => ['work', 'note', 'project', 'area', 'collection'].includes(o.type))
      .slice(0, lim)
      .map((o) => ({ id: o.id, type: o.type, title: (o as { title?: string }).title ?? o.id }));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = hab.store.links
      .filter((l) => l.resolved && ids.has(l.from) && ids.has(l.resolved))
      .map((l) => ({ source: l.from, target: l.resolved }));
    return { nodes, edges };
  });

  app.get('/api/search', async (req) => {
    const q = req.query as { q?: string; type?: string; limit?: string };
    if (!q.q?.trim()) return { hits: [], facets: hab.index.facets() };
    const hits = hab.index.search(q.q, { type: q.type, limit: Number(q.limit ?? 50) });
    touch(hab.store, hits.slice(0, 10).map((h) => h.id), 'search');
    return { hits, facets: hab.index.facets() };
  });

  app.get('/api/journal', async (req) => {
    const q = req.query as { actor?: string; op?: string; since?: string; limit?: string; target?: string };
    return { events: await hab.journal.query({ ...q, limit: Number(q.limit ?? 500) }) };
  });

  /* ---------------- 变更 ---------------- */

  app.post('/api/changes', async (req, reply) => {
    const b = req.body as {
      ops: Op[];
      reason?: string;
      baseRevisions?: Record<string, number>;
      base?: Record<string, { rev?: number; hash?: string; content?: string }>;
    };
    if (!Array.isArray(b?.ops) || b.ops.length === 0) {
      return reply.code(400).send({ error: 'ops 不能为空' });
    }
    // 预算页写着「默认每天 ≤3 条」。写了就要真拦——只约束 AI，
    // 人自己改东西不该被配额卡住（否则「AI 提案过量」会变成「人也干不了活」）。
    const actor = actorOf(b as never, req.headers);
    if (String(actor).startsWith('agent:')) {
      const limit = Number(process.env.HABITAT_DAILY_PROPOSALS ?? 3);
      const today = nowISO().slice(0, 10);
      const used = (await changesetsToday(hab.store, today)).filter((c) => c.author === actor).length;
      if (used >= limit) {
        return reply.code(429).send({
          ok: false,
          error: `${actor} 今天已提了 ${used} 次，超过上限 ${limit}。明天再来，或让人来改。`,
          used,
          limit,
        });
      }
    }
    const cs = await hab.changes.propose({
      ops: b.ops,
      reason: b.reason,
      baseRevisions: b.baseRevisions,
      base: b.base,
      actor: actorOf(b, req.headers),
    });
    const checks = await hab.changes.validate(cs);
    return reply.code(201).send({ ok: true, changeset: cs, checks });
  });

  app.post('/api/changes/:id/validate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cs = await hab.changes.load(id);
    if (!cs) return reply.code(404).send({ error: `变更不存在：${id}` });
    return { ok: true, changeset: cs, checks: await hab.changes.validate(cs) };
  });

  app.post('/api/changes/:id/commit', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await hab.changes.commit(id);
    if (r.ok) touch(hab.store, Object.keys(r.changeset?.baseRevisions ?? {}), 'edit');
    if (r.blocked?.length) {
      return reply.code(422).send({ ok: false, blocked: r.blocked, changeset: r.changeset });
    }
    if (!r.ok) return reply.code(409).send({ ok: false, conflict: r.conflict, changeset: r.changeset });
    return {
      ok: true,
      revision: Math.max(...Object.values(r.changeset.baseRevisions), 0) + 1,
      changeset: r.changeset,
      events: r.events,
    };
  });

  app.post('/api/changes/:id/revert', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await hab.changes.revert(id);
      if (!r.ok) return reply.code(409).send({ ok: false, conflict: r.conflict, changeset: r.changeset });
      return { ok: true, changeset: r.changeset, events: r.events };
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message) });
    }
  });

  /**
   * 变更列表。
   * ?summary=1 只回计数与最新时间——导航栏的角标只要这个，
   * 传完整 changeset（含 base 内容快照）一次 20KB，没必要每页都拉。
   */
  app.get('/api/changes', async (req) => {
    const q = req.query as { summary?: string };
    const all = await hab.changes.list();
    if (q.summary === '1') {
      const pending = all.filter((c) => c.state === 'draft' || c.state === 'validated');
      return {
        summary: {
          total: all.length,
          pending: pending.length,
          latestAt: all[0]?.createdAt ?? null,
        },
      };
    }
    return { changesets: all };
  });

  /* ---------------- 语义化写操作 ---------------- */

  const wrap = async (fn: () => Promise<unknown>, reply: { code: (n: number) => { send: (o: unknown) => unknown } }) => {
    try {
      return await fn();
    } catch (e) {
      const err = e as Error & { statusCode?: number; conflict?: unknown };
      if (err.statusCode === 409) return reply.code(409).send({ ok: false, conflict: err.conflict });
      return reply.code(400).send({ error: err.message });
    }
  };

  app.post('/api/capture', async (req, reply) => {
    const b = req.body as { title: string; body: string; kind?: never; srcIds?: Id[]; target?: 'inbox' | 'notes' };
    return wrap(async () => {
      const r = await hab.capture({ ...b, actor: actorOf(b, req.headers) });
      await rescan([r.id]);
      return { ok: true, ...r };
    }, reply);
  });

  app.post('/api/derive', async (req, reply) => {
    const b = req.body as { srcId: Id; title: string; body: string; kind?: 'point' | 'summary' | 'outline' | 'question'; quote?: string };
    return wrap(async () => {
      const r = await hab.derive({ ...b, actor: actorOf(b, req.headers) });
      await rescan([r.id]);
      return { ok: true, ...r };
    }, reply);
  });

  app.post('/api/annotate', async (req, reply) => {
    const b = req.body as {
      repId: Id; quote: string; note?: string; color?: string; from: number; to: number;
      prefix?: string; suffix?: string;
    };
    return wrap(async () => {
      const r = await hab.annotate({ ...b, actor: actorOf(b, req.headers) });
      await rescan([r.id]);
      return { ok: true, ...r };
    }, reply);
  });

  /** 删掉划错的一条批注。事件流留 unannotate，变更页可撤销 */
  app.delete('/api/annotations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = hab.store.get(id);
    if (!a || a.type !== 'annotation') return reply.code(404).send({ error: `批注不存在：${id}` });
    return wrap(async () => {
      const r = await hab.removeAnnotation(id, actorOf({}, req.headers));
      return { ok: true, ...r };
    }, reply);
  });

  /**
   * 所有未完成的任务。
   * 为什么必须有这个接口：今天页只取「今天到期」与「已逾期」两个桶，
   * 未来任务会彻底消失在界面上——文件里有、人看不到，等于没建。
   */
  app.get('/api/actions', async (req) => {
    const q = req.query as { includeDone?: string };
    const all = hab.store.all<Action>('action');
    const list = all
      .filter((a) => (q.includeDone === '1' ? true : a.state !== 'done'))
      .sort((a, b) => {
        if (a.due && b.due) return a.due < b.due ? -1 : 1;
        if (a.due) return -1;
        if (b.due) return 1;
        return a.text.localeCompare(b.text);
      });
    return { actions: list, total: all.length };
  });

  app.post('/api/actions', async (req, reply) => {
    const b = req.body as { text: string; due?: string; scheduled?: [string, string]; flow?: 'now' | 'next' | 'later'; projectId?: Id };
    return wrap(async () => {
      const r = await hab.addAction({ ...b, actor: actorOf(b, req.headers) });
      await rescan([r.id]);
      return { ok: true, ...r };
    }, reply);
  });

  app.post('/api/events', async (req, reply) => {
    const b = req.body as { title: string; date: string; start: string; end?: string; projectId?: Id };
    return wrap(async () => {
      const r = await hab.addEvent({ ...b, actor: actorOf(b, req.headers) });
      await rescan([r.id]);
      return { ok: true, ...r };
    }, reply);
  });

  app.post('/api/cursor', async (req, reply) => {
    const b = req.body as { repId: Id; pct: number; force?: boolean };
    return wrap(async () => {
      const r = await hab.setCursor(b.repId, b.pct, actorOf(b, req.headers), { force: b.force === true });
      return { ok: true, ...r };
    }, reply);
  });

  app.post('/api/review', async (req, reply) => {
    const b = req.body as { id: Id; note?: string };
    return wrap(async () => {
      const ev = await hab.review(b.id, b.note ?? '', actorOf(b, req.headers));
      return { ok: true, event: ev };
    }, reply);
  });

  app.post('/api/journal', async (req, reply) => {
    const b = req.body as { op: JournalOp; target: string; summary: string; payload?: Record<string, unknown>; phase?: 'intent' | 'done' | 'detected' };
    if (!b?.op || !b?.target) return reply.code(400).send({ error: 'op 与 target 必填' });
    const ev = await hab.journal.add({
      actor: actorOf(b, req.headers),
      op: b.op,
      phase: b.phase ?? 'done',
      target: b.target,
      summary: b.summary ?? b.op,
      payload: b.payload,
    });
    return reply.code(201).send({ ok: true, event: ev });
  });

  app.post('/api/journal/:id/claim', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { actor?: string };
    const ev = await hab.journal.claim(id, b.actor ?? 'human');
    if (!ev) return reply.code(404).send({ error: `事件不存在：${id}` });
    return { ok: true, event: ev };
  });

  /* ---------------- AI 域 ---------------- */

  app.get('/api/proposals', async () => {
    const raw = await hab.store.adapter.read(STATE.proposals).catch(() => '');
    return {
      proposals: raw
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    };
  });

  app.post('/api/proposals', async (req, reply) => {
    const b = req.body as {
      title: string; kind: string; rationale?: string; scope?: string; budgetCny?: number;
      risk?: 'low' | 'med' | 'high'; evidence?: Id[]; changes?: unknown[]; ops?: Op[];
    };
    const actor = actorOf(b, req.headers);
    // 空提案没有意义：它既不能校验也撤不回来，只会让变更列表里多一张废卡
    if (!Array.isArray(b.ops) || b.ops.length === 0) {
      return reply.code(400).send({ error: '提案里至少要有一条具体改动（ops 不能为空）' });
    }
    const cs = await hab.changes.propose({
      ops: b.ops,
      reason: b.title,
      actor,
    });
    const checks = await hab.changes.validate(cs);
    const p = {
      type: 'proposal',
      id: newId('prop'),
      schema: 1,
      spaceId: hab.store.space.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      author: actor,
      sensitivity: 'private',
      rev: 1,
      kind: b.kind ?? 'derive',
      title: b.title,
      rationale: b.rationale,
      changes: b.changes ?? [],
      evidence: b.evidence ?? [],
      scope: b.scope ?? '',
      budgetCny: b.budgetCny ?? 0,
      risk: b.risk ?? 'low',
      state: 'pending',
      changesetId: cs.id,
    };
    await hab.store.adapter.append(STATE.proposals, JSON.stringify({ ...p, checks }));
    return reply.code(201).send({ ok: true, proposal: p, changeset: cs, checks });
  });

  app.post('/api/proposals/:id/apply', async (req, reply) => {
    const { id } = req.params as { id: string };
    const raw = await hab.store.adapter.read(STATE.proposals).catch(() => '');
    const lines = raw.split('\n').filter(Boolean);
    let hit: (typeof lines)[number] | undefined;
    let idx = -1;
    for (let i = 0; i < lines.length; i += 1) {
      try {
        if ((JSON.parse(lines[i]) as { id: string }).id === id) {
          hit = lines[i];
          idx = i;
          break;
        }
      } catch {
        /* skip */
      }
    }
    if (!hit) return reply.code(404).send({ error: `提案不存在：${id}` });
    const p = JSON.parse(hit) as { changesetId?: string; id: string; state: string };
    if (!p.changesetId) return reply.code(400).send({ error: '这条提案没有绑定变更' });
    const r = await hab.changes.commit(p.changesetId);
    if (r.blocked?.length) return reply.code(422).send({ ok: false, blocked: r.blocked });
    if (!r.ok) return reply.code(409).send({ ok: false, conflict: r.conflict });
    lines[idx] = JSON.stringify({ ...p, state: 'applied' });
    await hab.store.adapter.write(STATE.proposals, `${lines.join('\n')}\n`, { backup: false });
    // 提案应用 = 这条闭环真正闭合了一次：写回执，让「谁确认的、改出了什么」进统一时间线。
    await appendReceipt(hab, {
      loop: 'proposal-approve',
      at: nowISO(),
      by: String(actorOf(req.body, req.headers)),
      trigger: 'event',
      result: 'ok',
      produced: [p.id, (r.changeset as { id?: string })?.id].filter((x): x is string => !!x),
      note: '提案已应用',
    });
    return { ok: true, changeset: r.changeset, events: r.events };
  });

  app.get('/api/jobs', async () => {
    const raw = await hab.store.adapter.read(STATE.jobs).catch(() => '');
    return {
      jobs: raw
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    };
  });

  /**
   * 作业是长流程，不是一次请求：
   *   queued → running → (waiting-approval | waiting-device) → done
   * 每推进一步都落盘检查点，恢复时从检查点继续，不重复副作用。
   */
  async function readJobs(): Promise<Record<string, unknown>[]> {
    const raw = await hab.store.adapter.read(STATE.jobs).catch(() => '');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => !!x);
  }
  async function writeJobs(jobs: Record<string, unknown>[]): Promise<void> {
    await hab.store.adapter.write(STATE.jobs, `${jobs.map((j) => JSON.stringify(j)).join('\n')}${jobs.length ? '\n' : ''}`, { backup: false });
  }

  app.post('/api/jobs', async (req, reply) => {
    const b = req.body as { name: string; trigger?: string; steps?: string[]; idempotencyKey?: string };
    if (!b?.name) return reply.code(400).send({ error: '作业得有个名字' });
    const jobs = await readJobs();
    const key = b.idempotencyKey ?? `${b.name}#${nowISO().slice(0, 10)}`;
    // 幂等：同一把钥匙不重复排队
    const exist = jobs.find((j) => j.idempotencyKey === key && j.state !== 'failed');
    if (exist) return { ok: true, job: exist, deduped: true };
    const job = {
      type: 'job',
      id: newId('job'),
      schema: 1,
      spaceId: hab.store.space.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      author: actorOf(b, req.headers),
      sensitivity: 'private',
      rev: 1,
      name: b.name,
      trigger: b.trigger ?? 'manual',
      state: 'queued',
      checkpoint: 'start',
      idempotencyKey: key,
      steps: (b.steps ?? ['扫描', '生成候选', '等待确认']).map((s) => ({ name: s, state: 'pending' as const })),
    };
    jobs.unshift(job as unknown as Record<string, unknown>);
    await writeJobs(jobs);
    await hab.journal.add({
      actor: job.author,
      op: 'propose',
      phase: 'intent',
      target: `job:${job.id}`,
      summary: `排队作业：${job.name}`,
      payload: { trigger: job.trigger },
    });
    return reply.code(201).send({ ok: true, job });
  });

  app.post('/api/jobs/:id/advance', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { approve?: boolean };
    const jobs = await readJobs();
    const i = jobs.findIndex((j) => j.id === id);
    if (i < 0) return reply.code(404).send({ error: `作业不存在：${id}` });
    const j = jobs[i] as unknown as {
      id: string; name: string; state: string; checkpoint: string;
      steps: { name: string; state: string }[]; waitingReason?: string; idempotencyKey: string;
    };

    // 「等待」不是失败：审批等待落库并释放执行器
    if (j.state === 'waiting-approval' && !b.approve) {
      return reply.code(409).send({ ok: false, error: '这条作业在等人确认', waitingReason: j.waitingReason });
    }

    // 退避期内的重试要等，不能连着猛推
    const backoff = j as unknown as { nextTryAt?: string; attempts?: number };
    if (backoff.nextTryAt && Date.parse(backoff.nextTryAt) > Date.now()) {
      return reply.code(429).send({
        ok: false,
        error: `第 ${backoff.attempts ?? 1} 次失败后要退避，最早 ${backoff.nextTryAt.slice(11, 16)} 再推进`,
        nextTryAt: backoff.nextTryAt,
      });
    }

    const pendingIdx = () => j.steps.findIndex((s) => s.state === 'pending');

    // 推进前，先把「当前检查点」这一步标记完成。
    // queued 还没进入任何步骤，waiting-approval 则是人刚点过确认，两种情况下这一步都算做完。
    if (j.state === 'running' || j.state === 'waiting-approval') {
      const cur = pendingIdx();
      if (cur >= 0) j.steps[cur].state = 'done';
    }

    const next = (() => {
      if (j.state === 'queued') return { state: 'running', checkpoint: j.steps[0]?.name ?? 'start' };
      const idx = pendingIdx();
      if (idx < 0) {
        for (const s of j.steps) s.state = 'done';
        return { state: 'done', checkpoint: 'done' };
      }
      // 第二步要人确认——这是设计里写死的：改语义必须逐条确认
      if (idx === 1) {
        return { state: 'waiting-approval', checkpoint: j.steps[idx].name, waitingReason: '这一步会改语义，需要人逐条确认' };
      }
      return { state: 'running', checkpoint: j.steps[idx].name };
    })();

    const updated = {
      ...j,
      state: next.state,
      checkpoint: next.checkpoint,
      waitingReason: next.state === 'waiting-approval' ? next.waitingReason : undefined,
      updatedAt: nowISO(),
      leaseUntil: next.state === 'running' ? nowISO(Date.now() + 60_000) : undefined,
    };
    jobs[i] = updated as unknown as Record<string, unknown>;
    await writeJobs(jobs);
    await hab.journal.add({
      actor: 'system',
      op: next.state === 'done' ? 'commit' : 'propose',
      phase: 'done',
      target: `job:${j.id}`,
      summary: `作业 ${j.name} → ${next.state}（检查点 ${next.checkpoint}）`,
      payload: { idempotencyKey: j.idempotencyKey },
    });
    if (next.state === 'done') {
      await appendReceipt(hab, {
        loop: 'job-advance',
        at: nowISO(),
        by: 'system',
        trigger: 'event',
        result: 'ok',
        produced: [j.id],
        note: `作业完成：${j.name}`,
      });
    }
    return { ok: true, job: updated };
  });

  /** 人把外部失败记到作业上：记尝试次数 + 指数退避；三次之后判永久失败，不再自动重试 */
  app.post('/api/jobs/:id/fail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { reason?: string };
    const jobs = await readJobs();
    const i = jobs.findIndex((x) => x.id === id);
    if (i < 0) return reply.code(404).send({ error: `作业不存在：${id}` });
    const j = jobs[i] as unknown as { attempts?: number; name: string; state: string; lastError?: string; nextTryAt?: string };
    const attempts = (j.attempts ?? 0) + 1;
    const permanent = attempts >= 3;
    j.attempts = attempts;
    j.lastError = b.reason ?? '外部步骤报错';
    j.state = permanent ? 'failed' : j.state;
    // 30s / 60s / 120s，封顶 5 分钟
    j.nextTryAt = permanent ? undefined : nowISO(Date.now() + Math.min(30_000 * 2 ** (attempts - 1), 300_000));
    jobs[i] = j as unknown as Record<string, unknown>;
    await writeJobs(jobs);

    await hab.journal.add({
      actor: 'system',
      op: 'build',
      phase: 'done',
      target: `job:${id}`,
      summary: permanent ? `作业 ${j.name} 第 ${attempts} 次失败，判永久失败` : `作业 ${j.name} 第 ${attempts} 次失败，退避后重试`,
      payload: { reason: j.lastError, nextTryAt: j.nextTryAt },
    });
    if (permanent) {
      await appendReceipt(hab, {
        loop: 'job-advance',
        at: nowISO(),
        by: 'system',
        trigger: 'event',
        result: 'fail',
        produced: [id],
        note: `连续失败 ${attempts} 次：${j.lastError ?? '未写原因'}`,
      });
      await new Notifier(hab.store).add({
        level: 'danger',
        title: `作业「${j.name}」连续失败 ${attempts} 次`,
        body: j.lastError,
        href: '#/jobs',
      });
    }
    return { ok: true, job: j, permanent };
  });

  app.get('/api/rules', async () => ({ rules: await loadRules(hab.store) }));

  app.post('/api/rules', async (req, reply) => {
    const b = req.body as { name: string; when?: string; do?: string; kind?: string; threshold?: number; limit?: number; enabled?: boolean };
    if (!b?.name) return reply.code(400).send({ error: '规则要有名字' });
    const kind = String(b.kind ?? 'custom');
    const rules = await loadRules(hab.store);
    const rule = normalizeRule({
      id: newId('rule'),
      name: b.name,
      kind,
      threshold: b.threshold ?? undefined,
      limit: b.limit ?? 3,
      enabled: b.enabled ?? true,
      when: b.when ?? kind,
      do: b.do ?? '产出一条通知',
      createdAt: nowISO(),
    });
    rules.push(rule);
    await saveRules(hab.store, rules);
    return reply.code(201).send({ ok: true, rule });
  });

  app.post('/api/rules/:id/toggle', async (req, reply) => {
    const { id } = req.params as { id: string };
    const rules = await loadRules(hab.store);
    const r = rules.find((x) => x.id === id);
    if (!r) return reply.code(404).send({ error: `规则不存在：${id}` });
    r.enabled = !r.enabled;
    await saveRules(hab.store, rules);
    return { ok: true, rule: r };
  });

  /** 立刻跑一轮规则：自动化页那个「现在跑一次」，也是测试与 doctor 的入口 */
  app.post('/api/rules/run', async (req) => {
    const b = (req.body ?? {}) as { dryRun?: boolean };
    const report = await runRules(hab, { dryRun: b.dryRun === true });
    if (!b.dryRun) {
      await hab.journal.add({
        actor: 'system',
        op: 'reconcile',
        phase: 'done',
        target: '.habitat/state/rules.json',
        summary: `规则执行：评估 ${report.evaluated} 条，触发 ${report.fired.length} 条`,
        payload: { fired: report.fired.map((f) => f.rule) },
      });
    }
    return { ok: true, report };
  });

  /* ---------------- 作品归组候选 ---------------- */

  /**
   * 找出「看起来是一本书、但还没被任何作品接管」的来源目录。
   * 只产出候选，不搬文件；人点了确认才写 work.yaml（partsFrom 指向原目录）。
   */
  app.get('/api/candidates/works', async () => ({ candidates: await findWorkCandidates(hab.store) }));

  app.post('/api/works/group', async (req, reply) => {
    const b = req.body as { dir: string; title: string; slug?: string };
    if (!b?.dir || !b?.title) return reply.code(400).send({ error: 'dir 与 title 必填' });
    const slug = (b.slug || b.dir.split('/').pop() || 'work').replace(/[^a-zA-Z0-9一-龥_-]/g, '-');
    const rel = `knowledge/works/${slug}/work.yaml`;
    const st = await hab.store.adapter.stat(rel);
    if (st) return reply.code(409).send({ error: `作品已存在：${slug}` });

    const yaml = [
      `title: ${JSON.stringify(b.title)}`,
      'kind: book',
      `partsFrom: ${JSON.stringify(b.dir)}`,
      '',
    ].join('\n');
    await hab.store.adapter.write(rel, yaml, { backup: false });
    await hab.journal.add({
      actor: 'human',
      op: 'settle',
      phase: 'done',
      target: rel,
      summary: `归组：${b.title} ← ${b.dir}`,
      payload: { dir: b.dir, chapters: 0 },
    });
    await hab.rescan();
    return reply.code(201).send({ ok: true, slug, rel });
  });

  /* ---------------- 断链 ---------------- */

  app.get('/api/links/unresolved', async () => ({ items: hab.store.unresolvedTargets() }));

  /* ---------------- 管家：简报与代谢 ---------------- */

  app.get('/api/maintenance/brief', async () => {
    const data = await collectBrief(hab);
    return { data, brief: renderBrief(data) };
  });

  /**
   * 当日对账：今天实际做了什么 vs 今天该做什么。
   * 只读接口：返回的是证据和提案，勾掉任务仍然走 /api/actions 或 habitat done。
   */
  app.get('/api/day/actual', async (req) => {
    const q = req.query as { date?: string };
    const day = /^\d{4}-\d{2}-\d{2}$/.test(q.date ?? '') ? q.date! : nowISO().slice(0, 10);
    const r = await reconcileDay(hab, day);
    return { ...r, text: renderDayLines(r).join('\n') };
  });

  /**
   * 确认「可能已完成」：走同一条 ChangeService，不绕过 propose/commit。
   * 界面 / CLI 都可以不调它（直接 habitat done），这里只是为了少一次两步提交。
   */
  app.post('/api/day/confirm', async (req, reply) => {
    const b = req.body as { id?: Id };
    return wrap(async () => {
      if (!b?.id) throw new Error('缺少任务 id');
      const a = hab.store.get<Action>(b.id);
      if (!a || a.type !== 'action') throw new Error(`任务不存在：${b.id}`);
      if (a.state === 'done') return { ok: true, already: true };
      const r = await hab.commitOps(
        [{ t: 'update', id: a.id, patch: { state: 'done' } }],
        actorOf(b, req.headers),
        `当日对账：确认完成「${a.text.slice(0, 20)}」`,
      );
      await rescan([a.id]);
      return { ok: true, ...r };
    }, reply);
  });

  /** 翻新证据包：它主张什么 + 库里哪几条可能撞上（召回由服务端做，判定交给 AI） */
  app.get('/api/renew/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const pack = await renewPack(hab, id);
    if (!pack) return reply.code(404).send({ error: `对象不存在：${id}` });
    return { ok: true, pack, text: renderRenew(pack) };
  });

  /** 记一次复核：ok=true 间隔往后推一档，false 回到明天 */
  app.post('/api/review/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { ok?: boolean };
    if (!hab.store.get(id)) return reply.code(404).send({ error: `对象不存在：${id}` });
    const r = await markReviewed(hab, id, b.ok === true);
    return { ok: true, ...r };
  });

  /** 生命周期快照：每个对象在哪一步、卡在什么地方 */
  app.get('/api/lifecycle', async () => lifeSnapshot(hab));

  app.get('/api/lifecycle/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const got = await lifeViewOf(hab, id, { withStat: true });
    if (!got) return reply.code(404).send({ error: `对象不存在或不参与生命周期：${id}` });
    return got;
  });

  /** 默认只算不改；apply=true 才真归档（走变更集，可撤销） */
  app.post('/api/maintenance/tidy', async (req) => {
    const b = (req.body ?? {}) as { apply?: boolean };
    return { ok: true, report: await runTidy(hab, { dryRun: b.apply !== true }) };
  });

  /* ---------------- 邮件提醒 ---------------- */

  app.get('/api/notify/status', async () => {
    const st = mailStatus();
    return {
      configured: st.configured,
      // 发件人和收件人是两件事，必须分开回：合并回会让界面把两个框填成一样
      user: st.user ?? null,
      to: st.to ?? null,
      host: st.host ?? null,
      port: st.port ?? null,
      secure: st.secure ?? null,
      fromName: st.fromName ?? null,
      allowFrom: (() => {
        try {
          return (JSON.parse(fs.readFileSync(configPath(), 'utf8')) as { allowFrom?: string[] }).allowFrom ?? [];
        } catch {
          return [];
        }
      })(),
      missing: st.missing,
      configPath: st.path,
      env: { HABITAT_SMTP_HOST: !!process.env.HABITAT_SMTP_HOST },
    };
  });

  /** 保存邮件通道配置。pass 传空字符串表示「沿用已保存的」——表单不该把密钥又显示出来 */
  app.put('/api/notify/config', async (req, reply) => {
    const b = (req.body ?? {}) as Partial<MailConfig> & { pass?: string };
    const cur = (() => {
      try {
        return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<MailConfig>;
      } catch {
        return {} as Partial<MailConfig>;
      }
    })();
    const next: MailConfig = {
      host: String(b.host ?? cur.host ?? 'smtp.qq.com').trim(),
      port: Number(b.port ?? cur.port ?? 465),
      secure: b.secure ?? cur.secure ?? true,
      user: String(b.user ?? cur.user ?? '').trim(),
      pass: (b.pass && b.pass.trim()) || String(cur.pass ?? ''),
      to: String(b.to ?? cur.to ?? '').trim(),
      fromName: String(b.fromName ?? cur.fromName ?? 'Habitat 知识库').trim(),
      // 投递白名单：空 = 只认自己。支持 @domain 后缀匹配
      allowFrom: Array.isArray(b.allowFrom)
        ? b.allowFrom.map((x) => String(x).trim()).filter(Boolean)
        : (cur.allowFrom ?? []),
    };
    if (!next.user) return reply.code(400).send({ error: '发件邮箱不能为空' });
    if (!next.to) return reply.code(400).send({ error: '收件邮箱不能为空' });
    if (!next.pass) return reply.code(400).send({ error: '授权码不能为空' });

    await fsp.mkdir(path.dirname(configPath()), { recursive: true });
    await fsp.writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8');
    return { ok: true, ...mailStatus() };
  });

  /** 发一封测试信：授权码对不对，一次就知道 */
  app.post('/api/notify/test', async (_req, reply) => {
    const cfg = loadMailConfig();
    if (!cfg) return reply.code(400).send({ ok: false, error: '没有配置邮件通道' });
    const r = await sendMail({
      subject: '✅ Habitat 邮件通道已接通',
      text: `这封信是从本地知识库发出的。

收件人：${cfg.to}
时间：${nowISO()}

之后日程到点前 ${process.env.HABITAT_REMIND_WINDOW_MIN ?? 30} 分钟、以及每天第一次发现逾期任务时，会发到这里。`,
    });
    if (!r.ok) return reply.code(502).send({ ok: false, error: r.error });
    return { ok: true, messageId: r.messageId };
  });

  /** 邮件投递：把「发给自己」的邮件收进收件箱。dryRun 只看不收 */
  app.post('/api/inbox/mail', async (req) => {
    const b = (req.body ?? {}) as { dryRun?: boolean; limit?: number };
    return { ok: true, report: await ingestMail(hab, { dryRun: b.dryRun !== false, limit: b.limit }) };
  });

  app.post('/api/notify/run', async (req) => {
    const b = (req.body ?? {}) as { dryRun?: boolean };
    return { ok: true, report: await runReminders(hab, { dryRun: b.dryRun === true }) };
  });

  /* ---------------- 通知 ---------------- */

  app.get('/api/notifications', async (req) => {
    const q = req.query as { limit?: string };
    return new Notifier(hab.store).list(Number(q.limit ?? 50));
  });

  app.post('/api/notifications/read', async (req) => {
    const b = (req.body ?? {}) as { id?: string };
    const n = await new Notifier(hab.store).markRead(b.id);
    return { ok: true, marked: n };
  });

  /* ---------------- 系统域 ---------------- */

  app.get('/api/system', async () => {
    const s = hab.stats();
    const today = nowISO().slice(0, 10);
    const evs = await hab.journal.query({ since: today, limit: 10000 });
    return {
      space: hab.store.space,
      stats: s,
      storage: {
        adapter: hab.store.adapter.name,
        capabilities: hab.store.adapter.capabilities,
        root: hab.store.root,
        wpsNotice: hab.store.wps.notice,
        assets: hab.store.assets,
        assetBytes: s.assetBytes,
      },
      budget: {
        dailyProposalLimit: Number(process.env.HABITAT_DAILY_PROPOSALS ?? 3),
        // 只统计 agent 的：这个数字是给「AI 会不会烦人」看的，人自己改东西不算消耗
        usedToday: (await changesetsToday(hab.store, today)).filter((c) => String(c.author ?? '').startsWith('agent:')).length,
      },
      health: {
        unresolvedLinks: s.unresolved,
        links: s.links,
        resolveRate: s.links ? +(1 - s.unresolved / s.links).toFixed(3) : 1,
        indexDocs: hab.index.stats().docs,
      },
    };
  });

  app.post('/api/system/reindex', async () => {
    await hab.rescan();
    return { ok: true, stats: hab.stats(), index: hab.index.stats() };
  });

  app.post('/api/system/rescan', async () => {
    await hab.rescan();
    return { ok: true, stats: hab.stats() };
  });

  /* ---------------- 自动化闭环 ---------------- */

  app.get('/api/loops', async () => ({ ...(await computeStatuses(hab)), loops: LOOPS }));

  app.get('/api/loops/check', async () => checkAutomation(hab));

  app.get('/api/loops/brief', async () => ({ brief: await agentBrief(hab) }));

  app.get('/api/loops/receipts', async (req) => {
    const q = (req.query ?? {}) as { loop?: string; limit?: string };
    const all = await readReceipts(hab);
    const filtered = q.loop ? all.filter((r) => r.loop === q.loop) : all;
    return { receipts: filtered.slice(-Number(q.limit ?? 100)) };
  });

  app.get('/api/loops/manual', async (_req, reply) =>
    reply.type('text/markdown; charset=utf-8').send(renderManual({ generatedAt: nowISO() })),
  );

  /** 空间级操作手册：和 `habitat loops init` 写到空间根的是同一份内容 */
  app.get('/api/loops/guide', async (_req, reply) =>
    reply.type('text/markdown; charset=utf-8').send(
      renderSpaceGuide({ space: hab.store.space.name || hab.store.root, generatedAt: nowISO() }),
    ),
  );

  app.post('/api/loops/conformance', async (req) => {
    const b = (req.body ?? {}) as { harness?: HarnessProfile };
    return conformance(hab, b.harness);
  });

  app.get('/api/loops/leases', async () => ({ leases: await listLeases(hab) }));

  app.get('/api/loops/claims', async (req) => {
    const q = (req.query ?? {}) as { loop?: string };
    return { claims: await listClaims(hab, q.loop) };
  });

  app.post('/api/loops/alerts', async (req) => {
    const b = (req.body ?? {}) as { mail?: boolean };
    return { ok: true, report: await runLoopAlerts(hab, { mail: b.mail === true }) };
  });

  app.get('/api/loops/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const def = loopById(id);
    if (!def) return reply.code(404).send({ error: `没有这条闭环：${id}` });
    const status = await computeStatuses(hab);
    const receipts = await readReceipts(hab);
    return {
      loop: def,
      status: status.states.find((s) => s.id === id),
      claims: (await listClaims(hab, id)),
      recent: receipts.filter((r) => r.loop === id).slice(-10).reverse(),
    };
  });

  app.post('/api/loops/:id/config', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!loopById(id)) return reply.code(404).send({ error: `没有这条闭环：${id}` });
    const b = (req.body ?? {}) as { enabled?: boolean; owner?: string; note?: string };
    const cfg = await loadAutomation(hab);
    cfg.loops[id] = { ...(cfg.loops[id] ?? {}), ...b };
    await saveAutomation(hab, cfg);
    return { ok: true, config: cfg.loops[id] };
  });

  app.post('/api/loops/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!loopById(id)) return reply.code(404).send({ error: `没有这条闭环：${id}` });
    const b = (req.body ?? {}) as { dryRun?: boolean; force?: boolean; out?: string; fetch?: boolean; mail?: boolean };
    const actor = actorOf(b, req.headers);
    const r = await runLoop(hab, id, { ...b, actor });
    return reply.code(r.result === 'fail' ? 500 : 200).send({ ok: r.result !== 'fail', ...r });
  });

  app.post('/api/loops/:id/claim', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!loopById(id)) return reply.code(404).send({ error: `没有这条闭环：${id}` });
    const b = (req.body ?? {}) as { target?: string; ttlMin?: number };
    if (!b.target) return reply.code(400).send({ error: 'target 不能为空（对象 id 或断链目标）' });
    const by = String(actorOf(b, req.headers));
    const r = await claimTarget(hab, id, b.target, by, b.ttlMin);
    return (r.ok ? reply.code(201) : reply.code(409)).send({ ...r });
  });

  app.post('/api/loops/:id/release', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { by?: string };
    const n = await releaseClaims(hab, id, b.by);
    return { ok: true, released: n };
  });

  app.post('/api/loops/:id/beat', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!loopById(id)) return reply.code(404).send({ error: `没有这条闭环：${id}` });
    const b = (req.body ?? {}) as { ok?: boolean; note?: string; produced?: string[]; counts?: Record<string, number> };
    const r = await beat(hab, id, { ...b, actor: actorOf(b, req.headers) });
    return reply.code(201).send({ ok: true, receipt: r });
  });

  app.get('/api/agent/manifest', async () => ({
    manifest: buildManifest(hab),
  }));

  app.post('/api/agent/reconcile', async () => ({ ok: true, report: await hab.doReconcile() }));

  app.get('/api/health', async () => ({ ok: true, space: hab.store.root, objects: hab.store.objects.size }));
}, { name: 'habitat-api' });

/* ---------------- 能力清单 ---------------- */

export interface Capability {
  id: string;
  name: string;
  human: string;
  agent: string;
  writes: string;
  event: string;
  command: string;
  mutating: boolean;
}

export function buildManifest(hab: Habitat): {
  space: string;
  generatedAt: string;
  capabilities: Capability[];
  automation: { list: string; check: string; manual: string; guide: string; run: string; beat: string };
  loops: { id: string; name: string; mode: string; autonomy: string; trigger: string; requires: string[]; entry: { cli?: string; api?: string; mcp?: string; ui?: string; command?: string }; backlog?: string }[];
} {
  const root = hab.store.root;
  return {
    space: root,
    generatedAt: nowISO(),
    automation: {
      list: 'GET /api/loops',
      check: 'GET /api/loops/check',
      manual: 'GET /api/loops/manual',
      guide: 'GET /api/loops/guide',
      run: 'POST /api/loops/:id/run {dryRun, force}',
      beat: 'POST /api/loops/:id/beat {ok, note, produced[]}',
    },
    loops: LOOPS.map((d) => ({
      id: d.id,
      name: d.name,
      mode: d.mode,
      autonomy: d.autonomy,
      trigger: d.trigger.kind === 'interval'
        ? `every ${d.trigger.minutes}m`
        : d.trigger.kind === 'daily'
          ? `daily ${d.trigger.at}`
          : d.trigger.kind === 'event'
            ? `event: ${d.trigger.on}`
            : `manual: ${d.trigger.note ?? ''}`,
      requires: d.requires,
      entry: d.entry,
      backlog: d.backlog,
    })),
    capabilities: [
      {
        id: 'search',
        name: '检索',
        human: '检索页输入关键词，或命令面板 ⌘K',
        agent: 'GET /api/search?q=&type=',
        writes: '不写',
        event: '无（派生操作不记事件）',
        command: 'habitat search "关键词"',
        mutating: false,
      },
      {
        id: 'read',
        name: '读对象与正文',
        human: '书架点章节，右侧阅读器',
        agent: 'GET /api/objects?type=work｜GET /api/reps/:id/content',
        writes: '不写（只写阅读位置）',
        event: 'read',
        command: 'habitat read <rep-id>',
        mutating: false,
      },
      {
        id: 'capture',
        name: '采集',
        human: '命令面板「采集」或收件箱新建',
        agent: 'POST /api/capture {title, body}',
        writes: 'inbox/ 或 knowledge/notes/*.md',
        event: 'capture',
        command: 'habitat capture "标题" --body "…"',
        mutating: true,
      },
      {
        id: 'derive',
        name: '衍生笔记',
        human: '阅读器选中正文 → 衍生笔记',
        agent: 'POST /api/derive {srcId, title, body}',
        writes: 'knowledge/notes/*.md',
        event: 'derive',
        command: 'habitat derive --src <id> --title "…"',
        mutating: true,
      },
      {
        id: 'annotate',
        name: '批注',
        human: '阅读器选中正文 → 高亮/批注',
        agent: 'POST /api/annotate {repId, quote, from, to}',
        writes: 'knowledge/annotations/<repId>.jsonl',
        event: 'annotate',
        command: 'habitat annotate --rep <id> --quote "…"',
        mutating: true,
      },
      {
        id: 'unannotate',
        name: '删批注',
        human: '阅读器边注「删除」',
        agent: 'DELETE /api/annotations/:id',
        writes: 'knowledge/annotations/<repId>.jsonl（摘掉一行）',
        event: 'unannotate',
        command: 'habitat annotate --remove <ann-id>',
        mutating: true,
      },
      {
        id: 'propose',
        name: '提案与提交',
        human: 'AI 域「变更」页逐条确认',
        agent: 'POST /api/changes {ops, reason} → POST /api/changes/:id/commit',
        writes: '提交时才写内容文件',
        event: 'propose → commit',
        command: 'habitat propose --ops ops.json',
        mutating: true,
      },
      {
        id: 'journal',
        name: '记账',
        human: '接入页看事件流',
        agent: 'POST /api/journal {op, target, summary}',
        writes: '.habitat/journal/YYYY-MM.jsonl',
        event: '任意 op',
        command: 'habitat agent log --op build --target "…" --summary "…"',
        mutating: true,
      },
      {
        id: 'reconcile',
        name: '对账',
        human: '系统域「健康恢复」点「对账」',
        agent: 'POST /api/agent/reconcile',
        writes: '.habitat/state/snapshot.json + 事件流',
        event: 'external_edit / reconcile',
        command: 'habitat agent reconcile',
        mutating: true,
      },
      {
        id: 'reindex',
        name: '重建索引',
        human: '系统域点「重建索引」',
        agent: 'POST /api/system/reindex',
        writes: '.habitat/state/habitat.db',
        event: 'build',
        command: 'habitat reindex',
        mutating: false,
      },
    ],
  };
}
