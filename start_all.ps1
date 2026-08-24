# ============================================================
#  Distributed Job Scheduler (DJS) — Universal Launch Script
#  Works on Windows PowerShell 5+ and PowerShell Core 7+
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   Distributed Job Scheduler (DJS) Platform Launcher   " -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Helper: open a new PowerShell window with a title and command ──────────────
function Start-Service($title, $dir, $command) {
    $escapedDir = $dir.Replace("'", "''")
    $escapedCmd = $command.Replace("'", "''")
    Start-Process powershell -ArgumentList (
        "-NoExit",
        "-Command",
        "Set-Location -LiteralPath '$escapedDir'; `$Host.UI.RawUI.WindowTitle = '$title'; Write-Host '[$title]' -ForegroundColor Cyan; $escapedCmd"
    )
}

# ── Step 1: Install dependencies if node_modules missing ──────────────────────
Write-Host "[1/6] Checking & installing dependencies..." -ForegroundColor Yellow

foreach ($svc in @("backend", "scheduler", "worker", "frontend")) {
    $svcPath = Join-Path $rootDir $svc
    $nmPath   = Join-Path $svcPath "node_modules"
    if (-not (Test-Path $nmPath)) {
        Write-Host "      Installing $svc dependencies..." -ForegroundColor DarkYellow
        Push-Location $svcPath
        npm install --silent 2>&1 | Out-Null
        Pop-Location
        Write-Host "      $svc ✓" -ForegroundColor Green
    } else {
        Write-Host "      $svc - already installed ✓" -ForegroundColor DarkGray
    }
}

# ── Step 2: Seed Database ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "[2/6] Seeding database (admin & dev accounts)..." -ForegroundColor Yellow
Push-Location (Join-Path $rootDir "backend")
node src/database/seed.js
Pop-Location
Write-Host "      Seed complete ✓" -ForegroundColor Green

# ── Step 3: Backend API ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "[3/6] Launching Backend REST API  →  http://localhost:4000" -ForegroundColor Yellow
Start-Service "DJS-Backend" (Join-Path $rootDir "backend") "npm run dev"
Start-Sleep -Seconds 4

# ── Step 4: Scheduler ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[4/6] Launching Scheduler Service..." -ForegroundColor Yellow
Start-Service "DJS-Scheduler" (Join-Path $rootDir "scheduler") "node src/index.js"
Start-Sleep -Seconds 2

# ── Step 5: Worker fleet ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "[5/6] Launching Worker Fleet (Alpha & Beta)..." -ForegroundColor Yellow
Start-Service "DJS-Worker-Alpha" (Join-Path $rootDir "worker") "node src/index.js --worker-id=worker-alpha --concurrency=5 --poll-interval=100"
Start-Sleep -Milliseconds 500
Start-Service "DJS-Worker-Beta"  (Join-Path $rootDir "worker") "node src/index.js --worker-id=worker-beta  --concurrency=5 --poll-interval=100"

# ── Step 6: Frontend ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[6/6] Launching Frontend Dashboard →  http://localhost:3000" -ForegroundColor Yellow
Start-Service "DJS-Frontend" (Join-Path $rootDir "frontend") "npm run dev"

Write-Host ""
Write-Host "========================================================"  -ForegroundColor Green
Write-Host "  All services launched!                                "  -ForegroundColor Green
Write-Host "========================================================"  -ForegroundColor Green
Write-Host ""
Write-Host "  Dashboard :  http://localhost:3000"       -ForegroundColor White
Write-Host "  Backend   :  http://localhost:4000"       -ForegroundColor White
Write-Host "  WebSocket :  ws://localhost:3000/ws  (Vite-proxied to :4000)" -ForegroundColor White
Write-Host ""
Write-Host "  Credentials:" -ForegroundColor Yellow
Write-Host "    Admin : admin@djs.io   / AdminPassword123!" -ForegroundColor White
Write-Host "    Dev   : dev@djs.io     / DevPassword123!"   -ForegroundColor White
Write-Host ""
Write-Host "  Architecture:" -ForegroundColor Yellow
Write-Host "    Backend   — Express API, JWT auth, RBAC, rate limiting"         -ForegroundColor DarkGray
Write-Host "    Scheduler — Priority+Aging+WFQ, cron, DAG, stale worker reaper" -ForegroundColor DarkGray
Write-Host "    Worker x2 — Atomic claim, 5 service types, heartbeat, DLQ"      -ForegroundColor DarkGray
Write-Host "    Frontend  — React dashboard, live WS updates (DB-polled)"       -ForegroundColor DarkGray
Write-Host ""

Set-Location -Path $rootDir
