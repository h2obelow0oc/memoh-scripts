#!/bin/bash
# Memoh 一键部署 ZCode 领取/监控环境
# 全部落 /data（真持久卷），重启不丢
set -u

D=/data
cd "$D" || { echo "无法进入 $D"; exit 1; }

echo "== 1. 检查持久卷 =="
df -h "$D" | tail -1

echo "== 2. 依赖 =="
if [ -d "$D/node_modules/puppeteer-core" ]; then
  echo "puppeteer-core 已存在"
else
  npm i puppeteer-core || { echo "npm 安装失败"; exit 1; }
fi

echo "== 3. chromium / xvfb =="
command -v chromium >/dev/null || { echo "缺 chromium，请先 sudo apt-get install -y chromium"; exit 1; }
command -v Xvfb >/dev/null || { echo "缺 xvfb，请先 sudo apt-get install -y xvfb"; exit 1; }
echo "chromium: $(command -v chromium)"

echo "== 4. 脚本 =="
BASE=https://raw.githubusercontent.com/h2obelow0oc/memoh-scripts/main
for f in zcode-watch.mjs zcode-claim.mjs; do
  curl -fsSL "$BASE/$f" -o "$D/$f" && echo "  $f OK" || echo "  $f 下载失败"
done

echo "== 5. 凭据 =="
if [ -f "$D/zcode.json" ]; then
  echo "zcode.json 已存在"
  node -e "const c=require('/data/zcode.json');console.log('  jwt len',(c.jwt||'').length,'| device_mid',(c.device_mid||'').slice(0,8)+'...','| region',c.region)"
else
  echo "!! 缺 $D/zcode.json"
  echo "   格式: {\"jwt\":\"...\",\"device_mid\":\"...\",\"region\":\"cn\"}"
fi

echo "== 6. Xvfb =="
if pgrep -x Xvfb >/dev/null; then
  echo "Xvfb 在跑: $(pgrep -x Xvfb | head -1)"
else
  Xvfb :99 -screen 0 1920x1080x24 >/dev/null 2>&1 &
  sleep 1
  echo "已启动 Xvfb :99"
fi

echo "== 7. 自检 =="
export DISPLAY=:99
node "$D/zcode-claim.mjs" preview 2>&1 | head -6

echo
echo "完成。下一步："
echo "  cd /data && DISPLAY=:99 node zcode-watch.mjs"
