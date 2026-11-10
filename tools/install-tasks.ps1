# 注册 / 卸载 Windows 计划任务（替代 WorkBuddy 的调度器）
#
# 为什么走系统通道：WorkBuddy 的定时任务触发存在数分钟延迟（2026-11-09 实测 09:05 的任务
# 到 09:22 才落地计划），而开盘窗口只有几分钟。系统任务计划按秒级触发，且不依赖宿主进程存活。
#
# 用法（无需管理员，注册到当前用户）：
#   powershell -ExecutionPolicy Bypass -File tools\install-tasks.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install-tasks.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File tools\install-tasks.ps1 -List
#
# 说明：
# - 所有任务都调 tools\run-task.bat，再由 node tools\wake.js 执行，逻辑集中在 JS 里，便于复用与测试。
# - 只在周一到周五触发；节假日由 wake.js 读 data/holidays.json 自行跳过（任务计划做不了这件事）。
# - 触发时间到了但机器在睡眠：已设置 StartWhenAvailable，唤醒后补跑。
param(
  [switch]$Uninstall,
  [switch]$List,
  [switch]$WithAgent,
  [switch]$AutoSell
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Bat = Join-Path $Root 'tools\run-task.bat'
$Prefix = 'TradeDesk-'

# ---- 任务清单：时点 / wake.js 子命令 / 附加参数 / 说明 ----
$AgentArg = if ($WithAgent) { ' --agent' } else { '' }
$AutoArg = if ($AutoSell) { ' --auto' } else { '' }

$Tasks = @(
  @{ Name = '盘前计划';   At = '08:45'; Args = "plan$AgentArg";        Desc = '盘前计划：参数卡 + 观察池同步（不交易）' },
  @{ Name = '盯盘启动';   At = '09:20'; Args = "live-on$AutoArg";        Desc = '启动常驻实时盯盘进程（-AutoSell 时止损自动执行）' },
  @{ Name = '开盘执行';   At = '09:45'; Args = "open$AgentArg$AutoArg"; Desc = '开盘执行窗口：处理告警与风控' },
  @{ Name = '午间检视';   At = '11:25'; Args = "midday$AgentArg$AutoArg"; Desc = '午间持仓检视（只卖不买）' },
  @{ Name = '尾盘调仓';   At = '14:40'; Args = "tail$AgentArg$AutoArg"; Desc = '尾盘调仓窗口' },
  @{ Name = '盯盘停止';   At = '15:05'; Args = 'live-off';             Desc = '停止常驻盯盘进程' },
  @{ Name = '收盘归档';   At = '15:15'; Args = "close$AgentArg";       Desc = '收盘归档：快照 / 观察池 / 索引' }
)

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Path $Bat)) { throw "找不到 run-task.bat：$Bat" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'PATH 里找不到 node，先确认已安装 Node.js' }
# 选 node：优先系统级安装，避开随宿主应用升级而变动的内置解释器
$Candidates = @(
  "$env:ProgramFiles\nodejs\node.exe",
  "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
  (Get-Command node).Source
)
$Node = $Candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Node) { throw '找不到 node.exe' }

if ($List) {
  Get-ScheduledTask -TaskName "$Prefix*" -ErrorAction SilentlyContinue |
    Select-Object TaskName, State |
    Format-Table -AutoSize
  return
}

if ($Uninstall) {
  $found = Get-ScheduledTask -TaskName "$Prefix*" -ErrorAction SilentlyContinue
  if (-not $found) { Write-Host '没有已注册的 TradeDesk 任务'; return }
  foreach ($t in $found) {
    Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false
    Write-Host "已删除 $($t.TaskName)"
  }
  return
}

$useCmdlet = $true
try { Get-Command Register-ScheduledTask -ErrorAction Stop | Out-Null } catch { $useCmdlet = $false }

foreach ($t in $Tasks) {
  $taskName = "$Prefix$($t.Name)"
  if ($useCmdlet) {
    # 主路径：PowerShell 的 ScheduledTasks 模块，参数最稳
    $action = New-ScheduledTaskAction -Execute $Node -Argument "tools\wake.js $($t.Args)" -WorkingDirectory $Root
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $t.At
    $settings = New-ScheduledTaskSettingsSet `
      -StartWhenAvailable `
      -DontStopOnIdleEnd `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
      -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
      -Description $t.Desc -Force | Out-Null
  } else {
    # 兜底：schtasks（老系统或模块缺失）
    $tr = "`"$Bat`" $($t.Args)"
    & schtasks /Create /TN $taskName /TR "`"$Node`" tools\wake.js $($t.Args)" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST $t.At /F | Out-Null
  }
  Write-Host "已注册 $taskName  ->  $($t.At)  wake.js $($t.Args)"
}

Write-Host ''
Write-Host '完成。查看：powershell -File tools\install-tasks.ps1 -List'
Write-Host '撤回：powershell -File tools\install-tasks.ps1 -Uninstall'
Write-Host '注意：agent 模式需要先登录 CLI（codebuddy 然后 /login），否则 wake.js 自动降级为规则执行。'
