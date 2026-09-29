# YACR

Yet another chat room：打开即用的临时聊天室。房间号给你生成好，进去后把链接发给朋友；每人随机分到一个动物名，头像是一个随机 emoji 配纯色圆底。文字、图片、音频、视频都在浏览器之间 P2P 直连传输，服务器只负责"牵线"（信令），看不到内容；不保存任何历史，房间结束即清空。

## 功能

**访客**

- 首页：允许访客新建时，预先生成好 6 位房间号，可以换一个或改成朋友给的房间号；不允许时，首页只能填房间号加入已有房间
- 文字消息：链接可点击，每条可复制
- 图片、音频、视频：点"＋"选择，也可以粘贴或拖进窗口。先发缩略图"公告"，别人需要时再按需下载；5 MB 以下的图片自动下载。原发送者离开后，会向房间里其他有这个文件的人要。图片在页面内放大查看，浏览器放不了的格式提供"保存"
- 房间里任何人都可以"禁止新人加入"，已在房间里的人刷新仍能回来
- 成员栏显示谁已连上、谁还在连接（半透明虚线框头像）；20 秒还连不上会给出提示
- 浏览器禁用了 WebRTC 时直接提示，不会进入一个发不了消息的房间
- 标签页标题显示未读数，可选开启系统通知；手机切回前台或网络恢复时立即重连
- 直连失败时自动走 Cloudflare TURN 中继（需配置）

**管理员**（`/admin`）

- 站点总开关：关闭时访客只看到"网站维护中"，并结束所有房间
- 访客新建开关（默认关闭）：关闭时只有管理员能新建房间，访客只能凭房间号加入
- 右上角"新建房间"：直接建房并在新标签页打开，不受上面两个开关限制
- 查看活跃房间（成员、IP、锁定状态、最后消息时间），进入任意房间（包括已锁定、已满的），结束单个或全部房间
- 封禁：按浏览器标识，或按 IP；封禁名单可解除
- 房间参数：空闲时长、人数上限、单文件上限、建房频率（只对之后新建的房间生效）
- 显示 TURN 是否已配置

**房间结束条件**：结束后所有人被移出、内存中的消息和文件清空。

1. 房间里任何人点"结束房间"；
2. 所有人都离开（有 60 秒宽限，刷新页面不会误杀）；
3. 一段时间没有新消息（默认 30 分钟，可在后台调整）；
4. 创建后 5 分钟没人加入；
5. 管理员在后台结束，或关闭站点。

## 架构

一个 Cloudflare Worker 同时托管静态页面和一个很小的后端：

- `public/`：静态页面（首页和聊天是同一个页面，另有 `admin.html`）。访问静态文件免费且不触发 Worker。
- `src/worker.js`：只处理 `/api/*` 和 `/ws/*`，并检查 Origin，只接受本站页面（及 `ALLOWED_ORIGINS` 里的反代域名）发起的请求。
  - `Room`（Durable Object，每个房间一个）：Trystero 信令中继、在线名单、房间锁定、自动结束。
  - `Registry`（Durable Object，全局一个）：站点开关、访客新建开关、活跃房间列表、后台设置、封禁名单、建房 / ICE / 登录限流。
- `web/`：前端源码，由 `scripts/build.mjs` 打包成 `public/app.js`。

## 部署（GitHub + Cloudflare Workers）

1. Cloudflare 控制台 → Workers & Pages → 导入这个 GitHub 仓库。
   - Worker 名称必须与 `wrangler.jsonc` 里的 `name` 一致。
   - 部署命令用默认的 `npx wrangler deploy`，它会先自动执行 `npm run build`，构建命令一栏留空。
   - 在构建设置里关闭非生产分支的构建，只让 `main` 触发部署。
2. 在 Worker → Settings → Variables and Secrets 添加 Secret（保存后自动部署生效，不需要推代码）：
   - `ADMIN_TOKEN`（必填）：管理后台令牌，用 `openssl rand -base64 32` 生成，存进密码管理器。
   - `TURN_KEY_ID`、`TURN_KEY_API_TOKEN`（选填）：Cloudflare Realtime → TURN 里创建的 TURN Key 的 ID 和 API Token（Token 只在创建时显示一次）。
