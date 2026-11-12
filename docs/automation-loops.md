# 自动化与 AI 闭环：从「写过的机制」到「可验证的收敛」

> 本文是诊断 + 策略，配套两份可执行产物：
> - [`automation-manual.md`](automation-manual.md)：20 条闭环的参考手册（由目录生成，不要手改）
> - `shared/loops.ts`：闭环目录（唯一事实源）
>
> 结论先行：**空壳不是因为没实现，是因为没有账本。** 没人能回答「谁该跑、跑没跑、跑出了什么」，
> 于是每加一个机制，就多一份「文档里写了、实际没人执行」的债。

---

## 1. 五个结论（先看证据）

### 1.1 机制不少，账本为零

服务进程里有 6 个定时器（`server/index.ts:210` 规则、`:228` 提醒、`:252` 代谢、`:272` 简报、`:296` 外部改动轮询、`:298` 闭环告警），
加上 CLI、HTTP、MCP、UI 四个入口，能自动发生的事其实很多。

但在本次改动之前，**没有任何地方记录「上一次跑是什么时候、结果如何、产出了什么」**。
`grep -r "lastRun\|nextDue\|receipt" server/` 零命中。健康页有链接解析率、索引文档数，
却没有「闭环是否还活着」。

后果很直接：**定时器停了，界面一切正常。** 这是最坏的一种故障——安静。

### 1.2 入口不对称，同一件事有四张皮

| 面 | 数量（改动前） | 说明 |
|---|---|---|
| `buildManifest` 能力清单 | **9 条** | 手写在 `server/routes/api.ts:1295` |
| CLI 子命令 | **30+** | `server/cli.ts` 的主 switch |
| HTTP 路由 | **70+** | `server/routes/api.ts` 单文件 |
| MCP 工具 | **6 个** | `server/mcp.ts`，只有 status/search/read/capture/propose/reconcile |
| UI 页面 | 20+ | 部分能力只有 UI 有 |

四张清单没有一张是另一张的子集。举两个具体缺口：

- `rules`（规则通知）只有进程定时器和 `POST /api/rules/run`，**没有 CLI**；
- `jobs`（多步作业）只有 HTTP 和 UI，**CLI 与 MCP 都没有**。

一个只会跑命令的 harness，和一个只会说 MCP 的客户端，看到的是两个不同的系统。

### 1.3 去重策略各写各的，一共五套

| 机制 | 怎么防重复 | 位置 |
|---|---|---|
| 每日简报 | `brief.json` 记 `day` | `server/core/tidy.ts:246` |
| 提醒 | `reminders.json` 记 eventId + 逾期日期 | `server/core/reminders.ts:14` |
| 规则通知 | 反查 notifications.jsonl 的 `ruleId + 日期` | `server/core/notify.ts:49` |
| 作业 | `idempotencyKey` 查 jobs.jsonl | `server/routes/api.ts:796` |
| 复核 | 没有去重，靠间隔阶梯天然稀疏 | `server/core/renew.ts` |

五套都对的概率不高，而且**新增一条闭环时，没有人提醒你「你还没写去重」**。
更麻烦的是跨执行器：平台定时器和外部 cron 同时存在时，这五套去重都只管自己那一半。

### 1.4 「AI 钩子」停在文案

`docs/lifecycle.md:170` 自己写了：

> **AI 钩子是文案不是能力**：写的是「AI 能做什么」，真正执行要 harness 读 `next` 后自己动手。

这句话是诚实的，但它同时暴露了闭环的断点：
`next` 给出清单（`server/core/lifecycle.ts:251`，还只取前 20 条），
但**没有 claim、没有 done、没有产物回写**。agent 做完之后，系统不知道哪条被处理了、
处理成了什么、下次还要不要再提。

于是「AI 能接手」变成了「AI 可能接手，也可能不接，接没接没人知道」。

### 1.5 文档承诺 > 实现

`README.md:109` 写「服务内置代谢（归档已完成、发简报、到点提醒）」。
但改动前的 `server/index.ts` 只挂了规则、提醒、简报、轮询四个定时器，**没有 `runTidy`**。
代谢只能靠 CLI / API / UI 手动触发。

