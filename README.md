# YACR

**打开即用、不留记录的临时聊天室。** 发一个链接就能开聊，房间结束后所有内容随之消失。部署在 Cloudflare Workers 上，可以经你自己的 VPS 中转，国内也能稳定使用。

## 简介

- **发链接即聊**：房间号自动生成，每人随机分到一个动物名和 emoji 头像。支持文字、图片、音频、视频。
- **不留记录**：服务器不保存任何消息。有人点"结束房间"、所有人离开、或 30 分钟没有新消息，房间就结束，内容全部清空。
- **你来控制**：管理后台可以一键开关站点、决定访客能否自己建房、查看和结束房间、封禁捣乱的人。房间里的人也可以随时"禁止新人加入"。
- **两种传输方式**（后台切换）：
  - **WebSocket 中转**（默认）：消息经你 VPS 上的中转服务转发。只要网页能打开就能聊天，最稳定。
  - **P2P 直连**：浏览器之间直接传输，服务器看不到内容；但部分网络之间可能连不上。

```
访客 ──▶ VPS 上的 Caddy ─┬─ /relay ──▶ 中转服务（relay/，只转发不存储）
                         └─ 其他 ───▶ Cloudflare Worker（页面、房间管理、后台）
管理员 ─────────────────────────────▶ Cloudflare Worker /admin
```

## 部署

需要准备：一个 Cloudflare 账号，以及托管在 Cloudflare 上的域名；一台装了 Caddy 的 VPS（只用 P2P 模式可以不要）。

下文用 `yacr.example.com` 表示 Worker 的域名（源站），`chat.example.com` 表示发给朋友的访客地址。

### 第一步：部署 Worker

1. 把本仓库 fork 或推送到你的 GitHub。
2. Cloudflare 控制台 → Workers & Pages → 创建 → 导入这个仓库。名称填 `wrangler.jsonc` 里的 `name`，其他保持默认。
3. Worker → Settings → Domains & Routes → Add Domain，添加 `yacr.example.com`。
4. Worker → Settings → Variables and Secrets，添加 Secret `ADMIN_TOKEN`，值用 `openssl rand -base64 32` 生成，存进密码管理器。
5. 打开 `https://yacr.example.com/admin`，用令牌登录，点"开放站点"。

到这里已经可以用了（P2P 模式）。要让国内访问稳定，继续第二步。

### 第二步：在 VPS 上部署中转

1. 准备访客地址，二选一：
   - 新子域名：在 Cloudflare DNS 添加 `chat.example.com`，指向 VPS 的 IP，**关闭代理（灰云）**。
   - 已有网站的子路径（如 `https://example.com/chat/`）：不用改 DNS。
2. 在 VPS 上运行安装脚本，按提示填写域名、子路径和端口：

   ```bash
   git clone https://github.com/<你>/YACR.git && cd YACR
   sudo bash relay/setup.sh
   ```

3. 把脚本最后打印的配置加进 Caddyfile，然后：

   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl restart caddy
   curl https://chat.example.com/relay/health     # 输出 ok 即可
   ```

4. 回到 Worker → Variables and Secrets，按脚本打印的内容添加 4 项（3 个 Secret、1 个普通变量 `ALLOWED_ORIGINS`）。
5. 打开后台，看到"新房间：WebSocket 中转，服务正常"就完成了。把 `https://chat.example.com/` 发给朋友即可。

以后更新：`git pull` 后重新运行 `sudo bash relay/setup.sh`，上次的选项和密钥都会保留。

### 第三步：收尾（推荐）

- **关闭 workers.dev 入口**：在 `wrangler.jsonc` 加上 `"workers_dev": false` 和 `"preview_urls": false`，推送。
- **保护后台**：Cloudflare Zero Trust → Access，为 `yacr.example.com` 的 `admin*` 和 `api/admin/*` 添加只允许你邮箱的规则。
- **平时关站**：不用的时候在后台关闭站点，要用时再打开；保持"只有你能新建房间"；人到齐后点"禁止新人加入"。

## 常见问题

