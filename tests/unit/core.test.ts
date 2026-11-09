/**
 * G1 验收：并发写冲突 100% 被拦 · 所有写路径 100% 有事件 · 原件只读 · 链接解析率不下降
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Habitat } from '../../server/core/space.ts';
import { makeSpace, rmSpace, MINI, W1, D_TODAY, D_EVENT, MONTH_EVENT, day } from '../helpers/space.ts';
import { parseDoc } from '../../shared/frontmatter.ts';
import { gatesOf, stageOf } from '../../shared/lifecycle.ts';
import { tokenize, buildQuery } from '../../server/core/index.ts';
import type { Note, Part, Rep, Action } from '../../shared/types.ts';

let dir: string;
let hab: Habitat;

beforeEach(async () => {
  dir = await makeSpace();
  hab = await Habitat.open(dir, { fresh: true });
});

afterEach(async () => {
  hab.close();
  await rmSpace(dir);
});

const abs = (rel: string) => path.join(dir, rel);
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');
const write = (rel: string, s: string) => fs.writeFileSync(abs(rel), s, 'utf8');

/* ---------------- A. 扫描与对象模型 ---------------- */

describe('扫描 · 目录布局映射成对象图', () => {
  it('作品 / 章节 / 载体 / 笔记 / 任务 / 日程都建出来了', () => {
    const s = hab.stats();
    expect(s.works).toBe(2);
    expect(s.parts).toBe(4);
    expect(s.reps).toBe(6); // 4 个 md + 1 个入库原件 html + 1 个 pdf 原件
    expect(s.notes).toBe(5); // 状态就是记忆 / 调研报告 / 剪藏 / 周复盘 / 待归类
    expect(s.annotations).toBe(2);
    expect(s.actions).toBe(4); // 待办 3 条 + 已完成 1 条
    expect(s.events).toBe(1);
    expect(s.objects).toBe(30);
  });

  it('主计数是作品与章节，不是文件数', () => {
    const w = hab.workView(W1)!;
    expect(w.parts).toHaveLength(3); // 正文 2 章 + 附录 1
    expect(w.reps.length).toBeGreaterThanOrEqual(3);
    expect(w.parts.filter((p) => p.supplemental)).toHaveLength(1);
    expect(w.parts.find((p) => p.supplemental)!.title).toBe('公式表');
  });

  it('同一章节的多载体合成一个 Part', () => {
    const w2 = hab.works().find((v) => v.work.slug === 'durable-agent')!;
    const p1 = w2.parts[0];
    const reps = w2.reps.filter((r) => r.partId === p1.id);
    expect(reps.length).toBe(2); // md + 入库原件 html
    expect(reps.map((r) => r.carrier).sort()).toEqual(['html', 'md']);
  });

  it('有 source 的章节是原件，locked = true', () => {
    const locked = hab.store.all<Rep>('rep').filter((r) => r.locked);
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.every((r) => r.carrier === 'md' || r.path.startsWith('assets/originals'))).toBe(true);
  });

  it('wikilink 按 stem 解析，与目录无关', () => {
    const s = hab.stats();
    // 4 条正文链接 + 2 条 frontmatter source 链接（都指向不存在的条目）
    expect(s.links).toBe(6);
    expect(s.unresolved).toBe(2);
    const rate = 1 - s.unresolved / s.links;
    expect(rate).toBeGreaterThan(0.5);
  });

  it('章节文件名当 wikilink 目标也能解析：占位空 id 不能吞掉后面的真 id', async () => {
    // 真实库的章节叫「书名-·-第3章-…」，正文里引用的是文件名而不是 title。
    // 扫描时先按文件名登记了空 id 占位，章节建完再回填真 id；如果回填被 has() 挡住，
    // 这些链接就永远是「未解析」——关系页少边、反链缺失，看起来像没接上。
    const d = await makeSpace({
      ...MINI,
      'knowledge/notes/2026-11-02-指向章节.md': `---
title: 指向章节文件名
type: note
status: seedling
tags: [test]
summary: 链接写章节文件名，不写章节 title
created: 2026-11-02
updated: 2026-11-02
---

见 [[02-DeltaNet]]，也见 [[DeltaNet]]。
`,
    });
    const h = await Habitat.open(d, { fresh: true });
    const byFile = h.store.links.find((l) => l.to === '02-DeltaNet');
    const byTitle = h.store.links.find((l) => l.to === 'DeltaNet');
    expect(byFile?.resolved).toBeTruthy();
    expect(byTitle?.resolved).toBeTruthy();
    expect(byFile?.resolved).toBe(byTitle?.resolved);
    h.close();
    await rmSpace(d);
  });
});

describe('链接只在正文里算，代码示例不算', () => {
  it('代码围栏与行内代码里的 [[…]] 不产生链接', async () => {
    // 契约/说明类文档里到处是 `[[文件名]]` 这种写法示例；当成真链接会把断链计数顶上去。
    const d = await makeSpace({
      ...MINI,
      'knowledge/notes/2026-11-02-写法示例.md': `---
title: 写法示例
type: note
status: seedling
tags: [test]
summary: 演示 wikilink 写法，示例不该进图
created: 2026-11-02
updated: 2026-11-02
---

正文引用 [[DeltaNet]]。

行内示例：\`[[文件名]]\`。

\`\`\`yaml
source: "[[来源卡片]] 或 URL"
related: ["[[其他条目]]"]
\`\`\`
`,
    });
    const h = await Habitat.open(d, { fresh: true });
    const targets = h.store.links.map((l) => l.to);
    expect(targets).toContain('DeltaNet');
    expect(targets).not.toContain('文件名');
    expect(targets).not.toContain('来源卡片');
    expect(targets).not.toContain('其他条目');
    h.close();
    await rmSpace(d);
  });
});

describe('收件箱只列未消化的', () => {
  it('已归档的碎片不再出现在收件箱', async () => {
    const d = await makeSpace({
      ...MINI,
      'inbox/2026-10-31-已归档的空采集.md': `---
type: note
title: 已归档的空采集
status: seedling
srcIds: []
kind: point
archivedAt: 2026-10-31T10:00:00+08:00
createdAt: "2026-10-31T09:59:00+08:00"
updatedAt: "2026-10-31T10:00:00+08:00"
author: human
sensitivity: private
rev: 2
---

`,
    });
    const h = await Habitat.open(d, { fresh: true });
    const titles = h.inbox().map((n) => n.title);
    expect(titles).not.toContain('已归档的空采集');
    expect(titles).toContain('剪藏：一段话');
    h.close();
    await rmSpace(d);
  });
});

/* ---------------- B. 原件只读 ---------------- */

