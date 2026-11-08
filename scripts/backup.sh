#!/usr/bin/env bash
# 備份：pg_dump（自訂格式）＋ uploads 目錄打包，輸出到 backups/<時間戳>/
#   Docker：  bash scripts/backup.sh            （自動用 docker compose exec 進容器 dump）
#   非 Docker：DATABASE_URL=... UPLOAD_DIR=./uploads bash scripts/backup.sh --local
set -euo pipefail
cd "$(dirname "$0")/.."
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="backups/$STAMP"; mkdir -p "$OUT"

if [ "${1:-}" = "--local" ]; then
  : "${DATABASE_URL:?請設定 DATABASE_URL}"
  pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$OUT/db.dump"
  tar -czf "$OUT/uploads.tar.gz" -C "${UPLOAD_DIR:-./uploads}" . 2>/dev/null || echo "（uploads 目錄是空的或不存在，略過）"
else
  set -a; [ -f .env ] && . ./.env; set +a
  docker compose exec -T db pg_dump --format=custom --no-owner -U "${POSTGRES_USER:-qm}" "${POSTGRES_DB:-quotationmaster}" > "$OUT/db.dump"
  docker compose exec -T app tar -czf - -C /app/uploads . > "$OUT/uploads.tar.gz"
fi
echo "已備份到 $OUT（db.dump + uploads.tar.gz）。請把整個資料夾另外存放。"
