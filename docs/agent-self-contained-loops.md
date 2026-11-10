# 平台自闭环：配好 harness 之后，为什么不再需要外部 Agent 平台

> 结论先说：Habitat 已经把「调度、工单、认领、回执、审批、写入、审计、通知」全部放在平台侧；
> harness 只提供模型判断和工具调用。配好一个 harness 后，平台的判断类闭环可以由平台自己跑，
> 不需要再让外部 Agent 平台维护一套自己的 cron、记忆和写入通道。
>
> 本文对应实现：`server/agent/service.ts`、`server/core/loops.ts`、`server/routes/agent.ts`、
> `server/index.ts` 的 `HABITAT_AGENT_LOOP_MS` 定时器。

## 1. 控制面与执行面

| 层 | 归谁 | 具体职责 |
|---|---|---|
| 控制面 | **Habitat 平台** | 何时该跑（`computeStatuses`）、跑什么（`runLoop` 工单）、谁在跑（claims/leases）、跑没跑（receipts）、能不能写（审批）、写到哪（ChangeService）、留下什么（journal）、出问题通知谁（Notifier/mail） |
| 执行面 | **Harness** | 理解工单、读/搜/引用、判断、生成批注/提案、调用 `kb_*` 工具 |
| 事实源 | **空间文件** | Markdown / JSONL 是唯一真相；SQLite 只是索引 |
| 人 | **用户** | 需要时审批 `ask` 的提案、确认发布、处理外发 |

关键点：harness **不持有**空间目录，也不直接写文件。它的 cwd 是空沙箱，所有读写回到 session MCP，
再进 `ChangeService`。所以换 harness 不会换掉平台的权限、审计和回滚能力。

## 2. 一条判断类闭环怎么在平台内跑完

以 `triage-inbox`（收件箱分流）为例：

```
平台定时器（HABITAT_AGENT_LOOP_MS）
  → computeStatuses：发现 triage-inbox 迟到/积压
  → AgentService.runLoopTask('triage-inbox')
      → runLoop：生成工单（积压条目、已认领条目、操作要求）
      → AgentSession + 配置好的 harness
          → kb_loops claim <item>        先占住，避免两个执行者重复
          → kb_search / kb_read          读条目与相似内容
          → kb_annotate_suggest         给批注建议（ask 模式等人接受）
          → kb_propose                  给归并/衍生提案（ask 模式等人确认）
          → kb_loop_report              写回执，释放认领
      → 平台兜底：agent 没 report 就代记一笔，避免「跑了但系统认为没跑」
  → UI：变更页/收件箱看到提案；闭环页看到回执；超时没有回执会告警
```

这条链路里，外部 Agent 平台不再需要：

- 自己的 cron/定时器：平台有 `HABITAT_AGENT_LOOP_MS`。
- 自己的「待办队列」：平台有 `computeStatuses` + backlog。
- 自己的去重/租约：平台有 claims/leases + 回执幂等。
- 自己的写通道：平台有 session MCP → `ChangeService`。
- 自己的审计：平台有 journal + `agent_commit` 事件。

## 3. 能力闭环矩阵

| 能力 | 平台侧入口 | harness 需要做什么 | 没有 harness 时 |
|---|---|---|---|
| 阅读/检索/问答 | `kb_session` / `kb_search` / `kb_read` | 理解与组织回答 | 本地 BM25 检索仍可用 |
| 引用/上下文 | 选区引用 chips + `packContext` | 基于引用回答 | 引用仍可手动选 |
| 批注 | `kb_annotate_suggest` + 接受/`auto` | 找关键句、写 note | 人手动批注 |
| 改正文 | `kb_propose` → `ChangeService` | 出 ops | 人手动编辑 |
| 采集/衍生 | `kb_capture` / `kb_propose(create)` | 判断值得留什么 | 人手动采集 |
| 收件箱分流 | `triage-inbox` 工单 | 判断留/归/并/弃 | 工单仍生成，人执行 |
| 提炼/连接 | `digest-source` / `connect-notes` | 压结论、找关系 | 工单仍生成，人执行 |
| 断链修复 | `repair-links` 工单 | 判断补/改/删 | 只给候选 |
| 翻新/复核 | `renew-due` / `review-interval` | 判定是否被推翻 | 证据包仍生成 |
| 对账/索引/清理/邮件 | `runLoop` 确定性分支 | 不需要 | 平台独立跑 |
| 发布/构建 | `release-promote` / BuildManager | 不需要模型 | 平台/人执行 |

结论：**模型只占「判断」这一格；调度、证据、权限、写入、审计都不在模型侧。**
所以外部 harness 平台即使自己有一套 loop，也是在重复平台已经有的控制面，且绕不开平台的写闸门。

## 4. 平台自己跑闭环的三种模式

1. **server 模式（不需要 harness）**
   `reconcile`、`metabolism`、`index-rebuild`、`reminders`、`rules`、`daily-brief` 等
   由服务端定时器/`runLoop` 直接跑，模型缺失时照常工作。
