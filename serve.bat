@echo off
rem 常驻启动（不自动打开浏览器），供开机自启与后台恢复使用
cd /d "%~dp0"
set NO_OPEN=1
node server.js
