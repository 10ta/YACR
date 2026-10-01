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
# 重复执行是安全的：会更新代码并重启服务，已生成的两个密钥保持不变，上次的选项会作为默认值。
#
# 脚本会生成两个密钥（都保存在 /etc/yacr-relay.env）：
#   RELAY_SECRET  中转服务与 Worker 之间共用，用于签发和校验连接票据
#   PROXY_SECRET  Caddy 与 Worker 之间共用，Caddy 带上它，Worker 才采信反代传来的访客真实 IP
#                 脚本会把它写进 Caddy 的 systemd 配置（环境变量 YACR_PROXY_SECRET），不会重启 Caddy
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

# ---------- 1. Node.js + pm2（NodeSource，自包含）----------
# 替换原来的 "1. Node.js" 整段。幂等：环境已就绪时不联网、不动系统。
#   NODE_MAJOR=24      固定 Node.js 主版本（改它再运行即切换主版本）
#   NODE_UPDATE=1      强制更新：node 升到该主版本最新，pm2 升到最新，并 pm2 update
#   PM2_LOG_MAXSIZE=10M / PM2_LOG_KEEP=5   pm2 日志轮转
say "检查 Node.js / pm2"
NODE_MAJOR="${NODE_MAJOR:-24}"
NODE_UPDATE="${NODE_UPDATE:-0}"
PM2_LOG_MAXSIZE="${PM2_LOG_MAXSIZE:-10M}"
PM2_LOG_KEEP="${PM2_LOG_KEEP:-5}"

_pkgver() { dpkg-query -W -f='${db:Status-Status} ${Version}\n' "$1" 2>/dev/null | awk '$1=="installed"{print $2}' || true; }
_pm2ver() { /usr/bin/node -p "require('/usr/lib/node_modules/pm2/package.json').version" 2>/dev/null || true; }

