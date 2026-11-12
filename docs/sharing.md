# 对外分享（抽印本）

Habitat 默认只给登录后的自己看。分享要解决的问题是：**把库里的一小块，交给一个不需要账号的外部读者，并且随时能收回。**

它不是「整库只读模式」，也不是「公开目录」。它是抽印本：从书架上抽出来的几样东西，装订成一册，只带一个链接。

## 三条边界

| 边界 | 做法 | 为什么 |
|---|---|---|
| 公开范围 | 唯一依据是 `Share.targetIds` 白名单；作品连带章节，专题连带成员 | 白名单之外的对象连**标题**都不会出现在公开页里。链接泄漏不等于整库泄漏 |
| 权限载体 | 链接里的 `token`（12 字符，72 位随机） | 没有 token 的请求在鉴权闸门前就被挡；不需要给外部读者建账号 |
| 访问数据 | 只追加到 `.habitat/state/share-views.jsonl`，**不回写** `Share` | 否则每来一个访客都要走一次 `ChangeService`，只读页就成了写入源 |

## 文件在哪

```
shares/<share-id>.yaml        分享定义（事实源，可手改）
.habitat/state/share-views.jsonl   访问流水（可丢弃，删了只丢统计）
```

`shares/*.yaml` 是纯 YAML，不裹 frontmatter：

```yaml
type: share
id: share-01M77YP9XSY97Q1TSK5T3WEDWE
spaceId: space-01HX8Z9K7M2N4P6Q8R0S2T0000
createdAt: 2026-11-12T21:20:57+08:00
updatedAt: 2026-11-12T21:20:57+08:00
author: human
sensitivity: public
rev: 1
title: 给同事的三章
intro: 线性注意力那段最近讨论得多，抽出来一起看。
token: MIE9f5HR-zRn
state: active
targetIds:
  - work-01HX8Z9K7M2N4P6Q8R0S2T4V6W
  - note-01HX8Z9K7M2N4P6Q8R0S2T4V80
allowDownload: false
byline: Young
```

因为它是普通对象，所以：改它走 `ChangeService`（有基准、有反向操作、有事件、可撤销）；
删掉 `.habitat/state/*.db` 重启也能从文件重建分享；用编辑器直接改 `state: paused` 也生效。

## 公开面有哪些地址

| 地址 | 内容 |
|---|---|
| `/s/:token` | 抽印本目录：书籍 / 专题 / 笔记三段 |
| `/s/:token/w/:workId` | 书籍目录（章节、字数、补充材料） |
| `/s/:token/w/:workId/c/:partId` | 章节正文，含上一章 / 下一章 |
| `/s/:token/n/:noteId` | 一篇笔记 |
| `/s/:token/t/:collectionId` | 专题：它收入的书与笔记 |
| `/s/:token/raw?p=…` | 正文里的相对图片（只认分享内容目录与 `assets/`，只发图片类型） |
| `/s/:token/d/:repId` | PDF / EPUB 原件，**仅当 `allowDownload: true`** |

`/api/*` 全部仍要登录——包括 `/api/shares`。公开的只有 `/s/` 这一个前缀（见 `server/auth.ts` 的闸门白名单）。

## 状态与开关

`Share.stateOf()` 是唯一判定处，四种状态对应四种行为：

| 状态 | 触发 | 公开页 |
|---|---|---|
| `ok` | 默认 | 200 |
| `paused` | `state: paused` | 410「分享已暂停」 |
| `expired` | `expiresAt` ≤ 现在 | 410「分享已到期」 |
| `missing` | token 不存在、或对象已归档 | 404「这个链接打不开」 |

都**不做缓存**（`cache-control: no-store`），所以暂停、换链接、归档都是立刻生效。
`expiresAt` 只写日期时按当天 23:59:59 算——「到期日当天还能读」符合直觉。

## 专题为什么是快照

创建时把专题成员展开进 `targetIds`，之后往专题里加东西**不会**自动公开。
想带上新成员，在管理页点「同步专题成员」，那是一次明确的动作。

理由：分享是「我此刻同意的范围」。让明天的编辑变成今天的公开，等于把权限交给了未来的自己还没审过的内容。

## 访问统计

每条流水一行：

```json
{"at":"2026-11-12T21:23:40+08:00","share":"share-01M…","path":"/s/MIE9f5HR-zRn/w/work-…/c/part-…","item":"part-01M…","kind":"part","vid":"9f3c…","ref":"news.example.com"}
```

- `vid` 是签名无关的随机访客号，存在 Cookie `hb_v`（`Path=/s`，一年）。**不是精确人数**，清 Cookie 就是新访客。
- `ref` 只记外部来源域名；站内翻页记成「直接打开」。
- 聚合结果：总量 / 独立访客 / 今日 / 近 7 日 / 近 30 日 / 每日序列 / 按内容 / 按来源。
- 文件超过 8MB 只读尾部——统计是趋势，不是账本。

管理页 `GET /api/shares` 一次读盘、一次聚合（`statsAll`），不会对每条分享各读一遍日志。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/shares` | 列表 + 白名单 + 统计 + 汇总（进行中 / 近 7 日 / 访客） |
| GET | `/api/shares/options` | 可选的书籍、专题、笔记 |
| POST | `/api/shares` | 新建 |
| PATCH | `/api/shares/:id` | 改标题、引言、范围、到期、下载开关、暂停 |
| POST | `/api/shares/:id/rotate` | 换 token（旧链接立即失效，统计不丢） |
| POST | `/api/shares/:id/sync` | 按专题当前成员同步范围 |
| POST | `/api/shares/:id/archive` | 归档（文件留着，链接失效） |
| GET | `/api/shares/:id/stats?days=30` | 单条明细 |

## 部署注意

- **给外部读者的链接必须能被外部解析**。默认 `baseUrl` 取自请求（`X-Forwarded-Host` / `Host`），
  本机开发时就是 `http://127.0.0.1:8787`，外部打不开。生产要设 `HABITAT_PUBLIC_URL=https://…`，
  管理页会在没设的时候显式提示。
- **反代要透传** `X-Forwarded-Proto` 与 `X-Forwarded-Host`，否则生成的链接是 http / 内网地址。
- 公开页带 `Content-Security-Policy: default-src 'none'`、`X-Robots-Tag: noindex`、`no-referrer`，
  正文里的 HTML 一律不执行（`markdown-it` 关掉 `html`）。
- 每 IP 每分钟 240 次上限（`ShareService.allow`），挡的是脚本扫链接，不影响正常阅读。

## 已知取舍

- **没有密码保护**。要「凭密码看」请给对方一个新 token 而不是共用口令——token 本身就是凭据。
- **没有单个读者的访问明细**。只按浏览器去重，不做设备指纹：这是个人知识库，不是分析平台。
- **统计只在分享页产生**。`/s/…/raw` 与 `/d/…` 不计数，避免一张图刷成十几次阅读。
- **归档不做物理删除**。要彻底清掉，归档后再删 `shares/<id>.yaml`；统计流水需要单独清理。