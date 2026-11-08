# 測試報告（1.0.0 開源初版）

執行日期：2026-11-08（最後一輪含瀏覽器實測後的四項修正）。環境：macOS（Apple Silicon）、Node 26（CI 用 22）、PostgreSQL 15（本機）與 17（Docker）、Docker（Colima arm64，2 CPU／3 GB）。

## 執行摘要

| 項目 | 指令 | 結果 |
|------|------|------|
| 型別檢查 | `npm run check` | 通過（0 錯誤） |
| 建置 | `npm run build` | 通過；`dist/index.js` 198 KB，不含 `vite` import；前端 bundle 無原公司字樣 |
| 單元／API 測試 | `DATABASE_URL=… npm test`（空庫） | quotations 61／contracts 42／hr 52／adapter 30／api 83，全部通過，失敗 0 |
| 端對端 API（本機 `dist/index.js`） | `npm run test:e2e` | 通過 327／失敗 0，69 條路由全部打到 |
| 端對端 API（Docker 環境，重建後含 `0001_company_principal` migration） | `E2E_BASE_URL=http://localhost:5080 E2E_ADMIN_PASSWORD=… npm run test:e2e` | 通過 327／失敗 0；同一資料庫連跑兩次都通過 |
| 瀏覽器逐頁實測（Docker 版 localhost:5080） | 人工（Chrome） | 見下方「瀏覽器實測」；發現 4 項已修正並重新驗證 |
| Docker 一鍵 | `bash scripts/setup.sh` | image 建置成功（含 2 GB heap 設定）、`db`/`app` 皆 healthy、`/api/health` 200；偵測到 macOS AirPlay 占用 5000 → 改 `APP_PORT=5080` |
| 容器內自動建表 | `docker compose logs app` | `[db] migrations 已套用（/app/migrations）`、角色／管理員／預設公司／範本建立；`drizzle.__drizzle_migrations` 2 筆（`0000_init`、`0001_company_principal`） |
| uploads volume | 上傳 logo／簽回檔後 `ls /app/uploads` | `branding/`、`documents/YYYYMM/` 以 `node`(uid 1000) 寫入成功 |
| 重啟保留資料 | `docker compose restart app` | 設定、logo（HTTP 200）、使用者（15 筆）都在；未重複建立管理員 |
| 開發模式 | `npm run dev` | 啟動、`/api/health` 200、index 由 Vite 送出 |
| Dockerfile 自檢（hadolint 風格） | 人工 | 固定 tag `node:22-alpine`、非 root `USER node`、`HEALTHCHECK`、`EXPOSE 5000`、`npm ci --omit=dev`、無 `latest`、無 `apt-get` |
| 殘留字樣掃描 | `grep -ri 衡心\|張文彥\|82969999\|HENG\|cardiometrics\|replit\|firebase` | 原始碼與 dist 皆 0 筆（Google Fonts 網址除外） |

## 功能 × 測試方式 × 結果

測試方式代號：**E2E** = `tests/e2e-api.test.ts`（真 Express＋真 PostgreSQL，本機與 Docker 各跑一次）、**API** = `tests/api.test.ts`、**Q/C/H/A** = quotations／contracts／hr／adapter 資料層測試、**手動** = curl 或命令列操作、**未測** = 需瀏覽器或未涵蓋。

### 系統與啟動

| 功能 | 測試方式 | 結果 |
|------|---------|------|
| 啟動時自動套用 migrations（空庫建 25 張表） | 手動（本機、Docker）、E2E（自起伺服器） | 通過 |
| 重複啟動不重跑 migration、不重建資料 | 手動（restart 容器） | 通過 |
| 初始管理員：使用者數 0 時建立、未設密碼時隨機並印 log、首次登入須改密碼 | 手動（log）、E2E §1/§3 | 通過 |
| 設定 `INITIAL_ADMIN_PASSWORD` 時用指定密碼 | E2E 自起伺服器模式 | 通過 |
| 預設公司（companies 空時建立）、預設合約範本（不覆蓋修改） | 手動、C §3、E2E §14 | 通過 |
| `GET /api/health`（DB 正常 200） | E2E §0、Docker HEALTHCHECK | 通過 |
| DB 掛掉時 health 回 503 | 未測 | 未測：需人為中斷資料庫 |
| 正式環境缺 `SESSION_SECRET` 拒絕啟動 | 未測 | 未測（程式路徑未變動） |
| 靜態檔與 SPA fallback | 手動（`/`、`/logo-default.svg` 200） | 通過 |

### 認證與帳號