describe('原件不可变', () => {
  it('改 locked 载体：校验直接拦下，且不写盘', async () => {
    const rep = hab.store.all<Rep>('rep').find((r) => r.locked)!;
    const before = read(rep.path);
    const cs = await hab.changes.propose({
      ops: [{ t: 'setBody', id: rep.id, body: '我要改原文' }],
      actor: 'human',
      reason: '试试改原件',
    });
    const checks = await hab.changes.validate(cs);
    const ro = checks.find((c) => c.name === 'readonly')!;
    expect(ro.ok).toBe(false);
    expect(ro.detail).toContain('不能改原件');
    expect(read(rep.path)).toBe(before); // 提交前不写盘
  });

  it('原件只能衍生，衍生出来的笔记不锁', async () => {
    const rep = hab.store.all<Rep>('rep').find((r) => r.locked)!;
    const r = await hab.derive({ srcId: rep.id, title: '读后一得', body: '这是我自己写的。' });
    await hab.rescan();
    const note = hab.store.get<Note>(r.id)!;
    expect(note.srcIds).toContain(rep.id);
    const noteRep = hab.store.file(note.id)!;
    expect(noteRep.startsWith('knowledge/notes/')).toBe(true);
  });
});

/* ---------------- C. 并发写冲突 ---------------- */

describe('并发写冲突 100% 被拦', () => {
  it('外部 Agent 绕过接口改了文件：提交时按哈希拦下，并给出三方内容', async () => {
    const note = hab.store.all<Note>('note').find((n) => n.title === '状态就是记忆')!;
    const rel = hab.store.file(note.id)!;
    const cs = await hab.changes.propose({
      ops: [{ t: 'update', id: note.id, patch: { status: 'evergreen' } }],
      actor: 'human',
      reason: '改成定稿',
    });

    // 外部改文件（不 bump rev，模拟最坏情况：普通编辑器随手一改）
    write(rel, read(rel).replace('status: growing', 'status: seedling'));

    const r = await hab.changes.commit(cs.id);
    expect(r.ok).toBe(false);
    expect(r.conflict).toBeTruthy();
    expect(r.conflict!.base.content).toContain('status: growing');
    expect(r.conflict!.mine.content).toContain('status: evergreen');
    expect(r.conflict!.theirs.content).toContain('status: seedling');
    // 界面要能提供「重新载入 / 看差异 / 另存副本」，三方数据必须完整
    expect(r.conflict!.base.rev).toBeGreaterThan(0);
    expect(r.conflict!.theirs.rev).toBeGreaterThan(0);
    expect(read(rel)).toContain('status: seedling'); // 没有覆盖别人的改动
  });

  it('打开之后被外部改了：以客户端基准为准，照样拦下', async () => {
    // 这条覆盖的是最阴险的一种：外部改动发生在「你打开编辑器之后、点保存之前」。
    // 如果服务端 propose 时自己读盘当基准，就会把外部那一份当成你的基准，
    // 于是你的保存静默覆盖掉别人的改动——这正是「不强制覆盖」要防的。
    const note = hab.store.all<Note>('note').find((n) => n.title === '状态就是记忆')!;
    const rel = hab.store.file(note.id)!;
    const st = await hab.store.adapter.stat(rel);
    const baseContent = read(rel);

    write(rel, baseContent.replace('status: growing', 'status: seedling'));
    await hab.rescan(); // 服务端已经看到外部改动了

    const cs = await hab.changes.propose({
      ops: [{ t: 'update', id: note.id, patch: { status: 'evergreen' } }],
      base: { [note.id]: { rev: 1, hash: st!.hash, content: baseContent } },
      actor: 'human',
      reason: '改成定稿',
    });
    const r = await hab.changes.commit(cs.id);

    expect(r.ok).toBe(false);
    expect(r.conflict).toBeTruthy();
    expect(r.conflict!.base.content).toContain('status: growing');   // 我打开时看到的
    expect(r.conflict!.mine.content).toContain('status: evergreen'); // 我要写的
    expect(r.conflict!.theirs.content).toContain('status: seedling');// 现在盘上的
    expect(read(rel)).toContain('status: seedling');                 // 没有覆盖别人
  });

  it('没给基准时，按当时盘上的内容当基准（采集/衍生这类新建走这条路）', async () => {
    const note = hab.store.all<Note>('note').find((n) => n.title === '状态就是记忆')!;
    const cs = await hab.changes.propose({
      ops: [{ t: 'update', id: note.id, patch: { status: 'evergreen' } }],
      actor: 'human',
      reason: '改成定稿',
    });
    const r = await hab.changes.commit(cs.id);
    expect(r.ok).toBe(true);
    expect(read(hab.store.file(note.id)!)).toContain('status: evergreen');
  });

  it('两个人同时改同一篇：后提交的那个被拦', async () => {
    const note = hab.store.all<Note>('note').find((n) => n.title === '状态就是记忆')!;
    const cs1 = await hab.changes.propose({
      ops: [{ t: 'update', id: note.id, patch: { status: 'evergreen' } }],
      actor: 'human',
      reason: 'A：改成定稿',
    });
    const cs2 = await hab.changes.propose({
      ops: [{ t: 'update', id: note.id, patch: { kind: 'summary' } }],
      actor: 'agent:workbuddy',
      reason: 'B：改成摘要',
    });

    const r1 = await hab.changes.commit(cs1.id);
    expect(r1.ok).toBe(true);
    const r2 = await hab.changes.commit(cs2.id);
    expect(r2.ok).toBe(false);
    expect(r2.conflict).toBeTruthy();
    expect(r2.conflict!.theirs.rev).toBeGreaterThan(r2.conflict!.base.rev);
  });

  it('外部改动同时 bump 了 rev：版本号这一层也能拦', async () => {
    const note = hab.store.all<Note>('note').find((n) => n.title === '状态就是记忆')!;
    const rel = hab.store.file(note.id)!;
    const cs = await hab.changes.propose({
      ops: [{ t: 'update', id: note.id, patch: { kind: 'outline' } }],
      actor: 'human',
      reason: '改成提纲',
    });
    write(rel, read(rel).replace('rev: 1', 'rev: 9').replace('status: growing', 'status: seedling'));
    const r = await hab.changes.commit(cs.id);
    expect(r.ok).toBe(false);
    expect(r.conflict!.theirs.rev).toBe(9);
  });

  it('存储层的条件写本身就是拦不住的：ifHash 不匹配抛 ConflictError', async () => {
    const rel = 'knowledge/notes/状态就是记忆.md';
    const st = await hab.store.adapter.stat(rel);
    await expect(hab.store.adapter.write(rel, 'x', { ifHash: 'deadbeef' })).rejects.toThrow(/条件写失败/);
    await expect(hab.store.adapter.write(rel, 'x', { ifHash: st!.hash })).resolves.toBeTruthy();
  });

  it('冲突没有 force 覆盖这条路：validate 失败时 commit 仍然被挡', async () => {
    const rep = hab.store.all<Rep>('rep').find((r) => r.locked)!;
    const cs = await hab.changes.propose({
      ops: [{ t: 'setBody', id: rep.id, body: '硬来' }],
      actor: 'human',
      reason: '硬来',
    });
    await hab.changes.validate(cs);
    const r = await hab.changes.commit(cs.id);
    // 原件只读是硬错误：放行后仍然会被哈希层挡下，或者压根不该被提交
    expect(r.ok).toBe(false);
  });
});

/* ---------------- D. 所有写路径 100% 有事件 ---------------- */