3. 打开 `https://<你的域名>/admin`，用令牌登录，点"开放站点"。**站点默认是关闭的**；"允许访客新建"也**默认关闭**。
4. 建议：
   - 绑定自定义域名（`*.workers.dev` 在国内经常无法访问），域名只在控制台配置，不要写进仓库。
   - 用 Cloudflare Access 保护 `admin*` 和 `api/admin/*` 两个路径。
   - 确认自定义域名可用后，在 `wrangler.jsonc` 加上 `"workers_dev": false` 和 `"preview_urls": false`，关闭可以绕过 Access 的默认地址。

之后每次推送到 `main` 都会自动重新部署，Secret 会一直保留。

## 经 VPS 反向代理（改善中国大陆访问）

`*.workers.dev` 在国内基本打不开，Cloudflare 自定义域名直连也常常慢或不稳定。可以让访客访问一个解析到 VPS 的域名，由 VPS 把请求转给 Worker。只有页面和信令经过 VPS，聊天内容仍是浏览器之间直连（或走 TURN），VPS 流量很小。

需要两个域名：

- **源站域名**（如 `o.example.com`）：在 Cloudflare 绑定为 Worker 的自定义域名，管理员从这里进后台，可以用 Cloudflare Access 保护。
- **访客域名**（如 `chat.example.com`）：DNS 解析到 VPS，**不开 Cloudflare 代理（灰云）**，由 VPS 上的反代转发到源站域名。

Worker 需要两个 Secret（用 Secret 而不是普通变量：值不公开，且不会被自动部署覆盖）：

- `ALLOWED_ORIGINS`：访客域名的完整来源，如 `https://chat.example.com`，多个用逗号分隔。不设置的话，经反代来的请求会被 Origin 检查拒绝。
- `PROXY_SECRET`：一串随机字符串（`openssl rand -hex 24`）。反代在 `X-Yacr-Proxy` 头里带上它，Worker 才会采信 `X-Yacr-Client-IP` 里的访客真实 IP；否则所有访客都会被当成 VPS 的 IP，按 IP 的限流和封禁会失效或误伤所有人。

反代时要做到：请求头 `Host` 改成源站域名、TLS SNI 用源站域名、覆盖（而不是追加）上面两个头、支持 WebSocket，并且屏蔽 `/admin` 和 `/api/admin/`（后台只从源站域名访问）。如果反代前面还有一层本机转发（例如 sing-box 按 SNI 分流后转给 Caddy），反代看到的来源 IP 会是 `127.0.0.1`，此时需要让前一层把真实 IP 传过来（如 PROXY protocol），否则 Worker 会把这些访客都记为同一个"proxy"IP。

## TURN 中继

**不配置也能用**，只是有一部分人之间会连不上：两边都用手机流量（运营商级 NAT）、公司或学校网络封锁 UDP、开着代理或 VPN 接管了流量等情况。连不上的两人互相收不到消息和文件，成员栏会显示"正在连接"并出现提示；房间人数、锁定、结束等功能不受影响。

**配置后**：凭证由服务端向 Cloudflare 申请，只发给持有有效令牌的房间成员，每个 IP 每 10 分钟最多申请 20 次；凭证有效期 4 小时，服务端缓存复用。已经在房间里的人需要刷新页面才会用上 TURN。

**确认是否真的生效**：后台的"已配置"只表示两个 Secret 存在，不校验对错。可以进一个房间，在浏览器开发者工具的网络面板里查看 `/api/ice` 的返回内容，有 `turn:turn.cloudflare.com` 开头的地址才算生效；或者在 Worker 日志里搜 `TURN credentials failed`，有这条说明 Key 或 Token 不对，此时会自动退回只用 STUN。

**滥用风险**：拿到凭证的人可以在有效期内用它中转任意流量，费用记在你的账户上。降低风险的做法：平时关闭站点；保持"允许访客新建"关闭（外人就只能靠猜中正在使用的房间号才能拿到令牌）；人到齐后"禁止新人加入"。发现异常用量时，在 Cloudflare 控制台删除 TURN Key 即可让凭证失效，再新建一个 Key 并更新两个 Secret。

## 管理员登录与令牌

- 登录后，cookie 里**不存令牌原文**，只存"过期时间.签名"，签名由 `ADMIN_TOKEN` 通过 HMAC-SHA256 算出。有效期 30 天，服务端不需要存储会话。
- 更换 `ADMIN_TOKEN` 后，所有浏览器里的旧登录立即失效。
- 同一 IP 15 分钟内输错 5 次会被暂时锁定。

