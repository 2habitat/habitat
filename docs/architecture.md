# 架构

## 一句话

**文件是事实源，事件流是审计，SQLite 是索引。** 三者职责不重叠，任何一层都可以单独重建。

```
       写入                          读取
        │                             │
   ┌────▼─────┐                ┌─────▼─────┐
   │ChangeSvc │                │  Fastify  │
   │ propose  │                │    API    │
   │ validate │                └─────┬─────┘
   │ commit   │                      │
   └────┬─────┘                ┌─────▼─────┐
        │                      │  SQLite   │ ← 只读索引，可丢弃
   ┌────▼─────┐   ┌────────┐   └───────────┘
   │  .md/.yaml│──▶│ journal │
   │  事实源   │   │  事件流 │──▶ 审计 / 撤销 / 简报
   └──────────┘   └────────┘
```

## 目录

```
server/core/          核心，按职责分文件
  storage.ts          文件适配器（读写 / 哈希 / mtime）
  store.ts            扫描目录 → 对象图；id 分配与自愈；链接解析
  journal.ts          事件流（JSONL，按月分片）
  commit.ts           ChangeService：propose / validate / commit / revert
  index.ts            SQLite 全文索引（中文 2-gram）
  space.ts            空间门面：把上面几件拼起来，对外提供业务方法
  lifecycle.ts        生命周期快照（状态 / 活性 / 翻新队列）
  renew.ts            翻新：候选召回 + 间隔复习
  usage.ts            使用计数（轻量，不写 journal）
  tidy.ts             管家：代谢 + 每日简报
  reminders.ts        日程提醒
  mailer.ts           SMTP
  inbox-mail.ts       IMAP 收信 → 收件箱
  assets.ts           附件入库
  reconcile.ts        对账：外部改动 → external_edit
  export.ts / sync.ts 导出与增量同步

server/routes/api.ts  HTTP 接口（按域分段，单文件）
server/mcp.ts         MCP（stdio JSON-RPC，6 个工具）
shared/               前后端共用：类型 / frontmatter / 生命周期模型 / 检索取词
src/                  React 界面，按业务域拆
```

## 数据模型

### 对象

所有内容都是同一种形状（`BaseObject` + 各自字段）：

| 字段 | 说明 |
|---|---|
| `id` | 稳定标识，一旦分配永不变（改名、改标题都不变） |
| `type` | `note` / `work` / `part` / `rep` / `action` / `event` / `project` / `area` / `collection` / `annotation` / `source` |
| `rev` | 修订号，每次提交 +1，用于乐观并发 |
| `author` | 谁改的（`human` / `agent:xxx` / `system`） |
| `archivedAt` | 归档时间；不删文件，只做标记 |

`id` 与文件路径是**两个独立维度**：路径是给人看的（文件名是地址），id 是给系统用的。
文件名可以改（改 frontmatter 的 `title` 另说），id 不变。

### 存储形态

| 类型 | 落在哪 | 形态 |
|---|---|---|
| 笔记 / 报告 | `knowledge/notes/*.md` | YAML frontmatter + 正文 |
| 作品 / 章节 | `knowledge/works/<slug>/` | `work.yaml` + `parts/*.md` |
| 任务 / 日程 | `work/actions/tasks.md`、`work/events/YYYY-MM.md` | **行内记录**（`- [ ] … ^id`） |
| 项目 / 领域 | `work/projects/*.md` | frontmatter |
| 批注 | 章节文件内的标记 | 行内 |
| 事件流 | `.habitat/journal/YYYY-MM.jsonl` | 一行一事件 |

**行内记录**（任务、日程）是这套设计里最特殊的一块：它们不是独立文件，而是 Markdown 列表里的一行，
带 `[due:: …]` 这样的行内字段和 `^id` 锚点。好处是人可以直接在编辑器里勾选、拖动；
代价是写入必须重新序列化整行——见下面「四种序列化路径」。

## 写入路径

