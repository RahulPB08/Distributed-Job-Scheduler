@echo off
title Distributed Job Scheduler - Platform Launcher
echo ========================================================
echo   Distributed Job Scheduler (DJS) Platform Launcher
echo ========================================================
echo.

echo [1/4] Seeding Database with Default Admin and Dev accounts...
cd /d "%~dp0backend"
call node src/database/seed.js

echo.
echo [2/4] Launching Backend REST API and Scheduler Engine (Port 4000)...
start "DJS Backend and Scheduler (Port 4000)" cmd /k "cd /d %~dp0backend && npm run dev"

echo.
echo [3/4] Launching Worker Fleet (Alpha and Beta)...
start "DJS Worker Alpha" cmd /k "cd /d %~dp0worker && node src/index.js --worker-id=worker-alpha --concurrency=5 --poll-interval=100"
start "DJS Worker Beta" cmd /k "cd /d %~dp0worker && node src/index.js --worker-id=worker-beta --concurrency=5 --poll-interval=100"

echo.
echo [4/4] Launching Frontend Web Dashboard (Port 3000)...
start "DJS Frontend Dashboard (Port 3000)" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo ========================================================
echo   All 4 Platform Services Started Successfully!
echo   - Frontend: http://localhost:3000
echo   - Backend API: http://localhost:4000
echo   - WebSocket: ws://localhost:4000/ws
echo   - Admin User: admin@djs.io / AdminPassword123!
echo ========================================================
echo.
pause
