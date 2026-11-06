@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Trade Desk  -  http://localhost:5173
echo   Ctrl+C to stop
echo ============================================
node server.js
pause