### 忘了令牌怎么办

找不回就直接换一个（最快，一两分钟）：

1. 生成新令牌：`openssl rand -base64 32`，先存进密码管理器。
2. Cloudflare 控制台 → 你的 Worker → Settings → Variables and Secrets → 编辑 `ADMIN_TOKEN`，填入新值并保存，会立即部署。
3. 打开 `/admin`，用新令牌登录。（如果配了 Cloudflare Access，会先要求邮箱验证码。）
4. 需要的话，点"关闭站点"。关站会同时结束所有房间。

房间、封禁名单、各项设置都存在 Durable Object 里，换令牌不受影响。

**登录被锁怎么办**：如果之前连续输错了 5 次，这个 IP 会被锁 15 分钟，换了新令牌也一样登不上。要么等 15 分钟，要么换个网络，比如手机开热点。

**更极端的情况：连后台都不想进，先让网站下线**：去 Worker → Settings → Domains & Routes，把自定义域名移除，网站马上就访问不到了（如果已关闭 workers.dev，就没有其他入口了）。这会让所有人都无法访问，事后要重新添加域名。**不要用删除 Worker 的方式来停站**：那会连同 Durable Object 里的所有数据一起删掉，包括封禁名单和设置。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 修改里面的 ADMIN_TOKEN
npm run dev                      # http://localhost:8787
```

用两个不同的浏览器（或普通窗口加无痕窗口）就能互相聊天。本地没有配置 TURN 时，可以在浏览器控制台执行 `localStorage.rc_ice = '[]'` 让直连只用本机地址，建连更快。

## 参数

部署默认值在 `wrangler.jsonc` 的 `vars` 里。前四项也可以在管理后台修改，后台的修改只对之后新建的房间生效。

| 变量 | 默认 | 含义 |
|---|---|---|
| `IDLE_MINUTES` | 30 | 多久没有新消息自动结束房间 |
| `MAX_MEMBERS` | 10 | 每个房间人数上限 |
| `MAX_FILE_MB` | 100 | 单个图片、音频、视频的大小上限 |
| `CREATE_LIMIT_PER_10MIN` | 10 | 每个 IP 每 10 分钟最多建几个房间（管理员不受限） |
| `EMPTY_GRACE_SECONDS` | 60 | 所有人离开后多久结束房间 |
| `UNJOINED_MINUTES` | 5 | 创建后多久没人加入就失效 |
| `TOMBSTONE_HOURS` | 24 | 结束的房间号保留多久（期间打开链接显示"已结束"） |

## 房间号

6 位，字符集为 `0-9` 加去掉 `i l o u` 的 22 个小写字母，共 32 种字符，约 10.7 亿种组合，用 `crypto.getRandomValues` 生成，服务端建房时查重。输入不区分大小写，`o` 自动当作 `0`，`i`、`l` 当作 `1`。

## 封禁的边界

没有账号体系，所以封禁只能做到"防君子"：

- **封禁**：按浏览器标识（存在 localStorage 的随机 ID），对方清除浏览器数据或换浏览器即可绕过。
- **封 IP**：更难绕过，但会连带同一网络出口下的所有人（家人、同事、同一运营商的手机用户），谨慎使用。

## 关于 Trystero 的处理

- 使用 `@trystero-p2p/core` 0.25.4 的自定义信令策略（`web/relay.js`），版本已锁定，升级前请先测试。
- 关闭了 trickle ICE（`trickleIce: false`）。0.25.x 在房间里有人等待超过约 57 秒后，新加入的人会连不上（上游 issue #204），关闭 trickle 后实测正常。代价是建连要等 ICE 收集，因此 `scripts/build.mjs` 打包时把 Trystero 的收集超时从 15 秒改为 3 秒；若 Trystero 源码变化导致替换失败，构建会直接报错。
- STUN 只用 Cloudflare 的 `stun.cloudflare.com`；TURN 地址会去掉浏览器会拦截的 53 端口。

## 头像 emoji

`web/emoji.js` 由 unicode-emoji-json 生成：除旗帜外的全部分组，限 Emoji 12.0 及以前（老系统也能显示），不含 ZWJ 组合和键帽数字。
