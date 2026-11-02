/**
 * SQLite 索引 —— 可随时删掉重建（habitat reindex）。文件才是事实源。
 * FTS5 自带的 unicode61 不切分中文（实测 "知识库管理" 是一个整 token，搜 "知识" 搜不到），
 * 所以入库前先把 CJK 串展开成 2-gram。
 */
import Database from 'better-sqlite3';
import type { AnyObject, Id } from '../../shared/types.ts';
import type { Store } from './store.ts';

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

export function tokenize(text: string): string {
  const out: string[] = [];
  let buf = '';
  let bufCjk = false;
  const flush = () => {
    if (!buf) return;
    if (bufCjk) {
      if (buf.length === 1) out.push(buf);
      else for (let i = 0; i < buf.length - 1; i += 1) out.push(buf.slice(i, i + 2));
    } else {
      out.push(buf.toLowerCase());
    }
    buf = '';
  };
  for (const ch of text) {
    const isCjk = CJK.test(ch);
    const isWord = /[A-Za-z0-9_]/.test(ch);
    if (isCjk) {
      if (buf && !bufCjk) flush();
      buf += ch;
      bufCjk = true;
    } else if (isWord) {
      if (buf && bufCjk) flush();
      buf += ch;
      bufCjk = false;
    } else {
      flush();
    }
  }
  flush();
  return out.join(' ');
}

function escapeToken(t: string): string {
  return `"${t.replace(/"/g, '""')}"`;
}

