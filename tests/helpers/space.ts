/** 测试用的最小空间：真实目录布局 + 真实行内语法，复制到临时目录里跑 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDF_BASE64 } from './pdf.ts';

export const W1 = 'work-01HX8Z9K7M2N4P6Q8R0S2T4V6W';
export const W2 = 'work-01HX8Z9K7M2N4P6Q8R0S2T4V6X';
/** 章节与载体也给固定 id，这样批注文件才能在 fixture 里预置 */
export const P1 = 'part-01HX8Z9K7M2N4P6Q8R0S2T4V61';
export const R1 = 'rep-01HX8Z9K7M2N4P6Q8R0S2T4VR1';
export const N1 = 'note-01HX8Z9K7M2N4P6Q8R0S2T4V80';

/** 种子数据里的日期全部相对「今天」生成：写死日期过几天就会变成空看板，界面看着像坏了 */
export function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const D_TODAY = day(0);
export const D_LATER = day(10);
export const D_OVERDUE = day(-2);
export const D_EVENT = day(4);
export const MONTH_EVENT = D_EVENT.slice(0, 7);

export const MINI: Record<string, string> = {
  'space.yaml': `id: space-01HX8Z9K7M2N4P6Q8R0S2T0000
name: 测试空间
tz: Asia/Shanghai
layout: 2
defaultSensitivity: private
schema: 1
author: human
sensitivity: private
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
rev: 1
`,

  'knowledge/works/ai-infra/work.yaml': `id: ${W1}
type: work
title: AI Infra 进阶
kind: book
desc: 线性注意力机制与推理实现
slug: ai-infra
schema: 1
spaceId: space-01HX8Z9K7M2N4P6Q8R0S2T0000
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
`,

  'knowledge/works/ai-infra/parts/01-线性注意力.md': `---
id: ${P1}
repId: ${R1}
type: part
title: 线性注意力
source: "[[AI-Infra 原文]]"
status: growing
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# 线性注意力

线性注意力把 softmax 拆成特征映射的内积，把注意力复杂度从平方降到线性。
代价是固定容量状态， remembering 能力变弱。参见 [[DeltaNet]]。
`,

  'knowledge/works/ai-infra/parts/02-DeltaNet.md': `---
id: part-01HX8Z9K7M2N4P6Q8R0S2T4V62
type: part
title: DeltaNet
source: "[[AI-Infra 原文]]"
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# DeltaNet

Delta 规则做状态更新，把记忆当成在线学习的目标。
`,

  'knowledge/works/ai-infra/parts/附录A-公式表.md': `---
id: part-01HX8Z9K7M2N4P6Q8R0S2T4V6A
type: part
title: 公式表
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# 公式表

补充材料，不进正文顺序。
`,

  'knowledge/works/durable-agent/work.yaml': `id: ${W2}
type: work
title: Durable Agent 详解
kind: article
slug: durable-agent
schema: 1
spaceId: space-01HX8Z9K7M2N4P6Q8R0S2T0000
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
`,

  'knowledge/works/durable-agent/parts/01-持久化内核.md': `---
id: part-01HX8Z9K7M2N4P6Q8R0S2T4V71
type: part
title: 持久化内核
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# 持久化内核

原子 Commit、Task 六态、工具 call+execute 与 safe 重放。参见 [[线性注意力]]。
`,

  'knowledge/notes/状态就是记忆.md': `---
id: note-01HX8Z9K7M2N4P6Q8R0S2T4V80
type: note
title: 状态就是记忆
status: growing
kind: point
srcIds: ["${W1}"]
tags: [ai, 方法论]
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# 状态就是记忆

固定容量状态能替代 KV Cache 的前提是：被压缩掉的信息对后续任务不再重要。

这是我自己写的。
`,

  'knowledge/reports/2026-10-29-注意力机制调研.md': `---
id: note-01HX8Z9K7M2N4P6Q8R0S2T4V81
type: note
title: 注意力机制调研
status: evergreen
kind: report
srcIds: ["${W1}", "${W2}"]
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# 注意力机制调研

问题：线性注意力能否替代 KV Cache。证据见 [[状态就是记忆]]。建议：按通道遗忘门。
`,

  'inbox/2026-10-29-剪藏.md': `---
id: note-01HX8Z9K7M2N4P6Q8R0S2T4V82
type: note
title: 剪藏：一段话
status: seedling
kind: point
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

先存着，回头再想。
`,

  'work/actions/tasks.md': `---
title: 任务池
type: area
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# 任务池

## 待办

- [ ] 读《AI Infra 进阶》第一遍 [due:: ${D_TODAY}] [pri:: med] ^act-20261029-07
- [ ] 整理迁移脚本 [due:: ${D_LATER}] [pri:: high] ^act-20261029-08
- [ ] 补一段上月欠下的笔记 [due:: ${D_OVERDUE}] [pri:: low] ^act-20261029-10
- [x] 建测试空间 [due:: ${D_OVERDUE}] ^act-20261029-09

## 备忘

- 一条普通备忘，不是任务。
`,

  [`work/events/${MONTH_EVENT}.md`]: `---
title: 日程 ${MONTH_EVENT}
month: "${MONTH_EVENT}"
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# 日程 ${MONTH_EVENT}

## 日程

### ${D_EVENT}
- 09:30–10:30 周会 ^evt-20261103-01
`,

  'work/projects/habitat.md': `---
id: project-01HX8Z9K7M2N4P6Q8R0S2T4V90
type: project
title: 统一工作台
state: active
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# 统一工作台

把知识库与个人工作台合成一个系统。
`,

  'work/areas/系统与工具.md': `---
id: area-01HX8Z9K7M2N4P6Q8R0S2T4VA0
type: area
title: 系统与工具
standard: 每周检查一次健康
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# 系统与工具
`,

  'knowledge/annotations/rep-01HX8Z9K7M2N4P6Q8R0S2T4VR1.jsonl':
    `{"id":"ann-01HX8Z9K7M2N4P6Q8R0S2T4VA1","type":"annotation","schema":1,"spaceId":"space-01HX8Z9K7M2N4P6Q8R0S2T0000","createdAt":"2026-10-29T11:00:00+08:00","updatedAt":"2026-10-29T11:00:00+08:00","author":"human","sensitivity":"private","rev":1,"targetRepId":"rep-01HX8Z9K7M2N4P6Q8R0S2T4VR1","revision":1,"locator":{"kind":"char","from":0,"to":12,"prefix":"","suffix":"代价是"},"quote":"线性注意力把 softmax 拆成特征映射的内积","note":"复杂度从平方降到线性，这是全篇的题眼","color":"yellow"}\n` +
    `{"id":"ann-01HX8Z9K7M2N4P6Q8R0S2T4VA2","type":"annotation","schema":1,"spaceId":"space-01HX8Z9K7M2N4P6Q8R0S2T0000","createdAt":"2026-10-29T11:05:00+08:00","updatedAt":"2026-10-29T11:05:00+08:00","author":"agent:workbuddy","sensitivity":"private","rev":1,"targetRepId":"rep-01HX8Z9K7M2N4P6Q8R0S2T4VR1","revision":1,"locator":{"kind":"char","from":60,"to":74,"prefix":"代价是","suffix":"。"},"quote":"固定容量状态","note":"代价写在这里：被压掉的信息回不来","color":"blue"}\n`,

  'knowledge/collections/AI-阅读清单.md': `---
id: collection-01HX8Z9K7M2N4P6Q8R0S2T4VB0
type: collection
title: AI 阅读清单
desc: 线性注意力与 Durable Agent 的对照阅读
memberIds: ["work-01HX8Z9K7M2N4P6Q8R0S2T4V6W"]
query: "type:work"
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

- [[状态就是记忆]]
`,

  'work/reviews/2026-10-29-周复盘.md': `---
id: note-01HX8Z9K7M2N4P6Q8R0S2T4V83
type: note
title: 周复盘 2026-10-29
status: growing
kind: summary
srcIds: []
tags: [复盘]
createdAt: "2026-10-29T20:00:00+08:00"
updatedAt: "2026-10-29T20:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# 周复盘

- 做完：建了测试空间、把对象模型落成了 TS
- 卡住：原件只读这条一开始只在界面层拦，绕过接口就能改
- 下周：把提交引擎的四项校验接进界面
`,

  'inbox/2026-10-29-待归类.md': `---
id: note-01HX8Z9K7M2N4P6Q8R0S2T4V84
type: note
title: 待归类：一段关于遗忘门的话
status: seedling
kind: question
srcIds: []
createdAt: "2026-10-29T21:00:00+08:00"
updatedAt: "2026-10-29T21:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

遗忘门从标量到向量到按通道，每一步多解决了什么问题？
`,

  'work/areas/知识体系.md': `---
id: area-01HX8Z9K7M2N4P6Q8R0S2T4VA1
type: area
title: 知识体系
standard: 每周清理一次收件箱
createdAt: "2026-10-29T10:00:00+08:00"
updatedAt: "2026-10-29T10:00:00+08:00"
author: human
sensitivity: private
rev: 1
---

# 知识体系
`,

  '.habitat/journal/2026-10.jsonl':
    `{"id":"ev-01HX8Z9K7M2N4P6Q8R0S2T4VE1","at":"2026-10-29T09:12:00+08:00","actor":"human","op":"capture","phase":"done","target":"inbox/2026-10-29-剪藏.md","summary":"采集：剪藏：一段话","spaceId":"space-01HX8Z9K7M2N4P6Q8R0S2T0000"}\n` +
    `{"id":"ev-01HX8Z9K7M2N4P6Q8R0S2T4VE2","at":"2026-10-29T09:40:00+08:00","actor":"human","op":"ingest","phase":"done","target":"knowledge/works/ai-infra/parts/01-线性注意力.md","summary":"入库：AI Infra 进阶","spaceId":"space-01HX8Z9K7M2N4P6Q8R0S2T0000"}\n` +
    `{"id":"ev-01HX8Z9K7M2N4P6Q8R0S2T4VE3","at":"2026-10-29T11:00:00+08:00","actor":"human","op":"annotate","phase":"done","target":"knowledge/works/ai-infra/parts/01-线性注意力.md","summary":"批注：线性注意力把 softmax 拆成特征映射的内积","spaceId":"space-01HX8Z9K7M2N4P6Q8R0S2T0000"}\n` +
    `{"id":"ev-01HX8Z9K7M2N4P6Q8R0S2T4VE4","at":"2026-10-29T11:05:00+08:00","actor":"agent:workbuddy","op":"annotate","phase":"done","target":"knowledge/works/ai-infra/parts/01-线性注意力.md","summary":"批注：固定容量状态","spaceId":"space-01HX8Z9K7M2N4P6Q8R0S2T0000"}\n` +
    `{"id":"ev-01HX8Z9K7M2N4P6Q8R0S2T4VE5","at":"2026-10-29T14:20:00+08:00","actor":"human","op":"derive","phase":"done","target":"knowledge/notes/状态就是记忆.md","summary":"衍生：状态就是记忆","spaceId":"space-01HX8Z9K7M2N4P6Q8R0S2T0000"}\n` +
    `{"id":"ev-01HX8Z9K7M2N4P6Q8R0S2T4VE6","at":"2026-10-29T19:30:00+08:00","actor":"agent:workbuddy","op":"build","phase":"done","target":"90-assets/2026/prototype.html","summary":"重建原型","payload":{"bytes":3027714},"spaceId":"space-01HX8Z9K7M2N4P6Q8R0S2T0000"}\n` +
    `{"id":"ev-01HX8Z9K7M2N4P6Q8R0S2T4VE7","at":"2026-10-29T22:10:00+08:00","actor":"external:unknown","op":"external_edit","phase":"detected","target":"knowledge/notes/状态就是记忆.md","summary":"检测到未署名改动","spaceId":"space-01HX8Z9K7M2N4P6Q8R0S2T0000"}\n` +
    `{"id":"ev-01HX8Z9K7M2N4P6Q8R0S2T4VE8","at":"2026-10-29T22:30:00+08:00","actor":"system","op":"reconcile","phase":"done","target":".habitat/state/snapshot.json","summary":"对账：12 个文件，未署名改动 1 处","spaceId":"space-01HX8Z9K7M2N4P6Q8R0S2T0000"}\n`,

  'assets/originals/durable-agent/index.html': `<h1>Durable Agent 原文</h1><p>入库原件，只读。</p>`,
};

/** 二进制样本单独放：MINI 里全是文本，塞不进 Buffer */
export const MINI_BINARY: Record<string, Buffer> = {
  // 挂在 ai-infra 作品下，会被 linkOriginals 匹配到「线性注意力」那一章
  'assets/originals/ai-infra/线性注意力-原文.pdf': Buffer.from(PDF_BASE64, 'base64'),
};

export async function makeSpace(files: Record<string, string> = MINI, bin: boolean = true): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'habitat-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }
  if (bin) {
    for (const [rel, buf] of Object.entries(MINI_BINARY)) {
      const abs = path.join(dir, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, buf);
    }
  }
  return dir;
}

export async function rmSpace(dir: string): Promise<void> {
  // Windows 上偶尔有句柄残留导致 ENOTEMPTY，退避重试几次
  for (let i = 0; i < 5; i += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 });
      return;
    } catch (e) {
      if (i === 4) throw e;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
}

export function readFile(p: string): string {
  return fs.readFileSync(p, 'utf8');
}
