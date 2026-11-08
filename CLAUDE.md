# QuotationMaster — 給 AI 助手的專案指南

一句話：繁體中文（台灣用語）的自架報價／合約／人事管理系統，白牌化（名稱、公司、logo、印章、編號前綴、主色都在資料庫設定），MIT。

## 目錄地圖

- `client/` 前端 React 18 + TS + Vite + Tailwind/shadcn
  - `src/App.tsx` 路由與側欄；`src/pages/*` 各頁；`src/lib/api.ts` API 客戶端與型別；`src/context/{Auth,Settings}Context.tsx`；`src/lib/pdfService.ts` PDF；`src/lib/adapters.ts` API→PDF 形狀
- `server/` Express + TS（esbuild → `dist/index.js`）
  - `index.ts` 啟動順序（連線 → migrate → seed → routes → static/vite）；`routes.ts` 全部路由；`auth.ts` session／權限／角色預設／初始管理員；`repositories/*.ts` 業務規則與 SQL；`migrate.ts`；`seed.ts`；`static.ts`（正式）／`vite.ts`（開發）
- `shared/schema.ts` Drizzle schema（唯一的表定義）、狀態機、`PERMISSIONS`
- `migrations/` drizzle-kit 產生的 SQL，啟動自動套用
- `tests/` 真 PostgreSQL 的測試；`scripts/` setup／backup／restore／reset-password／ci-seed／run-tests
- `docs/` 文件（DEPLOY、CONFIG、ARCHITECTURE、DEVELOPMENT、TEST_REPORT、AI_GUIDE）

## 指令

`npm run dev`、`npm run check`（tsc）、`npm run build`、`npm start`、`npm run db:generate`、`npm run db:migrate`、`npm run db:push`（只開發）、`npm test`、`npm run test:e2e`（先 build；或 `E2E_BASE_URL=… E2E_ADMIN_PASSWORD=…` 打現成環境）。測試都需要 `DATABASE_URL` 指向可清空的庫，`TZ=UTC`。

## 慣例

1. 註解繁體中文，寫「為什麼」。
2. DATE／NUMERIC 在後端全程是字串（`server/db.ts` type parser）；金額由伺服器計算，前端只預覽。
3. 錯誤類別：`server/errors.ts` 的 `ValidationError`(400)、`UnauthorizedError`(401)、`ForbiddenError`(403)、`NotFoundError`(404)、`ConflictError`(409)。路由用 `wrap()` 包 async，錯誤交給 `routes.ts` 最後的 error handler。
4. 權限檢查：`requireAuth` → `requirePermission(PERMISSIONS.X, …)`（任一符合）；`system:admin` 全通。細粒度（只看自己）在 handler 內用 `req.user.permissions.has()`。
5. 每個寫入 `INSERT INTO audit_log (...)`。
6. Migration：改 `shared/schema.ts` → `npm run db:generate` → 看 SQL → 一起提交；不改已發布的檔。
7. 品牌／公司資料／前綴／印章：後端 `repositories/settings.getSettings()`，前端 `useSettings()`。不寫死。
8. 不碰 `uploads/`；不把 `.env`、密鑰、客戶資料進 repo。
9. 狀態轉移用 `shared/schema.ts` 的 `*_TRANSITIONS` 與 `canTransition*`。
10. repository 回傳欄位用 `AS "camelCase"`（少數舊端點如 `getQuotation` 是 snake_case，前端型別已對應，維持現狀）。

## 常見任務怎麼做

- **加一條 API**：`routes.ts` 加路由（zod → requireAuth → requirePermission → repository），repository 寫 SQL＋audit，`client/src/lib/api.ts` 加函式與型別，`tests/e2e-api.test.ts` 補正向與權限失敗案例（它會檢查 routes.ts 每條路由都被打到；路由數斷言要同步改）。
- **加欄位**：`shared/schema.ts` → `npm run db:generate` → repository 的 SELECT/INSERT → api.ts 型別 → 頁面。
- **加權限**：`PERMISSIONS` 加常數 → `auth.ts` 的 `ROLE_PRESETS` 分配 → `client/src/lib/api.ts` 的 `PERMISSION` 與 `Users.tsx` 的 `PERMISSION_LABEL`。
- **加設定欄位**：`appSettings` 表 → migration → `repositories/settings.ts`（SELECT、updateSettings 驗證、toClientSettings）→ `api.ts` 型別 → `pages/Settings.tsx`。
- **改 PDF**：只動 `pdfService.ts`，資料形狀透過 `adapters.ts`。

## 禁忌

- 不要在前端信任金額或狀態、不要繞過狀態機。
- 不要把 `vite` import 進 `server/index.ts` 的靜態路徑（正式 bundle 會要求安裝 vite）；開發用的是變數路徑動態 import。
- 不要用 `db:push` 取代 migration。
- 不要把任何真實公司／客戶名稱寫進測試或文件，用「範例公司」「王小明」「12345678」「QT」。
