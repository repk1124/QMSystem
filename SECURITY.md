# 安全政策

## 回報漏洞

請用 GitHub 的「Report a vulnerability」（Security → Advisories）私下回報，或寄信給維護者（見 repo 頁面）。請附重現步驟與影響範圍。我們會在 7 天內回覆、確認後盡快釋出修正並在 CHANGELOG 註明。

## 部署建議

- 一定要設定隨機的 `SESSION_SECRET`，對外服務請走 HTTPS（反向代理範例見 docs/DEPLOY.md）
- 初始管理員首次登入即強制改密碼；不要把 `INITIAL_ADMIN_PASSWORD` 留在 `.env` 裡
- `.env`、`uploads/`、`backups/` 都在 `.gitignore`，不要提交
- 內建 PostgreSQL 不對外開埠（compose 沒有 `ports`），要遠端連線請用 SSH tunnel
- 定期執行 `scripts/backup.sh` 並把備份放到別台機器

## 已實作的防護

- 密碼 bcrypt（12 rounds）、最少 10 字元且英數混合
- 登入爆破防護：IP＋帳號 8 次／帳號 20 次，15 分鐘窗口；登入後換發 session id
- session 存 PostgreSQL，cookie `httpOnly`、`sameSite=lax`、HTTPS 下 `Secure`
- 所有 API 需登入，權限在伺服器檢查；成本／薪資獨立權限
- 上傳檔驗 MIME 與檔頭、大小上限、以 sha256 命名、只存相對路徑；下載時 `nosniff`，非 PDF 一律附件；logo／印章拒絕含 `<script>` 的 SVG 並以 CSP sandbox 送出
- PDF 內所有插值 HTML 逸出
- 錯誤回應不洩漏堆疊；所有寫入留稽核紀錄
