#!/usr/bin/env bash
# 跑全部測試（需要一個「可以隨便弄髒」的 PostgreSQL，用 DATABASE_URL 指定）。
# 步驟：套 migration → seed 測試前置資料 → 依序跑 tests/*.test.ts。
# CI 與本機都走這支：TZ 固定 UTC，出勤工時的斷言才不會因時區差八小時。
set -euo pipefail
cd "$(dirname "$0")/.."
export TZ=UTC
: "${DATABASE_URL:?請設定 DATABASE_URL（指向可清空的測試資料庫）}"

echo "=== migrate";   npx tsx server/migrate.ts
echo "=== seed";      npx tsx scripts/ci-seed.ts
for t in quotations contracts hr adapter api; do
  echo "=== tests/$t.test.ts"
  npx tsx "tests/$t.test.ts"
done
echo "=== 全部測試通過"
