# AGENTS.md

给在本仓库里工作的 Agent 的项目上下文。**这个文件是给改代码的 Agent 看的**；
如果你的任务是操作某个知识空间（跑闭环、处理收件箱、交账），先读空间根目录的 `AGENTS.md`
（由 `habitat loops init` 生成），或直接看 [`docs/automation-manual.md`](docs/automation-manual.md)。

## 这是什么

Habitat 是一个以文件为事实源的个人知识库与工作台：Markdown + YAML frontmatter 是真相，
SQLite 只是可丢弃的索引，事件流负责审计与撤销。所有写入走
`propose → validate → commit`，每次提交带基准、反向操作和事件。

## 常用命令

```bash
npm install
npm run dev            # 前端 5178，后端 8787
npm run typecheck
npm run test:unit      # 快，先跑这个
npm run test:e2e       # 真浏览器，改了界面/流程再跑
npm run build
npx habitat status     # 需要在有 space.yaml 的目录，或设 HABITAT_SPACE
```

Node 22（`.node-version`）。`better-sqlite3` 是原生模块，换 Node 大版本后要 `npm rebuild`；
`npx habitat` 启动壳会先探测 ABI，失配时自动找兼容的 Node。

## 不可协商的约束

1. **文件是唯一事实源**。任何时候删掉 `.habitat/state/*.db`，重启都能从文件重建。
2. **写入必须走 ChangeService**。不要绕过 `propose/commit` 直接改内容文件；归档代替删除。
3. **判断类只能提案**。`mode=assist` 的闭环不允许自动 commit，测试会拦。
4. **跑完必须留回执**。新增任何定时器/自动化，都要写 `loop-runs.jsonl`；没有回执等于没跑。
5. **文档不手写**。`docs/automation-manual.md` 由 `shared/loops.ts` 生成，改目录再重新生成。

## Agent 会话层在这一带

```
shared/agent.ts          事件 / harness 配置 / 上下文 / 技能 / 审批契约
server/agent/config.ts   agents.yaml 与默认 dsh / WorkBuddy / mock
server/agent/acp.ts      ACP stdio（dsh）
server/agent/workbuddy.ts ACP HTTP/SSE 桥（WorkBuddy /api/v1/acp）
server/agent/remote.ts   远端 ACP 驱动（HTTP JSON + SSE）
scripts/agent-bridge.mjs 远端 bridge（在远端拉起 dsh，暴露 /acp）
server/agent/service.ts  会话状态机、上下文打包、审批闸门、session MCP、平台任务执行
server/agent/context.ts  选区定位与预算裁剪
server/agent/skills.ts   SKILL.md 加载与编译
server/routes/agent.ts   /api/agent/*
src/app/AiPanel.tsx      dock / float / 会话流
docs/agent-self-contained-loops.md  平台自闭环分析
```

**硬约束**：harness 不直接碰空间目录；写只走 session MCP → `ChangeService`。
新增 harness 先实现 `AgentDriver`，不要在 UI 里加分支。

## 对外分享在这一带

```
shared/types.ts          Share 对象（token / targetIds / state / expiresAt）
server/core/shares.ts    白名单展开、状态判定、访问流水与聚合
server/routes/share.ts   /s/:token 公开页 + /api/shares 管理接口
server/share-page.ts     公开页的服务端模板（独立 CSS，不继承管理端）
src/domains/share/       分享管理页
docs/sharing.md          边界、状态机、统计口径、部署注意
```

**硬约束**：公开页只从 `ShareService.scopeOf` 取对象，别在路由里直接 `store.all()`；
访问统计只追加 `share-views.jsonl`，不要为记一次阅读去跑 ChangeService。

## 自动化闭环在这一带

```
shared/loops.ts        20 条闭环目录（触发/入口/步骤/产物/证据/幂等/降级）
server/core/loops.ts   回执、健康、租约、认领、告警、执行、能力协商
server/index.ts        进程内定时器（每个都必须写回执）
server/cli.ts          habitat loops …（人 + 外部 harness 的主入口）
server/routes/api.ts   /api/loops*（平台 Agent 的主入口）
server/mcp.ts          kb_loops / kb_loop_run / kb_loop_report
src/domains/ai/LoopsPage.tsx  闭环健康页
```

### 新增一条闭环

1. 在 `shared/loops.ts` 的 `LOOPS` 里加定义。十二个字段缺一不可：
   `id / intent / trigger / maxSilenceMinutes / mode / autonomy / executors /
   requires / entry / steps / outputs / evidence / idempotency / degrade`。
2. 至少给一个非 UI 入口（CLI 或 HTTP）；`entry.cli` 必须是单条可执行命令。
3. `mode=assist` 必须写 `degrade.noModel`，`autonomy` 只能是 `read/derived/propose`。
4. 如果是服务端能跑的，在 `runLoop` 的 switch 里加执行分支，并在结束时写回执。
5. `npm run test:unit`（契约测试会检查入口/证据/幂等/降级）。
6. `npx habitat loops manual --out docs/automation-manual.md` 重新生成手册。

## 测试与验证

| 层 | 命令 | 说明 |
|---|---|---|
| 类型 | `npm run typecheck` | 包含 src/server/shared/tests |
| 单元 | `npx vitest run tests/unit/loops.test.ts` | 闭环契约、租约、认领、告警 |
| 单元（全量） | `npm run test:unit` | 191 条 |
| E2E | `npx playwright test` | 90 条，约 2.5 分钟；测试空间 `.e2e-space` 每次重建 |

E2E 走 `HABITAT_AUTH=off`，不读真实账号文件，也不会碰真实空间。

## 容易踩的坑

- **别用 `git stash`**（本机已知会毁 objects/refs，见用户级记忆）。
- `ExportReport` 的字段是 `files`，不是 `items`。
- `entry.cli` 不要写成 `a · b` 或 `a → b`：测试要求单条命令，否则生成的 cron 不可执行。
- 进程内轮询（如 `watch-external`）要标 `serverOnly`，否则外部 harness 会重复接管。
- 健康判定里 `never` 不等于 `down`：新部署必然全是 never，只有 `down` 才判不通过。
- `loadAutomation` 必须每次返回新的 `loops` 对象，否则改一条配置会污染全局默认值。
- 分享的可选字段要清空时写 `null` 而不是 `undefined`：变更集是 JSONL，`undefined` 活不过序列化。
- 公开页要在 `server/auth.ts` 的闸门白名单里：只放 `/s/`，不要顺手放 `/api/`。

## 参考

- [`docs/automation-loops.md`](docs/automation-loops.md) — 失配分析、Loop Contract、调研与路线
- [`docs/automation-manual.md`](docs/automation-manual.md) — 20 条闭环的逐条手册（生成）
- [`docs/architecture.md`](docs/architecture.md) — 数据模型、写入路径、索引
- [`skills/habitat-automation/SKILL.md`](skills/habitat-automation/SKILL.md) — 可移植技能：怎么接闭环
