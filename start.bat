@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   Trade Desk  -  http://127.0.0.1:5193
echo   Ctrl+C to stop
echo ============================================
node server.js
pause