2. **platform-agent 模式（需要 harness）**
   `triage-inbox`、`digest-source`、`connect-notes`、`repair-links`、`renew-due` 等
   由 `runLoopTask` 出工单，harness 执行，平台收口。默认 `ask` 写正文；`auto` 只由用户显式开启。
3. **gate 模式（需要人）**
   提案提交、发布、外发。harness 可以准备到「提案/回执」，但最后一步必须过人。

降级不静默：
- 没配模型：工单仍然生成，状态是 `prepared`，人可以直接执行；
- harness 未登录/密钥失效：session 启动或首轮报明确错误，任务记 `fail` 回执；
- 没有定时器：`runLoopTask` 仍可手动/CLI/HTTP 调用，积压数在闭环页可见。

## 5. 什么时候仍需要「外部 Agent 平台」

只剩三种情况，而且都不是「闭环能力」本身：

1. **模型凭据不在本机**：比如必须走某个云端 Agent 的托管模型。此时它只是模型供应商，
   不是闭环所有者；平台仍然通过 ACP/HTTP 驱动它，写入仍回平台。
2. **网络到不了平台**：远端 harness 在 NAT 后面，需要反向隧道/远端 bridge。
   这是传输问题，不是能力问题；平台侧仍保留 session/审批/回执。
3. **需要平台没有的副作用**：比如发布到某个外部系统、调用企业内网 API。
   这类应做成平台工具或独立作业，不应该让外部 Agent 直接改空间。

## 6. 远端 harness 怎么接

远端机器不需要装 Habitat 的平台，只需要跑 bridge：

```bash
# 远端机器
node scripts/agent-bridge.mjs \
  --platform https://habitat.example.com \
  --code 123456 \
  --url http://<远端IP>:8799/acp \
  --command dsh
```

平台「Agent 接入」页点「配对远端」拿 6 位码；bridge 用码换 token 后自动出现在 harness 列表。
配对码 10 分钟有效、一次性；token 只在服务端配置里，不下发浏览器。

也可以不用配对码，直接在 `agents.yaml` 写：

```yaml
- id: studio
  label: 远端实验室
  driver: remote
  endpoint: http://<远端IP>:8799/acp
  token: ${REMOTE_AGENT_TOKEN}
```

要点：
- 平台必须能访问 `--url`；NAT 后面先做反向隧道。
- 平台把 session MCP 的 URL 传给远端 harness，远端必须能访问这个 URL；
  对外部署时设 `HABITAT_PUBLIC_URL=https://habitat.example.com`。
- `scripts/agent-bridge.mjs` 只做传输，不持有审批/写入；审批仍在平台。

## 7. 迁移与验证建议

1. 配好 `agents.yaml`（dsh / WorkBuddy / 远端 ACP），在「Agent 接入」页点「探测」。
2. 在闭环页选一条 `assist` 闭环，点「平台跑」；看三样东西：
   - 会话事件流：有没有 `tool` 调用 `kb_loops claim` / `kb_loop_report`；
   - 回执：`by` 是否为 `agent:<harness>`，`produced` 是否指向提案/变更集；
   - 变更页：`ask` 模式下是否停在待确认，而不是直接落盘。
3. 确认后打开 `HABITAT_AGENT_LOOP_MS=3600000`（每小时挑一条），观察一周：
   - `runDueLoops` 每次最多跑 `HABITAT_AGENT_LOOP_LIMIT` 条（默认 1）；
   - 失败/超时会写 `fail` 回执，闭环页会变红，不会静默；
   - 成本 = 模型调用，不是外部平台的订阅/调度费。
4. 外部 Agent 平台原来的 cron 可以停掉，只保留模型/工具能力；如果它还直接写空间，
   应改为调用平台的 session MCP 或 API，否则会绕开审批和审计。

## 8. 风险与边界

- **成本**：判断类闭环每次都会调模型；默认关闭自动驾驶，手动「平台跑」可控。
- **死循环**：`kb_loop_run` 拒绝递归执行 `platform-agent` 闭环；`runDueLoops` 每 tick 限 1 条。
- **权限**：`auto` 只允许批注/update/setBody/新建 note，单轮 5 次/8000 字；删除/归档/外发永不自动。
- **注入**：正文与工具结果都可能含指令；真正的防线是写闸门和审批，不是 prompt。
- **可观测**：会话 metrics（活跃/轮次/失败/平均耗时）在接入页；闭环回执在闭环页；两者都不依赖外部平台。
- **远端**：NAT 后的远端 harness 需要 bridge/反向隧道；平台不假设远端能直接连 localhost。

一句话：**平台是控制面和事实源，harness 是可替换的判断引擎。**
配好 harness 后，平台已经具备自己调度、自己出工单、自己收口、自己审计的完整闭环；
外部 Agent 平台不再需要维护第二套闭环。