| 功能 | 測試方式 | 結果 |
|------|---------|------|
| 登入：錯密碼 401、不存在 401、缺欄位 400、成功 200 回權限清單 | E2E §1、API §2 | 通過 |
| `/auth/me` 未登入 401／登入 200 | E2E §1 | 通過 |
| 首次登入 `mustChangePassword=true`，改完變 false | E2E §3 | 通過 |
| 改密碼：目前密碼錯 400、太弱 400、新舊相同 400、未登入 401、成功 200 | E2E §3 | 通過 |
| 登出後 401；舊密碼登入失敗、新密碼登入成功 | E2E §3 | 通過 |
| 爆破防護：連續失敗 429、鎖定期正確密碼也 429、不影響其他 session | E2E §4、API §13 | 通過 |
| 使用者列表（admin 200／employee 403）、角色列表（manager 200／employee 403） | E2E §2 | 通過 |
| 建立使用者：缺密碼 400、弱密碼 400、未知角色 400、重複 409、業務 403、成功 201 | E2E §2 | 通過 |
| 修改角色、停用、停用者登入 401、不存在 404、主管 403 | E2E §2 | 通過 |
| 最後一個管理員不能降級／停用 | 未測 | 未測（既有邏輯未變動；e2e 建立的第二個 admin 使其不易觸發） |
| `reset-password.mjs`（容器內）：列出帳號、重設 admin 密碼後可登入且須再改密碼 | 手動（`docker compose exec app node scripts/reset-password.mjs …`） | 通過 |
| 前端擋「停用自己」 | 未測 | 未測：需瀏覽器 |

### 系統設定（白牌化）

| 功能 | 測試方式 | 結果 |
|------|---------|------|
| `GET /settings/public` 免登入，只含 appName／logoUrl／primaryColor | E2E §5、手動 | 通過 |
| `GET /settings`（完整設定）未登入 401、employee／manager 403、admin 200；`GET /settings/branding` 未登入 401、任何登入者 200 | E2E §5、API §14 | 通過（修正：原本只 requireAuth） |
| 前端 `/settings` 沒權限顯示「需要權限」頁；側欄只列有權限的項目（報價／合約／檔案→quotation:read、品項→product:read、客戶→client:read、員工→employee:read、使用者→user:read）；admin 的 system:admin 全開 | 瀏覽器實測 | 通過（修正） |
| `PUT /settings`：employee／manager 403；前綴含符號、主色格式、空名稱 400；admin 200 回更新後值；前綴轉大寫 | E2E §5、API §14、手動 | 通過（修掉一個「回傳交易前舊值」的 bug） |
| 改公司名／統編／地址／電話／負責人後預設公司同步 | E2E §5、API §14 | 通過 |
| 改 `quotation_prefix`／`contract_prefix` 後新單據編號前綴跟著變 | E2E §8、§14 | 通過（`EQ-…`、`EC-…`） |
| 上傳 logo：png 201、免登入可讀且逐位元組相同、超過 2 MB 413、pdf 400、含 script 的 SVG 400、沒附檔 400、業務 403 | E2E §5、手動 | 通過 |
| 上傳印章：201、未登入 401、登入 200、無印章 404 | E2E §5 | 通過 |
| 刪除 logo／印章：業務 403、成功 200、刪後 404、舊檔從磁碟移除 | E2E §5、手動（`ls uploads/branding`） | 通過 |
| 稽核紀錄有 `settings` 類型 | E2E §18 | 通過 |
| 前端：側欄／登入頁／`<title>`／favicon／主色套用、設定頁表單與上傳 | 未測 | 未測：需瀏覽器（待 UI 測試） |

### 客戶與品項

| 功能 | 測試方式 | 結果 |
|------|---------|------|
| 建立客戶：統編位數／檢查碼錯 400、缺名稱 400、employee 403、成功 201、同統編 409 | E2E §6、API §3 | 通過 |
| 列表搜尋、取得、404、id 非數字 400、employee 403 | E2E §6 | 通過 |
| 更名（時間軸 2 筆、舊名進別名可搜尋） | E2E §6、API §4 | 通過 |
| 新增聯絡人 201、employee 403 | E2E §6 | 通過 |
| 品項：主管建 201（自動 SKU）、業務 403、缺名稱 400、搜尋、employee 403、修改 200、404 | E2E §7 | 通過 |

### 報價

