/**
 * 分享（抽印本）契约测试。
 *
 * 重点不是覆盖率，而是四条边界：
 *   1. 白名单之外的东西一律读不到（连标题都不出现）；
 *   2. 暂停 / 到期 / 换链接 / 归档都是立刻生效；
 *   3. 访问统计只记公开页，且能和分享一起活下去；
 *   4. 公开页不带脚本、不泄漏内部路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../server/index.ts';
import { makeSpace, rmSpace, W1, W2, N1 } from '../helpers/space.ts';

const COLLECTION = 'collection-01HX8Z9K7M2N4P6Q8R0S2T4VB0';
const PRIVATE_NOTE = 'note-01HX8Z9K7M2N4P6Q8R0S2T4V84';

let dir: string;
let app: FastifyInstance;

beforeEach(async () => {
  dir = await makeSpace();
  app = await buildServer({ root: dir, authMode: 'off', usersFile: path.join(dir, '.habitat/test-auth.json') });
});

afterEach(async () => {
  await app.close();
  app.habitat.close();
  await rmSpace(dir);
});

/** 章节与载体的 id 是扫描时生成的，测试不能拿 fixture 里的旧 id 猜 */
async function workInfo(): Promise<{
  parts: { id: string; title: string }[];
  pdfRep: string | null;
}> {
  const res = await app.inject({ method: 'GET', url: `/api/works/${W1}` });
  const j = res.json() as {
    parts: { part: { id: string; title: string } }[];
    reps: { id: string; carrier: string }[];
  };
  return {
    parts: j.parts.map((p) => ({ id: p.part.id, title: p.part.title })),
    pdfRep: j.reps.find((r) => r.carrier === 'pdf')?.id ?? null,
  };
}

async function create(body: Record<string, unknown>): Promise<{ id: string; token: string; url: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/shares', payload: body });
  expect(res.statusCode, res.body).toBe(201);
  const j = res.json() as { share: { id: string; token: string; url: string } };
  return j.share;
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = String(res.headers['set-cookie'] ?? '');
  return raw.split(';')[0];
}

describe('分享的公开范围', () => {
  it('只公开选中的书与笔记，未选中的对象连标题都不出现', async () => {
    const s = await create({ title: '给朋友的抽印本', targetIds: [W1, N1] });
    const res = await app.inject({ method: 'GET', url: `/s/${s.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('给朋友的抽印本');
    expect(res.body).toContain('AI Infra 进阶');
    expect(res.body).toContain('状态就是记忆');
    // 另一本书与收件箱里的私人笔记都不在范围里
    expect(res.body).not.toContain('Durable Agent 详解');
    expect(res.body).not.toContain('待归类：一段关于遗忘门的话');
    expect(res.body).not.toContain('<script');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('书籍页只列本书章节，章节页能渲染正文与站内链接', async () => {
    const s = await create({ title: '一本书', targetIds: [W1] });
    const book = await app.inject({ method: 'GET', url: `/s/${s.token}/w/${W1}` });
    expect(book.statusCode).toBe(200);
    expect(book.body).toContain('线性注意力');
    expect(book.body).toContain('DeltaNet');
    expect(book.body).not.toContain('持久化内核');

    const { parts } = await workInfo();
    const ch = await app.inject({ method: 'GET', url: `/s/${s.token}/w/${W1}/c/${parts[0].id}` });
    expect(ch.statusCode).toBe(200);
    expect(ch.body).toContain('复杂度从平方降到线性');
    // [[DeltaNet]] 在同一本书里 → 应该变成公开章节链接，而不是纯文本
    const delta = parts.find((p) => p.title === 'DeltaNet')!;
    expect(ch.body).toContain(`/s/${s.token}/w/${W1}/c/${delta.id}`);
    // 只读页不能出现管理端入口
    expect(ch.body).not.toContain('/#/reader');
  });

  it('越界的对象、图片路径与原件下载都拒绝', async () => {
    const s = await create({ title: '边界', targetIds: [W1] });
    const otherNote = await app.inject({ method: 'GET', url: `/s/${s.token}/n/${PRIVATE_NOTE}` });
    expect(otherNote.statusCode).toBe(404);
    expect(otherNote.body).not.toContain('待归类');

    const otherBook = await app.inject({ method: 'GET', url: `/s/${s.token}/w/${W2}` });
    expect(otherBook.statusCode).toBe(404);

    const traversal = await app.inject({ method: 'GET', url: `/s/${s.token}/raw?p=${encodeURIComponent('../../etc/passwd')}` });
    expect([400, 403]).toContain(traversal.statusCode);

    const dl = await app.inject({ method: 'GET', url: `/s/${s.token}/d/${(await workInfo()).pdfRep}` });
    expect(dl.statusCode).toBe(404);
  });

  it('打开下载开关后，原件以附件形式提供', async () => {
    const s = await create({ title: '带原件', targetIds: [W1], allowDownload: true });
    const { pdfRep } = await workInfo();
    expect(pdfRep).toBeTruthy();
    const dl = await app.inject({ method: 'GET', url: `/s/${s.token}/d/${pdfRep}` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(String(dl.headers['content-disposition'])).toContain('attachment');
  });

  it('专题会把成员一并带进白名单，但不会带上专题里的私人散篇', async () => {
    const s = await create({ title: '一个专题', targetIds: [COLLECTION] });
    const res = await app.inject({ method: 'GET', url: `/s/${s.token}/t/${COLLECTION}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('AI 阅读清单');
    expect(res.body).toContain('AI Infra 进阶');
    // 专题正文里提到这篇笔记，但 memberIds 没有它，所以不应公开
    expect(res.body).not.toContain('状态就是记忆');
  });
});

describe('分享的开关都立即生效', () => {
  it('暂停 / 恢复 / 到期', async () => {
    const s = await create({ title: '开关', targetIds: [W1] });
    const pause = await app.inject({ method: 'PATCH', url: `/api/shares/${s.id}`, payload: { state: 'paused' } });
    expect(pause.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/s/${s.token}` })).statusCode).toBe(410);

    await app.inject({ method: 'PATCH', url: `/api/shares/${s.id}`, payload: { state: 'active' } });
    expect((await app.inject({ method: 'GET', url: `/s/${s.token}` })).statusCode).toBe(200);

    await app.inject({ method: 'PATCH', url: `/api/shares/${s.id}`, payload: { expiresAt: '2020-01-01' } });
    const expired = await app.inject({ method: 'GET', url: `/s/${s.token}` });
    expect(expired.statusCode).toBe(410);
    expect(expired.body).toContain('分享已到期');

    await app.inject({ method: 'PATCH', url: `/api/shares/${s.id}`, payload: { expiresAt: null } });
    expect((await app.inject({ method: 'GET', url: `/s/${s.token}` })).statusCode).toBe(200);
  });

  it('换链接后旧 token 立即 404，统计仍挂在同一个分享上', async () => {
    const s = await create({ title: '换链接', targetIds: [W1] });
    await app.inject({ method: 'GET', url: `/s/${s.token}` });
    const rot = await app.inject({ method: 'POST', url: `/api/shares/${s.id}/rotate` });
    expect(rot.statusCode).toBe(200);
    const next = (rot.json() as { share: { token: string } }).share.token;
    expect(next).not.toBe(s.token);
    expect((await app.inject({ method: 'GET', url: `/s/${s.token}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/s/${next}` })).statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/shares' });
    const item = (list.json() as { shares: { id: string; stats: { total: number } }[] }).shares.find((x) => x.id === s.id);
    expect(item?.stats.total).toBe(2);
  });

  it('归档后从管理列表消失，链接也打不开', async () => {
    const s = await create({ title: '归档', targetIds: [W1] });
    const arch = await app.inject({ method: 'POST', url: `/api/shares/${s.id}/archive` });
    expect(arch.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/s/${s.token}` })).statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/api/shares' });
    expect((list.json() as { shares: { id: string }[] }).shares.some((x) => x.id === s.id)).toBe(false);
  });
});

