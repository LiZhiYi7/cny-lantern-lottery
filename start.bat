@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Spring Festival Lottery Server
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ first: https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\qrcode" (
  echo [INFO] First run, installing the QR code dependency...
  call npm install --no-audit --no-fund
  if errorlevel 1 echo [WARN] npm install failed. QR code is unavailable, everything else still works.
)
node server.js
echo.
echo Server stopped. Press any key to close this window.
pause >nul
