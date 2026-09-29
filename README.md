# roomchat

打开即用的临时聊天室。打开首页自动生成一个房间，把链接发给朋友就能进来；每人随机分到一个动物名和一个纯色圆形头像。聊天内容在浏览器之间 P2P 直连传输，服务器只负责"牵线"（信令），看不到消息；不保存任何历史，房间结束即清空。

## 架构

一个 Cloudflare Worker 同时托管静态页面和一个很小的后端：

- `public/`：静态页面。访问静态文件免费且不触发 Worker。
- `src/worker.js`：只处理 `/api/*` 和 `/ws/*`。
  - `Room`（Durable Object，每个房间一个）：Trystero 信令中继、房间锁定、自动结束。
  - `Registry`（Durable Object，全局一个）：站点开关、活跃房间列表、建房限流。
- `web/`：前端源码，由 `scripts/build.mjs` 打包成 `public/app.js`。

房间在以下情况结束，结束后所有人被移出、内存中的消息清空：

1. 房间里任何人点"结束房间"；
2. 所有人都离开（有 60 秒宽限，刷新页面不会误杀）；
3. 30 分钟没有新消息；
4. 创建后 5 分钟没人加入；
5. 管理员在后台结束，或关闭站点。

房间里的任何人都可以切换"禁止新人加入"。已经在房间里的人刷新页面仍然可以回来。

## 部署（GitHub + Cloudflare Workers）

1. 把这个仓库推到 GitHub（建议设为私有）。
2. Cloudflare 控制台 → Workers & Pages → 创建 → 导入 GitHub 仓库，选中它。
   - Worker 名称填 `roomchat`（必须与 `wrangler.jsonc` 里的 `name` 一致）。
   - 部署命令用默认的 `npx wrangler deploy` 即可。它会先自动执行 `npm run build`，构建命令一栏可以留空。
3. 设置管理员令牌：进入该 Worker → Settings → Variables and Secrets → 添加，类型选 **Secret**，名称 `ADMIN_TOKEN`，值用一串足够长的随机字符串（比如 `openssl rand -base64 24` 的输出）。
   也可以用命令行：`npx wrangler secret put ADMIN_TOKEN`。
4. 打开 `https://<你的域名>/admin`，用令牌登录，点"开放站点"。**站点默认是关闭的**，访客只会看到"网站维护中"。
5. 建议绑定自定义域名（Worker → Settings → Domains & Routes）。`*.workers.dev` 在国内经常无法访问。

之后每次推送到 GitHub 都会自动重新部署。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 修改里面的 ADMIN_TOKEN
npm run dev                      # http://localhost:8787
```

在同一台电脑上用两个不同的浏览器（或一个普通窗口加一个无痕窗口）就能互相聊天。

## 可调参数

在 `wrangler.jsonc` 的 `vars` 里修改：

| 变量 | 默认 | 含义 |
|---|---|---|
| `IDLE_MINUTES` | 30 | 多久没有新消息自动结束房间 |
| `EMPTY_GRACE_SECONDS` | 60 | 所有人离开后多久结束房间 |
| `UNJOINED_MINUTES` | 5 | 创建后多久没人加入就失效 |
| `TOMBSTONE_HOURS` | 24 | 结束的房间 ID 保留多久（期间打开链接显示"已结束"） |
| `MAX_MEMBERS` | 10 | 每个房间人数上限 |
| `CREATE_LIMIT_PER_10MIN` | 10 | 每个 IP 每 10 分钟最多建几个房间 |

## 房间 ID

6 位，字符集为 `0-9` 加去掉 `i l o u` 的 22 个小写字母，共 32 种字符，约 10.7 亿种组合，由服务端用 `crypto.getRandomValues` 生成并查重。输入不区分大小写，`o` 自动当作 `0`，`i`、`l` 当作 `1`。

## 关于 Trystero 的两处处理

- 使用 `@trystero-p2p/core` 0.25.4 的自定义信令策略（`web/relay.js`），版本已锁定，升级前请先测试。
- 关闭了 trickle ICE（`trickleIce: false`）。原因：0.25.x 在房间里第一个人等待超过约 57 秒后，新加入的人会连不上（上游 issue #204）；关闭 trickle 后实测正常。代价是建连要等 ICE 收集，因此 `scripts/build.mjs` 在打包时把 Trystero 的收集超时从 15 秒改为 3 秒。若 Trystero 源码变化导致替换失败，构建会直接报错而不是悄悄失效。

## 还没做的

- 发送图片、音频、视频
- TURN 中继（部分网络之间无法直连时需要）
- 管理员按人封禁