describe('访问统计', () => {
  it('记总访问、独立访客、按内容与来源', async () => {
    const s = await create({ title: '统计', targetIds: [W1, N1] });
    const first = await app.inject({ method: 'GET', url: `/s/${s.token}` });
    const cookie = cookieOf(first);
    expect(cookie).toContain('hb_v=');

    const { parts } = await workInfo();
    const partId = parts[0].id;
    await app.inject({
      method: 'GET', url: `/s/${s.token}/w/${W1}/c/${partId}`,
      headers: { cookie, referer: 'https://news.example.com/post/1' },
    });
    await app.inject({ method: 'GET', url: `/s/${s.token}/n/${N1}`, headers: { cookie } });
    // 没带 cookie 的新读者
    await app.inject({ method: 'GET', url: `/s/${s.token}` });

    const list = await app.inject({ method: 'GET', url: '/api/shares' });
    const item = (list.json() as {
      totals: { views7: number; visitors7: number };
      shares: { id: string; stats: {
        total: number; unique: number; last7: number;
        items: { id: string; kind: string; views: number }[];
        refs: { host: string; views: number }[];
      } }[];
    }).shares.find((x) => x.id === s.id)!;

    expect(item.stats.total).toBe(4);
    expect(item.stats.unique).toBe(2);
    expect(item.stats.last7).toBe(4);
    expect(item.stats.items.find((x) => x.id === partId)?.kind).toBe('part');
    expect(item.stats.items.find((x) => x.id === N1)?.views).toBe(1);
    expect(item.stats.refs.find((x) => x.host === 'news.example.com')?.views).toBe(1);

    const stats = await app.inject({ method: 'GET', url: `/api/shares/${s.id}/stats?days=14` });
    const detail = (stats.json() as { stats: { series: { d: string; views: number }[] } }).stats;
    expect(detail.series.length).toBe(14);
    expect(detail.series.reduce((a, b) => a + b.views, 0)).toBe(4);
  });
});

describe('文件是事实源', () => {
  it('分享落成 shares/<id>.yaml，token 与范围都能在文件里看到', async () => {
    const s = await create({ title: '落盘', targetIds: [W1], intro: '一段说明' });
    const file = path.join(dir, 'shares', `${s.id}.yaml`);
    expect(fs.existsSync(file)).toBe(true);
    const yaml = fs.readFileSync(file, 'utf8');
    expect(yaml).toContain('token:');
    expect(yaml).toContain(s.token);
    expect(yaml).toContain(W1);
    expect(yaml).toContain('intro: 一段说明');
  });

  it('标题里的 HTML 会被转义，不会变成公开页上的标签', async () => {
    const s = await create({ title: '<script>alert(1)</script>', targetIds: [W1] });
    const res = await app.inject({ method: 'GET', url: `/s/${s.token}` });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
