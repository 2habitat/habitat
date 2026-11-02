/**
 * habitat CLI —— 外部 Agent 与人的同一个入口。
 * 直接操作文件（不需要先起服务），与 HTTP 接口走同一套 ChangeService。
 */
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Habitat } from './core/space.ts';
import { buildManifest } from './routes/api.ts';
import { takeSnapshot } from './core/reconcile.ts';
import { runSync, loadExactMap } from './core/sync.ts';
import { exportSpace, verifyExport } from './core/export.ts';
import { runMcp } from './mcp.ts';
import { saveAsset, assetUrl, assetMarkdown } from './core/assets.ts';
import { mailStatus, sendMail } from './core/mailer.ts';
import { runReminders } from './core/reminders.ts';
import { collectBrief, renderBrief, runTidy } from './core/tidy.ts';
import { ingestMail } from './core/inbox-mail.ts';
import { lifeViewOf, lifeSnapshot, renderNext } from './core/lifecycle.ts';
import { renewPack, renderRenew, markReviewed, reviewOf } from './core/renew.ts';
import { touch, flush } from './core/usage.ts';
import type { JournalOp } from '../shared/types.ts';
import { nowISO } from '../shared/id.ts';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  return process.argv[i + 1] ?? def;
}
function notifyStatus() {
  const st = mailStatus();
  return { configured: st.configured, to: st.to, host: st.host, configPath: st.path, missing: st.missing };
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * 取命令后的「位置参数」，自动跳过 `--flag`
 * 和它后面的值。不这样的话 `done id --root D:/x` 会把 D:/x 也当成 id。
 */
function positional(from = 3): string[] {
  const out: string[] = [];
  const argv = process.argv;
  for (let i = from; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // `--name value` 形式：下一个不是 -- 开头就吃掉它
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

// 认空间的顺序：环境变量 → --root → 默认空间。
// **不能**用位置参数兜底：`habitat search 上下文压缩` 的第 3 个参数是关键词，
// 当成空间根会去找「上下文压缩/.habitat」这种目录，报「数据库打不开」。
// 空间根：环境变量 → --root → 当前目录下的 ./space。
// 故意不写死任何绝对路径——发布版不能带着作者的目录结构。
const ROOT = process.env.HABITAT_SPACE ?? arg('root') ?? path.resolve('space');

function usage(): string {
  return `habitat —— 知识库与个人工作台

  habitat status [--json]                 空间概览（--json 供脚本对比）
  habitat reindex                         重建 SQLite 索引
  habitat search <关键词> [--type=note]    检索
  habitat read <rep-id>                   读正文

  habitat capture "标题" --body "内容"     采集
  habitat derive  --src <id> --title "…" --body "…"
  habitat annotate --rep <id> --quote "…" [--from 0] [--to 10]
  habitat task "文本" [--due 2026-11-02] [--flow now|next|later] [--project <id>]   新建任务
  habitat event "标题" --date 2026-11-03 --start 14:00 [--end 15:00]  新建日程
  habitat inbox-mail [--fetch]             把发给自己的邮件收进收件箱（--fetch 才真收）
  habitat state <id>                       这个对象在哪一步、缺什么、下一步谁能推
  habitat refresh                          活性分布 + 该翻新的（久未使用的）
  habitat due [--limit 5]                  今天该复核哪几条（刻意限量，避免堆成山）
  habitat renew <id>                       翻新证据包：它主张什么 + 库里哪几条可能撞上
  habitat review <id> --ok|--stale         记一次复核：仍成立 → 间隔往后推；不对 → 明天再看
  habitat stuck [--ai]                     全库卡在哪（--ai 只看 AI 能接手的）
  habitat next                            给 AI 的接手清单
  habitat brief                            今日简报：今天/逾期/7 天内/读一半/收件箱/库状态
  habitat tidy [--apply]                   代谢：列出（或执行）可归档的已完成任务
  habitat notify [--test|--send]           邮件提醒：看配置 / 发测试信 / 真发一轮
  habitat attach <文件> [--as 名字] [--dir originals] [--markdown]   上传附件，给出可插入的 markdown
  habitat project "标题" [--goal "…"]      新建项目
  habitat done <id...>                    完成任务
  habitat move <id> --due 2026-11-05      改期
  habitat archive <id...>                 归档（不是删除）
  habitat write <id> --body "…" | --file x.md   改正文/改那一行
  habitat list --what tasks|events|inbox|works  列清单
  habitat mcp                                 起 MCP 服务（stdio，给 Claude Desktop / Cursor 挂）
  habitat propose --ops ops.json [--base base.json] [--reason "…"] [--commit] [--actor agent:xxx]
  habitat sync --from <旧库根> [--map plan.json] [--apply]   补进旧布局新增的文件（不覆盖）
  habitat export --out <目录> [--verify]        原样导出（含哈希清单），--verify 校验

  habitat agent manifest [--json]          能力清单（唯一事实）
  habitat agent log --op <op> --target <路径> --summary "…" [--actor agent:xxx]
  habitat agent reconcile                  对账：未署名改动 → external_edit
  habitat agent snapshot                   拍照存基线

op 取值：capture ingest read annotate derive edit propose review settle commit build import revert
`;
}

async function main(): Promise<number> {
  const [cmd, sub] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(usage());
    return 0;
  }
  const hab = await Habitat.open(ROOT);

  switch (cmd) {
    case 'status': {
      const s = hab.stats();
      // --json 给脚本用（升级前后对比对象数，防止重构把扫描改坏）
      if (flag('json')) {
        console.log(JSON.stringify({ space: hab.store.space.name, root: hab.store.root, ...s }));
        return 0;
      }
      console.log(`空间：${hab.store.space.name}（${hab.store.root}）`);
      console.log(`作品 ${s.works} · 章节 ${s.parts} · 载体 ${s.reps} · 笔记 ${s.notes} · 批注 ${s.annotations} · 任务 ${s.actions} · 日程 ${s.events}`);
      console.log(`链接 ${s.links} 条，未解析 ${s.unresolved} 条（解析率 ${s.links ? ((1 - s.unresolved / s.links) * 100).toFixed(1) : '100.0'}%）`);
      console.log(`附件 ${s.assets} 个 · ${(s.assetBytes / 1048576).toFixed(1)} MB`);
      return 0;
    }
    case 'reindex': {
      await hab.reindex();
      console.log(`索引已重建：${hab.index.stats().docs} 条对象，${hab.index.stats().links} 条链接`);
      return 0;
    }
    case 'search': {
      const q = positional()[0] ?? '';
      if (!q) return console.log(usage()), 1;
      const hits = hab.index.search(q, { type: arg('type'), limit: Number(arg('limit', '20')) });
      touch(hab.store, hits.slice(0, 10).map((h) => h.id), 'search');
      if (!hits.length) console.log('（没有命中）');
      for (const h of hits) console.log(`${h.type.padEnd(10)} ${h.title}\n           ${h.snippet}`);
      return 0;
    }
    case 'read': {
      const rid = positional()[0] ?? '';
      console.log(await hab.store.body(rid));
      // AI 读过也要算一次使用：不然「AI 访问」这条通道在活性里是空的
      if (rid) touch(hab.store, rid, 'ai');
      return 0;
    }
    case 'capture': {
      const title = positional()[0] ?? '未命名';
      const r = await hab.capture({
        title,
        body: arg('body', '') ?? '',
        srcIds: arg('src') ? [arg('src')!] : [],
        // 默认落收件箱，和界面上的「采集」一致：先存下来，想清楚了再衍生
        target: (arg('target') ?? 'inbox') as 'inbox' | 'notes',
        actor: (arg('actor') ?? 'human') as never,
      });
      console.log(`已采集 ${r.id}，事件 ${r.events.length} 条`);
      return 0;
    }
    case 'derive': {
      const r = await hab.derive({
        srcId: arg('src') ?? '',
        title: arg('title') ?? '未命名衍生',
        body: arg('body', '') ?? '',
        actor: (arg('actor') ?? 'human') as never,
      });
      console.log(`已衍生 ${r.id}，事件 ${r.events.length} 条`);
      return 0;
    }
    case 'annotate': {
      const repId = arg('rep') ?? '';
      const quote = arg('quote') ?? '';
      const r = await hab.annotate({
        repId,
        quote,
        note: arg('note'),
        from: Number(arg('from', '0')),
        to: Number(arg('to', String(quote.length))),
        actor: (arg('actor') ?? 'human') as never,
      });
      console.log(`已批注 ${r.id}，事件 ${r.events.length} 条`);
      return 0;
    }
    case 'propose': {
      // AI 侧主入口：把 ops 写进 JSON 文件，走和人完全相同的 propose → validate → commit
      const opsFile = arg('ops');
      if (!opsFile) return console.log('用法：habitat propose --ops ops.json [--base base.json] [--reason "…"] [--commit]'), 1;
      const opsRaw = JSON.parse(fs.readFileSync(opsFile, 'utf8')) as unknown;
      const ops = (Array.isArray(opsRaw) ? opsRaw : (opsRaw as { ops: unknown[] }).ops) as never[];
      if (!Array.isArray(ops) || ops.length === 0) return console.log('ops.json 里没有操作'), 1;
      const baseFile = arg('base');
      const base = baseFile ? (JSON.parse(fs.readFileSync(baseFile, 'utf8')) as never) : undefined;
      const cs = await hab.changes.propose({
        ops,
        base,
        reason: arg('reason') ?? 'CLI 提出变更',
        actor: (arg('actor') ?? 'agent:cli') as never,
      });
      const checks = await hab.changes.validate(cs);
      const bad = checks.filter((c) => !c.ok && c.level === 'error');
      console.log(`提案 ${cs.id}`);
      for (const c of checks) console.log(`  ${c.ok ? '✓' : c.level === 'error' ? '✗' : '!'} ${c.label}：${c.detail}`);
      if (bad.length) return console.log('校验没过，不落盘。'), 1;
      if (!flag('commit')) return console.log('只提了提案，没落盘。加 --commit 才写文件。'), 0;
      const r = await hab.changes.commit(cs.id);
      if (r.blocked?.length) return console.log(`被拦下：${r.blocked.map((b) => b.label).join('；')}`), 1;
      if (!r.ok) {
        console.log('撞车了，没有覆盖。三方内容：');
        console.log(JSON.stringify(r.conflict, null, 2));
        return 1;
      }
      console.log(`已落盘，事件 ${r.events.length} 条`);
      return 0;
    }
    case 'mcp': {
      // stdio 上只允许出现协议消息，日志一律走 stderr
      await runMcp(ROOT);
      return 0;
    }
    case 'export': {
      const out = arg('out');
      if (!out) return console.log('用法：habitat export --out <目录> [--verify]'), 1;
      if (flag('verify')) {
        const v = await verifyExport(out);
        console.log(v.ok ? `校验通过：${v.checked} 个文件哈希一致` : `校验失败：${v.bad.length} 处不对`);
        for (const b of v.bad) console.log(`  ✗ ${b}`);
        return v.ok ? 0 : 1;
      }
      const r = await exportSpace(hab.store, out);
      console.log(`已导出 ${r.files} 个文件（${(r.bytes / 1048576).toFixed(1)} MB）→ ${r.to}`);
      if (r.skipped.length) console.log(`  跳过 ${r.skipped.length} 个可重建文件（索引 / 写前备份 / 缓存）`);
      console.log(`  清单：${r.manifest}`);
      return 0;
    }
    case 'sync': {
      const from = arg('from');
      if (!from) return console.log('用法：habitat sync --from <旧库根> [--apply] [--json]'), 1;
      const apply = flag('apply');
      const mapFile = arg('map');
      const exact = mapFile ? loadExactMap(mapFile) : undefined;
      const r = await runSync(from, ROOT, hab.journal, apply, exact);
      if (flag('json')) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        console.log(`扫描 ${r.scanned} 个文件：新增 ${r.add.length} · 一致 ${r.same} · 两边不同 ${r.differ.length}`);
        for (const a of r.add.slice(0, 20)) console.log(`  + ${a.from} → ${a.to}`);
        if (r.add.length > 20) console.log(`  …还有 ${r.add.length - 20} 个新增`);
        for (const d of r.differ.slice(0, 20)) console.log(`  ! ${d.from} ↔ ${d.to}（内容不同，不覆盖）`);
        if (!apply) {
          console.log('只对比，没动文件。加 --apply 才复制新增（不覆盖任何已有内容）。');
        } else {
          console.log(`已复制 ${r.applied} 个文件${r.errors.length ? `，失败 ${r.errors.length} 个` : ''}`);
          for (const e of r.errors.slice(0, 5)) console.log(`  ✗ ${e.path}: ${e.error}`);
        }
      }
      if (apply && r.applied > 0) await hab.rescan();
      return 0;
    }
    case 'task': {
      const r = await hab.addAction({        text: positional()[0] ?? '未命名任务',
        due: arg('due'),
        flow: (arg('flow') as never) ?? undefined,
        // 任务挂项目：之前只能手拼 ops，命令里没有这个口子
        projectId: arg('project'),
        actor: (arg('actor') ?? 'human') as never,
      });
      console.log(`已建任务 ${r.id}，事件 ${r.events.length} 条`);
      return 0;
    }
    case 'event': {
      const title = positional()[0];
      const date = arg('date');
      const start = arg('start');
      if (!title || !date || !start) return console.log('用法：habitat event "标题" --date 2026-11-03 --start 14:00 [--end 15:00] [--project <id>]'), 1;
      const r = await hab.addEvent({ title, date, start, end: arg('end'), projectId: arg('project'), actor: 'human' });
      console.log(`已加日程 ${r.id}：${date} ${start}${arg('end') ? '–' + arg('end') : ''} ${title}`);
      return 0;
    }
    case 'inbox-mail': {
      const dry = !flag('fetch');
      const r = await ingestMail(hab, { dryRun: dry });
      if (!r.configured) return console.log(`没有配置邮件通道（${r.error}）`), 1;
      if (r.error) return console.log(`连不上：${r.error}`), 1;
      console.log(`${dry ? '（只看不收）' : ''}未读 ${r.fetched} 封，入库 ${r.captured.length}，跳过 ${r.skipped.length}`);
      for (const x of r.captured) console.log(`  ✓ ${x.subject}${x.attachments ? `（${x.attachments} 个附件）` : ''}${x.id ? ` → ${x.id}` : ''}`);
      for (const x of r.skipped) console.log(`  · 跳过 ${x.subject}（${x.skipped}）`);
      if (dry) console.log('加 --fetch 真的收下并标记已读。');
      return 0;
    }
    case 'state': {
      const id = positional()[0];
      if (!id) return console.log('用法：habitat state <id>'), 1;
      const got = await lifeViewOf(hab, id, { withStat: true });
      if (!got) return console.log(`对象不存在或不参与生命周期：${id}`), 1;
      const v = got.view;
      console.log(`${v.type} · ${v.stateName}（${v.state}）· 搁置 ${got.days} 天`);
      console.log(`这一步的意义：${v.goal}`);
      if (v.blockers.length) console.log(`缺：${v.blockers.join('；')}`);
      if (v.aiHook) console.log(`AI 能做：${v.aiHook}`);
      if (v.next.length) {
        console.log('下一步：');
        for (const n of v.next) console.log(`  → ${n.name}（${n.actors.join('/')} 可推；产出：${n.output}）${n.aiHook ? `  AI：${n.aiHook}` : ''}`);
      }
      return 0;
    }
    case 'renew': {
      const id = positional()[0];
      if (!id) return console.log('用法：habitat renew <id>'), 1;
      const pack = await renewPack(hab, id);
      if (!pack) return console.log(`对象不存在：${id}`), 1;
      console.log(renderRenew(pack));
      return 0;
    }
    case 'review': {
      const id = positional()[0];
      if (!id) return console.log('用法：habitat review <id> --ok|--stale'), 1;
      const ok = flag('ok');
      const stale = flag('stale');
      if (!ok && !stale) return console.log('要么 --ok（仍然成立），要么 --stale（已经不对）'), 1;
      const r = await markReviewed(hab, id, ok);
      console.log(ok ? `确认仍然成立，${r.nextIn} 天后再看（连续第 ${r.rec.streak} 次）` : `标记为待改写，明天再看`);
      return 0;
    }
    case 'due': {
      const snap = await lifeSnapshot(hab);
      const packs: { id: string; title: string; idle: number }[] = [];
      for (const x of snap.refresh) {
        const rv = await reviewOf(hab, x.id);
        const dueAt = rv ? Date.parse(rv.due) : 0;
        if (!rv || dueAt <= Date.now()) packs.push({ id: x.id, title: x.title, idle: x.idleDays });
      }
      if (!packs.length) {
        console.log('今天没有到期的复核。');
        return 0;
      }
      // 刻意限量：一次给一堆只会让人关掉它（社区反复踩过的坑）
      const cap = Number(arg('limit') ?? 5);
      console.log(`今天该复核 ${packs.length} 条，先看前 ${Math.min(cap, packs.length)} 条：`);
      for (const p of packs.slice(0, cap)) console.log(`  · ${p.title}（${p.idle} 天没碰）  ${p.id}`);
      console.log('');
      console.log('逐条跑 `habitat renew <id>` 拿证据包，再 `habitat review <id> --ok` 或 `--stale`。');
      return 0;
    }
    case 'refresh': {
      const snap = await lifeSnapshot(hab);
      console.log('活性分布：');
      for (const v of snap.byVitality) console.log(`  ${v.name.padEnd(4)} ${String(v.n).padStart(3)} 个`);
      console.log('');
      if (!snap.refresh.length) {
        console.log('没有冷掉的东西——要么都在用，要么刚建不久。');
        return 0;
      }
      console.log(`该翻新的 ${snap.refresh.length} 个（按多久没人碰排序）：`);
      for (const x of snap.refresh.slice(0, 20)) {
        console.log(`  · ${x.title}（${x.stateName}，${x.idleDays} 天没碰）${x.why}`);
      }
      console.log('');
      console.log('翻新不是"重读一遍"：定稿的做质疑、半成品接着写、碎片直接判断留不留。');
      return 0;
    }
    case 'stuck': {
      const snap = await lifeSnapshot(hab);
      console.log(`共扫描 ${snap.stuck.length} 个未完成对象`);
      for (const s of snap.byState) console.log(`  ${s.stateName.padEnd(6)} ${String(s.n).padStart(3)} 个（${s.flow}）`);
      if (flag('ai')) {
        console.log('');
        console.log(renderNext(snap));
        return 0;
      }
      console.log('');
      for (const x of snap.stuck.slice(0, 15)) {
        console.log(`  · ${x.title}（${x.stateName}，${x.days} 天）${x.blockers.length ? ' 缺：' + x.blockers[0] : ''}`);
      }
      console.log('');
      console.log('加 --ai 看 AI 能接手哪些。');
      return 0;
    }
    case 'next': {
      const snap = await lifeSnapshot(hab);
      console.log(renderNext(snap));
      if (snap.refresh.length) {
        console.log('');
        console.log(`## 冷掉的定稿（${snap.refresh.length} 个，先看前 5 个）`);
        console.log('这些不是"提醒你重读"，是"可能已经被新东西推翻了"。');
        for (const x of snap.refresh.slice(0, 5)) {
          console.log(`- ${x.title}（${x.idleDays} 天没碰）${x.why}`);
          console.log(`    拿证据：habitat renew ${x.id}`);
        }
      }
      return 0;
    }
    case 'brief': {
      const data = await collectBrief(hab);
      console.log(renderBrief(data));
      return 0;
    }
    case 'tidy': {
      const r = await runTidy(hab, { dryRun: !flag('apply') });
      console.log(r.brief);
      console.log('');
      if (r.dryRun) {
        console.log(`待归档 ${r.candidates} 条已完成任务（超过 ${process.env.HABITAT_ARCHIVE_DONE_DAYS ?? 30} 天）。`);
        console.log('加 --apply 真的归档（走变更集，可撤销）。');
      } else {
        console.log(r.error ? `出错：${r.error}` : `已归档 ${r.archived} 条（可在变更页整批撤销）。`);
      }
      return r.error ? 1 : 0;
    }
    case 'notify': {
      const st = notifyStatus();
      if (flag('test')) {
        const r = await sendMail({
          subject: '✅ Habitat 邮件通道已接通',
          text: `这封信是从本地知识库发出的。
收件人：${st.to ?? '(未配置)'}
时间：${nowISO()}`,
        });
        console.log(r.ok ? `已发出，messageId=${r.messageId}` : `没发出去：${r.error}`);
        return r.ok ? 0 : 1;
      }
      const rep = await runReminders(hab, { dryRun: !flag('send') });
      if (!flag('send')) {
        console.log(
          st.configured
            ? `邮件通道已配置 → ${st.to}`
            : `邮件通道未配置（${st.configPath}）${st.missing.length ? `，缺：${st.missing.join('、')}` : ''}`,
        );
        console.log(rep.sent.length ? `这一轮会提醒 ${rep.sent.length} 条：` : '这一轮没有要提醒的');
        for (const x of rep.sent) console.log(`  ${x.kind}：${x.title}`);
        for (const x of rep.skipped) console.log(`  · ${x}`);
        console.log('');
        console.log('加 --send 真的发；加 --test 发一封测试信。');
      } else {
        console.log(rep.sent.length ? `已发 ${rep.sent.length} 条` : '没有要发的');
        if (rep.error) console.log(`  出错：${rep.error}`);
      }
      return rep.error ? 1 : 0;
    }
    case 'attach': {
      const file = positional()[0];
      if (!file) return console.log('用法：habitat attach <文件路径> [--as 名字] [--dir attachments|originals] [--markdown]'), 1;
      const abs = path.resolve(file);
      const buf = await readFile(abs).catch(() => null);
      if (!buf) return console.log(`读不到文件：${abs}`), 1;
      const r = await saveAsset(hab.store, buf, {
        name: arg('as') ?? path.basename(abs),
        dir: arg('dir') === 'originals' ? 'assets/originals' : 'assets/attachments',
      });
      if (!r.deduped) {
        await hab.journal.add({
          actor: 'human',
          op: 'import',
          phase: 'done',
          target: r.rel,
          summary: `上传附件：${path.basename(abs)}（${(r.bytes / 1024).toFixed(0)} KB）`,
          payload: { bytes: r.bytes },
        });
      }
      const md = assetMarkdown(r.rel, r.rel.split('/').pop() ?? path.basename(abs));
      if (flag('markdown')) console.log(md);
      else {
        console.log(`${r.deduped ? '已存在，复用' : '已入库'}：${r.rel}（${(r.bytes / 1024).toFixed(0)} KB）`);
        console.log(`  访问：${assetUrl(r.rel)}`);
        console.log(`  插入用：${md}`);
      }
      return 0;
    }
    case 'project': {
      const title = positional()[0];
      const goal = arg('goal') ?? '';
      if (!title) return console.log('用法：habitat project "标题" [--goal "什么样子算完成"]'), 1;
      const obj = {
        type: 'project' as const,
        id: `project-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        schema: 1,
        spaceId: hab.store.space.id,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        author: 'human' as const,
        sensitivity: hab.store.space.defaultSensitivity,
        rev: 1,
        title,
        desc: goal,
        state: 'active' as const,
      };
      const cs = await hab.changes.propose({ ops: [{ t: 'create', obj }], reason: `新建项目：${title}`, actor: 'human' } as never);
      const r = await hab.changes.commit(cs.id);
      console.log(r.ok ? `已建项目 ${obj.id}：${title}${goal ? `（目标：${goal}）` : ''}` : '没建成');
      return r.ok ? 0 : 1;
    }
    case 'done': {
      const ids = positional();
      if (!ids.length) return console.log('用法：habitat done <id...>'), 1;
      const ops = ids.map((id) => ({ t: 'update' as const, id, patch: { state: 'done', doneAt: nowISO() } }));
      const cs = await hab.changes.propose({ ops, reason: `完成 ${ids.length} 项`, actor: 'human' } as never);
      const r = await hab.changes.commit(cs.id);
      console.log(r.ok ? `已完成 ${ids.length} 项` : `没改成：${r.conflict ? '撞车了，先看差异' : '校验没过'}`);
      return r.ok ? 0 : 1;
    }
    case 'move': {
      const id = positional()[0];
      const due = arg('due');
      if (!id || !due) return console.log('用法：habitat move <id> --due 2026-11-05'), 1;
      const cs = await hab.changes.propose({ ops: [{ t: 'update', id, patch: { due } }], reason: `改期到 ${due}`, actor: 'human' } as never);
      const r = await hab.changes.commit(cs.id);
      console.log(r.ok ? `已改到 ${due}` : '没改成（可能刚被别人改过）');
      return r.ok ? 0 : 1;
    }
    case 'archive': {
      const ids = positional();
      if (!ids.length) return console.log('用法：habitat archive <id...>   （归档，不是删除）'), 1;
      const ops = ids.map((id) => ({ t: 'archive' as const, id, archived: true }));
      const cs = await hab.changes.propose({ ops, reason: `归档 ${ids.length} 项`, actor: 'human' } as never);
      const r = await hab.changes.commit(cs.id);
      console.log(r.ok ? `已归档 ${ids.length} 项（文件还在，只是不参与日常视图）` : '没改成');
      return r.ok ? 0 : 1;
    }
    case 'write': {
      const id = positional()[0];
      const file = arg('file');
      const body = file ? await readFile(file, 'utf8') : arg('body');
      if (!id || body === undefined) return console.log('用法：habitat write <id> --body "…" | --file body.md'), 1;
      // 任务和日程是「一行」，没有独立正文；它们的文本就是那一行
      const obj = hab.store.get(id);
      const op = obj && (obj.type === 'action' || obj.type === 'event')
        ? { t: 'update' as const, id, patch: { text: body } }
        : { t: 'setBody' as const, id, body };
      const cs = await hab.changes.propose({ ops: [op], reason: '改内容', actor: 'human' } as never);
      const checks = await hab.changes.validate(cs);
      const bad = checks.filter((c) => !c.ok && c.level === 'error');
      if (bad.length) {
        console.log(`校验没过，没落盘：${bad.map((b) => b.label + '：' + b.detail).join('；')}`);
        return 1;
      }
      const r = await hab.changes.commit(cs.id);
      console.log(r.ok ? `已写入 ${id}` : '撞车了，没有覆盖');
      return r.ok ? 0 : 1;
    }
    case 'list': {
      const what = arg('what') ?? 'tasks';
      if (what === 'tasks') {
        const rows = (hab.store.all('action') as unknown as { id: string; text: string; state: string; due?: string; projectId?: string; archivedAt?: string }[])
          .filter((a) => a.state !== 'done' && !a.archivedAt)
          .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
        console.log(`未完成 ${rows.length} 条`);
        for (const a of rows) console.log(`  ${a.id}  ${a.due ?? '无日期'}  ${a.text}${a.projectId ? '  [项目]' : ''}`);
        return 0;
      }
      if (what === 'events') {
        const rows = (hab.store.all('event') as unknown as { id: string; title: string; start: string; archivedAt?: string }[])
          .filter((e) => !e.archivedAt)
          .sort((a, b) => a.start.localeCompare(b.start));
        console.log(`日程 ${rows.length} 条`);
        for (const e of rows) console.log(`  ${e.id}  ${e.start.slice(0, 16)}  ${e.title}`);
        return 0;
      }
      if (what === 'inbox') {
        const nodes = hab.inbox();
        console.log(`收件箱 ${nodes.length} 条`);
        for (const n of nodes) console.log(`  ${n.id}  ${n.title}`);
        return 0;
      }
      if (what === 'works') {
        for (const w of hab.works()) console.log(`  ${w.work.slug}  ${w.work.title}  ${w.parts.length} 章`);
        return 0;
      }
      console.log('用法：habitat list --what tasks|events|inbox|works');
      return 1;
    }
    case 'agent': {
      if (sub === 'manifest' || flag('json') === false && sub === undefined) {
        // fallthrough
      }
      switch (sub) {
        case 'manifest': {
          const m = buildManifest(hab);
          if (flag('json')) console.log(JSON.stringify(m, null, 2));
          else {
            console.log(`空间：${m.space}\n生成时间：${m.generatedAt}\n`);
            for (const c of m.capabilities) {
              console.log(`■ ${c.name}（${c.id}）${c.mutating ? '· 会写' : '· 只读'}`);
              console.log(`  人怎么用：${c.human}`);
              console.log(`  AI 怎么用：${c.agent}`);
              console.log(`  写哪里：${c.writes}`);
              console.log(`  什么事件：${c.event}`);
            }
          }
          return 0;
        }
        case 'log': {
          const op = arg('op') as JournalOp;
          const target = arg('target') ?? '';
          const summary = arg('summary') ?? '';
          if (!op || !target) return console.log(usage()), 1;
          const ev = await hab.journal.add({
            actor: (arg('actor') ?? 'agent:external') as never,
            op,
            phase: 'done',
            target,
            summary,
          });
          console.log(JSON.stringify(ev));
          return 0;
        }
        case 'reconcile': {
          const r = await hab.doReconcile();
          if (r.baseline) {
            console.log(`已建基线：${r.checked} 个文件（记下 sha256，下一次才能对账）`);
            return 0;
          }
          console.log(`对账 ${r.checked} 个文件：新增 ${r.added.length} · 删除 ${r.removed.length} · 改动 ${r.changed.length}`);
          console.log(`  署名改动 ${r.signed.length} 处，未署名 ${r.unsigned.length} 处`);
          for (const u of r.unsigned) console.log(`  ⚠ ${u.path}`);
          return 0;
        }
        case 'snapshot': {
          const s = await takeSnapshot(hab.store);
          console.log(`已拍照：${Object.keys(s).length} 个文件（${nowISO()}）`);
          return 0;
        }
        default:
          console.log(usage());
          return 1;
      }
    }
    default:
      console.log(usage());
      return 1;
  }
}

void path;
// 命令行是一次性进程：使用计数在内存里攒着，退出前必须落盘，否则 AI 读过的东西不算数
let exitCode = 0;
main()
  .then(async (c) => {
    exitCode = c;
    try {
      await flush();
    } catch {
      /* 落盘失败不影响退出码 */
    }
  })
  .then(() => process.exit(exitCode))
  .catch((e) => {
    console.error(`[habitat] ${(e as Error).message}`);
    process.exit(1);
  });