这不是谁的疏忽，而是**手写文档和代码之间没有一道闸**。文档说「有」，代码说「没有」，
两边都很有道理，直到某天有人真的依赖它。

---

## 2. 现状：三条执行面，四类闭环

### 2.1 三条执行面

```
┌─────────────────────────────────────────────────────────────┐
│ 定义面（随代码版本走）                                        │
│   shared/loops.ts · buildManifest · CLI usage · MCP TOOLS    │
└──────────────────────────┬──────────────────────────────────┘
                           │ 部署时对齐（目前靠人）
┌──────────────────────────▼──────────────────────────────────┐
│ 执行面（三套，互不知情）                                      │
│   进程定时器（server/index.ts）                               │
│   CLI（server/cli.ts，一次性进程）                            │
│   HTTP / MCP（server/routes/api.ts · server/mcp.ts）          │
└──────────────────────────┬──────────────────────────────────┘
                           │ 各自写自己的状态文件
┌──────────────────────────▼──────────────────────────────────┐
│ 状态面（.habitat/state/ 下 10 个文件，格式各异）                │
│   brief.json · reminders.json · rules.json · review.json     │
│   notifications.jsonl · jobs.jsonl · proposals.jsonl …       │
└─────────────────────────────────────────────────────────────┘
```

三层之间没有契约：定义面改了，执行面不一定跟；执行面跑了，状态面不一定记；
状态面记了，也没有统一的读取方式。

### 2.2 四类闭环（按「谁负责判断」分）

| 类 | 例子 | 现状 | 断点 |
|---|---|---|---|
| **维持** | 轮询、对账、代谢、简报、提醒、规则 | 基本可用 | 没有回执，停了不知道 |
| **消化** | 收件箱分流、提炼、连接、断链修复 | 只有入口和清单 | 没有 claim / done / 产物 |
| **判断** | 翻新、复核、质疑、提案确认 | 机制齐全 | 入口不全，策略只在 UI |
| **交付** | 收信、导出、发布 | 可用 | 没有节奏约束，靠人记 |

---

## 3. 八个失配（M1–M8）

### M1 清单漂移

四份清单各自维护，没有生成关系，也没有测试断言「文档里的每条能力都有入口」。
**后果**：agent 读到的是残缺地图，走到边界才发现没有路。

### M2 双调度，无租约

平台进程有定时器，外部 harness 也可以配 cron。两边都能跑同一个闭环，
但**没有 owner、没有 lease、没有「这次归谁」的记录**。
**后果**：要么重复跑（简报发两封、归档提两批），要么都以为对方会跑（谁也没跑）。

### M3 去重策略分裂

见 1.3。**后果**：新增闭环时最容易被忘掉的一步就是去重；
而重复执行的副作用（重复邮件、重复提案）往往比不执行更烦人。

### M4 没有回执

没有 `lastRunAt / result / counts / produced`。
**后果**：
- `down` 和 `从未运行` 看起来一样；
- 「跑完了」只能靠日志，日志还会滚掉；
- 无法回答「上周 AI 到底处理了什么」。

### M5 判断闭环断在最后一米

`next` 给清单，`propose` 给提案，但两者之间没有「认领」。
`agentReady` 还只取前 20 条（`lifecycle.ts:251`），第 21 条永远不出现。
**后果**：AI 每次从零开始读库，做完的成果没有结构化回写，下次重复劳动。

### M6 承诺漂移

README / lifecycle / architecture 三份文档各自描述「系统会做什么」，
但没有一份是从代码生成的。**后果**：文档越详细，错得越具体。

### M7 策略只在 UI 文案里

UI 的「权限四档」（派生自动 / 授权内新增 / 改语义逐条确认 / 外部副作用禁止）
写在 `src/domains/ai/pages.tsx` 的数组里，是给人看的文案。
后端没有对应的策略对象，CLI 的 `propose --commit`（`server/cli.ts:549`）可以直接落盘。
**后果**：同一个 agent，走 UI 要确认，走 CLI 不用。策略取决于路径，而不是身份。

### M8 入口不对称

`rules` 无 CLI、`jobs` 无 CLI/MCP、`repair-links` 改动前只有 HTTP/UI。
**后果**：外部 harness 的接入成本取决于它碰巧支持哪种协议，而不是它该做什么。

---

## 4. 为什么会变成空壳（机制层）

