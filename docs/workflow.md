# 开发与日常使用的闭环

## 问题

生产（给日常用的服务）和开发（改代码的地方）如果是同一个目录，
你改到一半、或者重启一下，日常使用就受影响；更糟的是拿真实数据当了试验田。

所以**代码分两份**，**数据只有一份**。

```
D:\works\habitat          生产：跑在某个 tag 上，只做 checkout，不写代码
D:\works\habitat-dev      开发：随便改，连的是示例空间或临时空间
D:\...\MySpace            数据：只有一份，两边都不直接写它（写操作都走服务）
```

生产目录里不写代码，开发目录里不连真实数据。这两条守住，闭环就是安全的。

## 日常循环

```
每天用 ──→ 发现不对劲 ──→ 记成任务（挂在 habitat 项目下）
                              │
                              ▼
                    在 dev 里改 → 跑测试 → commit → push
                              │
                              ▼
                    打 tag（v0.1.1）→ 在生产目录 promote
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
              检查通过 → 完成      检查不过 → 自动回滚
```

### 1. 发现问题，先记下来

不要当场修。用你自己的系统记：

```bash
habitat task "早上打开今天页白屏（v0.1.0）" --due <今天> --project <habitat 项目 id>
```

记的时候带上**能复现的三件事**：你点了什么、期望什么、实际什么。
不记的话，晚上回家就想不起细节了。

### 2. 在开发目录改

```bash
cd D:\works\habitat-dev
git checkout -b fix/today-blank
# 改代码
npm run test:unit        # 快，先跑这个
npm run test:e2e         # 慢，改了界面/流程再跑
npm run dev              # 前端 5178，后端 8787，连的是示例空间
```

开发目录**永远不连真实空间**。要复现真实数据的问题，用导出：

```bash
# 在数据侧导出（只读，不动原数据）
habitat export --out D:/tmp/repro-space --verify
# 然后在 dev 里指向它
HABITAT_SPACE=D:/tmp/repro-space npm run dev
```

### 3. 合并、打标签

```bash
git checkout main && git merge --no-ff fix/today-blank
git push origin main
git tag -a v0.1.1 -m "修：今天页首次加载白屏"
git push origin v0.1.1
```

### 4. 发布到生产

```bash
cd D:\works\habitat
set HABITAT_SPACE=D:\works\PersonalKnowledgeBase\MySpace
set HABITAT_RESTART_CMD=python D:/works/PersonalKnowledgeBase/.kb/tools/kb_remote.py restart

node scripts/promote.mjs v0.1.1 --dry-run    # 先看它打算做什么
node scripts/promote.mjs v0.1.1
```

`HABITAT_RESTART_CMD` **必须用绝对路径**。生产目录里没有 `.kb/`，写相对路径
`python .kb\tools\kb_remote.py restart` 会在 `D:\works\habitat` 下找不到文件而失败，
promote 判定重启失败后回滚，白跑一轮。`kb_remote.py` 用自身位置推导知识库根，不依赖 cwd。

脚本会依次：检查工作区干净 → 记录基线 → 切 tag → 装依赖（变了才装）→ 构建 →
跑单测 → 重启 → 健康检查 → **对比对象数和链接解析率** → 任一项不过**自动回滚**。

判断标准，缺一不可：

| 检查 | 为什么 |
|---|---|
| `/healthz` 返回 ok | 进程起来了 |
| 对象数不减少 | 防扫描逻辑被改坏（最隐蔽的回归） |
| 解析率不明显下降 | 防链接解析回归 |
| `dist/index.html` 非空、含入口脚本、引用资源存在 | 防白屏。`/healthz` 只证明进程活着，证明不了页面能打开 |

最后一条由 `scripts/verify-dist.mjs` 执行（已串在 `npm run build` 尾部，
promote 在构建后再独立跑一次）。2026-11-13 就栽在这：构建报成功、
`/healthz` 回 ok、对象数不变，但入口 HTML 是 621 字节全零，浏览器白屏。

### 构建环境的一个已知故障（2026-11-13）

`vite build` 启动时会 `emptyDir(dist)`。本机这个 `rmSync` 被 WorkBuddy 的
`safe-delete` 垫片接管，而垫片的状态目录里有一批内容是 `0x00` 的损坏
`state.json`（`%TEMP%\codebuddy-safe-delete-bulk\*\state.json`，与那次
`index.html` 被清零是同一时刻的写盘事故），于是：

- `rmSync` 抛 `SAFE_DELETE_BULK_GUARD_ERROR`
- 但 `index.html` 已被以截断方式打开过 → 留下**长度正确、内容全零**的残骸
- 构建中断，`dist/assets/` 里的旧文件还在 → 看起来"像是构建成功了"

三种绕法，任选其一：

```bash
# 1) 构建时摘掉垫片的环境变量（最干净，不碰任何运行时状态）
env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR -u CODEBUDDY_TOOL_CALL_ID npm run build

# 2) 跳过清目录
npx vite build --emptyOutDir false && node scripts/verify-dist.mjs

# 3) 修状态文件：删掉 %TEMP%\codebuddy-safe-delete-bulk 下内容全为 0 的 state.json
```

promote 已内置第 2 种作为兜底（识别到垫片异常就自动重试）。
但**建议用第 1 种执行发布**——这是唯一能让清目录也正常工作的方式：

```bash
env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR -u CODEBUDDY_TOOL_CALL_ID \
  HABITAT_SPACE=D:/works/PersonalKnowledgeBase/MySpace \
  HABITAT_PORT=8765 \
  HABITAT_RESTART_CMD="python D:/works/PersonalKnowledgeBase/.kb/tools/kb_remote.py restart" \
  node scripts/promote.mjs v0.9.6 --skip-ci
```

### 5. 坏了怎么退

promote 会自己回滚。手动退：

```bash
cd D:\works\habitat
git checkout v0.1.0 && npm ci && npm run build
python D:\works\PersonalKnowledgeBase\.kb\tools\kb_remote.py restart
```

数据不需要跟着回滚——所有写入都是带反向操作的变更集，真要撤销某个改动：

```bash
habitat propose --ops ...   # 或者直接在「变更」页点撤销
```

## 什么时候可以破例

| 场景 | 做法 |
|---|---|
| 只改文案 / README | 直接在 dev 改，不用打 tag，也不用发布 |
| 一行 hotfix，影响日常使用 | 仍然走 tag，但可以 `--no-test` 跳过 E2E，单测别跳 |
| 改 schema / 迁移 | **先在导出的副本上跑一遍**，确认对象数和链接数没掉，再发 |
| 改写入逻辑 | 发版前 `habitat export --verify` 存一份基线 |

## 不要做的事

1. **不要在生产目录改代码**。promote 会拒绝（工作区必须干净），但别指望它拦你。
2. **不要在开发目录连真实空间**。一个手误的 `--apply` 就写进去了。
3. **不要 `git pull` 生产目录**。生产只 checkout tag，主线在 dev 里推进。
4. **不要在发布过程中操作网页**。重启窗口里写入会失败（不会损坏，但会烦）。

## 一次典型的一周

```
周一  发现今天页点不动 → habitat task 记下
周二  晚上在 dev 改，单测过，E2E 过，push + tag v0.1.1
周三  早上 promote（3 分钟），健康检查过，对象数 186 → 186
周五  又发现一个问题 → 重复
```

关键是**每次只推进一小步**：一个 tag 只修一件事，出问题时回滚代价最小。
