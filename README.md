# QuotationMaster — 報價／合約／人事管理系統

給中小企業自架用的內部管理系統：報價單（版本鎖定、狀態機、PDF 匯出與自動用印）、合約（範本變數、簽署鎖定）、客戶與品項主檔、檔案管理（簽回檔去重與掛錯偵測）、人事（員工、出勤留痕、請假與特休額度），全程稽核軌跡。**白牌化**：系統名稱、公司資料、logo、印章、編號前綴、主色都在「系統設定」頁改，不用動程式碼。

> English summary at the bottom.

## 功能

| 模組 | 內容 |
|------|------|
| 報價 | 報價單據＋版本（每次修改開新版本、客戶接受後鎖定）、狀態機（草稿→待核准→已核准→寄出→已讀→接受／拒絕／過期／作廢）、履約進度（交付→驗收→請款→收款→結案）、金額由伺服器計算、成本與毛利依權限遮蔽、PDF 匯出（我方資料與印章取自設定） |
| 合約 | 從已接受的報價套範本產生，`{變數}` 自動填入；簽署後內容鎖定；到期查詢；簽回檔上傳 |
| 客戶／品項 | 客戶主檔（統編驗證與重複偵測、更名時間軸、聯絡人）、品項庫（成本／售價、自動帶入報價） |
| 檔案 | 上傳檔以 sha256 去重，同一份檔掛到多張單據時標為「可疑」待人工確認；只存相對路徑 |
| 人事 | 員工主檔（部門／職位自動建立、薪資獨立權限）、出勤打卡與修改留痕（含事由）、請假申請／核決、特休額度（勞基法 §38 年資計算、遞延與折發） |
| 系統 | 使用者與角色（內建 admin／manager／sales／accounting／employee）、首次登入強制改密碼、登入爆破防護、稽核紀錄、系統設定（白牌化） |

截圖請放在 `docs/screenshots/`（目前為空，歡迎 PR）。

## 快速開始（Docker，含資料庫）

需要 Docker Engine 或 Docker Desktop（Compose v2）。各平台安裝細節見 [docs/DEPLOY.md](docs/DEPLOY.md)。

```bash
git clone https://github.com/<你的帳號>/quotationmaster.git
cd quotationmaster
```

**Linux / macOS**

```bash
bash scripts/setup.sh
```

**Windows（PowerShell）**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

腳本會：檢查 Docker → 從 `.env.example` 產生 `.env`（自動填入隨機 `SESSION_SECRET` 與 `POSTGRES_PASSWORD`）→ `docker compose up -d --build` → 等健康檢查 → 印出網址。第一次啟動會自動建表、建立內建角色、預設公司、合約範本與**初始管理員**。

初始管理員：帳號 `admin`（可用 `INITIAL_ADMIN_USERNAME` 改）。沒有在 `.env` 設 `INITIAL_ADMIN_PASSWORD` 的話，系統會產生一組隨機密碼印在 log：

```bash
docker compose logs app | grep -A3 初始管理員
```

首次登入會強制修改密碼。

> macOS 注意：port 5000 預設被「AirPlay 接收器」占用，瀏覽器會看到空白的 403。請在 `.env` 設 `APP_PORT=5080`（setup 腳本會偵測並提示）。

## 不用 Docker

需要 Node.js 22+ 與 PostgreSQL 14+：

```bash
cp .env.example .env            # 填 DATABASE_URL 與 SESSION_SECRET
npm install
npm run build
npm start                       # 啟動時自動套用 migrations 並建立初始管理員
```

開發模式（Vite HMR）：`npm run dev`，見 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 設定說明

登入後到 **系統 → 系統設定**（需要 `settings:manage` 權限，admin 角色預設有）：

- 系統名稱、我方公司名稱／統編／地址／電話／Email（會印在報價單與合約的甲方欄位，並同步到預設公司主體）
- Logo（側欄、登入頁、瀏覽器分頁圖示）與公司印章（PDF 自動用印；上傳前在瀏覽器端縮圖去背）
- 報價／合約編號前綴（`QT-20260811-001`、`CNT-20260811-001`）
- 主色（套到介面的主要按鈕與焦點色）

