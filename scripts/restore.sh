#!/usr/bin/env bash
# 還原：bash scripts/restore.sh backups/<時間戳>  [--local]
# 會清空現有資料庫內容再還原，請先確認。
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=${1:?用法：bash scripts/restore.sh backups/<時間戳> [--local]}
[ -f "$SRC/db.dump" ] || { echo "找不到 $SRC/db.dump"; exit 1; }
read -r -p "將覆蓋目前的資料庫與上傳檔，確定要還原 $SRC 嗎？(yes/no) " ans
[ "$ans" = "yes" ] || exit 1

if [ "${2:-}" = "--local" ]; then
  : "${DATABASE_URL:?請設定 DATABASE_URL}"
  pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$SRC/db.dump"
  [ -f "$SRC/uploads.tar.gz" ] && { mkdir -p "${UPLOAD_DIR:-./uploads}"; tar -xzf "$SRC/uploads.tar.gz" -C "${UPLOAD_DIR:-./uploads}"; }
else
  set -a; [ -f .env ] && . ./.env; set +a
  docker compose stop app
  docker compose exec -T db pg_restore --clean --if-exists --no-owner -U "${POSTGRES_USER:-qm}" -d "${POSTGRES_DB:-quotationmaster}" < "$SRC/db.dump"
  [ -f "$SRC/uploads.tar.gz" ] && docker compose run --rm --no-deps -T app sh -c "tar -xzf - -C /app/uploads" < "$SRC/uploads.tar.gz"
  docker compose start app
fi
echo "還原完成。"
