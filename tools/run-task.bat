@echo off
rem 系统任务唤醒包装器：由 Windows 任务计划程序调用，不经过 WorkBuddy 调度器。
rem 用途：cd 到项目目录、补日志、跑 wake.js，把退出码原样传回去。
setlocal
cd /d "%~dp0.."
if not exist "data\live" mkdir "data\live"
node tools\wake.js %* >> "data\live\wake-stdout.log" 2>&1
endlocal
