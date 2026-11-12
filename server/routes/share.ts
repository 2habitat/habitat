/**
 * 分享的 HTTP 面：一半对外（/s/:token，只读），一半对内（/api/shares）。
 *
 * 对外只暴露「这一份抽印本里的东西」：
 *   - 页面只从 ShareService.scopeOf 取对象，白名单之外连标题都不会出现；
 *   - 图片只允许读分享内容所在目录与 assets/，不做整库静态服务；
 *   - PDF / EPUB 默认不提供下载，要主人在创建时显式打开。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Collection, Id, Note, Part, Rep, Share, Work, Author } from '../../shared/types.ts';
import { countChars, parseDoc, stripLeadingH1 } from '../../shared/frontmatter.ts';
import { safeJoin } from '../core/storage.ts';
import type { Habitat } from '../core/space.ts';
import { ShareService, type ShareScope } from '../core/shares.ts';
import {
  renderSharePage, renderPublicMarkdown, esc, formatDay, formatWords, excerptOf,
  type Chrome, type Crumb, type IndexEntry, type ChapterEntry, type SharePageModel,
} from '../share-page.ts';

export interface ShareRouteOpts {
  hab: Habitat;
}

const KIND_LABEL: Record<string, string> = {
  point: '笔记', summary: '摘要', outline: '提纲', question: '问题', report: '报告',
};
const STATUS_LABEL: Record<string, string> = { seedling: '幼苗', growing: '生长', evergreen: '常青' };
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
};

function baseUrlOf(req: FastifyRequest): string {
  const env = (process.env.HABITAT_PUBLIC_URL ?? '').trim();
  if (env) return env.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
    || (req.protocol ?? 'http');
  const host = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim()
    || String(req.headers.host ?? '127.0.0.1:8787');
  return `${proto}://${host}`;
}

function actorOf(req: FastifyRequest): Author {
  const h = String(req.headers['x-habitat-actor'] ?? '').trim();
  return h && h !== 'human' ? (`agent:${h}` as Author) : 'human';
}

function cookieOf(req: FastifyRequest, key: string): string {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== key) continue;
    return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeExpiry(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const raw = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T23:59:59`; // 到期日当天仍可读
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new Error('到期时间看不懂，请用日期或 ISO 时间');
  return new Date(t).toISOString();
}

function normalizePublicPath(input: string): string | null {
  const q = input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\0/g, '');
  if (!q) return null;
  const n = path.posix.normalize(q);
  if (n === '..' || n.startsWith('../') || n.startsWith('/')) return null;
  return n;
}

export function registerShareRoutes(app: FastifyInstance, opts: ShareRouteOpts): void {
  const hab = opts.hab;
  const store = hab.store;
  const shares = new ShareService(hab, () => (process.env.HABITAT_PUBLIC_URL ?? '').trim().replace(/\/+$/, ''));

  const spaceName = (): string => store.space.name || '未命名空间';

  const chromeOf = (share: Share): Chrome => ({
    token: share.token,
    title: share.title,
    space: spaceName(),
    byline: share.byline?.trim() || spaceName(),
  });

  /* ---------------- 读取正文与词数 ---------------- */

  const wordCache = new Map<Id, { key: string; words: number }>();

  async function docOf(id: Id): Promise<{ rel: string; body: string; words: number }> {
    const rel = store.file(id) ?? '';
    const o = store.get(id);
    const st = rel ? await store.adapter.stat(rel) : null;
    const key = `${st?.mtime ?? ''}|${st?.bytes ?? 0}|${o?.rev ?? 0}`;
    const cached = wordCache.get(id);
    if (cached?.key === key) {
      const body = o?.type === 'note' ? (o as Note).body : rel ? parseDoc(await store.adapter.read(rel)).body : '';
      return { rel, body, words: cached.words };
    }
    let body = '';
    if (o?.type === 'note') body = (o as Note).body ?? '';
    else if (rel.endsWith('.md')) body = parseDoc(await store.adapter.read(rel)).body;
    const words = countChars(body);
    if (wordCache.size > 800) wordCache.clear();
    wordCache.set(id, { key, words });
    return { rel, body, words };
  }

  /** 只取字数：目录页不需要把每章正文都留在内存里 */
  async function wordsOf(id: Id): Promise<number> {
    const rel = store.file(id);
    const o = store.get(id);
    const st = rel ? await store.adapter.stat(rel) : null;
    const key = `${st?.mtime ?? ''}|${st?.bytes ?? 0}|${o?.rev ?? 0}`;
    const cached = wordCache.get(id);
    if (cached?.key === key) return cached.words;
    let body = '';
    if (o?.type === 'note') body = (o as Note).body ?? '';
    else if (rel) body = parseDoc(await store.adapter.read(rel)).body;
    const words = countChars(body);
    if (wordCache.size > 800) wordCache.clear();
    wordCache.set(id, { key, words });
    return words;
  }

  /* ---------------- 公开链接构造 ---------------- */

  const tokenOf = (share: Share): string => encodeURIComponent(share.token);
  const pageUrl = (share: Share): string => `/s/${tokenOf(share)}`;
  const workUrl = (share: Share, workId: Id): string => `/s/${tokenOf(share)}/w/${encodeURIComponent(workId)}`;
  const chapterUrl = (share: Share, workId: Id, partId: Id): string =>
    `/s/${tokenOf(share)}/w/${encodeURIComponent(workId)}/c/${encodeURIComponent(partId)}`;
  const noteUrl = (share: Share, noteId: Id): string => `/s/${tokenOf(share)}/n/${encodeURIComponent(noteId)}`;
  const topicUrl = (share: Share, collectionId: Id): string => `/s/${tokenOf(share)}/t/${encodeURIComponent(collectionId)}`;

  function hrefResolver(share: Share, scope: ShareScope, currentRel: string): (href: string) => string | null {
    const map = new Map<string, string>();
    for (const n of scope.notes) {
      const rel = store.file(n.id);
      if (rel) map.set(rel, noteUrl(share, n.id));
    }
    for (const [workId, parts] of scope.partsOf) {
      for (const p of parts) {
        const rel = store.file(p.id);
        if (rel) map.set(rel, chapterUrl(share, workId, p.id));
      }
    }
    return (href: string): string | null => {
      if (!href || href.startsWith('#') || href.startsWith('/') || /^[a-z]+:/i.test(href)) return null;
      const [beforeHash, hash] = href.split('#');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(currentRel), beforeHash));
      const hit = map.get(resolved);
      return hit ? `${hit}${hash ? `#${hash}` : ''}` : null;
    };
  }

  function wikiResolver(share: Share, scope: ShareScope): (target: string) => { href: string; label: string } | null {
    return (raw: string) => {
      const target = raw.trim();
      if (!target) return null;
      const o = store.byStem(target) ?? store.get(target);
      if (!o) return null;
      if (o.type === 'note' && scope.noteIds.has(o.id)) {
        return { href: noteUrl(share, o.id), label: (o as Note).title };
      }
      if (o.type === 'work' && scope.workIds.has(o.id)) {
        return { href: workUrl(share, o.id), label: (o as Work).title };
      }
      if (o.type === 'part' && scope.partIds.has(o.id)) {
        return { href: chapterUrl(share, (o as Part).workId, o.id), label: (o as Part).title };
      }
      if (o.type === 'collection' && scope.collectionIds.has(o.id)) {
        return { href: topicUrl(share, o.id), label: (o as Collection).title };
      }
      return null;
    };
  }

  /* ---------------- 页面数据 ---------------- */

  function pageMeta(share: Share, scope: ShareScope): string {
    const updated = [
      ...scope.works.map((w) => w.updatedAt),
      ...scope.notes.map((n) => n.updatedAt),
      ...scope.collections.map((c) => c.updatedAt),
    ].sort().pop();
    const bits: string[] = [];
    if (scope.works.length) bits.push(`<b>${scope.works.length}</b> 本书`);
    if (scope.collections.length) bits.push(`<b>${scope.collections.length}</b> 个专题`);
    if (scope.notes.length) bits.push(`<b>${scope.notes.length}</b> 篇笔记`);
    bits.push(`更新于 ${formatDay(updated ?? share.updatedAt)}`);
    return bits.join('<span aria-hidden="true">·</span>');
  }

  async function workEntry(share: Share, scope: ShareScope, w: Work): Promise<IndexEntry> {
    const parts = scope.partsOf.get(w.id) ?? [];
    const words = (await Promise.all(parts.map((p) => wordsOf(p.id)))).reduce((a, b) => a + b, 0);
    return {
      href: workUrl(share, w.id),
      title: w.title,
      meta: `${parts.length} 章 · ${formatWords(words)}`,
      desc: w.desc?.trim() || undefined,
    };
  }

  function noteEntry(share: Share, n: Note): IndexEntry {
    return {
      href: noteUrl(share, n.id),
      title: n.title,
      tag: KIND_LABEL[n.kind] ?? '笔记',
      meta: `${formatWords(countChars(n.body ?? ''))} · ${formatDay(n.updatedAt)}`,
      desc: excerptOf(n.body ?? ''),
    };
  }

  function topicEntry(share: Share, scope: ShareScope, c: Collection): IndexEntry {
    const members = (c.memberIds ?? []).filter((id) => scope.noteIds.has(id) || scope.workIds.has(id) || scope.partIds.has(id));
    return {
      href: topicUrl(share, c.id),
      title: c.title,
      meta: `${members.length} 项`,
      desc: c.desc?.trim() || undefined,
    };
  }

  async function indexPage(share: Share): Promise<SharePageModel> {
    const scope = shares.scopeOf(share);
    return {
      kind: 'index',
      chrome: chromeOf(share),
      intro: share.intro?.trim() || undefined,
      meta: pageMeta(share, scope),
      books: await Promise.all(scope.works.map((w) => workEntry(share, scope, w))),
      topics: scope.collections.map((c) => topicEntry(share, scope, c)),
      notes: scope.notes.map((n) => noteEntry(share, n)),
    };
  }

  async function workPage(share: Share, workId: Id): Promise<SharePageModel | null> {
    const scope = shares.scopeOf(share);
    const work = store.get<Work>(workId);
    if (!work || work.type !== 'work' || !scope.workIds.has(work.id)) return null;
    const parts = scope.partsOf.get(work.id) ?? [];
    const main = parts.filter((p) => !p.supplemental);
    const supp = parts.filter((p) => p.supplemental);
    const entries = await Promise.all(parts.map(async (p, i) => ({
      href: chapterUrl(share, work.id, p.id),
      title: p.title,
      no: i + 1,
      words: await wordsOf(p.id),
    })));
    const byId = new Map(entries.map((e) => [e.href, e]));
    const mainEntries = main.map((p) => byId.get(chapterUrl(share, work.id, p.id))!).filter(Boolean);
    const suppEntries = supp.map((p) => byId.get(chapterUrl(share, work.id, p.id))!).filter(Boolean);
    const total = entries.reduce((a, b) => a + b.words, 0);
    return {
      kind: 'work',
      chrome: chromeOf(share),
      title: work.title,
      desc: work.desc?.trim() || undefined,
      meta: `<b>${entries.length}</b> 章<span aria-hidden="true">·</span>约 ${formatWords(total)}<span aria-hidden="true">·</span>更新于 ${formatDay(work.updatedAt)}`,
      chapters: mainEntries,
      supplements: suppEntries,
      startHref: (mainEntries[0] ?? suppEntries[0])?.href,
    };
  }

  async function chapterPage(share: Share, workId: Id, partId: Id): Promise<SharePageModel | null> {
    const scope = shares.scopeOf(share);
    const part = store.get<Part>(partId);
    if (!part || part.type !== 'part' || part.workId !== workId) return null;
    if (!scope.partIds.has(part.id)) return null;
    const work = store.get<Work>(workId);
    if (!work) return null;
    const list = scope.partsOf.get(workId) ?? [];
    const idx = list.findIndex((p) => p.id === part.id);
    if (idx < 0) return null;
    const doc = await docOf(part.id);
    const body = stripLeadingH1(doc.body);
    const rel = doc.rel;
    const html = renderPublicMarkdown(body, {
      token: share.token,
      rel,
      hrefOf: hrefResolver(share, scope, rel),
      wikiOf: wikiResolver(share, scope),
    });
    const at = (n: number) => list[n];
    const link = (p: Part | undefined) => (p ? { href: chapterUrl(share, workId, p.id), title: p.title } : undefined);
    const kicker = part.supplemental ? '补充材料' : `第 ${idx + 1} 章`;
    return {
      kind: 'chapter',
      chrome: chromeOf(share),
      crumbs: [
        { label: share.title, href: pageUrl(share) },
        { label: work.title, href: workUrl(share, work.id) },
        { label: part.title },
      ],
      title: part.title,
      kicker,
      no: idx + 1,
      meta: `${esc(work.title)}<span aria-hidden="true">·</span>${formatWords(doc.words)}<span aria-hidden="true">·</span>更新于 ${formatDay(part.updatedAt)}`,
      bodyHtml: html,
      prev: link(at(idx - 1)),
      next: link(at(idx + 1)),
      tocHref: workUrl(share, work.id),
      rail: work.title,
    };
  }

  function notePage(share: Share, noteId: Id): SharePageModel | null {
    const scope = shares.scopeOf(share);
    const note = store.get<Note>(noteId);
    if (!note || note.type !== 'note' || !scope.noteIds.has(note.id)) return null;
    const rel = store.file(note.id) ?? '';
    const body = stripLeadingH1(note.body ?? '');
    const html = renderPublicMarkdown(body, {
      token: share.token,
      rel,
      hrefOf: hrefResolver(share, scope, rel),
      wikiOf: wikiResolver(share, scope),
    });
    return {
      kind: 'note',
      chrome: chromeOf(share),
      crumbs: [
        { label: share.title, href: pageUrl(share) },
        { label: KIND_LABEL[note.kind] ?? '笔记' },
        { label: note.title },
      ],
      title: note.title,
      meta: `${KIND_LABEL[note.kind] ?? '笔记'}<span aria-hidden="true">·</span>${STATUS_LABEL[note.status] ?? note.status}<span aria-hidden="true">·</span>${formatWords(countChars(note.body ?? ''))}<span aria-hidden="true">·</span>更新于 ${formatDay(note.updatedAt)}`,
      bodyHtml: html,
      tags: note.tags ?? [],
      rail: '笔记',
    };
  }

  async function topicPage(share: Share, collectionId: Id): Promise<SharePageModel | null> {
    const scope = shares.scopeOf(share);
    const c = store.get<Collection>(collectionId);
    if (!c || c.type !== 'collection' || !scope.collectionIds.has(c.id)) return null;
    const books: IndexEntry[] = [];
    const notes: IndexEntry[] = [];
    for (const id of c.memberIds ?? []) {
      const o = store.get(id);
      if (!o) continue;
      if (o.type === 'work' && scope.workIds.has(o.id)) books.push(await workEntry(share, scope, o as Work));
      else if (o.type === 'note' && scope.noteIds.has(o.id)) notes.push(noteEntry(share, o as Note));
      else if (o.type === 'part' && scope.partIds.has(o.id)) {
        const p = o as Part;
        const w = store.get<Work>(p.workId);
        books.push({
          href: chapterUrl(share, p.workId, p.id),
          title: p.title,
          meta: w ? `《${w.title}》` : '章节',
        });
      }
    }
    return {
      kind: 'topic',
      chrome: chromeOf(share),
      title: c.title,
      desc: c.desc?.trim() || undefined,
      meta: `<b>${books.length + notes.length}</b> 项<span aria-hidden="true">·</span>更新于 ${formatDay(c.updatedAt)}`,
      books,
      notes,
    };
  }

  /* ---------------- 响应 ---------------- */

  function sendPage(reply: FastifyReply, html: string, code = 200): FastifyReply {
    return reply.code(code)
      .headers({
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow, noarchive',
      })
      .send(html);
  }

  function sendError(reply: FastifyReply, token: string, state: 'missing' | 'paused' | 'expired'): FastifyReply {
    const model: SharePageModel = state === 'missing'
      ? {
        kind: 'error',
        chrome: { token, title: '抽印本', space: spaceName(), byline: spaceName() },
        title: '这个链接打不开',
        message: '地址里没有对应的抽印本。可能是链接抄漏了一段，也可能主人收回了这次分享。',
        tone: 'muted',
      }
      : state === 'paused'
        ? {
          kind: 'error',
          chrome: { token, title: '抽印本', space: spaceName(), byline: spaceName() },
          title: '分享已暂停',
          message: '主人暂时关上了这扇窗。稍后再试，或向对方要一个新链接。',
          tone: 'closed',
        }
        : {
          kind: 'error',
          chrome: { token, title: '抽印本', space: spaceName(), byline: spaceName() },
          title: '分享已到期',
          message: '这份抽印本的有效期到了。需要继续阅读，请向主人要一个新链接。',
          tone: 'closed',
        };
    return sendPage(reply, renderSharePage(model), state === 'missing' ? 404 : 410);
  }

  function visitor(req: FastifyRequest, reply: FastifyReply): string {
    const existing = cookieOf(req, 'hb_v');
    const vid = /^[a-f0-9]{16,64}$/i.test(existing) ? existing : randomBytes(12).toString('hex');
    const secure = String(req.headers['x-forwarded-proto'] ?? '').includes('https');
    if (vid !== existing) {
      reply.header('set-cookie', `hb_v=${vid}; Path=/s; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`);
    }
    return vid;
  }

  /** 只记外部来源；站内翻页不算「从哪来的」，否则每条都是自己的域名 */
  function refOf(req: FastifyRequest): string | undefined {
    const ref = String(req.headers.referer ?? '');
    const host = hostOf(ref);
    const self = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim().toLowerCase();
    if (!host || host === self) return undefined;
    return ref;
  }

  async function guard(
    req: FastifyRequest,
    reply: FastifyReply,
    token: string,
  ): Promise<{ share: Share; scope: ShareScope } | null> {
    if (!shares.allow(req.ip)) {
      reply.code(429).type('text/plain; charset=utf-8').send('访问太频繁，请一分钟后再试。');
      return null;
    }
    const share = shares.byToken(token);
    const state = shares.stateOf(share);
    if (!share || state !== 'ok') {
      sendError(reply, token, state === 'ok' ? 'missing' : state);
      return null;
    }
    return { share, scope: shares.scopeOf(share) };
  }

  const log = async (share: Share, req: FastifyRequest, reply: FastifyReply, item?: Id, kind?: 'work' | 'part' | 'note' | 'collection'): Promise<void> => {
    await shares.recordView({
      share,
      path: String(req.url).split('?')[0],
      item,
      kind,
      vid: visitor(req, reply),
      ref: refOf(req),
    });
  };

  /* ---------------- 对外页面 ---------------- */

  app.get('/s/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const g = await guard(req, reply, token);
    if (!g) return reply;
    const model = await indexPage(g.share);
    await log(g.share, req, reply);
    return sendPage(reply, renderSharePage(model));
  });

  app.get('/s/:token/w/:workId', async (req, reply) => {
    const { token, workId } = req.params as { token: string; workId: string };
    const g = await guard(req, reply, token);
    if (!g) return reply;
    const model = await workPage(g.share, workId);
    if (!model) return sendError(reply, token, 'missing');
    await log(g.share, req, reply, workId, 'work');
    return sendPage(reply, renderSharePage(model));
  });

  app.get('/s/:token/w/:workId/c/:partId', async (req, reply) => {
    const { token, workId, partId } = req.params as { token: string; workId: string; partId: string };
    const g = await guard(req, reply, token);
    if (!g) return reply;
    const model = await chapterPage(g.share, workId, partId);
    if (!model) return sendError(reply, token, 'missing');
    await log(g.share, req, reply, partId, 'part');
    return sendPage(reply, renderSharePage(model));
  });

  app.get('/s/:token/n/:noteId', async (req, reply) => {
    const { token, noteId } = req.params as { token: string; noteId: string };
    const g = await guard(req, reply, token);
    if (!g) return reply;
    const model = notePage(g.share, noteId);
    if (!model) return sendError(reply, token, 'missing');
    await log(g.share, req, reply, noteId, 'note');
    return sendPage(reply, renderSharePage(model));
  });

  app.get('/s/:token/t/:collectionId', async (req, reply) => {
    const { token, collectionId } = req.params as { token: string; collectionId: string };
    const g = await guard(req, reply, token);
    if (!g) return reply;
    const model = await topicPage(g.share, collectionId);
    if (!model) return sendError(reply, token, 'missing');
    await log(g.share, req, reply, collectionId, 'collection');
    return sendPage(reply, renderSharePage(model));
  });

  /** 正文里的相对图片。只认分享内容所在目录与 assets/，并且只发图片类型。 */
  app.get('/s/:token/raw', async (req, reply) => {
    const { token } = req.params as { token: string };
    const q = req.query as { p?: string };
    const g = await guard(req, reply, token);
    if (!g) return reply;
    const rel = normalizePublicPath(String(q.p ?? ''));
    if (!rel) return reply.code(400).send({ error: '路径不合法' });

    const roots = new Set<string>(['assets/']);
    for (const n of g.scope.notes) {
      const r = store.file(n.id);
      if (r) roots.add(`${path.posix.dirname(r)}/`);
    }
    for (const p of g.scope.parts) {
      const r = store.file(p.id);
      if (r) roots.add(`${path.posix.dirname(r)}/`);
    }
    for (const w of g.scope.works) {
      if (w.slug) roots.add(`knowledge/works/${w.slug}/`);
    }
    if (![...roots].some((r) => rel.startsWith(r))) {
      return reply.code(403).send({ error: '这份抽印本没有公开这个文件' });
    }

    const ext = path.posix.extname(rel).slice(1).toLowerCase();
    const type = IMAGE_TYPES[ext];
    if (!type) return reply.code(403).send({ error: '只提供图片文件' });
    try {
      safeJoin(store.root, rel);
    } catch {
      return reply.code(403).send({ error: '路径不合法' });
    }
    const buf = await store.adapter.readBytes(rel).catch(() => null);
    if (!buf) return reply.code(404).send({ error: '图片不存在' });
    return reply.headers({
      'content-type': type,
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
      ...(ext === 'svg' ? { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {}),
    }).send(Buffer.from(buf));
  });

  /** PDF / EPUB 原件下载：默认关闭，主人在创建时明确打开才给。 */
  app.get('/s/:token/d/:repId', async (req, reply) => {
    const { token, repId } = req.params as { token: string; repId: string };
    const g = await guard(req, reply, token);
    if (!g) return reply;
    if (!g.share.allowDownload) return sendError(reply, token, 'missing');
    const rep = store.get<Rep>(repId);
    if (!rep || rep.type !== 'rep' || !g.scope.partIds.has(rep.partId)) return sendError(reply, token, 'missing');
    const rel = store.file(rep.id) ?? rep.path;
    if (!rel) return reply.code(404).send({ error: '原件不存在' });
    const ext = path.posix.extname(rel).slice(1).toLowerCase();
    if (ext !== 'pdf' && ext !== 'epub') return reply.code(403).send({ error: '这个格式不提供下载' });
    const abs = safeJoin(store.root, rel);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) return reply.code(404).send({ error: '原件不存在' });
    const type = ext === 'pdf' ? 'application/pdf' : 'application/epub+zip';
    const name = rel.split('/').pop() ?? `original.${ext}`;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) {
          return reply.code(416).header('content-range', `bytes */${st.size}`).send();
        }
        return reply.code(206).headers({
          'content-type': type,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${st.size}`,
          'accept-ranges': 'bytes',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'cache-control': 'private, max-age=0',
        }).send(fs.createReadStream(abs, { start, end }));
      }
    }
    return reply.headers({
      'content-type': type,
      'content-length': String(st.size),
      'accept-ranges': 'bytes',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, max-age=0',
      'x-content-type-options': 'nosniff',
    }).send(fs.createReadStream(abs));
  });

  /* ---------------- 对内管理接口 ---------------- */

  app.get('/api/shares', async (req) => {
    const list = shares.list();
    const stats = await shares.statsAll(list, 14);
    const base = baseUrlOf(req);
    const overview = await shares.overview(list);
    return {
      ok: true,
      baseUrl: base,
      baseUrlHint: !process.env.HABITAT_PUBLIC_URL && /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1])/i.test(base),
      shares: list.map((s) => ({
        id: s.id,
        title: s.title,
        intro: s.intro ?? '',
        token: s.token,
        state: shares.stateOf(s),
        archivedAt: s.archivedAt ?? null,
        expiresAt: s.expiresAt ?? null,
        allowDownload: Boolean(s.allowDownload),
        byline: s.byline ?? '',
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        url: `${base}/s/${s.token}`,
        targets: shares.targetsOf(s),
        counts: shares.countsOf(s),
        stats: stats.get(s.id),
      })),
      totals: overview,
    };
  });

  app.get('/api/shares/options', async () => {
    const works = store.all<Work>('work')
      .filter((w) => !w.archivedAt)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((w) => ({
        id: w.id,
        title: w.title,
        desc: w.desc ?? '',
        chapters: store.all<Part>('part').filter((p) => p.workId === w.id).length,
        updatedAt: w.updatedAt,
      }));
    const collections = store.all<Collection>('collection')
      .filter((c) => !c.archivedAt)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((c) => ({
        id: c.id,
        title: c.title,
        desc: c.desc ?? '',
        members: (c.memberIds ?? []).length,
        updatedAt: c.updatedAt,
      }));
    const notes = store.all<Note>('note')
      .filter((n) => !n.archivedAt)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, 300)
      .map((n) => ({
        id: n.id,
        title: n.title,
        kind: n.kind,
        status: n.status,
        tags: n.tags ?? [],
        updatedAt: n.updatedAt,
      }));
    return { ok: true, works, collections, notes };
  });

  app.post('/api/shares', async (req, reply) => {
    const b = (req.body ?? {}) as {
      title?: string; intro?: string; targetIds?: string[]; expiresAt?: string | null;
      allowDownload?: boolean; byline?: string;
    };
    try {
      const share = await shares.create({
        title: String(b.title ?? ''),
        intro: b.intro ? String(b.intro) : undefined,
        targetIds: Array.isArray(b.targetIds) ? b.targetIds.map(String) : [],
        expiresAt: b.expiresAt ? normalizeExpiry(b.expiresAt) : undefined,
        allowDownload: Boolean(b.allowDownload),
        byline: b.byline ? String(b.byline) : undefined,
      }, actorOf(req));
      const base = baseUrlOf(req);
      return reply.code(201).send({
        ok: true,
        share: { ...share, url: `${base}/s/${share.token}` },
      });
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.patch('/api/shares/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as {
      title?: string; intro?: string; targetIds?: string[]; expiresAt?: string | null;
      allowDownload?: boolean; byline?: string; state?: 'active' | 'paused';
    };
    try {
      const share = await shares.update(id, {
        title: b.title,
        intro: b.intro,
        targetIds: b.targetIds,
        expiresAt: b.expiresAt === null ? null : b.expiresAt === undefined ? undefined : normalizeExpiry(b.expiresAt),
        allowDownload: b.allowDownload,
        byline: b.byline,
        state: b.state,
      }, actorOf(req));
      return { ok: true, share };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/api/shares/:id/rotate', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const share = await shares.rotate(id, actorOf(req));
      const base = baseUrlOf(req);
      return { ok: true, share: { ...share, url: `${base}/s/${share.token}` } };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/api/shares/:id/sync', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const share = await shares.sync(id, actorOf(req));
      return { ok: true, share };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/api/shares/:id/archive', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await shares.archive(id, actorOf(req));
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ ok: false, error: (e as Error).message });
    }
  });

  app.get('/api/shares/:id/stats', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { days?: string };
    const share = shares.byId(id);
    if (!share) return reply.code(404).send({ ok: false, error: '分享不存在或已归档' });
    const days = Number(q.days ?? 30);
    return { ok: true, stats: await shares.stats(share, Number.isFinite(days) ? days : 30) };
  });

}
