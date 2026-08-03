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

echo "[install] 3/4 写入 systemd 服务 ..."
mkdir -p "$APP/data"
cat > /etc/systemd/system/ai-news.service <<EOF
[Unit]
Description=AI News MiniProgram API
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP
ExecStart=/usr/local/bin/node $APP/local-server.mjs
Environment=PORT=3000
Environment=SYNC_TOKEN=$SYNC_TOKEN
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
