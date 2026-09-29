# YACR

Yet another chat room：打开即用的临时聊天室。首页给你生成好一个房间号，进去后把链接发给朋友；每人随机分到一个动物名，头像是一个随机 emoji 配纯色圆底。文字、图片、音频、视频都在浏览器之间 P2P 直连传输，服务器只负责"牵线"（信令），看不到内容；不保存任何历史，房间结束即清空。

## 功能

- 首页预生成 6 位房间号，可以换一个，也可以填朋友给的房间号直接进入
- 文字消息（链接可点击、单条复制）；图片、音频、视频（先发缩略图"公告"，别人需要时再按需下载，5 MB 以下的图片自动下载）
- 房间里任何人都可以"禁止新人加入"，已在房间里的人刷新仍能回来
- 成员栏显示谁已连上、谁还在连接；长时间连不上会给出提示
- 标签页标题显示未读数，可选开启系统通知；手机切回前台自动重连
- 直连失败时自动走 Cloudflare TURN 中继（需配置）
- 管理后台：站点总开关、访客新建房间开关、查看和结束房间、进入任意房间、封禁（按浏览器标识或 IP）、调整房间参数

房间在以下情况结束，结束后所有人被移出、内存中的消息和文件清空：

1. 房间里任何人点"结束房间"；
2. 所有人都离开（有 60 秒宽限，刷新页面不会误杀）；
3. 一段时间没有新消息（默认 30 分钟，可在后台调整）；
4. 创建后 5 分钟没人加入；
5. 管理员在后台结束，或关闭站点。

## 架构

一个 Cloudflare Worker 同时托管静态页面和一个很小的后端：

- `public/`：静态页面。访问静态文件免费且不触发 Worker。
- `src/worker.js`：只处理 `/api/*` 和 `/ws/*`，并检查 Origin，只接受本站页面发起的请求。
  - `Room`（Durable Object，每个房间一个）：Trystero 信令中继、在线名单、房间锁定、自动结束。
  - `Registry`（Durable Object，全局一个）：站点开关、活跃房间列表、后台设置、封禁名单、建房和登录限流。
- `web/`：前端源码，由 `scripts/build.mjs` 打包成 `public/app.js`。

## 部署（GitHub + Cloudflare Workers）

1. Cloudflare 控制台 → Workers & Pages → 导入这个 GitHub 仓库。
   - Worker 名称必须与 `wrangler.jsonc` 里的 `name` 一致。
   - 部署命令用默认的 `npx wrangler deploy`，它会先自动执行 `npm run build`，构建命令一栏留空。
   - 在构建设置里关闭非生产分支的构建，只让 `main` 触发部署。
2. 在 Worker → Settings → Variables and Secrets 添加 Secret：
   - `ADMIN_TOKEN`（必填）：管理后台令牌，用 `openssl rand -base64 32` 生成。
   - `TURN_KEY_ID`、`TURN_KEY_API_TOKEN`（选填）：Cloudflare Realtime → TURN 里创建的 TURN Key。不填也能用，只是直连失败的人之间无法通信。
3. 打开 `https://<你的域名>/admin`，用令牌登录，点"开放站点"。**站点默认是关闭的**。
   - 后台还有第二个开关"允许访客新建"，**默认关闭**：此时只有管理员能新建房间，访客在首页只能用房间号加入已有房间。
4. 建议：
   - 绑定自定义域名（`*.workers.dev` 在国内经常无法访问），域名只在控制台配置，不要写进仓库。
   - 用 Cloudflare Access 保护 `admin*` 和 `api/admin/*` 两个路径。
   - 确认自定义域名可用后，在 `wrangler.jsonc` 加上 `"workers_dev": false` 和 `"preview_urls": false`，关闭可以绕过 Access 的默认地址。

之后每次推送到 `main` 都会自动重新部署。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 修改里面的 ADMIN_TOKEN
npm run dev                      # http://localhost:8787
```

用两个不同的浏览器（或普通窗口加无痕窗口）就能互相聊天。

## 参数

部署默认值在 `wrangler.jsonc` 的 `vars` 里。前四项也可以在管理后台修改，后台的修改只对之后新建的房间生效。

| 变量 | 默认 | 含义 |
|---|---|---|
| `IDLE_MINUTES` | 30 | 多久没有新消息自动结束房间 |
| `MAX_MEMBERS` | 10 | 每个房间人数上限 |
| `MAX_FILE_MB` | 100 | 单个图片、音频、视频的大小上限 |
| `CREATE_LIMIT_PER_10MIN` | 10 | 每个 IP 每 10 分钟最多建几个房间 |
| `EMPTY_GRACE_SECONDS` | 60 | 所有人离开后多久结束房间 |
| `UNJOINED_MINUTES` | 5 | 创建后多久没人加入就失效 |
| `TOMBSTONE_HOURS` | 24 | 结束的房间号保留多久（期间打开链接显示"已结束"） |

管理员登录：同一 IP 15 分钟内输错 5 次会被暂时锁定。

## 房间号

6 位，字符集为 `0-9` 加去掉 `i l o u` 的 22 个小写字母，共 32 种字符，约 10.7 亿种组合，用 `crypto.getRandomValues` 生成，服务端建房时查重。输入不区分大小写，`o` 自动当作 `0`，`i`、`l` 当作 `1`。

## 封禁的边界

没有账号体系，所以封禁只能做到"防君子"：

- **封禁**：按浏览器标识（存在 localStorage 的随机 ID），对方清除浏览器数据或换浏览器即可绕过。
- **封 IP**：更难绕过，但会连带同一网络出口下的所有人（家人、同事、同一运营商的手机用户），谨慎使用。

## 关于 Trystero 的处理

- 使用 `@trystero-p2p/core` 0.25.4 的自定义信令策略（`web/relay.js`），版本已锁定，升级前请先测试。
- 关闭了 trickle ICE（`trickleIce: false`）。0.25.x 在房间里有人等待超过约 57 秒后，新加入的人会连不上（上游 issue #204），关闭 trickle 后实测正常。代价是建连要等 ICE 收集，因此 `scripts/build.mjs` 打包时把 Trystero 的收集超时从 15 秒改为 3 秒；若 Trystero 源码变化导致替换失败，构建会直接报错。

## 头像 emoji

`web/emoji.js` 由 unicode-emoji-json 生成：除旗帜外的全部分组，限 Emoji 12.0 及以前（老系统也能显示），不含 ZWJ 组合和键帽数字。