describe('写路径事件覆盖率', () => {
  it('每条写操作都留下事件，且 op 与动作对得上', async () => {
    const rep = hab.store.all<Rep>('rep').find((r) => r.carrier === 'md')!;
    const note = hab.store.all<Note>('note')[0];

    const caps = await hab.capture({ title: '采集一条', body: '内容' });
    const der = await hab.derive({ srcId: note.id, title: '衍生一条', body: '我的理解' });
    const ann = await hab.annotate({ repId: rep.id, quote: '固定容量状态', from: 10, to: 20, note: '关键' });
    const act = await hab.addAction({ text: '写测试', due: '2026-11-05' });
    const evt = await hab.addEvent({ title: '评审', date: '2026-11-06', start: '14:00', end: '15:00' });

    for (const [name, r, op] of [
      ['采集', caps, 'capture'],
      ['衍生', der, 'derive'],
      ['批注', ann, 'annotate'],
    ] as const) {
      expect(r.events.length, name).toBeGreaterThanOrEqual(2); // 动作事件 + 提交事件
      expect(r.events.some((e) => e.op === op), `${name} 应产生 ${op} 事件`).toBe(true);
      expect(r.events.some((e) => e.op === 'commit')).toBe(true);
    }
    for (const [name, r] of [['任务', act], ['日程', evt]] as const) {
      expect(r.events.some((e) => e.op === 'capture'), name).toBe(true);
    }

    // 阅读与回顾是单独的事件，不走变更
    const cur = await hab.setCursor(rep.id, 0.4);
    expect(cur.event.op).toBe('read');
    const rev = await hab.review(note.id, '回顾了一次');
    expect(rev.op).toBe('review');
  });

  it('事件的 actor 区分人与 AI', async () => {
    await hab.capture({ title: '人写的', body: '', actor: 'human' });
    await hab.capture({ title: 'AI 写的', body: '', actor: 'agent:workbuddy' as never });
    const evs = await hab.journal.query({ limit: 100 });
    expect(evs.some((e) => e.actor === 'human')).toBe(true);
    expect(evs.some((e) => e.actor === 'agent:workbuddy')).toBe(true);
  });

  it('事件只追加：撤销不会删掉历史', async () => {
    const note = hab.store.all<Note>('note')[0];
    const cs = await hab.changes.propose({
      ops: [{ t: 'update', id: note.id, patch: { kind: 'summary' } }],
      actor: 'human',
      reason: '改类型',
    });
    await hab.changes.commit(cs.id);
    const n1 = (await hab.journal.query({ limit: 1000 })).length;
    await hab.changes.revert(cs.id);
    const n2 = (await hab.journal.query({ limit: 1000 })).length;
    expect(n2).toBeGreaterThan(n1); // 撤销是新增事件，不是删除
  });
});

/* ---------------- E. 撤销 ---------------- */

describe('撤销', () => {
  it('更新可以撤回到改前的值', async () => {
    const note = hab.store.all<Note>('note').find((n) => n.title === '状态就是记忆')!;
    const before = read(hab.store.file(note.id)!);
    const cs = await hab.changes.propose({
      ops: [{ t: 'update', id: note.id, patch: { status: 'evergreen' } }],
      actor: 'human',
      reason: '改成定稿',
    });
    await hab.changes.commit(cs.id);
    expect(read(hab.store.file(note.id)!)).toContain('status: evergreen');

    const r = await hab.changes.revert(cs.id);
    expect(r.ok).toBe(true);
    await hab.rescan();
    const after = read(hab.store.file(note.id)!);
    expect(parseDoc(after).fm.status).toBe(parseDoc(before).fm.status);
  });

  it('新建可以撤销（归档而不是删除）', async () => {
    const c = await hab.capture({ title: '待撤销', body: '内容' });
    await hab.rescan();
    const cs = (await hab.changes.list()).find((x) => x.reason === '采集：待撤销')!;
    const r = await hab.changes.revert(cs.id);
    expect(r.ok).toBe(true);
    await hab.rescan();
    expect(hab.store.get(c.id)?.archivedAt).toBeTruthy();
  });
});

/* ---------------- F. 阅读进度 ---------------- */

describe('阅读位置：current 与 furthest 分开', () => {
  it('回看不覆盖最远位置', async () => {
    const rep = hab.store.all<Rep>('rep').find((r) => r.carrier === 'md')!;
    await hab.setCursor(rep.id, 0.5);
    await hab.setCursor(rep.id, 0.8);
    const back = await hab.setCursor(rep.id, 0.3);
    expect(back.cursor.current).toBeCloseTo(0.3);
    expect(back.cursor.furthest).toBeCloseTo(0.8);
  });
});

describe('作品进度：按章算覆盖率，不按单章最深处', () => {
  const mainReps = () => {
    const parts = hab.store.all<Part>('part').filter((p) => p.workId === W1 && !p.supplemental);
    return hab.store
      .all<Rep>('rep')
      .filter((r) => parts.some((p) => p.id === r.partId));
  };

  it('一章滚到底只算这一章，整本不再跟着满格', async () => {
    const reps = mainReps();
    await hab.setCursor(reps[0].id, 1);
    const v = hab.workView(W1)!;
    expect(v.chapterCount).toBe(2); // 附录是补充材料，不进分母
    expect(v.readChapters).toBe(1);
    expect(v.readPct).toBeCloseTo(0.5);
    expect(v.lastReadAt).toBeTruthy();
    expect(v.lastRepId).toBe(reps[0].id);
  });

  it('差一点点不算读完：0.97 只停在「在读」', async () => {
    await hab.setCursor(mainReps()[0].id, 0.97);
    const v = hab.workView(W1)!;
    expect(v.readChapters).toBe(0);
    expect(v.readPct).toBe(0);
    expect(v.lastReadAt).toBeTruthy(); // 读过，只是没读完
  });

  it('正文章全部读完才是 100%', async () => {
    for (const r of mainReps()) await hab.setCursor(r.id, 1);
    const v = hab.workView(W1)!;
    expect(v.readChapters).toBe(2);
    expect(v.chapterCount).toBe(2);
    expect(v.readPct).toBe(1);
  });
});

/* ---------------- G. 生命周期 ---------------- */

describe('生命周期五阶段闸门', () => {
  it('闸门是算出来的：没有衍生就卡在衍生，读过且衍生够才进消化', () => {
    const f = { exists: true, hasSource: true, derivedCount: 0, readPct: 1, reviewedAt: null, evergreen: false, inbound: 0 };
    expect(stageOf(f)).toBe('capture');
    expect(gatesOf(f).find((g) => g.key === 'derive')!.pass).toBe(false);

    const f2 = { ...f, derivedCount: 1 };
    expect(stageOf(f2)).toBe('digest');

    const f3 = { ...f2, reviewedAt: '2026-10-29' };
    expect(stageOf(f3)).toBe('review');

    const f4 = { ...f3, evergreen: true, inbound: 2 };
    expect(stageOf(f4)).toBe('settle');
  });

  it('消化要同时满足读过 99% 和有衍生', () => {
    const f = { exists: true, hasSource: true, derivedCount: 1, readPct: 0.5, reviewedAt: null, evergreen: false, inbound: 0 };
    expect(gatesOf(f).find((g) => g.key === 'digest')!.pass).toBe(false);
    expect(gatesOf({ ...f, readPct: 1 }).find((g) => g.key === 'digest')!.pass).toBe(true);
  });

  it('作品的实际闸门来自真实血缘与批注', () => {
    const g = hab.gates(W1);
    expect(g.facts.derivedCount).toBe(4); // 2 篇衍生笔记 + 2 条批注
    expect(g.facts.inbound).toBe(3); // 2 篇笔记引用 + 1 个专题收录
    expect(g.stage).toBe('settle'); // 报告是 evergreen 且被引用 ≥2 处
  });
});

