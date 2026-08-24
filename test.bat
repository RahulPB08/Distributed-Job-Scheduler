@echo off
setlocal enabledelayedexpansion
title Distributed Job Scheduler - Test Runner

echo ======================================================================
echo   DISTRIBUTED JOB SCHEDULER -- WINDOWS BATCH TEST RUNNER
echo ======================================================================
echo.

set FILTER_ARG=%1
if not "%FILTER_ARG%"=="" (
    echo [RUN] Executing filtered test suites matching: %FILTER_ARG%
    node "%~dp0tests\run_all.js" --filter=%FILTER_ARG%
) else (
    echo [RUN] Executing all cross-platform test suites...
    node "%~dp0tests\run_all.js"
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Test suite execution failed with exit code %ERRORLEVEL%.
    exit /b %ERRORLEVEL%
) else (
    echo.
    echo [SUCCESS] All test suites completed successfully!
    exit /b 0
)
