# 账号与登录

Habitat 默认是本机单进程，但经常被反向隧道暴露到公网。这里定义两种凭据、一套强制改密规则，
以及它们各自的边界。

## 两种凭据，各管一件事

| 凭据 | 谁用 | 载体 | 能否管理账号 | 是否受强制改密约束 |
|---|---|---|---|---|
| 用户名 + 密码 | 人 | Cookie `kb_session`（签名，30 天） | owner 可以 | 是 |
| 访问令牌 | 脚本 / Agent / CLI | Cookie `kb_token`、`Authorization: Bearer`、`X-KB-Token` | 否 | 否 |

令牌是「整库读写」级别的机器凭据，本身就是最高权限，因此要求它改密没有意义；
账号管理接口只接受 owner 的**会话**，不接受令牌。

## 账号文件

默认 `~/.habitat/auth.json`（`HABITAT_AUTH_FILE` 可改），权限 `0600`。

```json
{
  "version": 1,
  "secret": "…32 字节随机数，会话 Cookie 的 HMAC 密钥…",
  "users": [
    {
      "username": "young",
      "displayName": "Young",
      "role": "owner",
      "hash": "scrypt$32768$8$1$<salt>$<hash>",
      "pwv": 3,
      "mustChangePassword": false,
      "passwordUpdatedAt": "2026-11-04T01:48:20.000Z",
      "createdAt": "2026-11-01T02:00:00.000Z",
      "updatedAt": "2026-11-04T01:48:20.000Z",
      "lastLoginAt": "2026-11-04T01:48:20.000Z",
      "lastLoginIp": "127.0.0.1",
      "disabled": false
    }
  ]
}
```

**为什么不放空间目录**：空间常被同步到云盘（WPS / OneDrive / iCloud），
密码哈希不该跟着笔记一起漂。一个进程也可以有多个空间共用一套登录。

**备份**：这个文件丢了，账号就没了（内容不受影响）。它和 `mail.json` 一样属于「机器凭据」，
应该进你的私密备份，而不是进仓库。

## 密码

- 哈希：`scrypt(N=32768, r=8, p=1, keylen=64)` + 16 字节随机盐；参数写在哈希串里，以后调参不破坏旧密码。
- 校验：`crypto.timingSafeEqual`；用户不存在时也照常算一次哈希，响应时间不泄露账号是否存在。
- 临时密码：16 位，去掉 `0/O/1/l/I` 等易混字符，四段一组（`xxxx-xxxx-xxxx-xxxx`），只显示一次。
- 策略（前后端共用 `shared/password.ts`）：
  - 10–200 个字符（按 Unicode 码点算，中文密码不会被当成 3 字节）；
  - 至少两类字符；16 个字符以上可放宽（长口令本身就是强度）；
  - 不能等于 / 包含用户名；不能等于当前密码；首尾不能有空白；
  - 常见弱密码字典直接拒绝。
- 登录节流：同一 IP + 用户名连续失败 5 次锁 5 分钟，继续失败翻倍，上限 30 分钟。
  改密时的「当前密码」校验也走同一套节流。

## 强制改密

三种情况会触发（服务端每个请求都会重新判断，不是登录时算一次）：

| 来源 | 标记 | 提示 |
|---|---|---|
| 首次登录 / 管理员新建 | `mustChangePassword: true` 且密码时间 ≈ 创建时间 | 首次登录，请先设置自己的密码 |
| 管理员重置 | `mustChangePassword: true`，密码时间晚于创建时间 | 管理员要求你更新密码 |
| 密码超过有效期 | `passwordUpdatedAt + HABITAT_PASSWORD_DAYS < now` | 密码已使用 N 天，超过 M 天有效期 |

触发后：

- 任何 HTML 页面 → `302 /change-password`；
- 任何 `/api/*`（除 `me` / `logout` / `password`）→ `403 { code: "password_change_required" }`；
- 改密必须提供**当前密码**（临时密码也是密码），并满足新密码策略；
- 改密成功：`pwv + 1`，当前设备换发新 Cookie，其它设备上的旧会话立即失效。