### 4.1 定时器是 edge-triggered

现在的定时器是「到点做一次」：`setInterval(..., 5min)` 里跑一遍规则。
漏掉一轮（进程重启、机器休眠、异常提前 return），这一轮就永久消失。

Kubernetes 的控制器刻意反过来：**level-triggered**——不关心「错过了什么事件」，
只关心「当前状态和期望状态差多少」。漏掉的下一轮会自己补上。

> 对应到本项目：`watch-external` 已经是 level-triggered（按指纹重算），
> 但 `rules` / `reminders` / `brief` 还是「到点执行」。这不是必须马上改，
> 但**回执 + 上限**能把「漏了」变成可见，而不是靠重写调度器。

### 4.2 责任真空

「平台 Agent（如果启用了）」「外部 harness（如果配了 cron）」「人（如果想起来了）」
三者之间没有明确的 owner 字段。**没有 owner 的事，等于所有人的事，最后是没人做的事。**

### 4.3 闭环的定义停在「能跑」

一个函数能跑，和一个闭环成立，是两件事。闭环至少还要回答：
- 跑完的产物是什么？
- 怎么证明它跑过？
- 重复跑会怎样？
- 缺一个依赖时降级成什么？
- 失败了谁接手？

现在的代码只回答了第一个，而且只回答了一半（返回 void 或一句 console.log）。

### 4.4 文档手写，代码在改

任何「文档描述代码」的结构都会漂移，除非文档是生成的，或者有测试锁住。
`buildManifest` 是手写的，所以它必然落后于 CLI；手册如果手写，也会落后于目录。

### 4.5 「AI 可选」被当成「可以没有」

设计上「不配 Agent 系统也能转」是对的。但落到实现，容易变成
「AI 那部分没人跑就算了」——因为没有地方记录「这部分本该有人跑」。

**可选的是执行者，不是闭环。** 闭环必须一直在，只是可以由不同的人/程序来推。

---

## 5. 业界怎么做（调研与映射）

### 5.1 Kubernetes 控制器：level-triggered reconciliation

- 观察当前状态 → 与期望状态求差 → 幂等修正 → 把结果写进 `status.conditions`。
- 关键取舍：**watch 只是低延迟优化，周期性全量 resync 才是正确性保证**。
- 状态必须持久化，不能靠内存里的「这个我处理过了」。

**映射**：`watch-external` 已经是这个模型；`loops status` 相当于 `status.conditions`；
`maxSilence` 相当于「多久没 reconcile 就判 NotReady」。

### 5.2 Temporal：Workflow 持有计划，Activity 做副作用

- Workflow 持久化「走到哪一步、已经知道了什么」；Activity 负责会失败的外部调用。
- 重放时跳过已完成的 Activity，避免重复付费；人工确认是一等状态（Signal）。
- 判断标准很简单：**「如果进程在这里死掉，会丢失什么？」** 答案是「全部重来」时，才需要持久化执行。

**映射**：现有 `jobs.jsonl` 已经是轻量版（checkpoint / waiting-approval / 退避 / 上限三次）。
不需要引入 Temporal，但应该把「作业」和「闭环」的关系写清：
**作业是一次具体执行，闭环是反复发生的收敛。**

### 5.3 Healthchecks.io：dead man's switch

- 监控的不是「失败」，而是「成功没有发生」。
- 每个 job 有 period + grace；支持 start / success / fail 三种信号。
- 关键洞察：**如果监控依赖出故障的东西自己上报，那你没有监控，只有一个安慰故事。**

**映射**：这就是 `loop-runs.jsonl` + `maxSilence` 的设计来源。
外部 cron 被删掉、机器休眠、进程崩溃——这些都不会主动报错，只有「该来的回执没来」能发现。

### 5.4 能力声明的四个层次

| 层次 | 格式 | 回答什么 | 本项目对应 |
|---|---|---|---|
| 项目上下文 | `AGENTS.md` | 这个仓库怎么工作 | 待补（`habitat loops brief` 可生成） |
| 可移植能力 | `SKILL.md` | 这类任务怎么做 | CLI 命令 + 本手册 |
| 服务能力 | A2A Agent Card | 这个 agent 能接什么 | `loops bind --harness` |
| 函数能力 | MCP `tools/list` | 现在能调哪些函数 | `server/mcp.ts` |

