#!/usr/bin/env bash
# Computer MCP relay: run once on a fresh Linux server (Hong Kong or abroad; a mainland server
# needs an ICP filing before ports 80/443 work). It installs Node.js and Computer MCP, gets a free
# HTTPS certificate for this server's IP, starts the relay as a system service and shows the QR
# code for the phone app.
#
#   curl -fsSL <url of this file> | sudo bash
#   curl -fsSL <url of this file> | sudo CMCP_SHARED=1 bash     # serve several people
#
# Optional: CMCP_HOST (public IP or domain), CMCP_PACKAGE (npm spec or tarball URL), CMCP_STAGING=1.
set -euo pipefail

PACKAGE="${CMCP_PACKAGE:-@zhuangzihan/computer-mcp@0.4.0}"
STATE=/var/lib/computer-mcp
NODE_MAJOR=22

say() { printf '\n\033[1;34m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "请用 root 运行：在命令前加 sudo。Run as root."
command -v curl >/dev/null || fail "需要 curl。Install curl first."
command -v systemctl >/dev/null || fail "这台服务器没有 systemd，暂不支持。"

case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac

# Mainland networks often cannot reach nodejs.org or npmjs.org quickly, so fall back to npmmirror.
if curl -fsS -m 8 -o /dev/null https://nodejs.org/dist/index.json; then
  NODE_BASE=https://nodejs.org/dist
  REGISTRY=https://registry.npmjs.org
else
  NODE_BASE=https://npmmirror.com/mirrors/node
  REGISTRY=https://registry.npmmirror.com
fi

# A current Node.js: 22.13 or newer.
have_node() {
  command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
}

if ! have_node; then
  say "安装 Node.js ${NODE_MAJOR}..."
  command -v xz >/dev/null || { (apt-get install -y xz-utils || yum install -y xz || dnf install -y xz) >/dev/null 2>&1 || true; }
  sums=$(curl -fsSL "$NODE_BASE/latest-v${NODE_MAJOR}.x/SHASUMS256.txt")
  file=$(printf '%s\n' "$sums" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-${ARCH}\.tar\.xz$" | head -n1)
  [ -n "$file" ] || fail "找不到 Node.js 安装包。"
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/$file" "$NODE_BASE/latest-v${NODE_MAJOR}.x/$file"
  (cd "$tmp" && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c - >/dev/null) || fail "Node.js 安装包校验失败。"
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf "$tmp/$file" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  ln -sf /opt/node/bin/npm /usr/local/bin/npm
  rm -rf "$tmp"
fi

say "安装 Computer MCP..."
npm install -g --registry "$REGISTRY" --no-fund --no-audit "$PACKAGE" >/dev/null
CLI="$(npm root -g)/@zhuangzihan/computer-mcp/bin/computer-mcp.mjs"
[ -f "$CLI" ] || fail "安装后找不到 computer-mcp。"
NODE="$(command -v node)"
cmcp() { COMPUTER_MCP_HOME="$STATE" "$NODE" "$CLI" "$@"; }

HOST="${CMCP_HOST:-}"
if [ -z "$HOST" ]; then
  for url in https://api.ipify.org https://4.ipw.cn https://ifconfig.me/ip; do
    HOST=$(curl -fsS -4 -m 8 "$url" 2>/dev/null | tr -d '[:space:]') || true
    [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break
    HOST=""
  done
fi
[ -n "$HOST" ] || fail "查不到这台服务器的公网 IP。请用 CMCP_HOST=你的IP 重新运行。"
say "服务器地址：$HOST"

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null && firewall-cmd --reload >/dev/null
fi

setup_args=(relay setup --host "$HOST")
[ "${CMCP_SHARED:-0}" = 1 ] && setup_args+=(--shared)
[ "${CMCP_STAGING:-0}" = 1 ] && setup_args+=(--staging)
mkdir -p "$STATE"
cmcp "${setup_args[@]}"

cat > /etc/systemd/system/computer-mcp-relay.service <<UNIT
[Unit]
Description=Computer MCP relay
After=network-online.target
Wants=network-online.target

[Service]
Environment=COMPUTER_MCP_HOME=$STATE
ExecStart=$NODE $CLI relay run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable computer-mcp-relay >/dev/null 2>&1
systemctl restart computer-mcp-relay

say "申请 HTTPS 证书（通常不到一分钟）..."
ok=0
for _ in $(seq 1 60); do
  if curl -fsSk -m 5 -o /dev/null "https://127.0.0.1/healthz"; then ok=1; break; fi
  sleep 3
done
if [ "$ok" != 1 ]; then
  journalctl -u computer-mcp-relay -n 15 --no-pager || true
  next=app
  [ "${CMCP_SHARED:-0}" = 1 ] && next=invite
  fail "证书还没拿到。最常见的原因：云服务商控制台的防火墙没有放行 80 和 443 端口。放行后服务会自己重试，几分钟后运行：sudo COMPUTER_MCP_HOME=$STATE node $CLI relay $next"
fi

if [ "${CMCP_SHARED:-0}" = 1 ]; then
  say "完成。给每个人生成一个邀请："
  echo "  sudo COMPUTER_MCP_HOME=$STATE node $CLI relay invite"
  cmcp relay invite
else
  say "完成。用手机上的 Computer MCP 扫这个二维码："
  cmcp relay app
fi
