@echo off
chcp 65001 >nul
setlocal
set NODE=C:\Program Files\nodejs\node.exe
set CLI=D:\program\workBuddy\resources\app.asar.unpacked\cli\bin\codebuddy

echo ============================================================
echo  登录 WorkBuddy CLI（一次性）
echo ============================================================
echo.
echo  login 成功后才能用定时任务的 agent 模式：
echo    盘前计划里的判断、条件单的搭建、复盘结论，都靠它。
echo.
echo  步骤：
echo    1. 在下面出现的界面里输入  /login  回车
echo    2. 浏览器里完成授权，回到这个窗口
echo    3. 输入  /exit  退出
echo    4. 回来告诉 Agent「登录好了」，剩下的事由它验证
echo.
echo ------------------------------------------------------------
echo.

if not exist "%NODE%" (
  echo [错误] 找不到 node：%NODE%
  echo        改这个 bat 里的 NODE 路径，或把 Node.js 装到默认位置。
  pause
  exit /b 1
)
if not exist "%CLI%" (
  echo [错误] 找不到 CLI 入口：%CLI%
  echo        WorkBuddy 升级后路径可能变了，去 resources\app.asar.unpacked\cli\bin 下找。
  pause
  exit /b 1
)

"%NODE%" "%CLI%"

echo.
echo ------------------------------------------------------------
echo 已退出 CLI。登录状态是否生效，回来让 Agent 跑一次自检就知道。
pause
