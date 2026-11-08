# 架構

## 目錄

```
client/                 前端（React 18 + TypeScript + Vite + Tailwind/shadcn）
  index.html            入口；字型／圖示 CDN 連結；favicon 由設定覆寫
  public/logo-default.svg
  src/App.tsx           路由、側欄、Shell（強制改密碼擋在這裡）
  src/context/          AuthContext（session）、SettingsContext（白牌設定、套 CSS 變數）、QuotationContext（PDF 用型別）
  src/lib/api.ts        所有後端呼叫與型別；PERMISSION 常數
  src/lib/adapters.ts   API 資料 ↔ pdfService 形狀
  src/lib/pdfService.ts 報價單／合約 PDF（html2pdf）；一頁排版、用印
  src/lib/stampImage.ts 印章縮圖去背、抓印章成 data URL
  src/lib/numbering.ts  編號工具（前綴來自設定）
  src/pages/            各頁面（Dashboard、QuotationList/Form、Clients、Products、Contracts、
                        DocumentList、SuspectDocuments、Employees、Leave、Attendance、Users、
                        AuditLog、Settings、ChangePassword、LoginPage）
  src/components/NoPermission.tsx  沒權限時的整頁提示
  src/components/ui/    shadcn 元件
server/                 後端（Express + TypeScript，esbuild 打包成 dist/index.js）
  index.ts              啟動順序：連線檢查 → migrate → seed → routes → 靜態檔／Vite
  migrate.ts            drizzle migrator（啟動時自動套 migrations/）
  seed.ts               設定列、角色、初始管理員、預設公司、合約範本（idempotent）
  seed/contractTemplates.ts
  auth.ts               session、密碼雜湊、爆破防護、requireAuth/requirePermission、角色預設
  routes.ts             全部 REST 路由與錯誤處理
  db.ts                 pg Pool、DATE/NUMERIC 以字串處理、transaction()
  errors.ts             AppError 家族（Validation 400 / Unauthorized 401 / Forbidden 403 / NotFound 404 / Conflict 409）
  static.ts             正式環境靜態檔（跟 vite.ts 分開，避免 bundle 拉進 vite）
  vite.ts               開發模式 Vite middleware
  repositories/         資料層：quotations、clients、contracts、documents、hr、admin、dashboard、settings
shared/schema.ts        Drizzle schema（唯一的資料表定義來源）、狀態機、PERMISSIONS
migrations/             drizzle-kit generate 產生的 SQL（正式環境啟動時套用）
scripts/                setup.sh / setup.ps1（一鍵）、backup.sh / restore.sh、reset-password.mjs、ci-seed.ts、run-tests.sh
tests/                  tsx 直接執行的測試（真 PostgreSQL）
docs/                   文件
```

## 資料流

```
瀏覽器 ──fetch /api/*（same-origin cookie）──▶ Express routes.ts
                                               │  zod 驗證 body → requireAuth → requirePermission
                                               ▼
                                         repositories/*.ts（業務規則、狀態機、稽核）
                                               │  pool.query / transaction()
                                               ▼
                                          PostgreSQL
上傳檔：multer memory → repositories/documents.storeDocument（sha256 去重、驗檔頭）→ 寫到 UPLOAD_DIR
PDF：前端 adapters.toLegacyQuotation(報價, 設定的公司資料) + 印章 data URL → pdfService → html2pdf
```

原則：
- **前端不算數**：金額由伺服器重算，前端只是預覽；狀態轉移、鎖定、權限全在伺服器。
- **DATE 與 NUMERIC 一律字串**（`server/db.ts` 的 type parser）：避免時區位移一天、浮點誤差差一塊。
- **只存相對路徑**：檔案 `storage_key`、logo／印章 `*_path` 都相對於 `UPLOAD_DIR`，換主機不會失效。
- **設定讀取有快取**（`repositories/settings.ts`），寫入後清掉；多副本部署時請改成無快取或加 TTL。

## 權限模型

`users.role` → `roles.permissions[]`（text[]）。`requirePermission(...perms)` 任一符合即可；`system:admin` 可通過所有檢查。內建角色（啟動時 upsert，可在 DB 調整 permissions）：

| 角色 | 權限摘要 |
|------|---------|
| admin | 全部（含 `settings:manage`、`system:admin`） |
| manager | 報價讀寫／核准／作廢／成本、客戶、品項讀寫、員工讀寫、出勤讀與管理、請假讀與核准、使用者讀、稽核讀 |
| sales | 報價讀寫、客戶讀寫、品項讀、打卡、請假申請與讀 |
| accounting | 報價讀＋成本、客戶讀、品項讀、員工讀＋薪資、稽核讀 |
| employee | 打卡、請假申請與讀 |

完整常數在 `shared/schema.ts` 的 `PERMISSIONS`。前端 `useAuth().can()` 只決定顯示，真正把關在伺服器。

特殊規則：`/employees/:id` 沒有 `employee:read` 時只能看自己（`employees.user_id = 自己`）；`/leave-requests`、`/attendance` 沒有核准／管理權時只回自己的；`/documents/:id/download` 逐一檢查檔案掛在的實體類型是否有讀取權，孤兒檔不能下載。

員工與使用者的對應：`employees.user_id`，啟動時與建立員工／使用者時自動依「帳號＝員編」或「email 相同」連起來。

## 資料表一覽

| 表 | 用途 |
|----|------|
| `app_settings` | 系統設定單列（id=1） |
| `companies` | 我方公司主體（`is_default`） |
| `users` / `roles` / `user_sessions` | 帳號、角色權限、session（connect-pg-simple） |
| `clients` / `client_name_history` / `client_contacts` | 客戶主檔、更名時間軸、聯絡人 |
| `products` | 品項庫（成本／售價） |
| `quotations` / `quotation_versions` / `quotation_items` / `quotation_status_history` | 報價本體（編號、履約進度）、版本（狀態、金額、客戶快照）、品項、狀態軌跡 |
| `document_templates` / `contracts` | 合約範本與合約 |
| `documents` / `document_links` | 檔案（sha256、軟刪除）與檔案↔單據關聯（可疑標記） |
| `departments` / `positions` / `employees` | 人事主檔 |
| `attendance` / `attendance_audit` | 出勤與修改留痕 |
| `leave_requests` / `leave_entitlements` | 請假與特休額度 |
| `audit_log` | 全系統稽核 |

狀態機定義（`shared/schema.ts`）：`QUOTATION_TRANSITIONS`、`FULFILLMENT_TRANSITIONS`、`CONTRACT_TRANSITIONS`。
