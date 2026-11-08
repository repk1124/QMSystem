# 部署指南

適用三種環境：Linux（Ubuntu/Debian＋Docker Engine）、macOS（Docker Desktop 或 OrbStack）、Windows 10/11（Docker Desktop＋WSL2）。最後一節是不用 Docker 的手動安裝。

系統需求：2 核心、2 GB 記憶體以上（build 階段較吃記憶體，3 GB 以下的 VM 已在 Dockerfile 設 `NODE_OPTIONS=--max-old-space-size=2048`）、10 GB 磁碟。

## 共通流程

1. 取得原始碼：`git clone … && cd quotationmaster`
2. 執行一鍵腳本（下面各平台）。腳本做的事：
   - 檢查 `docker` 與 `docker compose` 可用、daemon 在跑
   - 沒有 `.env` 就從 `.env.example` 複製，並自動填入隨機 `SESSION_SECRET`（32 bytes hex）與 `POSTGRES_PASSWORD`
   - 檢查 `APP_PORT`（預設 5000）沒被占用
   - `docker compose up -d --build`
   - 輪詢 `http://localhost:APP_PORT/api/health` 直到 200
   - 印出網址與初始管理員密碼的查看方式
3. 瀏覽器開 `http://<主機>:APP_PORT`，用 `admin` 登入，首次登入會要求改密碼。

想事先指定管理員密碼：先 `cp .env.example .env`，填 `INITIAL_ADMIN_PASSWORD=`（至少 12 字元），再跑腳本。

`docker-compose.yml` 包含兩個服務：`db`（postgres:17-alpine，volume `pgdata`，有 healthcheck）與 `app`（由 `Dockerfile` 建置，volume `uploads`，`depends_on: db: condition: service_healthy`，`restart: unless-stopped`，`HEALTHCHECK` 打 `/api/health`）。

常用指令：

```bash
docker compose ps                 # 狀態（兩個都應該是 healthy）
docker compose logs -f app        # 看應用程式 log
docker compose restart app
docker compose down               # 停止（資料保留在 volume）
docker compose down -v            # 停止並刪除資料（不可逆！）
docker compose up -d --build      # 更新程式後重建
```

## Linux（Ubuntu 22.04/24.04、Debian 12）＋ Docker Engine

```bash
# 安裝 Docker Engine 與 Compose plugin（官方 apt 來源）
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/$(. /etc/os-release && echo "$ID")/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$(. /etc/os-release && echo "$ID") $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER" && newgrp docker   # 讓目前使用者不用 sudo

git clone <repo> quotationmaster && cd quotationmaster
bash scripts/setup.sh
```

伺服器對外請搭配反向代理與 HTTPS（見下方），並用防火牆只開 80/443：`sudo ufw allow 80,443/tcp`。`APP_PORT` 建議只綁 localhost：在 `docker-compose.override.yml` 寫 `ports: ["127.0.0.1:5000:5000"]`。

## macOS（Intel 與 Apple Silicon）