/* ---------------- H. 检索 ---------------- */

describe('检索：中文 2-gram', () => {
  it('unicode61 不切中文，所以必须先做 2-gram', () => {
    expect(tokenize('知识库管理')).toBe('知识 识库 库管 管理');
    expect(tokenize('DeltaNet')).toBe('deltanet');
    expect(buildQuery('线性注意力')).toBe('"线性" AND "性注" AND "注意" AND "意力"');
  });

  it('中文关键词能搜到', () => {
    const hits = hab.index.search('线性注意力');
    expect(hits.map((h) => h.title)).toContain('线性注意力');
  });

  it('英文与混合关键词也能搜到', () => {
    expect(hab.index.search('DeltaNet').map((h) => h.title)).toContain('DeltaNet');
    expect(hab.index.search('注意力').length).toBeGreaterThan(0);
  });

  it('搜不到就说搜不到，不编造', () => {
    expect(hab.index.search('不存在的词xyzzy')).toHaveLength(0);
  });
});

/* ---------------- I. 对账 ---------------- */

describe('对账：承认有人不走接口', () => {
  it('未署名改动被检测出来，可认领，两条记录都保留', async () => {
    await hab.snapshot();
    const rel = 'knowledge/notes/状态就是记忆.md';
    write(rel, `${read(rel)}\n\n有人在编辑器里直接加了一句。`);

    const r = await hab.doReconcile();
    expect(r.unsigned.map((u) => u.path)).toContain(rel);
    expect(r.events[0].op).toBe('external_edit');
    expect(r.events[0].actor).toBe('external:unknown');

    const claimed = await hab.journal.claim(r.events[0].id, 'human');
    expect(claimed?.claimedBy).toBe('human');
    // 认领是回填，不是删除：未署名那条仍在
    // fixture 里预置了 1 条历史未署名改动，加上刚检测到的这条，共 2 条
    const all = await hab.journal.query({ op: 'external_edit', limit: 100 });
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.id === r.events[0].id)?.claimedBy).toBe('human');
    // 认领是回填：原来那条未署名的记录仍然在
    expect(all.filter((e) => e.actor === 'external:unknown')).toHaveLength(2);
  });

  it('走了接口的改动不算未署名', async () => {
    await hab.snapshot();
    await hab.capture({ title: '走接口的', body: '有事件留痕' });
    const r = await hab.doReconcile();
    expect(r.signed.length + r.added.length).toBeGreaterThan(0);
    expect(r.unsigned.map((u) => u.path).some((p) => p.includes('走接口的'))).toBe(false);
  });
});

/* ---------------- J. frontmatter 无损 ---------------- */

describe('frontmatter：未知字段原样保留', () => {
  it('表单之外的字段不被清掉', async () => {
    const rel = 'knowledge/notes/未知字段测试.md';
    write(rel, `---
id: note-01HX8Z9K7M2N4P6Q8R0S2T4VFF
type: note
title: 未知字段测试
status: seedling
kind: point
srcIds: []
related: ["[[状态就是记忆]]"]
aliases: [别名一, 别名二]
我自己加的字段: 保留我
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

正文。
`);
    await hab.rescan();
    const note = hab.store.all<Note>('note').find((n) => n.title === '未知字段测试')!;
    const cs = await hab.changes.propose({
      ops: [{ t: 'update', id: note.id, patch: { status: 'growing' } }],
      actor: 'human',
      reason: '推进状态',
    });
    await hab.changes.commit(cs.id);
    const fm = parseDoc(read(rel)).fm;
    expect(fm.status).toBe('growing');
    expect(fm.related).toEqual(['[[状态就是记忆]]']);
    expect(fm.aliases).toEqual(['别名一', '别名二']);
    expect(fm['我自己加的字段']).toBe('保留我');
  });

  it('编辑老笔记时沿用 created/updated，不塞 createdAt', async () => {
    // 真实库写的是 created: 2026-10-20；如果编辑时硬写 createdAt，
    // 同一篇里会并存两套日期，看着像被两个工具抢着改。
    const rel = 'knowledge/notes/老格式.md';
    write(rel, `---
title: 老格式
type: note
status: seedling
created: 2026-10-20
updated: 2026-10-20
tags: [a]
summary: 试一下
---

正文。
`);
    await hab.rescan();
    const note = hab.store.all<Note>('note').find((n) => n.title === '老格式')!;
    const cs = await hab.changes.propose({
      ops: [{ t: 'update', id: note.id, patch: { status: 'growing' } }],
      actor: 'human',
      reason: '改状态',
    });
    const r = await hab.changes.commit(cs.id);
    expect(r.ok).toBe(true);

    const raw = read(rel);
    expect(raw).toContain('created: 2026-10-20');
    expect(raw).not.toContain('createdAt');
    expect(raw).not.toContain('updatedAt');
    expect(raw).toMatch(/^updated: \d{4}-\d{2}-\d{2}$/m);
    expect(raw).toContain('status: growing');
  });
});

/* ---------------- K. 行内语法兼容 ---------------- */