```
POST /api/changes  ──┐
habitat propose …  ──┼──▶ ChangeService.propose
MCP kb_propose     ──┘        │
                              ├─ 装载草稿（按目标文件类型）
                              ├─ 计算 inverse（反向操作）
                              ├─ 记录 base（baseRevisions + 内容快照）
                              ▼
                        validate：四项校验
                          · 对象结构
                          · 原件只读
                          · 链接可解析
                          · 版本一致
                              │
                              ▼
                        commit
                          ├─ 落盘（原子写：临时文件 + rename）
                          ├─ rev +1
                          ├─ 写事件（每个 op 一条 + 汇总一条）
                          └─ 重建索引
```

### 四种序列化路径

这是最容易出 bug 的地方：改了对象不等于改了文件。草稿有四种形态，序列化各走各的：

| 草稿类型 | 谁用 | 序列化 |
|---|---|---|
| `blocks` | 行内任务、日程 | 重新渲染那一行（`- [ ] 文本 [due:: …] ^id`） |
| `fm` + `body` | 笔记、报告 | frontmatter 序列化 + 正文 |
| `yaml` | 作品定义 | YAML 序列化 |
| `jsonl` | 事件流、变更集 | 逐行 JSON |

**踩过的坑**：归档操作只改了 `objs` 里的对象，而序列化走的是 `blocks`，
结果 UI 报「已归档」、文件没变、重启就丢。所以任何在对象上的改动，都要显式落到对应的序列化路径。

## 并发与冲突

三个层次的处理：

1. **同进程**：所有写入串行过 `ChangeService`，不会互相踩。
2. **跨进程 / 外部编辑器**：提交时带 `baseHash`，落盘前比对当前文件哈希。不一致就返回 409 + 三方对比
   （你看到的 / 你改的 / 现在盘上的），由人决定重载还是另存。
3. **定时扫描**：每 15 秒比对文件指纹，外部改动自动进索引；`habitat agent reconcile` 会把它记成 `external_edit`
   并可认领，避免「谁改的」糊涂账。

## 索引

SQLite 存的是 token 倒排 + 对象快照，**完全由文件派生**：

- 扫描：遍历目录 → 解析 frontmatter / 行内记录 → 建对象 → 解析 wikilink
- 检索：中文按 2-gram 切分，英文按词，BM25 排序
- 重建：`habitat reindex`，或者直接删掉 `.habitat/state/*.db` 重启

`id` 分配有一层自愈：历史 bug 会把 id 越接越长（`work-xxx-ed1-ed1-…`），
`assignId` 对超过 80 字符的值一律当坏值重建，否则一个坏 id 会永远留在 `ids.json` 里。

## 生命周期

见 [`lifecycle.md`](lifecycle.md)。要点：

- **状态是算出来的**，不是手填标签
- **活性与成熟度正交**：前者看多久没碰，后者看长成什么样
- **AI 切入点固定四个**（判断 / 提炼 / 连接 / 质疑），每个都有确定的输入输出

## 自托管

```
本机 8787 ← SSH 反向隧道 / 内网穿透 → 服务器 nginx ← https://你的域名
```

- 默认只监听 `127.0.0.1`
- 令牌走 `KB_TOKEN` 环境变量；`/healthz` 不鉴权，其余全要
- Cookie 名可配（`HABITAT_COOKIE`），从别的系统迁移时保持同名，会话不用重登
- 数据目录建议**不要**放在会被云盘同步的位置，或者把凭据放在 `~/.habitat/`（本仓库就是这么做的）

## 测试策略

| 层 | 数量 | 覆盖什么 |
|---|---|---|
| 单元 | 57 | 扫描、id 稳定性、变更校验、索引、生命周期判定、翻新召回、邮件解析 |
| E2E | 76 | 真浏览器：采集→收件箱→衍生、提案→提交→撤销、上传、提醒配置、管家代谢 |

E2E 用 `tests/helpers/space.ts` 里的固定夹具，每次在 `.e2e-space` 重建，不碰真实数据。
邮件相关测试通过 `HABITAT_MAIL_CONFIG` 指向临时文件，绝不读真实凭据。