/** 把用户输入变成 FTS5 能吃的查询串 */
export function buildQuery(q: string): string {
  const toks = tokenize(q).split(' ').filter(Boolean);
  if (toks.length === 0) return '""';
  return toks
    .map((t) => (t.length >= 3 && !CJK.test(t) ? `${escapeToken(t)}*` : escapeToken(t)))
    .join(' AND ');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs(
  id TEXT PRIMARY KEY,
  type TEXT,
  title TEXT,
  body TEXT,
  path TEXT,
  work_id TEXT,
  updated_at TEXT,
  rev INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  id UNINDEXED, title, body, tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS links(
  from_id TEXT, to_stem TEXT, to_id TEXT
);
CREATE TABLE IF NOT EXISTS tags(
  object_id TEXT, tag TEXT
);
CREATE TABLE IF NOT EXISTS journal(
  id TEXT PRIMARY KEY, at TEXT, actor TEXT, op TEXT, phase TEXT, target TEXT, summary TEXT
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_docs_type ON docs(type);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);
CREATE INDEX IF NOT EXISTS idx_journal_at ON journal(at);
`;

export interface SearchHit {
  id: Id;
  type: string;
  title: string;
  path: string;
  snippet: string;
  score: number;
}

export interface IndexReport {
  objects: number;
  links: number;
  tags: number;
  journal: number;
  ms: number;
}

export class SearchIndex {
  db: Database.Database;

  constructor(public dbPath: string) {
    this.db = new Database(dbPath === ':memory:' ? ':memory:' : dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  async rebuild(store: Store, journalEvents: { id: string; at: string; actor: string; op: string; phase: string; target: string; summary: string }[] = []): Promise<IndexReport> {
    const t0 = Date.now();
    if (!this.db.open) return { objects: 0, links: 0, tags: 0, journal: 0, ms: 0 };
    // 章节正文存在文件里、不在对象上，得先把正文预读出来，否则检索只能搜到笔记
    const bodies = await loadBodies(store);
    // 预读是异步的，这中间可能已经被关掉了（提交回调还在飞）
    if (!this.db.open) return { objects: 0, links: 0, tags: 0, journal: 0, ms: 0 };
    this.db.exec('DELETE FROM docs; DELETE FROM fts; DELETE FROM links; DELETE FROM tags; DELETE FROM journal;');
    const insDoc = this.db.prepare(
      'INSERT OR REPLACE INTO docs(id,type,title,body,path,work_id,updated_at,rev) VALUES(?,?,?,?,?,?,?,?)',
    );
    const insFts = this.db.prepare('INSERT INTO fts(id,title,body) VALUES(?,?,?)');
    const insLink = this.db.prepare('INSERT INTO links(from_id,to_stem,to_id) VALUES(?,?,?)');
    const insTag = this.db.prepare('INSERT INTO tags(object_id,tag) VALUES(?,?)');
    const insEv = this.db.prepare(
      'INSERT OR REPLACE INTO journal(id,at,actor,op,phase,target,summary) VALUES(?,?,?,?,?,?,?)',
    );

    const tx = this.db.transaction(() => {
      for (const o of store.objects.values()) {
        const title = displayTitle(store, o);
        const workId = workIdOf(o);
        const body = bodySync(store, o) || bodies.get(o.id) || '';
        insDoc.run(o.id, o.type, title, body, store.file(o.id) ?? '', workId, o.updatedAt, o.rev);
        insFts.run(o.id, tokenize(title), tokenize(body));
        const tags = (o as { tags?: string[] }).tags ?? [];
        for (const tg of tags) insTag.run(o.id, tg);
      }
      for (const l of store.links) insLink.run(l.from, l.to, l.resolved ?? null);
      for (const e of journalEvents) insEv.run(e.id, e.at, e.actor, e.op, e.phase, e.target, e.summary);
    });
    tx();

    return {
      objects: store.objects.size,
      links: store.links.length,
      tags: (this.db.prepare('SELECT COUNT(*) c FROM tags').get() as { c: number }).c,
      journal: journalEvents.length,
      ms: Date.now() - t0,
    };
  }

  /** 单对象失效重插（提交后调用，不整库重建） */
  async upsert(store: Store, o: AnyObject): Promise<void> {
    const title = titleOf(o);
    const bodies = await loadBodies(store, [o.id]);
    const body = bodySync(store, o) || bodies.get(o.id) || '';
    this.db.prepare('INSERT OR REPLACE INTO docs(id,type,title,body,path,work_id,updated_at,rev) VALUES(?,?,?,?,?,?,?,?)')
      .run(o.id, o.type, title, body, store.file(o.id) ?? '', workIdOf(o), o.updatedAt, o.rev);
    this.db.prepare('DELETE FROM fts WHERE id = ?').run(o.id);
    this.db.prepare('INSERT INTO fts(id,title,body) VALUES(?,?,?)').run(o.id, tokenize(title), tokenize(body));
  }

  /**
   * 增量同步：只重插指定对象，顺带刷新它们的链接与标签。
   *
   * 为什么要有它：提交一次只改一两个对象，却要把全库正文重读一遍、全表重写一遍，
   * 一篇三万字的长笔记光分词就要几十毫秒。186 个对象实测整库重建 242ms，
   * 每次勾任务都等这么久，明显是浪费。
   */
  async syncObjects(store: Store, ids: string[]): Promise<void> {
    if (!this.db.open || !ids.length) return;
    const objs = [...new Set(ids)].map((id) => store.objects.get(id)).filter((o): o is AnyObject => !!o);
    if (!objs.length) return;
    const bodies = await loadBodies(store, objs.map((o) => o.id));
    if (!this.db.open) return;

    const delDoc = this.db.prepare('DELETE FROM docs WHERE id = ?');
    const delFts = this.db.prepare('DELETE FROM fts WHERE id = ?');
    const delLinks = this.db.prepare('DELETE FROM links WHERE from_id = ?');
    const delTags = this.db.prepare('DELETE FROM tags WHERE object_id = ?');
    const insDoc = this.db.prepare(
      'INSERT OR REPLACE INTO docs(id,type,title,body,path,work_id,updated_at,rev) VALUES(?,?,?,?,?,?,?,?)',
    );
    const insFts = this.db.prepare('INSERT INTO fts(id,title,body) VALUES(?,?,?)');
    const insLink = this.db.prepare('INSERT INTO links(from_id,to_stem,to_id) VALUES(?,?,?)');
    const insTag = this.db.prepare('INSERT INTO tags(object_id,tag) VALUES(?,?)');

    const tx = this.db.transaction(() => {
      for (const o of objs) {
        // 先清后插：标题、类型、正文都可能变，残留旧行会让检索结果对不上
        delDoc.run(o.id);
        delFts.run(o.id);
        delLinks.run(o.id);
        delTags.run(o.id);

        const title = displayTitle(store, o);
        const body = bodySync(store, o) || bodies.get(o.id) || '';
        insDoc.run(o.id, o.type, title, body, store.file(o.id) ?? '', workIdOf(o), o.updatedAt, o.rev);
        insFts.run(o.id, tokenize(title), tokenize(body));
        for (const tg of (o as { tags?: string[] }).tags ?? []) insTag.run(o.id, tg);
        for (const l of store.links) if (l.from === o.id) insLink.run(l.from, l.to, l.resolved ?? null);
      }
    });
    tx();
  }

  /** 只追加新事件（幂等）：整库重建不必每次把历史事件重写一遍 */
  appendJournal(events: { id: string; at: string; actor: string; op: string; phase: string; target: string; summary: string }[]): void {
    if (!this.db.open || !events.length) return;
    const ins = this.db.prepare('INSERT OR REPLACE INTO journal(id,at,actor,op,phase,target,summary) VALUES(?,?,?,?,?,?,?)');
    const tx = this.db.transaction(() => {
      for (const e of events) ins.run(e.id, e.at, e.actor, e.op, e.phase, e.target, e.summary);
    });
    tx();
  }

  remove(id: Id): void {
    this.db.prepare('DELETE FROM docs WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM fts WHERE id = ?').run(id);
  }

  search(q: string, opts: { type?: string; limit?: number } = {}): SearchHit[] {
    const query = buildQuery(q);
    const lim = opts.limit ?? 50;
    let rows: { id: string; type: string; title: string; body: string; path: string; score: number }[];
    try {
      rows = this.db
        .prepare(
          `SELECT d.id, d.type, d.title, d.path, d.body, bm25(fts, 10.0, 1.0) AS score
             FROM fts JOIN docs d ON d.id = fts.id
            WHERE fts MATCH ?
              ${opts.type ? 'AND d.type = ?' : ''}
            ORDER BY score LIMIT ?`,
        )
        .all(...(opts.type ? [query, opts.type, lim] : [query, lim])) as typeof rows;
    } catch {
      return [];
    }
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      path: r.path,
      score: r.score,
      snippet: snippet(r.body ?? '', q),
    }));
  }

  /** 标签 / 类型 / 状态 的分面统计 */
  facets(): { tags: { tag: string; n: number }[]; types: { type: string; n: number }[] } {
    const tags = this.db.prepare('SELECT tag, COUNT(*) n FROM tags GROUP BY tag ORDER BY n DESC LIMIT 40').all() as {
      tag: string;
      n: number;
    }[];
    const types = this.db.prepare('SELECT type, COUNT(*) n FROM docs GROUP BY type ORDER BY n DESC').all() as {
      type: string;
      n: number;
    }[];
    return { tags, types };
  }

  /** 反链：谁引用了我 */
  backlinks(id: Id): { fromId: string; toStem: string }[] {
    return this.db.prepare('SELECT from_id, to_stem FROM links WHERE to_id = ?').all(id) as {
      fromId: string;
      toStem: string;
    }[];
  }

  stats(): { docs: number; links: number; bytes: number } {
    const d = this.db.prepare('SELECT COUNT(*) c FROM docs').get() as { c: number };
    const l = this.db.prepare('SELECT COUNT(*) c FROM links').get() as { c: number };
    const b = this.db.prepare('SELECT COALESCE(SUM(LENGTH(body)),0) c FROM docs').get() as { c: number };
    return { docs: d.c, links: l.c, bytes: b.c };
  }
}

function titleOf(o: AnyObject): string {
  const any = o as unknown as { title?: string; text?: string };
  return any.title ?? any.text ?? o.id;
}

/** 检索结果的标题要说人话：载体显示成「作品 · 章节」，批注显示成引文 */
function displayTitle(store: Store, o: AnyObject): string {
  const t = titleOf(o);
  if (t !== o.id) return t;
  if (o.type === 'rep') {
    const rep = o as unknown as { partId: string; carrier: string; path: string };
    const part = store.get(rep.partId) as unknown as { title?: string; workId?: string } | undefined;
    const work = part?.workId ? (store.get(part.workId) as unknown as { title?: string } | undefined) : undefined;
    const name = [work?.title, part?.title].filter(Boolean).join(' · ');
    return name ? `${name}（${rep.carrier}）` : rep.path;
  }
  if (o.type === 'annotation') {
    return `批注：${(o as unknown as { quote: string }).quote.slice(0, 24)}`;
  }
  if (o.type === 'part') return (o as unknown as { path?: string }).path ?? o.id;
  return o.id;
}

function workIdOf(o: AnyObject): string | null {
  const any = o as unknown as { workId?: string; partId?: string };
  return any.workId ?? null;
}

function bodySync(store: Store, o: AnyObject): string {
  const n = o as unknown as { body?: string };
  if (typeof n.body === 'string') return n.body;
  return '';
}

/** 把载体正文读出来；html 去掉标签再入索引 */
async function loadBodies(store: Store, only?: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const o of store.objects.values()) {
    if (o.type === 'annotation') {
      // 批注本身很短，引文加批注语一起入索引，否则搜到了也看不出是哪条
      const a = o as unknown as { id: string; quote: string; note?: string };
      if (only && !only.includes(a.id)) continue;
      out.set(a.id, `${a.quote} ${a.note ?? ''}`);
      continue;
    }
    if (o.type !== 'rep') continue;
    const rep = o as unknown as { id: string; carrier: string };
    if (only && !only.includes(rep.id)) continue;
    if (rep.carrier !== 'md' && rep.carrier !== 'html') continue;
    try {
      const raw = await store.body(rep.id);
      const text = rep.carrier === 'html' ? stripHtml(raw) : raw;
      // frontmatter 不该进索引：搜 "rev" 会命中每一篇，纯噪音
      out.set(rep.id, text.replace(/^---\n[\s\S]*?\n---\n/, ''));
    } catch {
      /* 读不到就跳过 */
    }
  }
  return out;
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

export function snippet(body: string, q: string, n = 90): string {
  const text = body.replace(/\s+/g, ' ');
  const key = q.trim().slice(0, 8);
  const i = key ? text.indexOf(key) : -1;
  if (i < 0) return text.slice(0, n);
  const start = Math.max(0, i - 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + n)}…`;
}