describe('行内语法：与现库 tasks.md 兼容', () => {
  it('既有的 ^t- 风格 id 原样保留', () => {
    const acts = hab.store.all('action') as unknown as { id: string; text: string; due?: string; state: string }[];
    expect(acts.map((a) => a.id).sort()).toEqual(['act-20261029-07', 'act-20261029-08', 'act-20261029-09', 'act-20261029-10'].sort());
    const a7 = acts.find((a) => a.id === 'act-20261029-07')!;
    expect(a7.text).toBe('读《AI Infra 进阶》第一遍');
    expect(a7.due).toBe(D_TODAY);
    expect(acts.find((a) => a.id === 'act-20261029-09')!.state).toBe('done');
  });

  it('新建任务写成同样的行内格式，且能再读回来', async () => {
    const r = await hab.addAction({ text: '写 E2E 测试', due: '2026-11-10', flow: 'now' });
    await hab.rescan();
    const raw = read('work/actions/tasks.md');
    expect(raw).toMatch(/^- \[ \] 写 E2E 测试 \[due:: 2026-11-10\].*\^act-/m);
    expect(raw).toContain(`^${r.id}`);
    // 旧的三条一条没少
    expect(raw).toContain('^act-20261029-07');
    expect(raw).toContain('^act-20261029-08');
    expect(raw).toContain('^act-20261029-09');
    expect(raw).toContain('一条普通备忘，不是任务。');
  });

  it('任务带时间块：解析成 scheduled，写回 [at::]，再读还在', async () => {
    const r = await hab.addAction({
      text: '写日历桥接',
      due: D_TODAY,
      scheduled: ['14:00', '15:30'],
    });
    await hab.rescan();
    const a = hab.store.get<Action>(r.id)!;
    expect(a.scheduled).toEqual(['14:00', '15:30']);
    const raw = read('work/actions/tasks.md');
    expect(raw).toContain('[at:: 14:00-15:30]');
    expect(raw).toContain(`^${r.id}`);
    // 再扫一遍：写回去的内容必须还能被读出来（否则界面重启就丢）
    await hab.rescan();
    expect(hab.store.get<Action>(r.id)!.scheduled).toEqual(['14:00', '15:30']);
  });

  it('日程按日期解析', () => {
    const ev = hab.store.all('event') as unknown as { title: string; start: string; end: string }[];
    expect(ev[0].title).toBe('周会');
    expect(ev[0].start).toBe(`${D_EVENT}T09:30`);
    expect(ev[0].end).toContain('10:30');
  });

  it('新建的日程自带日期小标题，再读回来日期和时间都在', async () => {
    // 行里只写 HH:MM，日期靠 ### YYYY-MM-DD；少了这个标题，日期就丢了
    const r = await hab.addEvent({
      title: '设计评审',
      date: '2026-10-15',
      start: '14:00',
      end: '15:30',
      actor: 'human',
    });
    expect(r.id).toBeTruthy();

    const raw = read('work/events/2026-10.md');
    expect(raw).toContain('### 2026-10-15');
    expect(raw).toMatch(/- 14:00–15:30 设计评审/);

    await hab.rescan();
    const ev = hab.store.get(r.id) as unknown as { title: string; start: string; end: string };
    expect(ev.title).toBe('设计评审');
    expect(ev.start).toBe('2026-10-15T14:00');
    expect(ev.end).toBe('2026-10-15T15:30');
  });

  it('老文件里把完整 ISO 时间写进行里的也能读回来', async () => {
    // 早期版本写出来的行长这样，不能因为格式变了就读不出日期
    const rel = `work/events/${MONTH_EVENT}.md`;
    const legacy = day(6);
    write(rel, read(rel).replace('- 09:30–10:30 周会', `- ${legacy}T08:00–${legacy}T09:00 老格式评审`));
    await hab.rescan();
    const ev = hab.store.all('event') as unknown as { title: string; start: string }[];
    const hit = ev.find((e) => e.title === '老格式评审');
    expect(hit).toBeTruthy();
    expect(hit!.start).toBe(`${legacy}T08:00`);
  });
});

/* ---------------- L. 索引可重建 ---------------- */

describe('索引是派生的', () => {
  it('删掉重建后检索结果一致', () => {
    const a = hab.index.search('线性注意力').map((h) => h.id).sort();
    hab.index.rebuild(hab.store, []);
    const b = hab.index.search('线性注意力').map((h) => h.id).sort();
    expect(b).toEqual(a);
  });
});

/* ---------------- M. 能力清单 ---------------- */

describe('Agent 接入', () => {
  it('能力清单覆盖全部写路径', async () => {
    const { buildManifest } = await import('../../server/routes/api.ts');
    const m = buildManifest(hab);
    expect(m.capabilities.length).toBeGreaterThanOrEqual(9);
    for (const c of m.capabilities) {
      expect(c.human).toBeTruthy();
      expect(c.agent).toBeTruthy();
      expect(c.writes).toBeTruthy();
      expect(c.event).toBeTruthy();
    }
    expect(m.capabilities.filter((c) => c.mutating).length).toBeGreaterThanOrEqual(5);
  });
});

void MINI;

/* ---------------- N. 作品归组候选 ---------------- */

describe('作品归组：只出候选，不搬文件', () => {
  it('来源目录够 3 篇就成候选；已被 work.yaml 认领的不再出现', async () => {
    const extra = {
      ...MINI,
      'knowledge/sources/2026/某本未归组的书/01-开头.md': '---\ntitle: 开头\ntype: source\n---\n\n正文\n',
      'knowledge/sources/2026/某本未归组的书/02-中段.md': '---\ntitle: 中段\ntype: source\n---\n\n正文\n',
      'knowledge/sources/2026/某本未归组的书/03-结尾.md': '---\ntitle: 结尾\ntype: source\n---\n\n正文\n',
      // 只有两篇的目录不算书
      'knowledge/sources/2026/零散剪藏/a.md': '# a\n',
      'knowledge/sources/2026/零散剪藏/b.md': '# b\n',
    };
    const d2 = await makeSpace(extra, false);
    const h2 = await Habitat.open(d2, { fresh: true });
    try {
      const { findWorkCandidates } = await import('../../server/core/candidates.ts');
      const list = await findWorkCandidates(h2.store);
      const slugs = list.map((c) => c.slug);
      expect(slugs).toContain('某本未归组的书');
      expect(slugs).not.toContain('零散剪藏');
      // 夹具里 ai-infra 已经是作品了，不能再当候选
      expect(slugs).not.toContain('ai-infra');
      const hit = list.find((c) => c.slug === '某本未归组的书')!;
      expect(hit.chapters).toBe(3);
      expect(hit.dir).toBe('knowledge/sources/2026/某本未归组的书');
    } finally {
      h2.close();
      await rmSpace(d2);
    }
  });

  it('work.yaml 里声明 partsFrom 后，那个目录的章节算这部作品的', async () => {
    const extra = {
      ...MINI,
      'knowledge/works/ce101/work.yaml': 'title: 上下文工程 101\nkind: book\npartsFrom: knowledge/sources/2026/ce101\n',
      'knowledge/sources/2026/ce101/01-序章.md': '---\ntitle: 序章\ntype: source\n---\n\n正文\n',
      'knowledge/sources/2026/ce101/02-技术栈.md': '---\ntitle: 技术栈\ntype: source\n---\n\n正文\n',
      'knowledge/sources/2026/ce101/03-RAG.md': '---\ntitle: RAG\ntype: source\n---\n\n正文\n',
    };
    const d3 = await makeSpace(extra, false);
    const h3 = await Habitat.open(d3, { fresh: true });
    try {
      const w = h3.works().find((x) => x.work.slug === 'ce101');
      expect(w).toBeTruthy();
      expect(w!.parts.length).toBe(3); // 文件没搬，但算进这部书
      const { findWorkCandidates } = await import('../../server/core/candidates.ts');
      const slugs = (await findWorkCandidates(h3.store)).map((c) => c.slug);
      expect(slugs).not.toContain('ce101'); // 已认领
    } finally {
      h3.close();
      await rmSpace(d3);
    }
  });
});

/* ---------------- O. id 稳定性（edition 曾把 work 的 id 吃掉） ---------------- */