### 密钥泄露了怎么办？

| 泄露的是 | 处理 |
|---|---|
| `ADMIN_TOKEN` | 在 Worker 里把它改成新值，所有旧登录立即失效。 |
| `RELAY_SECRET` / `PROXY_SECRET` | VPS 上执行 `sudo sed -i '/^RELAY_SECRET=/d;/^YACR_PROXY_SECRET=/d' /etc/yacr-relay.env`，重新运行 setup.sh，`sudo systemctl restart caddy`，再把 Worker 里这两项改成新值。 |
| TURN 的 API Token | 在 Cloudflare Realtime → TURN 删除这个 Key，新建一个，更新 Worker 的 `TURN_KEY_ID`、`TURN_KEY_API_TOKEN`。 |

### TURN 被滥用、流量异常怎么办？

在 Cloudflare Realtime → TURN 删除这个 Key，已发出的凭证随之失效。TURN 只在 P2P 模式下使用、属于可选配置，用 WebSocket 中转可以完全不配。预防方法见上面的"平时关站"。

### 忘了管理员令牌？

在 Worker 里把 `ADMIN_TOKEN` 改成一个新值，用新值登录即可。房间、封禁名单和设置都不受影响。同一 IP 连续输错 5 次会被锁 15 分钟，等一等或换个网络。

### 需要让网站马上下线？

后台点"关闭站点"，所有房间立即结束。进不了后台时，在 Worker → Domains & Routes 移除自定义域名。**不要删除 Worker**，那会连同封禁名单和设置一起删掉。

### Caddy、Worker、中转服务分别管什么？

| | 管什么 |
|---|---|
| **Caddy** | 通路：哪些域名和路径能把请求送到聊天室。只转发，不判断权限。 |
| **Worker 的 `ALLOWED_ORIGINS`** | 权限：只有列在这里的访客地址能使用聊天室，其他地址打开会显示 403。多个地址用逗号分隔，必须带 `https://`，如 `https://chat.example.com,https://example.com`。 |
| **中转服务** | 只认 Worker 签发的票据，自己不需要配置允许的地址。 |

所以：一个地址能打开页面，说明 Caddy 通了；显示 403，就把它加进 `ALLOWED_ORIGINS`。setup.sh 里填的访客域名只用来生成 Caddy 配置和 `RELAY_URL`，不影响权限。

### 页面提示"与中转服务器的连接断了"？

在 VPS 上执行 `sudo journalctl -u yacr-relay -f`，会写明拒绝原因。最常见的原因是 Worker 里的 `RELAY_SECRET` 和 VPS 上的不一致。

### 后台里访客 IP 显示为 `proxy:xxx`？

说明 Caddy 前面还有一层本机转发（比如 sing-box 按 SNI 分流），访客的真实 IP 在那里丢了。聊天不受影响，只是按 IP 的限流和"封 IP"会作用于所有访客。需要让前一层用 PROXY protocol 把真实 IP 传给 Caddy。

### 服务器能看到聊天内容吗？

WebSocket 中转模式下，中转服务技术上能看到（但不存储）；P2P 模式下看不到。

### P2P 模式下有人一直"正在连接"？

对方的网络不允许直连。改用 WebSocket 中转，或者配置 TURN：在 Cloudflare Realtime → TURN 创建 Key，把 ID 和 API Token 添加为 Worker 的 Secret `TURN_KEY_ID`、`TURN_KEY_API_TOKEN`。

### 封禁靠得住吗？

没有账号体系，只能防君子。"封禁"按浏览器标识，清除浏览器数据就能绕过；"封 IP"更难绕过，但会连带同一网络出口下的所有人。

### 在哪里调参数？

空闲多久自动结束、人数上限、文件大小上限、建房频率，都在后台"房间设置"里修改，只对之后新建的房间生效。部署时的默认值在 `wrangler.jsonc` 的 `vars` 里。

### 怎么在本地运行？

```bash
npm install
cp .dev.vars.example .dev.vars   # 修改里面的 ADMIN_TOKEN
npm run dev                      # http://localhost:8787
```