1. 安裝 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 或 [OrbStack](https://orbstack.dev/)（較省資源），啟動後確認 `docker info` 正常。Apple Silicon 會直接建 arm64 image，不需要額外設定。
2. ```bash
   git clone <repo> quotationmaster && cd quotationmaster
   bash scripts/setup.sh
   ```
3. **port 5000 被 AirPlay 接收器占用**是 macOS 最常見的問題：瀏覽器會看到空白的 403。解法擇一：
   - `.env` 改 `APP_PORT=5080` 再執行 `docker compose up -d`
   - 系統設定 → 一般 → AirDrop 與接力 → 關閉「AirPlay 接收器」

   `scripts/setup.sh` 會在啟動前偵測並提示。

## Windows 10/11（Docker Desktop＋WSL2）

1. 安裝 WSL2：以系統管理員開 PowerShell 執行 `wsl --install`，重開機。
2. 安裝 Docker Desktop，設定 → General 勾選「Use the WSL 2 based engine」。
3. 以 PowerShell 執行（不需要系統管理員）：
   ```powershell
   git clone <repo> quotationmaster
   cd quotationmaster
   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
   ```
   `-ExecutionPolicy Bypass` 只對這一次執行放寬，不會改系統設定。若公司政策禁止，可改在 WSL 的 Ubuntu 裡用 `bash scripts/setup.sh`。

注意事項：
- **換行**：`.env` 與 shell 腳本必須是 LF。`setup.ps1` 寫出的 `.env` 已是 UTF-8（無 BOM）＋LF；若自己用記事本編輯 `.env`，請存成 UTF-8 並避免 BOM。Git 建議 `git config core.autocrlf false`。
- **路徑**：把專案放在 Windows 磁碟（`C:\…`）或 WSL 檔案系統都可以；放 WSL（`\\wsl$\Ubuntu\home\…`）建置速度快很多。路徑不要含中文或空白，Docker build context 偶爾會出問題。
- 之後的操作（`docker compose logs app` 等）在 PowerShell 或 WSL 都一樣。

## 反向代理與 HTTPS

對外服務一律放在反向代理後面並上 HTTPS。應用程式已設 `trust proxy: 1`，session cookie 預設 `COOKIE_SECURE=auto`：代理帶 `X-Forwarded-Proto: https` 時才標 Secure。

### Caddy（自動取得 Let's Encrypt 憑證，最省事）

`/etc/caddy/Caddyfile`：

```
qm.example.com {
    reverse_proxy 127.0.0.1:5000
    request_body {
        max_size 25MB
    }
}
```

`sudo systemctl reload caddy`。Caddy 會自動帶 `X-Forwarded-*` 標頭。

### nginx ＋ certbot

```nginx
server {
    listen 80;
    server_name qm.example.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    server_name qm.example.com;
    ssl_certificate     /etc/letsencrypt/live/qm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/qm.example.com/privkey.pem;
    client_max_body_size 25m;          # 上傳檔上限 20 MB

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

憑證：`sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d qm.example.com`。

### 只在內網用 HTTP

可以直接用 `http://主機:5000`，cookie 不會標 Secure（`auto` 模式）。不要把 `COOKIE_SECURE=true` 配 HTTP，會登入不了。

## 接外部資料庫

複製 `docker-compose.override.example.yml` 為 `docker-compose.override.yml`，覆寫 `app` 的 `DATABASE_URL`（雲端託管加 `?sslmode=require`），並停用內建 `db`。啟動時會在那個資料庫自動建表。

## 無 Docker 手動安裝

需求：Node.js 22 以上（`node -v`）、PostgreSQL 14 以上、`npm`。

```bash
# 1. 建資料庫
sudo -u postgres psql -c "CREATE USER qm WITH PASSWORD '改掉';" \
                      -c "CREATE DATABASE quotationmaster OWNER qm;"

# 2. 設定
cp .env.example .env
#   DATABASE_URL=postgresql://qm:改掉@localhost:5432/quotationmaster
#   SESSION_SECRET=$(openssl rand -hex 32)
#   UPLOAD_DIR=/var/lib/quotationmaster/uploads  （預設 ./uploads）

# 3. 建置與啟動（啟動時自動 migrate、建角色與管理員）
npm install
npm run build
set -a; . ./.env; set +a
npm start
```

用 systemd 常駐（`/etc/systemd/system/quotationmaster.service`）：

```ini
[Unit]
Description=QuotationMaster
After=network.target postgresql.service

[Service]
User=qm
WorkingDirectory=/opt/quotationmaster
EnvironmentFile=/opt/quotationmaster/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now quotationmaster`。Windows 不用 Docker 時可用 [NSSM](https://nssm.cc/) 把 `node dist\index.js` 包成服務，`.env` 內容改以系統環境變數設定（程式不會自己讀 `.env`，是由 docker compose 或 shell 載入的）。

## 疑難排解

| 症狀 | 原因與處理 |
|------|-----------|
| `docker compose up` 卡在 `db` healthy 之前 | 第一次初始化資料庫需要幾十秒；`docker compose logs db` 看是否有權限或磁碟錯誤 |
| app 一直 restart，log 說 `password authentication failed for user "qm"` | `.env` 的 `POSTGRES_PASSWORD` 在資料庫初始化之後被改過（PostgreSQL 只在第一次建立 volume 時讀它）。改回原值；或確定不要資料了就 `docker compose down -v` 重建 |
| app 一直 restart，log 說 `SESSION_SECRET 未設定` | `.env` 沒有 `SESSION_SECRET`，用 `openssl rand -hex 32` 產生後填入 |
| 瀏覽器開 5000 是空白 403（macOS） | AirPlay 接收器占用，改 `APP_PORT` |
| 登入成功但馬上又回登入頁 | 反向代理沒帶 `X-Forwarded-Proto`，或把 `COOKIE_SECURE=true` 配 HTTP |
| 上傳 PDF 回 413 | 反向代理的 body 大小限制（nginx `client_max_body_size`），應用程式本身上限 20 MB |
| 忘記管理員密碼 | `docker compose exec app node scripts/reset-password.mjs admin <新密碼>` |
| 想從頭來過 | `docker compose down -v`（刪除所有資料）後重跑 setup |
