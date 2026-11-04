---
name: habitat-automation
description: 在 Habitat 知识空间里接手自动化闭环：查看谁该跑/跑没跑、认领条目、执行确定性任务、交账并自检。当用户说「整理一下知识库」「哪些东西卡住了」「帮我跑一下简报/翻新/对账」「定时任务怎么配」「闭环停了」时使用。也适用于外部 harness 想知道自己能否通过 cron 支持这些闭环。
---

# Habitat 自动化闭环

这个技能解决一件事：**让「自动发生的事」有账本**。
每条闭环都有触发、入口、产物、证据、幂等和降级；没有回执就等于没跑。

## 什么时候用

- 用户让你整理知识库、处理收件箱、做提炼/连接/质疑；
- 用户问「有什么该做的」「哪些停了」「定时任务怎么配」；
- 你是一个外部 harness，想知道自己能不能用 cron/MCP 承担这些闭环；
- 你刚跑完一条闭环，需要交账。

不适用：纯检索/阅读（用 `habitat search` / `habitat read`）；改正文（走 `habitat propose`）。

## 先看三眼

```bash
npx habitat status          # 连的是哪个空间
npx habitat loops status    # 19 条闭环：ok / late / down / never / blocked
npx habitat loops brief     # 交接单：现在该做什么、别做什么
```

`down` 必须先处理：修、停、或明确接受降级。
`never` 先确认是刚部署还是根本没接。
`blocked` 多半是没配邮件通道。

## 四种闭环，四种接法

| mode | 含义 | 你怎么做 |
|---|---|---|
| `auto` | 确定性 | `loops run <id>`，服务端跑完 |
| `assist` | 服务端备料，你判断 | `loops run <id>` 拿工单 → 认领 → 逐条处理 → `beat` |
| `gate` | 必须人确认 | 准备提案，等人点；不要替人点头 |
| `verify` | 只验证 | 跑检查、出报告 |

### 判断类（assist）的标准动作

```bash
npx habitat loops run triage-inbox              # 拿工单（不会改任何东西）
npx habitat loops claim triage-inbox <对象 id>  # 动手前先占住
# …读、判断、propose…
npx habitat loops beat triage-inbox --ok --produced note-xxx --note "处理了 1 条"
```

`beat` 会自动释放你名下该闭环的全部认领。没做完也要 release：

```bash
npx habitat loops release triage-inbox
```

## 交账规则

```bash
npx habitat loops beat <id> --ok --produced a,b --note "做了什么"
npx habitat loops beat <id> --fail --note "为什么失败"
```

- `produced` 写对象 id / 变更集 id / 事件 id；**空着等于「跑了但什么也没发生」**。
- 失败也要写，别静默退出。
- 同一窗口内重复跑会被去重；确实要重跑加 `--force`。
- 两个执行者同时到点时，租约只放一个进去；拿不到租约不是失败。

## 外部 harness：先声明能力，再配 cron

```bash
npx habitat loops bind --harness harness.yaml --cron
```

输出三档：`✓ 能完整承担`（附 crontab）、`~ 只能承担一半`（写明缺什么）、`✗ 接不上`。
`— 进程内` 的闭环不用接管（起服务就够了）。

最小 `harness.yaml`：

```yaml
name: your-agent
scheduler: cron          # none | cron | interval
alwaysOn: false
invoke: [cli, fs]        # cli | http | mcp | fs
model: true
humanApproval: true
mail: smtp               # none | smtp | imap | both
shell: true
timezone: Asia/Shanghai
```

cron 一律用 `loops run` 触发，不要直接调底层命令：

```cron
0 8 * * *  cd /path/to/habitat && npx habitat loops run daily-brief --mail --actor agent:your-name
0 9 * * *  cd /path/to/habitat && npx habitat loops run renew-due --actor agent:your-name
```

## 自检

```bash
npx habitat loops check
```

- `down / late`：中断或迟到；
- `never`：从未运行（新部署正常）；
- `unowned`：服务端不跑、也没声明谁跑；
- `double`：十分钟内两个执行者都留了成功回执（只留一个）；
- `mismatch`：声明了 owner，实际回执来自别人。

## 数据边界

| 文件 | 用途 |
|---|---|
| `.habitat/state/loop-runs.jsonl` | 回执，只追加 |
| `.habitat/state/automation.json` | 启停 / 归属 / harness 声明 |
| `.habitat/state/loop-claims.json` | 认领（TTL 过期自动失效） |
| `.habitat/state/loop-leases.json` | 执行租约（正常跑完会删） |

优先用 CLI/API 写，不要手改：手改会绕过去重和条件写。

## 三条红线

1. 判断类只提案，不 commit；改语义必须人确认。
2. 不删除，只归档（可撤销）。
3. 不假装完成：没有回执就是没跑，没有产物就是没做。

更多：`docs/automation-manual.md`（19 条逐条说明）、`docs/automation-loops.md`（设计与失配分析）。