**关键**：A2A 的 Agent Card 是**服务级能力声明**（我擅长什么），
MCP 的 tools 是**函数级**（你现在能调什么）。本项目缺的是中间那层：
**「我能承担哪些闭环、缺什么」**。`HarnessProfile` + `fitLoop` 补的就是这一层。

### 5.5 平台工程：catalog + scorecard + golden path

- Catalog（Backstage）：每个资产有 owner、lifecycle、依赖，可查询。
- Scorecard：按标准打分，让「不合规」可见，而不是靠人记得。
- 反模式：「ticket-ops disguised as platform」——看起来有门户，实际只是把工单换了个界面。

**映射**：`shared/loops.ts` 是 catalog；`loops status/check` 是 scorecard；
`loops run` 是 golden path（一条命令走完，不用记步骤）。
**要避免的反模式**：只做 catalog 不做执行，就变成了「更漂亮的文档」。

### 5.6 Harness engineering：验证是「完成」的一部分

调研里反复出现的几条，几乎可以直接抄：

- **给 agent 一个自检方式，并把通过它作为 done 的一部分**；
- **把状态外置到文件，不要只留在上下文里**（长任务要能跨 session）；
- 定时 agent 的七个问题：时区、session 类型、交付、超时、失败模式、频率、去重；
- **无回执 = 没跑**；**空输出也要告警**（否则「成功但什么都没做」会被当成正常）。

**映射**：`produced[]` 就是「产物证据」；`beat` 是「完成」的仪式；
`check` 会把「跑了但没产物」暴露出来（produced 为空时人一眼能看到）。

### 5.7 一张映射表

| 业界实践 | 本项目对应物 | 本次是否落地 |
|---|---|---|
| desired/observed + status | `LoopState` + `loop-runs.jsonl` | ✅ |
| level-triggered | 回执 + 上限（不重写调度器） | ✅ 部分 |
| dead man's switch | `maxSilenceMinutes` + `check` | ✅ |
| 能力声明（服务级） | `HarnessProfile` + `fitLoop` | ✅ |
| catalog + scorecard | `shared/loops.ts` + `loops status/check` | ✅ |
| golden path | `loops run <id>` | ✅ |
| durable execution | `jobs.jsonl`（已有） | 沿用 |
| 验证即完成 | `produced[]` + `beat` | ✅ |
| 文档即代码 | `loops manual` 生成手册 | ✅ |

---

## 6. 目标模型：Loop Contract

### 6.1 三层

```
定义层  shared/loops.ts                 随代码走，测试锁住完整性
   │
运行层  .habitat/state/automation.json  启停 / 归属 / harness 声明
        .habitat/state/loop-runs.jsonl  回执（只追加）
   │
协商层  HarnessProfile + fitLoop        能接哪些、缺什么、cron 怎么配
```

三层各自可独立替换：
- 换 harness 不用改代码；
- 改节奏不用重启（配置在空间里）；
- 加闭环必须改代码 + 过测试（这是故意的不方便）。

### 6.2 一条闭环必须写清的 12 件事

| 字段 | 回答的问题 | 缺了会怎样 |
|---|---|---|
| `id` | 稳定标识 | 回执对不上 |
| `intent` | 收敛到什么状态 | 变成「跑个脚本」 |
| `trigger` | 什么时候该跑 | 没人知道节奏 |
| `maxSilenceMinutes` | 多久没跑算异常 | 停了不知道 |
| `mode` | 自动 / 备料 / 确认 / 验证 | 把判断类当自动类 |
| `autonomy` | 最大能写到哪 | 越权 |
| `executors` | 谁能跑 | 责任真空 |
| `requires` | 需要什么能力 | harness 接不上还不知道 |
| `entry` | 从哪进 | 只有 UI |
| `steps` / `outputs` | 做了什么、产出什么 | 只扫描不落盘 |
| `evidence` | 怎么证明 | 跑没跑靠猜 |
| `idempotency` / `degrade` | 重复跑怎样、缺依赖怎样 | 重复副作用 / 静默失败 |

### 6.3 四种 mode

