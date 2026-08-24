# Distributed Job Scheduler - PowerShell Cross-Platform Test Runner
param(
    [string]$Filter = "",
    [switch]$Docker
)

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  DISTRIBUTED JOB SCHEDULER - POWERSHELL TEST RUNNER" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

$WorkspaceRoot = $PSScriptRoot

if ($Docker) {
    Write-Host "[DOCKER] Spawning isolated container test run..." -ForegroundColor Yellow
    docker compose -f "$WorkspaceRoot\docker-compose.test.yml" up --build --abort-on-container-exit --exit-code-from test-runner
    exit $LASTEXITCODE
}

$ScriptPath = "$WorkspaceRoot\tests\run_all.js"
if ($Filter -ne "") {
    & node "$ScriptPath" "--filter=$Filter"
} else {
    & node "$ScriptPath"
}

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n[SUCCESS] Test run completed successfully." -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n[FAILURE] Test run encountered failures (Exit code: $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
}
