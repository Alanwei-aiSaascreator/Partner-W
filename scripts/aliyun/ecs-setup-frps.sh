#!/usr/bin/env bash
# Partner-W 手机远程入口：阿里云 ECS 一键部署 frps + nginx 反代
#
# 在 ECS 上以 root 执行：
#   sudo -i
#   bash ecs-setup-frps.sh
#   # 指定固定 token（不指定则自动生成，重跑会沿用旧 token）
#   FRP_TOKEN=xxxxxxxx bash ecs-setup-frps.sh
#
# 本脚本做的事（幂等，可重复跑）：
#   1. 安装 frps 到 /usr/local/bin，写 /etc/frp/frps.toml（含 proxyBindAddr=127.0.0.1）
#   2. 注册 systemd 服务 frps（非 root 用户 frp 运行）
#   3. 写 nginx conf.d：connection_upgrade map + rym 子域反代（按 nginx 版本选 http2 写法）
#   4. 证书缺失时先放自签占位证书，保证 nginx 能起；后续 acme.sh 覆盖同名文件即可
#   5. 防火墙放行 7000/tcp（8080 不放行）
#
# 不改动任何既有 server 块；失败时回滚本次新增的 nginx 配置。
set -euo pipefail

FRP_VERSION="${FRP_VERSION:-0.68.0}"
FRP_TOKEN="${FRP_TOKEN:-}"
SUBDOMAIN_HOST="${SUBDOMAIN_HOST:-rym.rongyinghudong.com}"
BIND_PORT="${BIND_PORT:-7000}"
VHOST_PORT="${VHOST_PORT:-8080}"
NGINX_CONF_DIR="${NGINX_CONF_DIR:-/etc/nginx/conf.d}"
CERT_DIR="${CERT_DIR:-/etc/nginx/certs/rym}"

FRPS_CONF="/etc/frp/frps.toml"
MAP_CONF="${NGINX_CONF_DIR}/00-frp-connection-upgrade.conf"
SITE_CONF="${NGINX_CONF_DIR}/rym-frp.conf"
SITE_BAK="${SITE_CONF}.bak-$(date +%Y%m%d%H%M%S)"

log() { printf '\033[32m[frp-setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[frp-setup]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[frp-setup] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行：sudo -i 之后再跑"
command -v nginx >/dev/null 2>&1 || die "未找到 nginx。本脚本只改配置不装 nginx，请先确认 nginx 已安装"
command -v curl >/dev/null 2>&1 || die "未找到 curl，请先安装 curl"

case "$(uname -m)" in
  x86_64|amd64) FRP_ARCH=amd64 ;;
  aarch64|arm64) FRP_ARCH=arm64 ;;
  *) die "不支持的 CPU 架构: $(uname -m)" ;;
esac

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ---------- 1. 安装 frps ----------
if command -v frps >/dev/null 2>&1 && frps -v 2>/dev/null | grep -q "${FRP_VERSION}"; then
  log "已安装 frps ${FRP_VERSION}，跳过下载"
else
  PKG="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"
  for base in \
    "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}" \
    "https://ghfast.top/https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}" \
    "https://gh-proxy.com/https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}"
  do
    log "下载 ${base}/${PKG}"
    if curl -fsSL --connect-timeout 8 --max-time 300 -o "$TMP/$PKG" "${base}/${PKG}"; then
      [ -s "$TMP/$PKG" ] && break
    fi
  done
  [ -s "$TMP/$PKG" ] || die "frp 下载失败：请手动下载 ${PKG} 上传到本机后解压，或用 FRP_VERSION=0.61.0 重试"
  tar -xzf "$TMP/$PKG" -C "$TMP"
  install -m 0755 "$TMP/frp_${FRP_VERSION}_linux_${FRP_ARCH}/frps" /usr/local/bin/frps
  install -m 0755 "$TMP/frp_${FRP_VERSION}_linux_${FRP_ARCH}/frpc" /usr/local/bin/frpc
  log "frps 已装到 /usr/local/bin/frps（$(frps -v)）"
fi

# ---------- 2. 运行用户 + frps.toml ----------
getent group frp >/dev/null || groupadd --system frp
id -u frp >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --gid frp frp

if [ -z "$FRP_TOKEN" ] && [ -f "$FRPS_CONF" ]; then
  FRP_TOKEN="$(sed -n 's/^auth\.token[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' "$FRPS_CONF" | head -n1)"
fi
[ -n "$FRP_TOKEN" ] || FRP_TOKEN="$(openssl rand -hex 24)"

install -d -o root -g frp -m 0750 /etc/frp
cat > "$FRPS_CONF" <<EOF
# Partner-W frp 服务端（由 scripts/aliyun/ecs-setup-frps.sh 生成）
bindAddr = "0.0.0.0"
bindPort = ${BIND_PORT}

# 关键：frp 为代理打开的监听器（含 vhostHTTP）只绑回环，公网只能经过 nginx
proxyBindAddr = "127.0.0.1"
vhostHTTPPort = ${VHOST_PORT}
subDomainHost = "${SUBDOMAIN_HOST}"

auth.method = "token"
auth.token = "${FRP_TOKEN}"

# 拒绝明文控制连接（frpc >= 0.50 默认开 TLS）
transport.tls.force = true

# 只允许客户端申请 7000，堵掉任意 tcp/udp 端口映射
allowPorts = [{ start = ${BIND_PORT}, end = ${BIND_PORT} }]
EOF
chown root:frp "$FRPS_CONF"
chmod 0640 "$FRPS_CONF"