| 功能 | 測試方式 | 結果 |
|------|---------|------|
| 建立：沒品項 400、日期格式 400、employee 403、未登入 401、成功 201 | E2E §8、API §5 | 通過 |
| 編號 `<prefix>-YYYYMMDD-NNN` 連號；併發撞號重試 | E2E §8、Q §2 | 通過 |
| 金額由伺服器算（前端假金額無效） | E2E §8、API §6、Q §4 | 通過 |
| 成本／毛利依權限遮蔽；業務傳的成本被忽略；主管建的報價會計看到毛利 30% | E2E §8、API §7、Q §10 | 通過 |
| 取得／404／400、列表搜尋與總數、employee 403 | E2E §8 | 通過 |
| 修改版本 200、employee 403、不存在 404；開新版本（舊版 superseded 且鎖定） | E2E §9、Q §7 | 通過 |
| 狀態機：未知 400；draft→accepted 409；業務核准／作廢 403；draft→pending_approval→approved（主管）→sent→viewed→accepted；sent→draft 409；accepted 後鎖定與修改 409；draft→sent→declined→voided；voided 後 409 | E2E §10、API §8/§9、Q §5/§6 | 通過 |
| 履約：employee 403；進行中→已收款 409；→已交付→已驗收（純日期字串）；倒退 409；未接受的報價 409 | E2E §11、Q §8 | 通過 |
| 刪除：業務 403；有紀錄 409；草稿 200 後 404 | E2E §11、Q §9 | 通過 |
| `/dashboard`：進行中案件數、已驗收待請款待辦；employee 看不到報價待辦；未登入 401 | E2E §13 | 通過 |
| PDF 匯出（我方資料取自設定、印章用印、一頁排版） | A §1–§4（資料形狀）；渲染未測 | 資料層通過；html2pdf 渲染需瀏覽器，未測 |

### 檔案

| 功能 | 測試方式 | 結果 |
|------|---------|------|
| 上傳簽回 PDF：employee 403、沒附檔 400、偽裝 PDF 400、exe 400、成功 201 回相對路徑 | E2E §12、API §10/§11 | 通過 |
| 下載：有權限 200 且逐位元組相同、employee 403、未登入 401、404 | E2E §12 | 通過 |
| 同檔掛第二張：去重＋標可疑；可疑清單；verify 200／404／employee 403；verify 後移出清單 | E2E §12、API §10 | 通過 |
| 解除連結 200／404／employee 403 | E2E §12 | 通過 |
| 檔案總覽列表、employee 403 | E2E §12 | 通過 |

### 範本與合約

| 功能 | 測試方式 | 結果 |
|------|---------|------|
| 範本列表（含預設 DEV-DEFAULT／RENT-DEFAULT）、employee 403 | E2E §14、C §3 | 通過 |
| 建立範本：業務 403、缺內容 400、成功 201 且變數抓出；修改 200／404 | E2E §14、C §9 | 通過 |
| 合約預覽：缺 templateId 400、範本不存在 404、甲方換成設定公司、乙方為客戶快照、`{principalName}` `{ourEmail}` `{ourPhone}` 取自設定、沒值的變數渲染成空字串且 `missing` 仍列出、employee 403 | E2E §14、C §2/§4/§5 | 通過（修正：原本留 `{ourEmail}` 字面值且代表人無來源） |
| 建立合約：employee 403、結束早於開始 400、成功 201 編號 `<prefix>-YYYYMMDD-NNN` | E2E §14、C §6 | 通過 |
| 列表／取得／404／employee 403／修改 | E2E §14、C §8 | 通過 |
| 狀態：draft→active 409、未知 400、→sent→signed（簽署日）、簽署後改內容 409、employee 403、→active | E2E §14、C §7 | 通過 |
| 已簽合約不受範本修改影響 | C §9 | 通過 |
| 合約簽回檔上傳 201、employee 403、沒附檔 400、明細帶出檔案 | E2E §14 | 通過 |

### 人事

| 功能 | 測試方式 | 結果 |
|------|---------|------|
| 建立員工：employee 403、缺姓名 400、僱用型態錯 400、admin 201（含薪資）、員編重複 409；部門／職位自動建立 | E2E §15 | 通過 |
| 員工自動對應帳號（email 相同） | E2E §15 | 通過（本版新增：建立當下即對應） |
| 列表（會計 200／employee 403）、取得（主管 200、員工看自己 200、看別人 403） | E2E §15 | 通過 |
| 薪資：主管無權看不到、會計 200 數字正確、業務 403 | E2E §15 | 通過 |
| 部門／職位列表 200、employee 403；修改員工 200／404／403 | E2E §15 | 通過 |
| 請假：假別錯 400、缺事由 400、無員工資料 400、建立 201、員工只看自己、主管看待審、員工自核 403、決定值錯 400、核准 200、重複核決 409、駁回缺理由 400、駁回 200、404 | E2E §16、H §4–§6 | 通過 |
| 特休額度：年資計算、週年制、遞延一次、折發工資、超額申請被擋 | H §1–§5b | 通過 |
| 出勤：無員工資料 400、會計 403、打卡 200、重複 409、下班 200、員工看自己、主管查詢、修改缺事由 400、employee 403、主管修改 200、404、歷程（留原值與事由）、業務看歷程 403 | E2E §17、H §7 | 通過 |