環境變數完整對照見 [docs/CONFIG.md](docs/CONFIG.md)。

## 升級

```bash
git pull
docker compose up -d --build     # 新版的 migrations 會在啟動時自動套用
```

非 Docker：`git pull && npm install && npm run build && npm start`。升級前請先備份。

## 備份／還原

```bash
bash scripts/backup.sh                       # → backups/<時間戳>/db.dump + uploads.tar.gz
bash scripts/restore.sh backups/<時間戳>      # 會先詢問確認
```

非 Docker 加 `--local` 並設 `DATABASE_URL`、`UPLOAD_DIR`。上傳的檔案（簽回 PDF、logo、印章）在 `uploads/`（Docker 為 `uploads` volume），**資料庫與 uploads 要一起備份**。

## 常見問題

- **忘記管理員密碼**：`docker compose exec app node scripts/reset-password.mjs admin <新密碼>`（非 Docker：`node scripts/reset-password.mjs admin <新密碼>`）。
- **登入後馬上被登出／登入沒反應**：`SESSION_SECRET` 每次啟動都不同（沒設定），或透過反向代理但沒帶 `X-Forwarded-Proto`。cookie 預設 `COOKIE_SECURE=auto`，走 HTTPS 才會標 Secure；見 docs/DEPLOY.md 的反向代理章節。
- **連不上資料庫**：Docker 版確認 `docker compose ps` 的 db 是 healthy；非 Docker 確認 `DATABASE_URL`，雲端託管的 DB 請加 `?sslmode=require`。
- **離線環境字型／圖示**：`client/index.html` 從 Google Fonts（Noto Sans TC、Inter）與 jsDelivr（remixicon）載入字型與圖示。沒有外網時會退回系統字型、少數圖示不顯示，功能不受影響；PDF 字型同樣退回系統字型。要完全離線請把字型檔放進 `client/public/` 並改 `index.html` 與 `pdfService.ts` 的連結。
- **既有的 PostgreSQL 想拿來用**：複製 `docker-compose.override.example.yml` 為 `docker-compose.override.yml`，覆寫 `DATABASE_URL` 並停用內建 db。

## 文件

- [docs/DEPLOY.md](docs/DEPLOY.md) — 各平台部署、反向代理與 HTTPS、無 Docker 安裝
- [docs/CONFIG.md](docs/CONFIG.md) — 環境變數與設定頁對照
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 目錄、資料流、權限模型、資料表
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — 開發、測試、migration 流程
- [docs/TEST_REPORT.md](docs/TEST_REPORT.md) — 功能 × 測試方式 × 結果
- [docs/AI_GUIDE.md](docs/AI_GUIDE.md) — 給 AI 助手的專案說明 prompt
- [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[CHANGELOG.md](CHANGELOG.md)

## 授權

MIT，見 [LICENSE](LICENSE)。

---

## English

QuotationMaster is a self-hosted quotation / contract / HR management system for small businesses (Traditional Chinese UI). Quotations are versioned and locked once accepted, with a strict status machine, server-side totals, permission-gated cost/margin, and PDF export with the company stamp. Contracts are generated from `{variable}` templates and locked after signing. Files are de-duplicated by sha256 and flagged when attached to multiple documents. HR covers employees, audited attendance edits, leave requests and statutory annual-leave entitlements. Everything is audit-logged.

**White-label**: app name, company details, logo, stamp, document number prefixes and primary colour are stored in the database and edited on the Settings page.

**Quick start** (Docker Compose v2): `bash scripts/setup.sh` (Linux/macOS) or `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1` (Windows). The script generates `.env` with random secrets, builds and starts PostgreSQL + the app, and prints the URL. Migrations and the initial admin user are created automatically on first start; the generated admin password is printed to `docker compose logs app`. Without Docker: Node 22 + PostgreSQL, `npm install && npm run build && npm start`.

Stack: React 18 + TypeScript + Vite + Tailwind/shadcn, Express + TypeScript, Drizzle ORM + PostgreSQL. License: MIT.