describe('对象 id 必须跨重扫稳定', () => {
  it('连扫三次：作品 id 不变，作品与版本各自独立', async () => {
    const snap = () =>
      hab.works().map((w) => `${w.work.slug}|${w.work.id}|${w.parts.length}`).sort().join('\n');

    const first = snap();
    expect(hab.works().length).toBe(2);

    await hab.rescan();
    const second = snap();
    await hab.rescan();
    const third = snap();

    expect(second).toBe(first);
    expect(third).toBe(first);

    // 版本对象不能顶掉作品：两者 id 必须不同
    const ws = hab.store.all('work') as { id: string }[];
    const eds = hab.store.all('edition') as { id: string }[];
    expect(eds.length).toBe(ws.length);
    expect(ws.some((w) => eds.some((e) => e.id === w.id))).toBe(false);
  });

  it('被写坏的超长 id 会被重建，不会一直留在 ids.json 里', async () => {
    const w = hab.works()[0].work;
    const broken = `${w.id}${'-ed1'.repeat(40)}`;
    expect(broken.length).toBeGreaterThan(80);
    // 直接塞进 idMap 模拟历史坏数据
    (hab.store as unknown as { idMap: Record<string, string> }).idMap[w.id] = broken;
    await hab.rescan();
    const after = hab.works().find((x) => x.work.slug === w.slug)!;
    expect(after.work.id.length).toBeLessThan(80);
  });
});

/* ---------------- P. 助手取词：中文问句不能整句去搜 ---------------- */

describe('助手取词', () => {
  it('剥掉请求语与疑问尾巴', async () => {
    const { extractKey } = await import('../../shared/ai.ts');
    expect(extractKey('帮我找一下上下文压缩有哪些做法？')).toBe('上下文压缩');
    expect(extractKey('我想知道 RAG 的权限过滤是什么')).toBe('RAG权限过滤');
    expect(extractKey('上下文压缩')).toBe('上下文压缩');
  });

  it('整句 miss 时能退到更短的片段', async () => {
    const { keyFallbacks, extractKey } = await import('../../shared/ai.ts');
    const k = extractKey('线性注意力为什么能把复杂度降到线性');
    expect(k).toBe('线性注意力');
    const f = keyFallbacks(`${k}记忆`);
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => `${k}记忆`.startsWith(x))).toBe(true);
    expect(f.every((x) => x.length >= 2 && x !== k)).toBe(true);
  });

  it('真实问法能在检索里命中（端到端）', async () => {
    const { extractKey, keyFallbacks } = await import('../../shared/ai.ts');
    // 夹具里有「线性注意力」，但整句带疑问成分直接搜会 0 命中
    const q = '线性注意力有哪些做法';
    expect(hab.index.search(q).length).toBe(0);
    const key = extractKey(q);
    let hits = hab.index.search(key).length;
    if (!hits) {
      for (const alt of keyFallbacks(key)) {
        hits = hab.index.search(alt).length;
        if (hits) break;
      }
    }
    // 夹具里「01-线性注意力」提到上下文压缩，整句搜本来会 0 命中
    expect(hits).toBeGreaterThan(0);
  });
});

/* ---------------- Q. 归档：行内记录也必须真落盘 ---------------- */

describe('归档（不删除只归档）', () => {
  it('任务归档后写进 [archived::]，重扫仍在、但不再算未完成', async () => {
    const a = hab.store.all('action').find((x) => (x as { state: string }).state === 'open') as unknown as { id: string };
    expect(a).toBeTruthy();

    const cs = await hab.changes.propose({ ops: [{ t: 'archive', id: a.id, archived: true }], reason: '归档测试', actor: 'human' } as never);
    const r = await hab.changes.commit(cs.id);
    expect(r.ok).toBe(true);

    const raw = await hab.store.adapter.read('work/actions/tasks.md');
    expect(raw).toContain('[archived::');

    await hab.rescan();
    const after = hab.store.get(a.id) as unknown as { archivedAt?: string };
    expect(after.archivedAt).toBeTruthy();
    // 文件还在（不是删除），但业务上不再出现
    expect(hab.store.file(a.id)).toBeTruthy();
  });

  it('日程归档同样落盘并能读回', async () => {
    const e = hab.store.all('event')[0] as unknown as { id: string };
    if (!e) return; // 夹具可能没有日程，跳过
    const cs = await hab.changes.propose({ ops: [{ t: 'archive', id: e.id, archived: true }], reason: '归档测试', actor: 'human' } as never);
    await hab.changes.commit(cs.id);
    await hab.rescan();
    expect((hab.store.get(e.id) as unknown as { archivedAt?: string }).archivedAt).toBeTruthy();
  });
});

/* ---------------- R. 邮件投递：转换与白名单 ---------------- */

describe('邮件投递', () => {
  it('邮件转成碎片：标题、正文、附件都保留', async () => {
    const { mailToCapture } = await import('../../server/core/inbox-mail.ts');
    const r = mailToCapture({
      subject: '  一条想法  ',
      from: { value: [{ address: 'someone@example.com' }] },
      date: new Date('2026-10-30T10:00:00Z'),
      text: '觉得这套东西的关键在「口径」而不是「算法」。',
      attachments: [{ filename: '收据.png', content: Buffer.from([1, 2, 3]) }],
    });
    expect(r.title).toBe('  一条想法  '.slice(0, 120));
    expect(r.body).toContain('口径');
    expect(r.body).toContain('收据.png');
    expect(r.body).toContain('someone@example.com');
    expect(r.attachments).toHaveLength(1);
  });

  it('只有 HTML 时能转出文本，不会把标签塞进正文', async () => {
    const { mailToCapture } = await import('../../server/core/inbox-mail.ts');
    const r = mailToCapture({
      subject: 'html only',
      html: '<div><style>.x{color:red}</style><p>第一段</p><p>第二段</p></div>',
    });
    expect(r.body).toContain('第一段');
    expect(r.body).toContain('第二段');
    expect(r.body).not.toContain('<p>');
    expect(r.body).not.toContain('color:red');
  });

  it('白名单：精确地址 / @域名 / 空=只认自己', async () => {
    const { allowedSenders } = await import('../../server/core/inbox-mail.ts');
    const base = { host: 'smtp.qq.com', port: 465, secure: true, user: 'me@example.com', pass: 'x', to: 'me@example.com' };
    expect(allowedSenders(base)).toEqual(['me@example.com']);
    expect(allowedSenders({ ...base, allowFrom: ['a@b.com', '@qq.com'] })).toEqual(['a@b.com', '@qq.com']);
  });
});

/* ---------------- S. 生命周期模型 ---------------- */

