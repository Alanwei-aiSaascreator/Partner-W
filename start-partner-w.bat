@echo off
setlocal
cd /d "%~dp0"

echo ==============================================
echo    Partner-W launcher (dev mode)
echo ==============================================
echo.

echo [1/2] Stopping stale dev processes...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'openclaw|vite|packages\\desktop|clawwork' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; foreach ($p in 5173,5174,18789) { $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } } }"
timeout /t 3 /nobreak >nul

echo [2/2] Starting dev server (keep this window open)...
echo.
pnpm dev

echo.
echo Dev server exited. You can close this window.
pause
