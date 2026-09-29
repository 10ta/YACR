#!/usr/bin/env bash
# YACR WebSocket 中转服务：安装 / 更新脚本（Debian / Ubuntu，需 root）
#
# 用法（在仓库根目录执行）：
#   sudo DOMAIN=chat.example.com ORIGIN_HOST=o.example.com bash relay/setup.sh
#
# 可选环境变量：
#   PORT=8790                   中转服务监听的本机端口
#   CADDY_PORT=8443             Caddy 站点端口（打印示例配置用）
#   INSTALL_DIR=/opt/yacr-relay 安装目录
#
# 重复执行是安全的：会更新代码并重启服务，已生成的 RELAY_SECRET 保持不变。
set -euo pipefail

DOMAIN="${DOMAIN:-}"
ORIGIN_HOST="${ORIGIN_HOST:-}"
PORT="${PORT:-8790}"
CADDY_PORT="${CADDY_PORT:-8443}"
INSTALL_DIR="${INSTALL_DIR:-/opt/yacr-relay}"
ENV_FILE=/etc/yacr-relay.env
UNIT=/etc/systemd/system/yacr-relay.service
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo）"
[[ -n "$DOMAIN" ]] || die "请设置 DOMAIN（访客域名，如 chat.example.com）"
[[ -n "$ORIGIN_HOST" ]] || die "请设置 ORIGIN_HOST（Cloudflare 上的源站域名，如 o.example.com）"
[[ -f "$SRC_DIR/server.js" ]] || die "找不到 $SRC_DIR/server.js，请在仓库里运行本脚本"

# ---------- 1. Node.js ----------
say "检查 Node.js"
node_ok() { command -v node >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]]; }
if ! node_ok || ! command -v npm >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq nodejs npm
fi
node_ok || die "需要 Node.js 18 或更高版本，当前：$(node -v 2>/dev/null || echo 无)"
NODE_BIN="$(command -v node)"
echo "Node.js $(node -v)（$NODE_BIN）"

# ---------- 2. 代码与依赖 ----------
say "安装到 $INSTALL_DIR"
install -d -m 755 "$INSTALL_DIR"
install -m 644 "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$INSTALL_DIR/"
(cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

# ---------- 3. 配置（密钥只生成一次） ----------
say "写入配置 $ENV_FILE"
SECRET=""
if [[ -f "$ENV_FILE" ]]; then
  SECRET="$(grep -E '^RELAY_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)"
fi
[[ -n "$SECRET" ]] || SECRET="$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
umask 077
cat > "$ENV_FILE" <<CONF
# YACR 中转服务配置（由 setup.sh 生成）
RELAY_SECRET=$SECRET
HOST=127.0.0.1
PORT=$PORT
# 允许连接中转服务的页面来源：访客域名，以及管理员使用的源站域名
ALLOWED_ORIGINS=https://$DOMAIN,https://$ORIGIN_HOST
CONF
chmod 600 "$ENV_FILE"
umask 022

# ---------- 4. systemd ----------
say "安装 systemd 服务"
sed -e "s#@NODE@#$NODE_BIN#g" -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" "$SRC_DIR/yacr-relay.service" > "$UNIT"
systemctl daemon-reload
systemctl enable yacr-relay >/dev/null 2>&1
systemctl restart yacr-relay

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$PORT/relay/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/relay/health" >/dev/null 2>&1 \
  || { journalctl -u yacr-relay -n 30 --no-pager; die "中转服务没有启动成功，见上面的日志"; }
echo "中转服务已运行：http://127.0.0.1:$PORT/relay/health"

# ---------- 5. 后续步骤 ----------
say "接下来（脚本不会自动修改 Caddy 和 Cloudflare）"
cat <<NEXT

1) Caddy：在访客域名的站点里加上 /relay 的转发（完整示例见 relay/Caddyfile.example）：

$DOMAIN:$CADDY_PORT {
	@admin path /admin /admin.html /api/admin/*
	respond @admin 404

	handle /relay* {
		reverse_proxy 127.0.0.1:$PORT
	}

	handle {
		reverse_proxy https://$ORIGIN_HOST {
			header_up Host $ORIGIN_HOST
			header_up X-Yacr-Proxy {\$YACR_PROXY_SECRET}
			header_up X-Yacr-Client-IP {remote_host}
			transport http {
				tls_server_name $ORIGIN_HOST
			}
		}
	}
}

   改完执行：caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
   验证：curl https://$DOMAIN/relay/health   应输出 ok

2) Cloudflare → Worker → Settings → Variables and Secrets，添加两个 Secret：
   RELAY_URL     = wss://$DOMAIN/relay
   RELAY_SECRET  = $SECRET

3) 打开 https://$ORIGIN_HOST/admin，确认"新房间：WebSocket 中转"显示服务正常。

日志：journalctl -u yacr-relay -f
更新：git pull 后重新运行本脚本
NEXT
