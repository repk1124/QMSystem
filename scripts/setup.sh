#!/usr/bin/env bash
# 一鍵安裝（Linux / macOS）：檢查 Docker → 產生 .env → 建置並啟動 → 等健康檢查 → 印出網址與帳密提示
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "找不到 docker。請先安裝 Docker Engine（Linux）或 Docker Desktop / OrbStack（macOS），見 docs/DEPLOY.md"; exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose 不可用（需要 Docker Compose v2）。"; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon 沒有在跑。請先啟動 Docker Desktop / OrbStack，或 sudo systemctl start docker"; exit 1
fi

rand() { if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"; else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }

if [ ! -f .env ]; then
  cp .env.example .env
  SECRET=$(rand 32); PGPW=$(rand 16)
  # macOS 的 sed 需要 -i ''，Linux 不需要；用暫存檔最保險
  sed -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PGPW}|" \
      -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://qm:${PGPW}@localhost:5432/quotationmaster|" \
      .env > .env.tmp && mv .env.tmp .env
  chmod 600 .env
  echo "已建立 .env（SESSION_SECRET 與 POSTGRES_PASSWORD 已自動填入隨機值）"
else
  echo ".env 已存在，沿用現有設定"
fi

APP_PORT=$(grep -E '^APP_PORT=' .env | cut -d= -f2); APP_PORT=${APP_PORT:-5000}

# 埠被別的程式占用時先擋下來。macOS 的 AirPlay 接收器預設就占著 5000，
# 瀏覽器會看到一個空白的 403 而不是本系統。
if ! docker compose ps --status running 2>/dev/null | grep -q "app"; then
  if (command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${APP_PORT}" -sTCP:LISTEN >/dev/null 2>&1) \
     || curl -s -m 2 -o /dev/null "http://localhost:${APP_PORT}/" 2>/dev/null; then
    echo "埠 ${APP_PORT} 已被其他程式占用（macOS 常見是 AirPlay 接收器）。"
    echo "請在 .env 把 APP_PORT 改成別的埠（例如 APP_PORT=5080）再重新執行，"
    echo "或到 系統設定 → 一般 → AirDrop 與接力 關閉「AirPlay 接收器」。"
    exit 1
  fi
fi

echo "建置並啟動（第一次需要幾分鐘下載 image 與打包）…"
docker compose up -d --build

echo -n "等待應用程式就緒"
for i in $(seq 1 60); do
  if curl -fs "http://localhost:${APP_PORT}/api/health" >/dev/null 2>&1; then echo " 完成"; break; fi
  echo -n "."; sleep 3
  if [ "$i" = 60 ]; then echo; echo "逾時。請看 docker compose logs app"; exit 1; fi
done

echo
echo "════════════════════════════════════════════════"
echo "  已啟動：http://localhost:${APP_PORT}"
echo
if grep -qE '^INITIAL_ADMIN_PASSWORD=.+' .env; then
  echo "  管理員帳號：$(grep -E '^INITIAL_ADMIN_USERNAME=' .env | cut -d= -f2)（密碼為 .env 的 INITIAL_ADMIN_PASSWORD，首次登入須修改）"
else
  echo "  未設定 INITIAL_ADMIN_PASSWORD，系統已隨機產生一組，請在以下輸出找「初始密碼」："
  echo "    docker compose logs app | grep -A3 初始管理員"
  docker compose logs app 2>/dev/null | grep -A3 "初始管理員" || true
fi
echo "  停止：docker compose down   更新：git pull && docker compose up -d --build"
echo "════════════════════════════════════════════════"