有效期默认 90 天，`HABITAT_PASSWORD_DAYS=0` 关闭。关掉有效期不影响前两种强制改密。

## 会话

签名 Cookie：`base64url({u,v,exp}).HMAC-SHA256(secret)`。

- 无状态：服务重启后仍然有效（`secret` 持久化在账号文件里）。
- 失效条件：过期、签名不对、用户被删/停用、`pwv` 与 Cookie 里不一致（改密或停用会 `+1`）。
- Cookie 属性：`HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`；检测到 `X-Forwarded-Proto: https` 时加 `Secure`。
- 非 GET 请求若带 `Origin`，必须与 `Host` 同源，否则 403（配合 SameSite 拦 CSRF）。

## 首次启用

```bash
# 方式一：显式打开，首次启动自动创建 admin，临时密码打印在服务日志里
HABITAT_AUTH=on npm run start

# 方式二：先用 CLI 建账号（不需要空间已就绪）
npx habitat user add young --name Young --role owner
# 输出临时密码，下次启动服务就会启用密码登录（HABITAT_AUTH=auto）
```

`HABITAT_AUTH=auto`（默认）在账号文件里有用户时启用密码登录；没有用户时保持原来的行为
（本机开发不鉴权，公网部署请务必配 `KB_TOKEN` 或账号）。

## 日常运维

```bash
habitat user list [--json]
habitat user add <用户名> [--name 显示名] [--role owner|member] [--password …] [--no-force]
habitat user reset <用户名> [--password …] [--no-force]   # 默认生成临时密码并强制下次改密
habitat user disable <用户名>
habitat user enable <用户名>
```

> CLI 直接改磁盘上的账号文件；服务在启动时把它读进内存，所以**用 CLI 改完要重启服务**。
> 网页端「账号与登录」里的操作走同一个进程，即时生效。

网页端「系统 → 账号与登录」提供同样的能力（owner 才能看到账号管理）：

- 查看自己的角色、上次登录、密码更新时间与到期时间；
- 修改自己的密码；
- 新建账号（留空自动生成临时密码）、重置密码、停用/启用；
- 退出登录（清 `kb_session` 与 `kb_token`）。

### 安全约束

- 不能停用/降级最后一个可用的 owner；
- 不能停用自己、不能改自己的角色（避免手滑把自己锁在外面）；
- 停用账号会 `pwv + 1`，现有会话全部失效；重新启用后旧 Cookie 也不会复活；
- 令牌会话看不到账号管理接口（403），账号操作必须用 owner 账号登录。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/me` | 当前身份、登录方式、是否待改密、能否管理账号 |
| POST | `/api/auth/password` | 改自己的密码（需会话 + 当前密码） |
| POST | `/api/auth/logout` | 清会话与令牌 Cookie |
| GET | `/api/auth/users` | 账号列表（owner） |
| POST | `/api/auth/users` | 新建账号（owner；返回一次性临时密码） |
| PATCH | `/api/auth/users/:username` | 改显示名 / 角色 / 停用 / 强制改密（owner） |
| POST | `/api/auth/users/:username/reset` | 重置密码（owner；返回一次性临时密码） |

页面：`GET/POST /login`、`GET/POST /change-password`、`GET /logout`。

## 已知边界

- 单机单进程，账号文件没有并发写锁（Node 单线程 + 串行队列够用；多进程同时写会互相覆盖）。
- 没有邮件找回密码：忘了密码就让另一个 owner 重置，或直接改账号文件（删掉该用户后重新 `user add`）。
- 没有 TOTP / WebAuthn。需要更强认证时，反向代理层加一层（如 Authelia）比在本进程里堆功能更合适。
- 反向代理必须保留 `Host`（nginx: `proxy_set_header Host $host`）。非 GET 请求会校验 `Origin` 与 `Host` 同源，代理把 Host 改掉会把自己的写请求拦成 403。
- 登录失败日志只打在进程输出里，没有单独的审计文件。