### 稽核

| 功能 | 測試方式 | 結果 |
|------|---------|------|
| `/audit` 有 login／create／update／status_change／rename／fulfillment_change／new_version；有 user／settings／client／quotation／contract／employee／leave_request／product 類型 | E2E §18 | 通過 |
| entityType 篩選；會計 200、業務 403 | E2E §18 | 通過 |

### 部署與維運

| 功能 | 測試方式 | 結果 |
|------|---------|------|
| `scripts/setup.sh`（產 .env、build、up、等 health） | 手動（Colima） | 通過；加入「埠被占用」偵測 |
| `scripts/setup.ps1` | 未測 | 未測：無 Windows 環境（邏輯與 setup.sh 對應） |
| `docker-compose.override.example.yml` | 未測 | 未測（範例檔） |
| `scripts/backup.sh`（Docker 模式）產出 `db.dump`＋`uploads.tar.gz` | 手動 | 通過 |
| `scripts/restore.sh`：故意改掉 `app_name` 後還原，設定與 logo 回復 | 手動 | 通過 |
| `scripts/seed-demo.mjs` 建示範帳號（可重複；本機與容器內） | 手動（跑兩次） | 通過 |
| CI workflow（GitHub Actions） | 未測 | 未測：需推到 GitHub；步驟與本機 `npm test`／`test:e2e`／docker build 相同 |
| `docker compose down -v` 清理 | 手動 | 通過 |

## 瀏覽器實測（Docker 版 http://localhost:5080，Chrome，人工）

| 功能 | 結果 |
|------|------|
| 登入：錯密碼顯示錯誤、正確密碼成功、首次登入強制改密碼頁 | 瀏覽器實測：通過 |
| 設定頁：改系統名稱／公司／前綴／主色後側欄、標題、按鈕色全站即時套用 | 瀏覽器實測：通過 |
| 設定頁：上傳 logo 後側欄與 favicon 更新；上傳印章後 PDF 用印 | 瀏覽器實測：通過 |
| 客戶：建立、新增聯絡人、更名 | 瀏覽器實測：通過 |
| 產品：建立 | 瀏覽器實測：通過 |
| 報價：建立、稅額計算、PDF 匯出（網路請求可見 `/api/settings/stamp` 200，html2canvas log 確認 200×200 PNG 印章嵌入） | 瀏覽器實測：通過（PDF 檔案本身由前端 html2pdf 產生，自動化拿不到，用請求與 log 驗證） |
| 報價：狀態 草稿→已寄出→已接受；履約「已交付」含日期框；建立新版本 v2 | 瀏覽器實測：通過 |
| 報價列表：單號與版本顯示 | 瀏覽器實測：原本「TS-20261108-001v2」黏在一起 → 已改成單號＋「第 2 版」badge（修正後未再瀏覽器驗證，e2e 不涵蓋純顯示） |
| 簽回檔：上傳、下載、檔案總覽 | 瀏覽器實測：通過 |
| 合約：從報價建立 `CNT-20261108-001`、狀態變更 | 瀏覽器實測：通過 |
| 使用者：新增；員工：新增並自動對應帳號 | 瀏覽器實測：通過 |
| 出勤：員工打卡上／下班；請假：送出與主管核准 | 瀏覽器實測：通過 |
| 稽核紀錄頁 | 瀏覽器實測：通過 |
| 員工帳號打受限 API 全部 403 | 瀏覽器實測：通過 |
| 員工帳號側欄原本列出報價單／合約／品項／簽回檔／檔案總覽，點進才報錯 | 瀏覽器實測：發現問題 → 已修正（側欄依權限隱藏） |
| 員工帳號可開 `/settings` 整頁、`GET /api/settings` 200 | 瀏覽器實測：發現問題 → 已修正（API 403、頁面顯示「需要權限」） |
| 合約內容殘留 `{ourEmail}`、`{principalName}` 無來源 | 瀏覽器實測：發現問題 → 已修正（新增公司負責人欄位，變數取自設定） |
| 登入頁載入瞬間 `<title>` 先顯示預設「報價管理系統」再換成設定值 | 瀏覽器實測：觀察到，判定不需修改（index.html 靜態標題，設定載入後覆寫） |

## 已知未測／限制

- 瀏覽器層已人工驗證一輪（上表）；四項修正後的 API 行為由 e2e 重新驗證，純顯示的修正（版本 badge、側欄隱藏、需要權限頁）尚待下一輪瀏覽器確認。
- Windows PowerShell 腳本僅做靜態檢視。
- 多副本部署下設定快取不會跨程序失效（文件已註明）。
