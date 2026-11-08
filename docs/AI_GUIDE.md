# 給 AI 助手的專案說明

把下面這段貼給 Claude／ChatGPT／Cursor／Copilot Chat，再描述你要做的事。專案內的 `CLAUDE.md` 與 `AGENTS.md` 是同一份更完整的版本，支援這些檔案的工具會自動讀。

```
你正在協助開發 QuotationMaster：一個繁體中文（台灣用語）的自架報價／合約／人事管理系統，MIT 授權。

技術：React 18 + TypeScript + Vite + Tailwind/shadcn（client/）、Express + TypeScript（server/，esbuild 打包成 dist/index.js）、Drizzle ORM + PostgreSQL（shared/schema.ts 是唯一的資料表定義）、Node 22、ESM。
指令：npm run dev（開發）、npm run check（tsc）、npm run build、npm start、npm run db:generate（產 migration）、npm test、npm run test:e2e。

目錄：server/routes.ts 全部 REST 路由；server/repositories/*.ts 業務規則與 SQL；server/auth.ts 認證與權限；server/migrate.ts + migrations/ 啟動時自動建表；server/seed.ts 預設資料；client/src/lib/api.ts 前端 API 客戶端與型別；client/src/pages/ 各頁；client/src/context/SettingsContext.tsx 白牌設定。

慣例（必須遵守）：
- 註解用繁體中文，寫「為什麼」。
- DATE 與 NUMERIC 欄位在整個後端都是字串，不要轉成 Date 或 number 存回去；金額由伺服器算。
- 錯誤用 server/errors.ts 的 ValidationError(400)/UnauthorizedError(401)/ForbiddenError(403)/NotFoundError(404)/ConflictError(409)，不要手寫 res.status。
- 路由順序：zod 驗證 → requireAuth → requirePermission(PERMISSIONS.X) → repository。權限常數在 shared/schema.ts 的 PERMISSIONS；system:admin 通過所有檢查。
- 任何寫入都插一筆 audit_log。
- 改 schema 的流程：改 shared/schema.ts → npm run db:generate → 檢查 SQL → 連 migrations/ 一起提交。不要改已發布的 migration。
- 品牌／公司資料／編號前綴／印章都從系統設定（app_settings、useSettings()）讀，不准寫死公司名稱。
- 不要碰 uploads/ 目錄的內容、不要把 .env 或任何密鑰寫進 repo。
- 狀態轉移以 shared/schema.ts 的 *_TRANSITIONS 為準，不要繞過。

測試：tests/*.test.ts 用真的 PostgreSQL（DATABASE_URL 指向可清空的庫），ok()/eq() 小工具，tsx 直接執行。新功能請補測試，路由請在 tests/e2e-api.test.ts 補正向與權限失敗案例（它會檢查 routes.ts 的每條路由都被打到）。
```