| mode | 含义 | 服务端能做的 | 不能做的 |
|---|---|---|---|
| `auto` | 确定性，自己跑完 | 读、派生、归档、发信 | 语义判断 |
| `assist` | 服务端备料，模型判断 | 召回、打包证据、出工单 | 下结论、commit |
| `gate` | 必须人确认 | 校验、排队、记录 | 替人点头 |
| `verify` | 只验证不生产 | 健康检查、导出校验 | 改内容 |

**红线**：`assist` 的 `autonomy` 只能是 `read / derived / propose`，测试会拦。
这不是保守，是因为「自动改语义」一旦出错，代价不是重跑一次，而是信任没了。

### 6.4 状态机

```
                 ┌──────────── paused（显式停用）
                 │
never ──► ok ──► late ──► down
  │        ▲                │
  │        └── beat(ok) ────┘
  └── blocked（缺依赖：邮件 / 环境变量关闭）
        manual（按需 / 事件型，不做存活判定）
```

判定规则（`evaluateLoop`）：

| 条件 | 状态 |
|---|---|
| 配置停用 | `paused` |
| `maxSilenceMinutes = 0` | `manual` |
| 缺依赖 | `blocked`（优先于 never） |
| 无回执 | `never` |
| 上次 `fail` | `down`（哪怕刚跑过） |
| 静默 > 2× 上限 | `down` |
| 静默 > 上限 | `late` |
| 其余 | `ok`（`skipped` 也算 ok，但原因要写进状态） |

「2 倍」是故意留的余量：一次漏跑不应该半夜报警，两次就是真的有问题。

### 6.5 幂等：两层

1. **执行前去重**：同一个闭环在窗口内只跑一次。
   窗口 = interval 的一半（最少 30 秒）/ daily 60 分钟 / 事件型不去重。
2. **执行内幂等**：每条闭环自己写清「重复跑会怎样」。
   例如简报按天去重、归档已归档的不再进候选、收信按 Message-ID 去重。

第一层防撞车，第二层防副作用。**只有第一层不够**——跨进程时窗口可能错开。

### 6.6 降级阶梯

每条闭环必须回答四个「如果没有」：

| 缺什么 | 应该变成什么 | 不允许变成什么 |
|---|---|---|
| 没有模型 | 出候选 / 工单，标 `prepared` | 假装判断过了 |
| 没有调度器 | 按需可跑，状态 `never/late` | 静默不跑 |
| 没有邮件 | 记 `skipped` + 原因，站内仍可见 | 假装发过 |
| 没有 Shell / 生产目录 | 出命令清单，人执行 | 假装发布成功 |

### 6.7 判断类为什么只出工单

`loops run triage-inbox` 不会改任何东西，它输出：

```
# 工单：收件箱分流（triage-inbox）
目标：…
积压 12 条，先看前 12 条：
- …  note-xxx
做完：逐条给出「留 / 归 / 并 / 弃」，走 propose；处理完用 loops beat 记产物。
```

这是刻意的：**服务端不应该有能力「替模型思考」**。
它能做的是把「该看什么、看完怎么交账」准备好。模型或人来做那一步，然后用 `beat` 交账。

---

## 7. 三个消费方怎么用

### 7.1 平台 Agent（有 UI、有配置）

```bash
GET  /api/loops                 # 全部闭环 + 状态 + 积压
GET  /api/loops/check           # 自检：down / never / 无归属 / 重复
POST /api/loops/:id/run         # 跑（或拿工单）
POST /api/loops/:id/beat        # 跑完交账
POST /api/loops/:id/config      # 启停 / 改归属
POST /api/loops/:id/claim       # 认领工单里的一条
POST /api/loops/:id/release     # 归还
GET  /api/loops/leases          # 谁在执行
POST /api/loops/alerts          # 把 down 推一次通知
GET  /api/loops/manual          # 20 条闭环手册（Markdown）
GET  /api/loops/guide           # 空间级 AGENTS.md（给 harness 的操作手册）
```

`GET /api/agent/manifest` 的返回里新增了 `automation` 与 `loops` 两个字段，
平台 Agent 不需要额外发现机制。

**典型用法**：用户说「帮我整理一下」，Agent 先读 `/api/loops`，
按 `backlog` 排序，挑 `triage-inbox`，调 `run` 拿工单，做完逐条 `propose`，
最后 `beat` 并把 `produced` 写成 note id。