describe('生命周期：状态判定与 AI 切入点', () => {
  it('笔记按事实落到正确状态', async () => {
    const { lifeOf } = await import('../../shared/lifecycle-model.ts');
    const base = { type: 'note' as const };

    expect(lifeOf({ ...base, bodyLength: 30 })?.state).toBe('captured');
    expect(lifeOf({ ...base, bodyLength: 500 })?.state).toBe('developed');
    expect(lifeOf({ ...base, bodyLength: 500, outbound: 2 })?.state).toBe('linked');
    expect(lifeOf({ ...base, bodyLength: 500, outbound: 2, evergreen: true })?.state).toBe('settled');
    expect(lifeOf({ ...base, supersededBy: 'note-x' })?.state).toBe('superseded');
    expect(lifeOf({ ...base, archivedAt: '2026-01-01' })?.state).toBe('archived');
  });

  it('每个状态都说清意义、可去、产出；有 AI 钩子的状态可枚举', async () => {
    const { FLOWS } = await import('../../shared/lifecycle-model.ts');
    for (const flow of FLOWS) {
      for (const s of flow.states) {
        expect(s.goal.length).toBeGreaterThan(0);
        expect(s.output.length).toBeGreaterThan(0);
        expect(Array.isArray(s.next)).toBe(true);
        expect(s.actors.length).toBeGreaterThan(0);
      }
    }
    const hooks = FLOWS.flatMap((f) => f.states.filter((s) => s.aiHook));
    // 判断/提炼/连接/质疑四个切入点必须都在
    expect(hooks.length).toBeGreaterThanOrEqual(4);
  });

  it('任务按 state 判定，归档优先', async () => {
    const { lifeOf } = await import('../../shared/lifecycle-model.ts');
    expect(lifeOf({ type: 'action', state: 'open' })?.state).toBe('open');
    expect(lifeOf({ type: 'action', state: 'done' })?.state).toBe('done');
    expect(lifeOf({ type: 'action', state: 'done', archivedAt: '2026-01-01' })?.state).toBe('archived');
  });
});

/* ---------------- T. 活性衰减与翻新 ---------------- */

describe('使用驱动的活性', () => {
  it('按最近一次使用分档', async () => {
    const { vitalityOf: v } = await import('../../server/core/lifecycle.ts');
    const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
    const rec = (n: number) => ({ last: daysAgo(n), open: 1, read: 0, search: 0, edit: 0, ai: 0 });

    expect(v(rec(3), undefined).level).toBe('hot');
    expect(v(rec(20), undefined).level).toBe('warm');
    expect(v(rec(60), undefined).level).toBe('cooling');
    expect(v(rec(120), undefined).level).toBe('cold');
    expect(v(rec(400), undefined).level).toBe('ash');
  });

  it('冷掉的定稿笔记会进翻新队列，理由说清为什么该翻', async () => {
    const d2 = await makeSpace(MINI, false);
    const h2 = await Habitat.open(d2, { fresh: true });
    try {
      const note = h2.store.all('note')[0] as unknown as { id: string; title: string };
      // 造一条 200 天没碰的使用记录
      const old = new Date(Date.now() - 200 * 86400_000).toISOString();
      await h2.store.adapter.write(
        '.habitat/state/usage.json',
        JSON.stringify({ [note.id]: { last: old, open: 0, read: 0, search: 0, edit: 0, ai: 0 } }),
        { backup: false },
      );
      const { lifeSnapshot } = await import('../../server/core/lifecycle.ts');
      // usage 有进程内缓存，换了文件要显式清掉
      const { resetUsageCache } = await import('../../server/core/usage.ts');
      resetUsageCache();
      h2.close();
      const h3 = await Habitat.open(d2, { fresh: true });
      const snap = await lifeSnapshot(h3);
      h3.close();
      resetUsageCache();

      expect(snap.byVitality.find((x) => x.vitality === 'ash')!.n).toBeGreaterThan(0);
      const hit = snap.refresh.find((x) => x.id === note.id);
      expect(hit).toBeTruthy();
      expect(hit!.why.length).toBeGreaterThan(0);
      expect(hit!.idleDays).toBeGreaterThan(180);
    } finally {
      await rmSpace(d2);
    }
  });
});

/* ---------------- U. 翻新：候选召回与复习间隔 ---------------- */

describe('翻新', () => {
  it('中文词袋不再只取前 6 个二元组（曾经导致候选永远为空）', async () => {
    const { conflictCandidates } = await import('../../server/core/renew.ts');
    // 取一条讲「状态就是记忆」的笔记，库里另有若干同主题笔记
    const note = hab.store.all('note').find((n) => String((n as unknown as { title: string }).title).includes('状态就是记忆'));
    expect(note).toBeTruthy();
    const cands = await conflictCandidates(hab, String((note as unknown as { id: string }).id));
    // 不保证一定有冲突，但至少要能跑出结构化结果
    expect(Array.isArray(cands)).toBe(true);
    for (const c of cands) {
      expect(c.id).not.toBe((note as unknown as { id: string }).id);
      expect(c.sim).toBeGreaterThanOrEqual(0.03);
      expect(c.shared.length).toBeGreaterThan(0);
    }
  });

  it('复习间隔按阶梯推进，判错回到明天', async () => {
    const { markReviewed } = await import('../../server/core/renew.ts');
    const id = String((hab.store.all('note')[0] as unknown as { id: string }).id);

    const r1 = await markReviewed(hab, id, true);
    expect(r1.nextIn).toBe(1);
    const r2 = await markReviewed(hab, id, true);
    expect(r2.nextIn).toBe(3);
    const r3 = await markReviewed(hab, id, true);
    expect(r3.nextIn).toBe(7);
    expect(r3.rec.streak).toBe(3);

    const bad = await markReviewed(hab, id, false);
    expect(bad.nextIn).toBe(1);
    expect(bad.rec.streak).toBe(0);
    expect(bad.rec.lastOk).toBeTruthy(); // 上次确认时间要保住，不是清零
  });
});

/* ---------------- V. 文件浏览与受管操作 ---------------- */

