# 一鍵安裝（Windows PowerShell）：檢查 Docker → 產生 .env → 建置並啟動 → 等健康檢查 → 印出網址與帳密提示
# 執行：powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "找不到 docker。請先安裝 Docker Desktop（含 WSL2），見 docs/DEPLOY.md"; exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "Docker Desktop 沒有在跑，請先啟動它。"; exit 1 }

function New-Hex([int]$bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString("x2") }) -join ""
}

if (-not (Test-Path ".env")) {
  $secret = New-Hex 32; $pgpw = New-Hex 16
  $content = Get-Content ".env.example" -Raw
  $content = $content -replace "(?m)^SESSION_SECRET=.*$", "SESSION_SECRET=$secret"
  $content = $content -replace "(?m)^POSTGRES_PASSWORD=.*$", "POSTGRES_PASSWORD=$pgpw"
  $content = $content -replace "(?m)^DATABASE_URL=.*$", "DATABASE_URL=postgresql://qm:$pgpw@localhost:5432/quotationmaster"
  # 用 UTF-8（無 BOM）＋ LF 寫檔：容器內的程式讀 .env 不吃 BOM 與 CRLF
  $content = $content -replace "`r`n", "`n"
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $content, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "已建立 .env（SESSION_SECRET 與 POSTGRES_PASSWORD 已自動填入隨機值）"
} else {
  Write-Host ".env 已存在，沿用現有設定"
}

$appPort = 5000
$m = Select-String -Path ".env" -Pattern "^APP_PORT=(\d+)" | Select-Object -First 1
if ($m) { $appPort = [int]$m.Matches[0].Groups[1].Value }

# 埠被占用時先擋下來（Windows 上常見是其他開發伺服器或 IIS）
$inUse = Get-NetTCPConnection -LocalPort $appPort -State Listen -ErrorAction SilentlyContinue
$running = (docker compose ps --status running 2>$null | Select-String "app")
if ($inUse -and -not $running) {
  Write-Host "埠 $appPort 已被其他程式占用。請在 .env 把 APP_PORT 改成別的埠（例如 5080）再重新執行。"; exit 1
}

Write-Host "建置並啟動（第一次需要幾分鐘）…"
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Write-Host "docker compose 失敗"; exit 1 }

Write-Host -NoNewline "等待應用程式就緒"
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "http://localhost:$appPort/api/health" -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
  Write-Host -NoNewline "."; Start-Sleep -Seconds 3
}
Write-Host ""
if (-not $ok) { Write-Host "逾時。請看 docker compose logs app"; exit 1 }

Write-Host "════════════════════════════════════════════════"
Write-Host "  已啟動：http://localhost:$appPort"
$pw = Select-String -Path ".env" -Pattern "^INITIAL_ADMIN_PASSWORD=(.+)$"
if ($pw) {
  Write-Host "  管理員密碼為 .env 的 INITIAL_ADMIN_PASSWORD（首次登入須修改）"
} else {
  Write-Host "  未設定 INITIAL_ADMIN_PASSWORD，系統已隨機產生一組，請在以下輸出找「初始密碼」："
  Write-Host "    docker compose logs app | Select-String 初始 -Context 0,3"
  docker compose logs app 2>$null | Select-String "初始管理員" -Context 0,3
}
Write-Host "  停止：docker compose down   更新：git pull; docker compose up -d --build"
Write-Host "════════════════════════════════════════════════"