### 7.2 外部 harness（无 UI、可能有 cron）

```bash
# 1. 先看有哪些闭环
npx habitat loops list --json

# 2. 声明自己的能力，算能接哪些
cat > harness.yaml <<'YAML'
name: claude-code
scheduler: cron          # none | cron | interval
alwaysOn: false
invoke: [cli, fs]        # cli | http | mcp | fs
model: true
humanApproval: true
mail: smtp
shell: true
timezone: Asia/Shanghai
YAML
npx habitat loops bind --harness harness.yaml --cron

# 3. 按输出的 crontab 配；判断类先认领，每跑完一条必须交账
npx habitat loops run triage-inbox --actor agent:claude-code
npx habitat loops claim triage-inbox note-xxx --actor agent:claude-code
npx habitat loops beat triage-inbox --ok --produced note-xxx --actor agent:claude-code
npx habitat loops beat daily-brief --ok --produced "" --note "已生成简报" --actor agent:claude-code

# 4. 自检：谁静默了、谁没归属、谁被重复执行
npx habitat loops check --json
```

`bind` 的输出分三档：

- `✓ full`：能完整承担，附 cron 行和建议命令；
- `~ partial`：能跑但闭环会在某处断（写明缺什么）；
- `✗ none`：不该接（例如只有 CLI 却要接只暴露 HTTP 的 `job-advance`）。

**关键**：`bind` 不执行、不注册、不写系统 crontab，只做能力对账。
真正的调度权在用户/harness 手里，这样平台不会被外部 harness 的配置绑架。

### 7.3 人（只看三件事）

```bash
npx habitat loops status     # 哪条 down、哪条阻塞、积压多少
npx habitat loops check      # 十分钟内有没有两个执行者撞车
npx habitat loops brief      # 一份「现在该做什么」的交接单
```

人不需要记 20 条闭环。只需要在 `down` 出现时决定：修、停、还是明确接受降级。

---

## 8. 本次落地了什么（P0）

| 文件 | 作用 |
|---|---|
| `shared/loops.ts` | 20 条闭环的目录 + 健康判定 + 能力协商 + 手册生成（纯函数） |
| `server/core/loops.ts` | 配置、回执、状态、执行、自检、交接单 |
| `server/cli.ts` | `loops list/status/show/run/beat/bind/check/brief/manual` + `rules run` + `links` |
| `server/routes/api.ts` | `/api/loops*` 全套 + manifest 增加 `automation/loops` |
| `server/mcp.ts` | 新增 `kb_loops` / `kb_loop_run` / `kb_loop_report` |
| `server/index.ts` | 四个定时器写回执；新增代谢定时器（补上 README 的承诺） |
| `tests/unit/loops.test.ts` | 42 条契约测试：入口、证据、幂等、降级、红线、租约、认领、告警 |
| `docs/automation-manual.md` | 由目录生成的手册 |

### 验收命令

```bash
npm run typecheck
npm run test:unit                 # 129 条（新增 42 条）

npx habitat loops status
npx habitat loops check
npx habitat loops show daily-brief
npx habitat loops manual --out /tmp/manual.md
```

---

## 9. 路线（P1 / P2）与不做的事

### P1（已落地，见 §12）

1. ✅ **UI 闭环健康页**：`#/loops`，复用 `/api/loops`，按状态筛选，可跑/停/自检/看详情。
2. ✅ **jobs / proposals 纳入目录**：作业完成/永久失败、提案应用后写回执，进统一时间线。
3. ✅ **跨进程租约**：`loop-leases.json` + 条件写重试；默认 10 分钟，过期可接管。
4. ✅ **告警通道**：down 推 `Notifier`，同一条每天一次；`HABITAT_LOOP_ALERT_MAIL=1` 同时发信。
5. ✅ **claim（认领）**：工单条目先到先得，TTL 120 分钟；`beat` 自动释放。

### P2（有真实数据再说）

1. 回执保留策略（现在只追加，长期会大）；
2. 每条闭环的 SLO（成功率 / 平均耗时 / 产物转化率）；
3. 多空间：一个进程管多个空间时，闭环归属怎么算；
4. 告警升级（单条闭环连续 3 天 down → 升级到邮件/其它通道）。