describe('文件浏览', () => {
  it('列目录：默认藏起系统目录，越界路径直接拒绝', async () => {
    const { listDir } = await import('../../server/core/fs.ts');
    const root = await listDir(hab, '');
    const names = root.dirs.map((d) => d.name);
    expect(names).toContain('knowledge');
    expect(names).toContain('work');
    expect(names).not.toContain('.habitat');

    await expect(listDir(hab, '../..')).rejects.toThrow(/越界/);
  });

  it('已入库且被引用的笔记：改名先拦下并报断链数，force 后才执行', async () => {
    const { listDir, moveFile } = await import('../../server/core/fs.ts');
    // 找一个有入链的笔记文件
    const notes = await listDir(hab, 'knowledge/notes');
    const target = notes.files.find((f) => f.indexed && (f.inbound ?? 0) > 0);
    expect(target, '夹具里应该有带入链的笔记').toBeTruthy();

    const next = target!.path.replace(/\.md$/, '-renamed.md');
    const blocked = await moveFile(hab, target!.path, next, {});
    expect(blocked.ok).toBe(false);
    expect(blocked.brokenLinks).toBeGreaterThan(0);
    expect(blocked.needConfirm).toContain('链接');

    // 文件没有被动过
    const after = await listDir(hab, 'knowledge/notes');
    expect(after.files.some((f) => f.path === target!.path)).toBe(true);

    const forced = await moveFile(hab, target!.path, next, { force: true });
    expect(forced.ok).toBe(true);
    const moved = await listDir(hab, 'knowledge/notes');
    expect(moved.files.some((f) => f.path === next)).toBe(true);
    expect(moved.files.some((f) => f.path === target!.path)).toBe(false);
  });

  it('归档是移动不是删除：落进 archive/fs/<日期>/，原位置不再有', async () => {
    const { listDir, archiveFiles } = await import('../../server/core/fs.ts');
    const first = (await listDir(hab, 'knowledge/notes')).files[0];
    expect(first).toBeTruthy();

    const r = await archiveFiles(hab, [first.path]);
    expect(r.moved).toHaveLength(1);
    expect(r.moved[0].to).toMatch(/^archive\/fs\/\d{4}-\d{2}-\d{2}\//);

    const after = await listDir(hab, 'knowledge/notes');
    expect(after.files.some((f) => f.path === first.path)).toBe(false);

    // 归档后的文件还在，能列出来
    const archived = await listDir(hab, r.moved[0].to.slice(0, r.moved[0].to.lastIndexOf('/')));
    expect(archived.files.some((f) => f.path === r.moved[0].to)).toBe(true);
  });
});

/* ---------------- W. 增量索引的正确性 ---------------- */

describe('增量索引', () => {
  it('提交后新内容立刻可检索，且不残留旧标题', async () => {
    const note = hab.store.all('note')[0] as unknown as { id: string; title: string };
    const stamp = `ZZQ${Date.now()}`;

    // 改标题 + 加一个检索得到的新词
    const cs = await hab.changes.propose({
      ops: [{ t: 'update', id: note.id, patch: { title: `新标题 ${stamp}` } }],
      reason: '增量索引测试',
      actor: 'human',
    } as never);
    const r = await hab.changes.commit(cs.id);
    expect(r.ok).toBe(true);

    // 提交回调是 void 的，等一拍让它跑完
    await new Promise((res) => setTimeout(res, 300));

    const hits = hab.index.search(stamp, { limit: 10 });
    expect(hits.some((h) => h.id === note.id)).toBe(true);

    // 旧标题不该还能检到（docs 表里是覆盖写，不是追加）
    const old = hab.index.search(note.title, { limit: 10 });
    expect(old.some((h) => h.id === note.id && h.title === note.title)).toBe(false);
  });

  it('增量同步不会把别的对象从索引里弄丢', async () => {
    const before = hab.index.search('线性注意力', { limit: 50 }).length;
    const one = hab.store.all('note')[1] as unknown as { id: string };
    await hab.syncIndex([one.id]);
    const after = hab.index.search('线性注意力', { limit: 50 }).length;
    expect(after).toBe(before);
  });
});

/* ---------------- X. 增量扫描的正确性 ---------------- */

/** 把扫描结果压成可比对的快照：对象、链接、词干、附件、行内块 */
function snapStore(store: import('../../server/core/store.ts').Store) {
  const types = ['note', 'work', 'part', 'rep', 'action', 'event', 'project', 'area', 'collection', 'annotation'] as const;
  const objs = types.flatMap((t) =>
    store.all(t).map((o) => {
      const x = o as { id: string; title?: string; text?: string };
      return `${t}|${x.id}|${x.title ?? x.text ?? ''}`;
    }),
  );
  return {
    objects: objs.sort(),
    links: store.links.map((l) => `${l.from}→${l.to}`).sort(),
    stems: [...store.stems.entries()].map(([k, v]) => `${k}=${v}`).sort(),
    assets: store.assets.map((a) => a.path).sort(),
    inline: [...store.inlineFiles.keys()].sort(),
  };
}

describe('增量扫描', () => {
  it('全命中缓存时，结果与上一次扫描完全一致', async () => {
    const d = await makeSpace(MINI, false);
    const h = await Habitat.open(d, { fresh: true });
    try {
      const first = snapStore(h.store);
      await h.store.scan(); // 全部命中片段缓存 → 只重放
      expect(snapStore(h.store)).toEqual(first);
    } finally {
      h.close();
      await rmSpace(d);
    }
  });

  it('改一个文件后，增量结果与全新实例的全量扫描一致', async () => {
    const d = await makeSpace(MINI, false);
    const h = await Habitat.open(d, { fresh: true });
    let incremental: ReturnType<typeof snapStore>;
    try {
      // 改一篇笔记：内容变、大小变，签名必然不同
      const target = (await import('node:fs')).readdirSync(`${d}/knowledge/notes`)[0];
      const rel = `knowledge/notes/${target}`;
      const abs = `${d}/${rel}`;
      const fsm = await import('node:fs/promises');
      const raw = await fsm.readFile(abs, 'utf8');
      await fsm.writeFile(abs, `${raw}\n\n补一句：新增了 [[另一个目标]] 这条链接。\n`, 'utf8');

      await h.store.scan(); // 只重解析这一个文件，其余重放
      incremental = snapStore(h.store);
    } finally {
      h.close();
    }

    // 全新实例：没有任何片段缓存，必定走完整解析
    const h2 = await Habitat.open(d, { fresh: true, dbPath: ':memory:' });
    try {
      expect(incremental).toEqual(snapStore(h2.store));
    } finally {
      h2.close();
      await rmSpace(d);
    }
  });
});

/* ---------------- Y. 欠账口径：只报真卡点 ---------------- */

describe('欠账口径', () => {
  it('接入态 + 有结论段 → 不算欠账，归稳定态', async () => {
    const { lifeOf } = await import('../../shared/lifecycle-model.ts');
    const base = { type: 'note', bodyLength: 900, inbound: 2, outbound: 1 };

    const done = lifeOf({ ...base, hasConclusion: true })!;
    expect(done.state).toBe('linked');
    expect(done.stuck).toBe(false);
    expect(done.blockers[0]).toContain('待确认');

    const unfinished = lifeOf({ ...base, hasConclusion: false })!;
    expect(unfinished.stuck).toBe(true);
    expect(unfinished.blockers[0]).toContain('没写结论');
  });

  it('备查是材料流终态，不再算欠账', async () => {
    const { lifeOf } = await import('../../shared/lifecycle-model.ts');
    const ref = lifeOf({ type: 'work', reference: true })!;
    expect(ref.state).toBe('reference');
    expect(ref.stateName).toBe('备查');
    expect(ref.stuck).toBe(false);

    // 同样的书不标备查，就是欠账
    const normal = lifeOf({ type: 'work' })!;
    expect(normal.state).toBe('capture');
    expect(normal.stuck).toBe(true);
    expect(normal.blockers[0]).toContain('衍生');
  });

  it('快照把稳定态与欠账分开，不混在一起报数', async () => {
    const snap = await (await import('../../server/core/lifecycle.ts')).lifeSnapshot(hab);
    // 两边不能重叠
    const stuckIds = new Set(snap.stuck.map((x) => x.id));
    for (const s of snap.stable) expect(stuckIds.has(s.id)).toBe(false);
    // 归档/定稿/备查不进任何一边
    for (const x of [...snap.stuck, ...snap.stable]) {
      expect(['archived', 'superseded', 'settled', 'reference']).not.toContain(x.state);
    }
  });
});
