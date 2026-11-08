# 更新紀錄

格式依 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)。

## [1.0.0] - 2026-11-08

開源初版（由某公司內部系統白牌化而來）。

### 新增
- 系統設定頁與 `app_settings` 表：系統名稱、公司資料、logo、印章、報價／合約編號前綴、主色，改完立即生效
- 啟動時自動套用 migrations（`server/migrate.ts`）、建立角色、初始管理員（可隨機密碼）、預設公司、合約範本
- 首次登入強制改密碼頁、右上角修改密碼
- Docker 一鍵部署：`Dockerfile`（多階段、非 root、HEALTHCHECK）、`docker-compose.yml`（postgres:17 + app）、`scripts/setup.sh` / `setup.ps1`
- 備份／還原腳本、通用 CI（Postgres service、build、測試、docker build）
- 端對端 API 測試 `tests/e2e-api.test.ts`（涵蓋全部 69 條路由）
- 設定頁「公司負責人／代表人」（`company_principal`），合約變數 `{principalName}` `{ourEmail}` `{ourPhone}` 取自設定；未填的變數渲染成空字串
- 側欄依權限隱藏沒權限的項目；直接輸入網址進設定頁時顯示「需要權限」
- 文件：README、DEPLOY、CONFIG、ARCHITECTURE、DEVELOPMENT、TEST_REPORT、AI_GUIDE、CLAUDE.md／AGENTS.md

### 移除
- Google 登入與 Firebase 相關程式、欄位（`users.google_subject`）、環境變數與套件
- Replit 相關檔案與設定、舊系統匯入腳本、`import_batches` / `import_id_map` 表
- 內建的特定公司印章與圖示

### 變更
- 建立使用者時密碼改為必填
- session cookie `secure` 改為 `auto`（HTTPS 才標 Secure），新增 `COOKIE_SECURE`
- 資料庫 SSL 改由連線字串 `sslmode=require` 決定
- 建立員工／使用者時立即嘗試對應帳號（原本只在啟動時）
