# 設定對照

兩個層級：**環境變數**（部署時決定、重啟才生效）與**設定頁**（存在資料庫 `app_settings`，改完立即生效）。品牌與公司資料一律在設定頁，不用環境變數。

## 環境變數

| 變數 | 必填 | 預設 | 說明 |
|------|------|------|------|
| `DATABASE_URL` | 是（非 Docker） | — | PostgreSQL 連線字串。Docker 版由 `docker-compose.yml` 用 `POSTGRES_*` 自動組出，`.env` 裡的值不會被用到。雲端託管的 DB 請加 `?sslmode=require`（有這個參數才會走 SSL） |
| `SESSION_SECRET` | 是 | — | session 簽章密鑰，至少 32 字元。正式環境（`NODE_ENV=production`）沒設會拒絕啟動；開發環境會每次隨機（重啟就全部登出） |
| `POSTGRES_PASSWORD` | 是（Docker） | — | 內建 PostgreSQL 的密碼，setup 腳本會自動產生 |
| `POSTGRES_USER` / `POSTGRES_DB` | 否 | `qm` / `quotationmaster` | 內建 PostgreSQL 的使用者與資料庫名 |
| `APP_PORT` | 否 | `5000` | Docker 對外埠（主機側） |
| `PORT` | 否 | `5000` | 應用程式監聽埠（容器內固定 5000） |
| `UPLOAD_DIR` | 否 | `./uploads` | 上傳檔根目錄；底下有 `documents/YYYYMM/`（簽回檔）與 `branding/`（logo、印章）。Docker 固定 `/app/uploads` 並掛 volume |
| `PG_POOL_MAX` | 否 | `10` | 連線池上限 |
| `COOKIE_SECURE` | 否 | `auto` | `auto`：走 HTTPS（或代理帶 `X-Forwarded-Proto: https`）才標 Secure；`true`：一律 Secure（必須 HTTPS）；`false`：一律不標 |
| `INITIAL_ADMIN_USERNAME` | 否 | `admin` | 初始管理員帳號 |
| `INITIAL_ADMIN_EMAIL` | 否 | `admin@example.com` | 初始管理員 Email |
| `INITIAL_ADMIN_PASSWORD` | 否 | （隨機） | 至少 12 字元。沒設就隨機產生並印在啟動 log。**只在使用者數為 0 時使用**，之後改這個變數沒有作用 |
| `NODE_ENV` | 否 | — | `production`：送靜態檔、要求 `SESSION_SECRET`；`development`：掛 Vite |
| `TZ` | 否 | 系統 | 影響出勤「工作日」判定與日期顯示，建議設 `Asia/Taipei`（docker compose 可在 `.env` 加） |

### 已移除的變數

舊版的 `GOOGLE_CLIENT_ID`、`VITE_GOOGLE_CLIENT_ID`、`FIREBASE_*`、`REPL_ID` 都已不存在，登入只有帳號密碼。

## 設定頁（系統 → 系統設定）

權限：`settings:manage`（內建 admin 角色有；可在資料庫 `roles.permissions` 加給其他角色）。設定頁（`GET/PUT /api/settings`）只有有權限的人能進；其他登入使用者透過 `GET /api/settings/branding` 讀品牌與我方公司資料（側欄、PDF 要用）。

| 欄位 | 資料表欄位 | 預設 | 用在哪裡 |
|------|-----------|------|---------|
| 系統名稱 | `app_name` | 報價管理系統 | 側欄、登入頁、`<title>`、啟動 log |
| 公司名稱 | `company_name` | 範例公司 | 報價單／合約甲方、側欄副標、預設公司主體（`companies.is_default`）同步 |
| 統一編號 | `company_tax_id` | 12345678 | 報價單抬頭、合約 `{companyTaxId}`、預設公司同步 |
| 公司地址／電話／Email | `company_address` / `company_phone` / `company_email` | 空 | 報價單抬頭、合約變數 `{ourPhone}` `{ourEmail}`、預設公司同步（地址與電話） |
| 公司負責人／代表人 | `company_principal` | 空 | 合約變數 `{principalName}`（甲方代表人）、預設公司 `companies.principal` 同步 |
| Logo | `logo_path` | 無（用 `/logo-default.svg`） | 側欄、登入頁、favicon。PNG／JPG／SVG，2 MB 內；SVG 不可含 script |
| 公司印章 | `stamp_path` | 無 | 報價單簽章欄／合約甲方欄自動用印。上傳前瀏覽器端縮到 440px 寬並去白底 |
| 報價編號前綴 | `quotation_prefix` | QT | `QT-YYYYMMDD-NNN`，1～10 個英數字，自動轉大寫；改了不影響既有編號 |
| 合約編號前綴 | `contract_prefix` | CNT | `CNT-YYYYMMDD-NNN` |
| 主色 | `primary_color` | 空（金黃 `#c9951a`） | `#rrggbb`，套到 CSS 變數 `--primary`、`--ring`、`--accent`；太亮時前景自動改深色 |

API：`GET /api/settings/public`（免登入：名稱、logo 網址、主色）、`GET /api/settings/branding`（登入）、`GET /api/settings`（`settings:manage`）、`PUT /api/settings`、`POST/DELETE /api/settings/logo`、`POST/DELETE /api/settings/stamp`、`GET /api/settings/logo`（免登入）、`GET /api/settings/stamp`（登入）。