frps verify -c "$FRPS_CONF" >/dev/null || die "frps.toml 语法校验失败，请检查 $FRPS_CONF"

cat > /etc/systemd/system/frps.service <<'EOF'
[Unit]
Description=frp server (partner-w mobile remote access)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=frp
Group=frp
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=on-failure
RestartSec=5s
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable frps >/dev/null 2>&1 || true
systemctl restart frps
sleep 2
systemctl is-active --quiet frps || {
  journalctl -u frps -n 40 --no-pager || true
  die "frps 启动失败，日志见上"
}
log "frps 已启动"

# ---------- 3. 证书占位（有真证书则跳过） ----------
install -d -m 0755 "$CERT_DIR"
if [ ! -s "$CERT_DIR/fullchain.pem" ] || [ ! -s "$CERT_DIR/privkey.pem" ]; then
  warn "未找到证书，先放 30 天自签占位证书（acme.sh 签发后覆盖同名文件即可）"
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 30 \
    -keyout "$CERT_DIR/privkey.pem" -out "$CERT_DIR/fullchain.pem" \
    -subj "/CN=${SUBDOMAIN_HOST}" \
    -addext "subjectAltName=DNS:*.${SUBDOMAIN_HOST},DNS:${SUBDOMAIN_HOST}" >/dev/null 2>&1
fi

# ---------- 4. nginx 配置 ----------
# nginx < 1.25.1 不支持 "http2 on;"
NGINX_VER="$(nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9][0-9.]*\).*#\1#p')"
NG_MAJOR="${NGINX_VER%%.*}"; NG_REST="${NGINX_VER#*.}"; NG_MINOR="${NG_REST%%.*}"
if [ "${NG_MAJOR:-0}" -gt 1 ] || { [ "${NG_MAJOR:-0}" -eq 1 ] && [ "${NG_MINOR:-0}" -ge 25 ]; }; then
  LISTEN_LINE="    listen 443 ssl;"
  HTTP2_LINE="    http2 on;"
  log "nginx ${NGINX_VER}：使用 http2 on;"
else
  LISTEN_LINE="    listen 443 ssl http2;"
  HTTP2_LINE=""
  log "nginx ${NGINX_VER}：使用 listen 443 ssl http2;（旧写法）"
fi

if grep -rqs 'map[[:space:]]\+\$http_upgrade[[:space:]]\+\$connection_upgrade' /etc/nginx \
   --include='*.conf' --exclude="$(basename "$MAP_CONF")"; then
  log "已有 connection_upgrade map，跳过"
else
  cat > "$MAP_CONF" <<'EOF'
# 由 ecs-setup-frps.sh 生成：WebSocket 反代需要
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF
  log "已写 $MAP_CONF"
fi

cat > "$SITE_CONF" <<EOF
# Partner-W手机远程入口：<short8>.${SUBDOMAIN_HOST} -> 127.0.0.1:${VHOST_PORT} (frps vhost)
# 由 scripts/aliyun/ecs-setup-frps.sh 生成，只处理 rym 子域
server {
    listen 80;
    server_name ~^(?<dev>[a-z0-9]{8})\.rym\.rongyinghudong\.com\$;
    return 301 https://\$host\$request_uri;
}

server {
${LISTEN_LINE}
${HTTP2_LINE}
    server_name ~^(?<dev>[a-z0-9]{8})\.rym\.rongyinghudong\.com\$;

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:RYMSSL:10m;
    ssl_session_timeout 1h;

    client_max_body_size 32m;
    proxy_request_buffering off;

    location / {
        proxy_pass http://127.0.0.1:${VHOST_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        proxy_buffering off;
    }
}
EOF

if ! nginx -t; then
  mv -f "$SITE_CONF" "$SITE_BAK"
  nginx -t >/dev/null 2>&1 || true
  die "nginx 配置校验失败，已回滚本次新增的 $(basename "$SITE_CONF")（备份：$SITE_BAK）"
fi
systemctl reload nginx
log "nginx 已 reload"

# ---------- 5. 防火墙：只开 7000 ----------
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port=${BIND_PORT}/tcp >/dev/null
  firewall-cmd --reload >/dev/null
  log "firewalld 已放行 ${BIND_PORT}/tcp"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow ${BIND_PORT}/tcp >/dev/null
  log "ufw 已放行 ${BIND_PORT}/tcp"
else
  warn "未检测到启用中的 firewalld/ufw，跳过主机防火墙"
fi

# ---------- 6. 自检 ----------
sleep 1
echo
log "========== 部署结果 =========="
ss -lntp 2>/dev/null | grep -E ":${BIND_PORT}|:${VHOST_PORT}" || warn "端口未监听，请查 journalctl -u frps"
echo
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${VHOST_PORT}/" || true)"
log "本机访问 frps vhost 返回 HTTP ${CODE}（404 = frps 在跑但没有 frpc 上线，正常）"
echo
log "frps 版本：$(frps -v)"
log "frp token：${FRP_TOKEN}"
log "（这个 token 要填进桌面壳下发给客户机的 frpc.toml，与后端设备 token 不是一回事）"
echo
warn "还差 3 件事（脚本管不到）："
warn "  1) 安全组放行 ${BIND_PORT}/tcp（0.0.0.0/0），不要放行 ${VHOST_PORT}"
warn "  2) 云解析加 *.rym A 记录 -> 本机公网 IP（注意是 *.rym，不是裸 *）"
warn "  3) 用 RAM 子账号签 *.rym 通配证书：bash issue-wildcard-cert.sh"
