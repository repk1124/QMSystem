# 開發

## 環境

- Node.js 22+、npm 10+
- PostgreSQL 14+（本機或 `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:17-alpine`）

```bash
npm install
export DATABASE_URL=postgresql://postgres:dev@localhost:5432/qm_dev
export UPLOAD_DIR=./uploads
npm run dev          # Express + Vite HMR，http://localhost:5000
```

開發模式不強制 `SESSION_SECRET`（每次重啟隨機，會登出）。第一次啟動會自動 migrate、建角色與管理員（密碼印在終端機）。macOS 的 5000 被 AirPlay 占用時改 `PORT=5001 npm run dev`。

## 指令

| 指令 | 說明 |
|------|------|
| `npm run dev` | 開發伺服器 |
| `npm run check` | `tsc` 型別檢查（含 client、server、shared；tests 不在內） |
| `npm run build` | `vite build`（→ `dist/public`）＋ `esbuild server/index.ts`（→ `dist/index.js`） |
| `npm start` | 正式模式執行 `dist/index.js` |
| `npm run db:generate` | 依 `shared/schema.ts` 產生新的 SQL migration 到 `migrations/` |
| `npm run db:migrate` | 手動套用 migrations（啟動時也會自動做） |
| `npm run db:push` | **只給開發**：直接把 schema 推到資料庫，不產 migration |
| `npm test` | migrate + seed + 跑 `tests/{quotations,contracts,hr,adapter,api}.test.ts` |
| `npm run test:e2e` | 端對端：起 `dist/index.js`（需先 build）打全部 68 條路由 |

## 測試

所有測試都打**真的 PostgreSQL**，請指向一個可以弄髒的資料庫：

```bash
createdb qm_test
DATABASE_URL=postgresql://localhost:5432/qm_test npm test
npm run build && DATABASE_URL=postgresql://localhost:5432/qm_test npm run test:e2e
```

`npm run test:e2e` 也可以打已經在跑的環境（例如 docker compose）：

```bash
E2E_BASE_URL=http://localhost:5080 E2E_ADMIN_PASSWORD=<初始密碼> npm run test:e2e
```

e2e 每次用隨機後綴建立自己的使用者／客戶／員工，可在同一個資料庫重複跑；結束時把設定還原成預設值。`TZ=UTC` 由 `scripts/run-tests.sh` 設定，直接跑單支測試時請自己加，否則出勤工時的斷言會差八小時。

測試寫法沿用 `ok()/eq()` 小工具，不用測試框架；每支檔案是獨立的 tsx 程式，最後 `process.exit(fail ? 1 : 0)`。

## Migration 流程

1. 改 `shared/schema.ts`
2. `npm run db:generate`（可加 `-- --name 描述`），產生 `migrations/NNNN_xxx.sql` 與 `meta/`
3. 看一眼 SQL（drizzle-kit 不會自動寫資料搬移；需要的話在同一檔手動補 `UPDATE`）
4. 本機 `npm run db:migrate` 或直接 `npm run dev` 讓它自動套
5. 連同 `migrations/` 一起 commit。正式環境 `docker compose up -d --build` 啟動時自動套用

已套用的紀錄在 `drizzle.__drizzle_migrations`。**不要修改已經發布的 migration 檔**，另開新檔。

從「migrations 出現之前」的舊資料庫升級：舊庫已有所有表但沒有 `drizzle.__drizzle_migrations`，啟動會因為 `CREATE TABLE` 衝突失敗。做法：先備份，手動執行 `migrations/0000_init.sql` 裡缺少的部分（`app_settings` 表），再把 `0000_init` 標記為已套用：

```sql
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
-- hash 取 migrations/meta/_journal.json 不需要；migrator 只比對 created_at（journal 的 when）
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('baseline', <journal 裡 0000 的 when>);
```

## 慣例

- 註解用繁體中文，說「為什麼」而不是「做什麼」。
- 新路由：zod 驗證 → `requireAuth` → `requirePermission` → repository；錯誤丟 `errors.ts` 的類別，不要直接 `res.status(…)`。
- repository 回傳給前端的欄位用 `AS "camelCase"`；`quotations.getQuotation` 等少數舊端點是 snake_case，前端型別已對應，不要混。
- 任何寫入都要 `audit_log` 一筆；金額與日期欄位在 SQL 層保持字串。
- 前端品牌文字一律從 `useSettings()` 取，不要寫死。