### 明确不做

| 不做 | 为什么 |
|---|---|
| 引入 Temporal / Redis / 消息队列 | 当前规模用 JSONL + 去重窗口足够；引入后运维成本 > 收益 |
| 服务端做语义判断 | 判断是模型/人的事；服务端做判断就无法解释、无法追责 |
| 让 assist 类自动 commit | 一次错误的自动改写，代价远大于省下的几次点击 |
| 把 crontab 写进系统 | 平台不该接管宿主的调度器；只做能力对账 |
| 把手册做成唯一文档 | 手册是产物；定义在代码里，改代码才算改 |

---

## 10. 反模式清单（防止再次空壳）

1. **加机制不加回执**：新写一个定时器，不写 `loop-runs.jsonl`，等于没加。
2. **加文档不加测试**：手册里出现一条目录里没有的闭环，下次生成就消失。
3. **用 `never` 当 `down`**：新部署必然全是 never，一律报警会让人三天内学会忽略。
4. **判断类给 `commit`**：测试会拦，但评审时也要拦。
5. **一个闭环两个 owner 没有租约**：宁可先只留一个 owner，另一个 `--dry-run`。
6. **只做扫描不做落盘**：回执里 `produced` 为空，就是「跑了但什么也没发生」。
7. **把「可选」当成「可以没有」**：执行者可以换，闭环不能缺。
8. **为了好看把 maxSilence 调大**：那只是把故障推迟到更晚被发现。

---

## 11. 验收清单（可以贴进 PR）

- [ ] 每条闭环有非 UI 入口（`tests/unit/loops.test.ts` 已断言）
- [ ] 每条闭环写了 `evidence`、`idempotency`、`degrade`
- [ ] `assist` 类没有 `commit`，且写了 `degrade.noModel`
- [ ] `auto` 类不依赖 `model`
- [ ] 定时器写完回执（`record(...)`）
- [ ] `loops check` 在目标部署形态下通过（无 `down`、无重复执行）
- [ ] `loops manual --out docs/automation-manual.md` 已重新生成，且与代码同一 commit
- [ ] README / lifecycle / architecture 里新增的承诺，都能在目录里找到对应闭环


## 12. P1 落地记录（2026-11）

P1 的五项都做完了，但都刻意停在「够用」：没有引入 Redis、没有引入工作流引擎，
仍然只有 JSON 文件和条件写。

| 能力 | 实现 | 关键取舍 |
|---|---|---|
| 租约 | `.habitat/state/loop-leases.json`，`ifHash` 条件写 + 4 次重试 | 过期即接管，不做心跳续租；进程崩了最多锁 10 分钟 |
| 认领 | `.habitat/state/loop-claims.json`，key = `loop:target` | TTL 120 分钟；`beat` 自动释放，不要求显式 release |
| 告警 | `runLoopAlerts` + Notifier `ruleId=loop:<id>` | 只报 `down`，不报 `late/never`；每条每天一次 |
| 作业回执 | 作业 `done` / 永久失败时写 `job-advance` | 中间状态不写，避免把「推进了一步」当成闭环闭合 |
| 提案回执 | `apply` 成功后写 `proposal-approve` | 失败/冲突不写，避免污染成功率 |
| UI | `#/loops`，30 秒轮询 | 只读 `/api/loops`，不引入新的状态源 |

**为什么租约不做心跳续租**：单机 + 个人库，最长的闭环是导出（秒级）。
10 分钟租约已经比任何一次执行长两个数量级；加心跳只会多一个需要维护的状态。
真正需要长任务时，应该走 `jobs`（自带 checkpoint/退避），而不是把闭环执行拉长。

**为什么认领不绑定到回执**：一个 agent 可能处理 10 条里的 3 条就退出。
如果认领只在 `beat` 时释放，剩下 7 条会锁 120 分钟；所以 `run` 的工单会显示
「已被他人认领 N 条」，并且 TTL 到期自动可接。

**还没有做的**：
- 租约的「续租」与「主动抢占」（目前只能等过期）；
- 告警分级（`late` 是否该提醒，取决于这条闭环的重要程度，现在一律不提醒）；
- 多空间下的租约命名空间（当前 key 只有 loop id，跨空间会撞，但一个进程只开一个空间）。
