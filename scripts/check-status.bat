@echo off
echo ==========================================
echo StepClaw OpenCode Proxy - Status Check
echo ==========================================
echo.

REM Check if proxy is running
echo [1] Checking if proxy is running on port 8080...
netstat -ano | findstr :8080 | findstr LISTENING >nul
if %errorlevel% == 0 (
    echo     Status: RUNNING
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8080 ^| findstr LISTENING') do (
        echo     PID: %%a
        tasklist /FI "PID eq %%a" 2>nul | findstr node.exe >nul
        if %errorlevel% == 0 (
            echo     Process: node.exe
        )
    )
) else (
    echo     Status: NOT RUNNING
    echo     Run scripts\start-proxy.bat to start it
)
echo.

REM Check upstream (StepClaw desktop)
echo [2] Checking StepClaw desktop proxy (port 3199)...
netstat -ano | findstr :3199 | findstr LISTENING >nul
if %errorlevel% == 0 (
    echo     Status: RUNNING
) else (
    echo     Status: NOT RUNNING
    echo     Please start StepClaw desktop app
)
echo.

REM Test proxy
echo [3] Testing proxy endpoint...
curl -s -o nul -w "%%{http_code}" http://127.0.0.1:8080/ > temp_status.txt
set /p status=<temp_status.txt
del temp_status.txt
if "%status%"=="200" (
    echo     HTTP Status: 200 OK
) else (
    echo     HTTP Status: %status% (expected 200)
)
echo.

echo [4] Useful commands:
echo     View logs:      type logs\proxy.log
echo     Stop proxy:     taskkill /F /IM node.exe
echo     Restart proxy:  scripts\start-proxy.bat
echo     Admin panel:    http://127.0.0.1:8080/_admin/upstreams
echo.

pause
