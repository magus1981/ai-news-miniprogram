#!/bin/bash
# 阿里云服务器一键安装脚本（以 root 运行）
# 前置：publish.ps1 已将项目文件 scp 到 /opt/ai-news，且 data/articles.db 已就位
# 用法：SYNC_TOKEN=xxx bash /opt/ai-news/deploy/install-server.sh
set -e
APP=/opt/ai-news

echo "[install] 1/4 检查 Node.js ..."
if ! command -v node >/dev/null 2>&1; then
  echo "[install] 安装 Node.js 22（npmmirror 国内源）..."
  cd /tmp
  curl -fsSL -o node.tgz https://registry.npmmirror.com/-/binary/node/v22.21.0/node-v22.21.0-linux-x64.tar.xz
  tar -xJf node.tgz -C /usr/local --strip-components=1
  rm -f node.tgz
  cd /
fi
node -v

echo "[install] 2/4 安装依赖 ..."
cd "$APP"
npm install --registry=https://registry.npmmirror.com --omit=dev

echo "[install] 3/4 写入密钥文件与 systemd 服务 ..."
mkdir -p "$APP/data" "$APP/backups"
SECRETS="$APP/secrets.env"

# 密钥落 0600 的 EnvironmentFile，不再写进 unit：
# unit 文件可被 systemctl cat / journal / 任何能读 /etc/systemd 的进程看到，
# 2026-09-14 前 SYNC_TOKEN 一直明文躺在 unit 里，而那一个 token 同时能整库替换、
# 推存档、用国内IP中继——泄露面与爆炸半径都太大。现拆成按能力分域的可选密钥
# （服务端缺省时回落 SYNC_TOKEN，Actions 侧不改也不断链，可逐步替换）。
if [ -n "${SYNC_TOKEN:-}" ]; then
  umask 077
  {
    echo "# AI News 服务密钥（0600，勿入库、勿回显）— 由 install-server.sh 生成 $(date +%F)"
    echo "PORT=${PORT:-3000}"
    echo "SYNC_TOKEN=$SYNC_TOKEN"
    echo "PROXY_MAX_PER_MIN=${PROXY_MAX_PER_MIN:-120}"
    echo "# 以下为可选的能力分域令牌；此行保持注释即未拆分，服务端回落 SYNC_TOKEN"
    if [ -n "${DB_TOKEN:-}" ]; then echo "DB_TOKEN=$DB_TOKEN"; else echo "# DB_TOKEN="; fi
    if [ -n "${ARCHIVE_TOKEN:-}" ]; then echo "ARCHIVE_TOKEN=$ARCHIVE_TOKEN"; else echo "# ARCHIVE_TOKEN="; fi
    if [ -n "${PROXY_TOKEN:-}" ]; then echo "PROXY_TOKEN=$PROXY_TOKEN"; else echo "# PROXY_TOKEN="; fi
  } > "$SECRETS"
  chmod 600 "$SECRETS"
  echo "[install] 密钥文件已写入 $SECRETS (0600)"
elif [ -f "$SECRETS" ]; then
  echo "[install] 未传 SYNC_TOKEN，保留现有 $SECRETS（幂等，不覆盖）"
else
  echo "[install] 警告：无 SYNC_TOKEN 且 $SECRETS 不存在，同步/中继端点将处于关闭态" >&2
  printf 'PORT=3000\n' > "$SECRETS"
  chmod 600 "$SECRETS"
fi

cat > /etc/systemd/system/ai-news.service <<EOF
[Unit]
Description=AI News MiniProgram API
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP
ExecStart=/usr/local/bin/node $APP/local-server.mjs
EnvironmentFile=$SECRETS
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ai-news >/dev/null 2>&1
systemctl restart ai-news
sleep 2

echo "[install] 4/4 验证 ..."
if curl -sf http://localhost:3000/api/dates >/dev/null; then
  echo "[install] OK - API 已在 3000 端口运行"
else
  echo "[install] 警告: API 未响应，查看日志: journalctl -u ai-news -n 50"
  exit 1
fi

echo ""
echo "=========================================="
echo " 部署完成！"
echo "  Phase 1: 安全组放行 3000 端口，小程序 apiBase 用 http://<公网IP>:3000"
echo "  Phase 2: 备案域名 + 证书后，启用 deploy/nginx-ai-news.conf（80/443）"
echo "  常用命令:"
echo "    journalctl -u ai-news -f        # 看日志"
echo "    systemctl restart ai-news       # 重启"
echo "=========================================="