node_ok() {  # NodeSource 的 nodejs，且主版本符合
  [[ "$(_pkgver nodejs)" == *nodesource* && -x /usr/bin/node && -x /usr/bin/npm ]] \
    && [[ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" == "$NODE_MAJOR" ]]
}
pm2_ok() {   # pm2 已装 + 开机自启 + 日志轮转（无 systemd 的环境不要求自启）
  [[ -x /usr/bin/pm2 && -n "$(_pm2ver)" && -f /etc/logrotate.d/pm2-root ]] \
    && { [[ ! -d /run/systemd/system ]] || systemctl is-enabled pm2-root.service >/dev/null 2>&1; }
}

setup_node_pm2() {
  local f tmp cand cur before after changed=0 need=()
  local src=/etc/apt/sources.list.d/nodesource.sources
  local clean_path="/usr/bin:/usr/sbin:/bin:/sbin:/usr/local/bin:/usr/local/sbin"
  export DEBIAN_FRONTEND=noninteractive

  command -v curl >/dev/null || need+=(curl)
  command -v gpg >/dev/null || need+=(gpg)
  command -v logrotate >/dev/null || need+=(logrotate)
  [[ -e /etc/ssl/certs/ca-certificates.crt ]] || need+=(ca-certificates)
  if ((${#need[@]})); then
    apt-get update -qq && apt-get install -y -qq --no-install-recommends "${need[@]}" || die "安装依赖失败：${need[*]}"
  fi

  # NodeSource 源：先停用旧脚本留下的其他 NodeSource 源（同源不同 Signed-By 会让 apt 报冲突）
  for f in /etc/apt/sources.list.d/*; do
    [[ -f "$f" && "$f" != "$src" ]] || continue
    case "$f" in *.list|*.sources) ;; *) continue ;; esac
    if grep -qs 'deb\.nodesource\.com' "$f"; then mv "$f" "$f.bak.$(date +%Y%m%d%H%M%S)"; echo "已停用旧的 NodeSource 源：$f"; fi
  done
  install -d -m 755 /etc/apt/keyrings
  tmp="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o "$tmp" || die "NodeSource 密钥下载失败"
  [[ -s "$tmp" ]] || die "NodeSource 密钥为空"
  install -m 644 "$tmp" /etc/apt/keyrings/nodesource.gpg; rm -f "$tmp"
  printf '%s\n' "Types: deb" "URIs: https://deb.nodesource.com/node_${NODE_MAJOR}.x" "Suites: nodistro" \
    "Components: main" "Signed-By: /etc/apt/keyrings/nodesource.gpg" >"$src"
  # 同名 nodejs 包以 NodeSource 为准，Debian 自带的不会插进来
  printf '%s\n' "Package: nodejs" "Pin: origin deb.nodesource.com" "Pin-Priority: 600" >/etc/apt/preferences.d/nodejs

  # Node.js（npm 随 nodejs 自带；Debian 的 npm 包与之冲突，先卸掉）
  if [[ "$NODE_UPDATE" == 1 ]] || ! node_ok; then
    if dpkg -s npm >/dev/null 2>&1; then apt-get purge -y -qq npm || die "卸载 Debian 的 npm 失败"; fi
    apt-get update -qq || die "apt-get update 失败"
    cand="$(apt-cache policy nodejs | awk '/Candidate:/{print $2}')"
    [[ "$cand" == *nodesource* ]] || die "nodejs 候选版本不是 NodeSource 的（${cand:-无}），检查 $src"
    cur="$(_pkgver nodejs)"
    if [[ "$cur" != "$cand" ]]; then
      apt-get install -y -qq --no-install-recommends --allow-downgrades "nodejs=${cand}" || die "安装 nodejs ${cand} 失败"
      changed=1
    fi
  fi

  # pm2：npm 全局装到 /usr（/usr/bin/pm2），systemd 和所有 shell 都能直接找到
  before="$(_pm2ver)"
  if [[ "$NODE_UPDATE" == 1 || -z "$before" || ! -x /usr/bin/pm2 ]]; then
    PATH="$clean_path" /usr/bin/npm install -g --prefix /usr --no-fund --no-audit --loglevel=error pm2@latest || die "安装 pm2 失败"
    after="$(_pm2ver)"
    [[ -n "$after" && -x /usr/bin/pm2 ]] || die "pm2 安装后未找到 /usr/bin/pm2"
    [[ "$before" == "$after" ]] || changed=1
  fi

  # 开机自启（官方 systemd 单元 pm2-root.service；PATH 固定为系统路径）
  if [[ -d /run/systemd/system ]]; then
    if ! { systemctl is-enabled pm2-root.service >/dev/null 2>&1 && grep -qs '/usr/lib/node_modules/pm2/bin/pm2' /etc/systemd/system/pm2-root.service; }; then
      PATH="$clean_path" /usr/bin/pm2 startup systemd -u root --hp /root >/dev/null || die "pm2 startup 失败"
    fi
  fi

  # pm2 日志轮转（~/.pm2/logs 不在系统默认的 logrotate 范围内）
  printf '%s\n' "# 由 app 初始化脚本生成" "/root/.pm2/pm2.log /root/.pm2/logs/*.log {" \
    "    rotate ${PM2_LOG_KEEP}" "    maxsize ${PM2_LOG_MAXSIZE}" "    copytruncate" "    compress" \
    "    delaycompress" "    missingok" "    notifempty" "}" >/etc/logrotate.d/pm2-root
  chmod 644 /etc/logrotate.d/pm2-root

  # 更新后让常驻的 pm2 守护进程换上新版 node/pm2（会短暂重启受管应用）
  if [[ "$NODE_UPDATE" == 1 && "$changed" == 1 ]] && pgrep -f 'PM2.*God Daemon' >/dev/null 2>&1; then
    echo "node/pm2 已更新，执行 pm2 update"
    PATH="$clean_path" /usr/bin/pm2 update
  fi
  return 0
}

if [[ "$NODE_UPDATE" == 1 ]] || ! node_ok || ! pm2_ok; then
  setup_node_pm2
  hash -r   # 让当前 shell 重新查找 node / pm2 的路径
fi
node_ok && pm2_ok || die "Node.js ${NODE_MAJOR}.x（NodeSource）/ pm2 未就绪，当前：node $(node -v 2>/dev/null || echo 无) / pm2 $(_pm2ver)"
for _p in /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/pm2 /root/.nvm /root/.volta /root/.fnm; do
  [[ -e "$_p" ]] && echo "提示：发现其他 Node 安装 $_p，可能抢在 /usr/bin 之前，确认不用就清掉" >&2
done; unset _p
NODE_BIN="$(command -v node)"
echo "Node.js $(node -v)（$NODE_BIN） · pm2 $(_pm2ver)"
[[ "$NODE_BIN" == /usr/bin/node ]] || echo "提示：当前 shell 的 node 是 $NODE_BIN，不是 /usr/bin/node" >&2
# 启动应用后记得 pm2 save，重启后 pm2 才会恢复应用：  pm2 start app.js --name myapp && pm2 save

# ---------- 2. 代码与依赖 ----------
say "安装到 $INSTALL_DIR"
install -d -m 755 "$INSTALL_DIR"
install -m 644 "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$INSTALL_DIR/"
(cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

# ---------- 3. 配置（密钥只生成一次） ----------
say "写入配置 $ENV_FILE"
randhex() { openssl rand -hex "$1" 2>/dev/null || node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
# RELAY_SECRET：Worker 签发中转票据、调用中转控制接口用
SECRET="$(prev RELAY_SECRET)"
[[ -n "$SECRET" ]] || SECRET="$(randhex 32)"
# PROXY_SECRET：Caddy 反代时带给 Worker，证明"这是我的反代"，Worker 才采信它传来的访客真实 IP。
# 与 RELAY_SECRET 是两个独立的密钥。优先级：环境变量 > 上次保存的 > Caddy 服务里已配置的 > 新生成
if [[ -z "${PROXY_SECRET:-}" ]]; then
  PROXY_SECRET="$(prev YACR_PROXY_SECRET)"
fi
if [[ -z "$PROXY_SECRET" ]]; then
  PROXY_SECRET="$(systemctl show caddy -p Environment 2>/dev/null | tr ' ' '\n' | sed -n -E 's/^(Environment=)?YACR_PROXY_SECRET=//p' | head -1)"
fi
[[ -n "$PROXY_SECRET" ]] || PROXY_SECRET="$(randhex 24)"
umask 077
cat > "$ENV_FILE" <<CONF
# YACR 中转服务配置（由 setup.sh 生成，重复运行会覆盖，RELAY_SECRET 保持不变）
RELAY_SECRET=$SECRET
HOST=127.0.0.1
PORT=$PORT
# 允许哪些页面来源访问，统一在 Worker 的 ALLOWED_ORIGINS 里配置（中转服务按票据里的来源校验），这里不用设置
# 以下只供 setup.sh 下次运行时作默认值
YACR_DOMAIN=$DOMAIN
YACR_ORIGIN_HOST=$ORIGIN_HOST
YACR_BASE_PATH=$BASE_PATH
YACR_CADDY_PORT=$CADDY_PORT
YACR_PROXY_SECRET=$PROXY_SECRET
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

# ---------- 5. 给 Caddy 设置 YACR_PROXY_SECRET ----------
CADDY_DROPIN=""
if systemctl cat caddy >/dev/null 2>&1; then
  say "给 Caddy 服务设置环境变量 YACR_PROXY_SECRET"
  CADDY_DROPIN=/etc/systemd/system/caddy.service.d/yacr.conf
  install -d -m 755 "$(dirname "$CADDY_DROPIN")"
  umask 077
  printf '# 由 YACR relay/setup.sh 生成\n[Service]\nEnvironment=YACR_PROXY_SECRET=%s\n' "$PROXY_SECRET" > "$CADDY_DROPIN"
  umask 022
  systemctl daemon-reload
  echo "已写入 $CADDY_DROPIN（只加了这一个环境变量，Caddy 需要重启后才生效）"
else
  echo "没有找到 caddy 的 systemd 服务，请自行给 Caddy 设置环境变量 YACR_PROXY_SECRET=$PROXY_SECRET"
fi

# ---------- 6. 打印 Caddy 配置与后续步骤 ----------
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

   Caddy 的环境变量 YACR_PROXY_SECRET 已由脚本写好${CADDY_DROPIN:+（$CADDY_DROPIN）}。
   如果你之前用 systemctl edit 手动加过同名变量，可以删掉那一行，免得两处不一致。
   改完 Caddyfile 执行：caddy validate --config /etc/caddy/Caddyfile && systemctl restart caddy
   验证：curl https://$DOMAIN$BASE_PATH/relay/health    应输出 ok

2) Cloudflare → Worker → Settings → Variables and Secrets，添加：
   类型 Secret：
     RELAY_URL       = wss://$DOMAIN$BASE_PATH/relay
     RELAY_SECRET    = $SECRET
     PROXY_SECRET    = $PROXY_SECRET
   类型 Text（普通变量，方便以后增删；多个用逗号分隔）：
     ALLOWED_ORIGINS = https://$DOMAIN

3) 打开 https://$ORIGIN_HOST/admin，确认"新房间：WebSocket 中转"显示服务正常；
   访客地址：$PUBLIC_BASE/

日志：journalctl -u yacr-relay -f
更新：git pull 后重新运行本脚本（上次的选项会作为默认值）
NEXT
