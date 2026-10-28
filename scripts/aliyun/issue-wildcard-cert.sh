#!/usr/bin/env bash
# Partner-W：用 acme.sh + 阿里云 DNS API 签发/续期 *.rym.rongyinghudong.com 通配证书
#
# 前提：Linux 上执行（ECS 本身或任意有 DNS API 权限的机器），且证书要落到
#      nginx 读取的目录（默认 /etc/nginx/certs/rym，与 ecs-setup-frps.sh 一致）。
#
# 用法（在 ECS 上，root）：
#   export ALI_ACCESS_KEY_ID=LTAI...
#   export ALI_ACCESS_KEY_SECRET=...
#   bash issue-wildcard-cert.sh
#
# 说明：
#   - acme.sh 的阿里云插件读的是 Ali_Key / Ali_Secret，本脚本自动从
#     ALI_ACCESS_KEY_ID / ALI_ACCESS_KEY_SECRET 映射，不需要你改密钥名。
#   - DNS-01 校验会临时在 _acme-challenge.rym 加 TXT，签完自动删。
#   - 续期由 acme.sh 自己装 cron（每天跑），续期后自动 nginx -s reload。
set -euo pipefail

DOMAIN="${DOMAIN:-rym.rongyinghudong.com}"
CERT_DIR="${CERT_DIR:-/etc/nginx/certs/rym}"
ACME_EMAIL="${ACME_EMAIL:-ops@rongyinghudong.com}"

log() { printf '\033[32m[acme]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[acme] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 执行（需要写 ${CERT_DIR} 和 reload nginx）"
: "${ALI_ACCESS_KEY_ID:?请先 export ALI_ACCESS_KEY_ID=（RAM 子账号 AccessKey ID）}"
: "${ALI_ACCESS_KEY_SECRET:?请先 export ALI_ACCESS_KEY_SECRET=（RAM 子账号 AccessKey Secret）}"

export Ali_Key="$ALI_ACCESS_KEY_ID"
export Ali_Secret="$ALI_ACCESS_KEY_SECRET"

ACME="$HOME/.acme.sh/acme.sh"
if [ ! -x "$ACME" ]; then
  log "安装 acme.sh"
  command -v curl >/dev/null || die "缺少 curl"
  curl -fsSL https://get.acme.sh | sh -s -- "email=${ACME_EMAIL}"
  ACME="$HOME/.acme.sh/acme.sh"
fi
[ -x "$ACME" ] || die "acme.sh 安装失败"

log "默认 CA 设为 Let's Encrypt（通配证书 + DNS-01）"
"$ACME" --set-default-ca --server letsencrypt >/dev/null

install -d -m 0755 "$CERT_DIR"

log "签发 *.${DOMAIN} 与 ${DOMAIN}（RSA 2048，兼容老安卓）"
"$ACME" --issue --dns dns_ali -d "*.${DOMAIN}" -d "${DOMAIN}" --keylength 2048

log "安装证书到 ${CERT_DIR} 并设置续期后 reload"
"$ACME" --install-cert -d "*.${DOMAIN}" \
  --key-file       "${CERT_DIR}/privkey.pem" \
  --fullchain-file "${CERT_DIR}/fullchain.pem" \
  --reloadcmd      "systemctl reload nginx" \
  || "$ACME" --install-cert -d "${DOMAIN}" \
       --key-file       "${CERT_DIR}/privkey.pem" \
       --fullchain-file "${CERT_DIR}/fullchain.pem" \
       --reloadcmd      "systemctl reload nginx"

echo
log "========== 结果 =========="
openssl x509 -in "${CERT_DIR}/fullchain.pem" -noout -subject -issuer -dates -ext subjectAltName
echo
log "续期定时任务："
crontab -l 2>/dev/null | grep -i acme || echo "  （未找到 cron 条目，检查 cron 服务或手动加）"
echo
log "验证 DNS-01 是否真的生效："
log "  curl -sI https://test1234.${DOMAIN}/ | head -3   # 期望 404（frps 在跑、无 frpc 上线）"
