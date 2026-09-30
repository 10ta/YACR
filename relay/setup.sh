#!/usr/bin/env bash
# YACR WebSocket 中转服务：安装 / 更新脚本（Debian / Ubuntu，需 root）
#
# 交互式运行（在仓库根目录）：
#   sudo bash relay/setup.sh
# 脚本会依次询问：访客域名、源站域名、子路径、中转服务端口、Caddy 端口，回车使用默认值。
#
# 也可以用环境变量直接给出，跳过对应的提问（适合重复执行）：
#   sudo DOMAIN=example.com ORIGIN_HOST=yacr.example.net BASE_PATH=/chat PORT=8790 CADDY_PORT=8443 bash relay/setup.sh
#
#   DOMAIN       访客打开的域名（解析到这台 VPS，Cloudflare 灰云）
#   ORIGIN_HOST  Cloudflare 上绑定到 Worker 的自定义域名
#   BASE_PATH    挂载的子路径，如 /chat；留空表示整个域名都给聊天室用
#   PORT         中转服务在本机监听的端口（只监听 127.0.0.1）
#   CADDY_PORT   访客域名在 Caddy 里的站点端口（443 被 sing-box 按 SNI 分流时通常是 8443）
#
# 重复执行是安全的：会更新代码并重启服务，已生成的 RELAY_SECRET 保持不变，上次的选项会作为默认值。
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/yacr-relay}"
ENV_FILE=/etc/yacr-relay.env
UNIT=/etc/systemd/system/yacr-relay.service
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31m错误：%s\033[0m\n' "$*" >&2; exit 1; }
prev() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo）"
[[ -f "$SRC_DIR/server.js" ]] || die "找不到 $SRC_DIR/server.js，请在仓库里运行本脚本"

# 提问：变量已由环境给出就不问；否则显示默认值，回车采用
ask() {
  local var="$1" prompt="$2" def="$3" val
  if [[ -n "${!var:-}" ]]; then return; fi
  if [[ -t 0 ]]; then
    read -rp "$prompt${def:+ [$def]}：" val || true
  fi
  printf -v "$var" '%s' "${val:-$def}"
}

say "基本信息（回车使用方括号里的默认值）"
ask DOMAIN "访客域名（解析到这台 VPS）" "$(prev YACR_DOMAIN)"
ask ORIGIN_HOST "源站域名（Cloudflare 上绑定到 Worker 的域名）" "$(prev YACR_ORIGIN_HOST)"
BASE_DEFAULT="$(prev YACR_BASE_PATH)"
# BASE_PATH 允许显式设为空（整个域名）：用 BASE_PATH= 传入时不再提问
if [[ -z "${BASE_PATH+x}" ]]; then
  if [[ -t 0 ]]; then
    read -rp "子路径，如 /chat；直接回车表示不用子路径、整个域名给聊天室${BASE_DEFAULT:+ [当前 $BASE_DEFAULT，输入 - 表示不用]}：" BASE_PATH || true
    [[ -z "$BASE_PATH" ]] && BASE_PATH="$BASE_DEFAULT"
    [[ "$BASE_PATH" == "-" ]] && BASE_PATH=""
  else
    BASE_PATH="$BASE_DEFAULT"
  fi
fi
ask PORT "中转服务本机端口" "$(prev PORT)"
PORT="${PORT:-8790}"
ask CADDY_PORT "Caddy 站点端口" "$(prev YACR_CADDY_PORT)"
CADDY_PORT="${CADDY_PORT:-8443}"

# ---------- 校验 ----------
DOMAIN="${DOMAIN,,}"
ORIGIN_HOST="${ORIGIN_HOST,,}"
host_re='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
[[ "$DOMAIN" =~ $host_re ]] || die "访客域名格式不对：'$DOMAIN'"
[[ "$ORIGIN_HOST" =~ $host_re ]] || die "源站域名格式不对：'$ORIGIN_HOST'"
[[ "$DOMAIN" != "$ORIGIN_HOST" ]] || die "访客域名和源站域名不能相同"
if [[ -n "$BASE_PATH" ]]; then
  BASE_PATH="/${BASE_PATH#/}"
  BASE_PATH="${BASE_PATH%/}"
  [[ "$BASE_PATH" =~ ^(/[A-Za-z0-9._~-]+)+$ ]] || die "子路径只能包含字母、数字和 . _ ~ -，如 /chat"
  case "$BASE_PATH" in /api|/api/*|/ws|/ws/*|/relay|/relay/*|/admin*) die "子路径不能用 $BASE_PATH（与内部路径冲突）" ;; esac
fi
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1024 && PORT <= 65535)) || die "中转服务端口应在 1024–65535 之间：$PORT"
[[ "$CADDY_PORT" =~ ^[0-9]+$ ]] && ((CADDY_PORT >= 1 && CADDY_PORT <= 65535)) || die "Caddy 端口不对：$CADDY_PORT"
if command -v ss >/dev/null && ss -Hltn "sport = :$PORT" | grep -q . && [[ "$(prev PORT)" != "$PORT" ]]; then
  die "本机端口 $PORT 已被占用，换一个"
fi

PUBLIC_BASE="https://$DOMAIN${BASE_PATH}"
echo
echo "  访客地址：   $PUBLIC_BASE/"
echo "  源站域名：   https://$ORIGIN_HOST"
echo "  中转服务：   127.0.0.1:$PORT（对外为 $PUBLIC_BASE/relay）"
echo "  Caddy 站点： $DOMAIN:$CADDY_PORT"
if [[ -t 0 ]]; then
  read -rp "确认无误？[Y/n] " ok || true
  [[ -z "${ok:-}" || "${ok,,}" == y* ]] || die "已取消"
fi

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
SECRET="$(prev RELAY_SECRET)"
[[ -n "$SECRET" ]] || SECRET="$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
umask 077
cat > "$ENV_FILE" <<CONF
# YACR 中转服务配置（由 setup.sh 生成，重复运行会覆盖，RELAY_SECRET 保持不变）
RELAY_SECRET=$SECRET
HOST=127.0.0.1
PORT=$PORT
# 允许连接中转服务的页面来源：访客域名，以及管理员使用的源站域名
ALLOWED_ORIGINS=https://$DOMAIN,https://$ORIGIN_HOST
# 以下只供 setup.sh 下次运行时作默认值
YACR_DOMAIN=$DOMAIN
YACR_ORIGIN_HOST=$ORIGIN_HOST
YACR_BASE_PATH=$BASE_PATH
YACR_CADDY_PORT=$CADDY_PORT
CONF
chmod 600 "$ENV_FILE"
umask 022

# ---------- 4. systemd ----------
say "安装 systemd 服务 yacr-relay"
sed -e "s#@NODE@#$NODE_BIN#g" -e "s#@INSTALL_DIR@#$INSTALL_DIR#g" "$SRC_DIR/yacr-relay.service" > "$UNIT"
systemctl daemon-reload
systemctl enable yacr-relay >/dev/null 2>&1
systemctl restart yacr-relay

for _ in $(seq 1 10); do
  curl -fsS "http://127.0.0.1:$PORT/relay/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/relay/health" >/dev/null 2>&1 \
  || { journalctl -u yacr-relay -n 30 --no-pager; die "中转服务没有启动成功，见上面的日志"; }
echo "中转服务已运行：http://127.0.0.1:$PORT/relay/health"

# ---------- 5. 打印 Caddy 配置与后续步骤 ----------
PROXY_BLOCK="$(cat <<BLOCK
	# 后台只从源站域名访问。注意要用 handle 包起来：respond 在 Caddy 里排在 handle 之后，单独写不会生效
	@yacr_admin path /admin /admin.html /api/admin/*
	handle @yacr_admin {
		respond 404
	}

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
BLOCK
)"

say "接下来（脚本不会自动修改 Caddy 和 Cloudflare）"
echo
if [[ -z "$BASE_PATH" ]]; then
  echo "1) Caddy：新增一个站点（整个域名给聊天室）："
  echo
  echo "$DOMAIN:$CADDY_PORT {"
  echo "$PROXY_BLOCK"
  echo "}"
else
  echo "1) Caddy：在 $DOMAIN 已有的站点块里加入下面这段（放在其他 handle 之前）："
  echo
  echo "	redir $BASE_PATH $BASE_PATH/ 308"
  echo "	handle_path $BASE_PATH/* {"
  echo "$PROXY_BLOCK" | sed 's/^./\t&/'
  echo "	}"
fi
cat <<NEXT

   Caddy 需要环境变量 YACR_PROXY_SECRET（和 Worker 的 PROXY_SECRET 相同）：
     systemctl edit caddy      # 加入：[Service] 换行 Environment=YACR_PROXY_SECRET=<值>
   改完执行：caddy validate --config /etc/caddy/Caddyfile && systemctl restart caddy
   验证：curl https://$DOMAIN$BASE_PATH/relay/health    应输出 ok

2) Cloudflare → Worker → Settings → Variables and Secrets，添加 Secret：
   RELAY_URL       = wss://$DOMAIN$BASE_PATH/relay
   RELAY_SECRET    = $SECRET
   ALLOWED_ORIGINS = https://$DOMAIN
   PROXY_SECRET    = 与 Caddy 的 YACR_PROXY_SECRET 相同

3) 打开 https://$ORIGIN_HOST/admin，确认"新房间：WebSocket 中转"显示服务正常；
   访客地址：$PUBLIC_BASE/

日志：journalctl -u yacr-relay -f
更新：git pull 后重新运行本脚本（上次的选项会作为默认值）
NEXT
