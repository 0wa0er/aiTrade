<#
  Trade Desk 迁移助手

  代码、配置、日志、测试都在 git 里，clone 下来就有。
  真正不在 git 里、又必须带走的是「运行态」——尤其是 data/state.json（账户真身）。
  本脚本只做两件事：

    -Export   把必须带走的运行态打成一个 zip（附清单与 SHA256，便于核对）
    -Check    在新机器上跑一遍体检：依赖、任务、端口、写死路径

  用法：
    powershell -ExecutionPolicy Bypass -File tools\migrate.ps1 -Export
    powershell -ExecutionPolicy Bypass -File tools\migrate.ps1 -Check

  为什么不把运行态也塞进 git：state.json 每个交易日都在变，
  入库存会让提交历史被账户流水淹没（见 .gitignore 注释）。
#>
param(
  [switch]$Export,
  [switch]$Check,
  [switch]$Force,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
# Compress-Archive / Expand-Archive 的进度条会刷屏，且经管道调用时会把输出搅乱
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$RootNorm = ($Root -replace '\\', '/').TrimEnd('/')

function Say($text, $color = 'Gray') {
  if ([string]::IsNullOrEmpty($text)) { Write-Host ' ' } else { Write-Host $text -ForegroundColor $color }
}
function Ok($text)   { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  [WARN] $text" -ForegroundColor Yellow }
function Bad($text)  { Write-Host "  [FAIL] $text" -ForegroundColor Red }

# 运行态清单：路径 / 等级 / 为什么
$RuntimeFiles = @(
  @{ Path = 'data\state.json';       Level = '必带'; Why = '账户真身：现金/持仓/成交/委托/观察池/dayStart 基准' },
  @{ Path = 'data\bands.state.json'; Level = '建议'; Why = '区间武装状态，不带会在新机重复告警一次' },
  @{ Path = 'data\alerts.json';      Level = '建议'; Why = '未处理告警队列，不带就丢失待办' }
)

# 明确不要带的东西（含原因），避免「整个 data 目录拷过去」这种懒办法
$Excluded = @(
  @{ Path = 'data\live\live.pid';      Why = '盯盘进程锁，带过去会让新机以为盯盘已在跑' },
  @{ Path = 'data\live\';              Why = '进程快照与事件流水，纯运行态' },
  @{ Path = 'data\regime.state.json';  Why = '当日分级判定，跨交易日自动失效，明天要重判' },
  @{ Path = 'data\state.bak-*.json';   Why = '改基准前的临时快照' },
  @{ Path = 'data\backup\';            Why = '历史手工备份' }
)

function Test-ServerListening($port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    return ($c.Count -gt 0)
  } catch {
    return $false
  }
}

function Get-GitCommit {
  try {
    $v = & git -C $Root rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0) { return $v.Trim() }
  } catch { }
  return 'unknown'
}

# ---------------------------------------------------------------- Export
function Invoke-Export {
  Say ''
  Say '=== 导出运行态 ===' Cyan

  if (Test-ServerListening 5193) {
    if (-not $Force) {
      Bad '服务正在 127.0.0.1:5193 运行，state.json 可能正被写入。'
      Say '       先停掉服务（关掉 start.bat 窗口），或加 -Force 强制导出。' Yellow
      return
    }
    Warn '服务仍在运行，已按 -Force 继续，导出内容可能不是最新。'
  } else {
    Ok '服务未运行（state.json 此刻是静止的）'
  }

  $Stage = Join-Path $env:TEMP ("td-migrate-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $Stage -Force | Out-Null

  $lines = @()
  $missing = @()
  foreach ($f in $RuntimeFiles) {
    $src = Join-Path $Root $f.Path
    if (-not (Test-Path $src)) {
      Warn ("缺失 " + $f.Path + "（" + $f.Level + "）")
      $missing += $f.Path
      continue
    }
    $dst = Join-Path $Stage $f.Path
    New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
    Copy-Item $src $dst -Force
    $hash = (Get-FileHash $dst -Algorithm SHA256).Hash.Substring(0, 16)
    $size = (Get-Item $dst).Length
    Ok ("{0}  {1}  {2,6} B  {3}" -f $f.Level, $f.Path, $size, $hash)
    $lines += ("{0}`t{1}`t{2}`t{3}`t{4}" -f $f.Level, $f.Path, $size, $hash, $f.Why)
  }

  if ($missing.Count -gt 0) {
    Warn ('有 ' + $missing.Count + ' 个文件没找到，导出包不完整')
  }

  $node = 'not found'
  try { $node = (& node -v) } catch { }

  # 逐行追加：PS 5.1 对 @(...) + (...) + @(...) 这种跨行拼接容易报解析错
  $manifest = @()
  $manifest += 'Trade Desk 迁移包清单'
  $manifest += ('导出时间  ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  $manifest += ('git 提交  ' + (Get-GitCommit))
  $manifest += ('node      ' + $node)
  $manifest += ('源目录    ' + $RootNorm)
  $manifest += ''
  $manifest += '本包内文件（必须解压到新机仓库根目录，覆盖同名文件）：'
  $manifest += ('等级' + "`t" + '路径' + "`t" + '字节' + "`t" + 'SHA256前16位' + "`t" + '说明')
  foreach ($l in $lines) { $manifest += $l }
  $manifest += ''
  $manifest += '以下内容刻意不打包（勿手工拷贝）：'
  foreach ($e in $Excluded) { $manifest += ('  ' + $e.Path + '  —  ' + $e.Why) }
  $manifest += ''
  $manifest += '新机还需要做的事（不在任何文件里）：'
  $manifest += '  1) git clone 仓库，再把本包 data\ 覆盖上去'
  $manifest += '  2) powershell -ExecutionPolicy Bypass -File tools\install-tasks.ps1   # 7 个计划任务'
  $manifest += '  3) 在 WorkBuddy 里重建 8 条自动化（4 ACTIVE / 4 PAUSED），cwd 指向新路径'
  $manifest += ('  4) 若新机路径不是 ' + $RootNorm + '，改 tools\prompts\*.md 里的工作目录')
  $manifest += '  5) powershell -ExecutionPolicy Bypass -File tools\migrate.ps1 -Check   # 体检'
  $manifestPath = Join-Path $Stage 'MANIFEST.txt'
  [IO.File]::WriteAllLines($manifestPath, $manifest, (New-Object Text.UTF8Encoding $true))

  if ([string]::IsNullOrWhiteSpace($Out)) {
    $Out = Join-Path (Split-Path -Parent $Root) 'trade-desk-migrate.zip'
  }
  if (Test-Path $Out) { Remove-Item $Out -Force }
  Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Out -Force
  Remove-Item $Stage -Recurse -Force

  Say ''
  Ok ('已生成 ' + $Out)
  Say ('     ' + [math]::Round((Get-Item $Out).Length / 1KB, 1) + ' KB，含 MANIFEST.txt') DarkGray
  Say ''
  Say '提醒：包里是账户现金与持仓，别当普通压缩包乱发。' Yellow
}

# ---------------------------------------------------------------- Check
function Invoke-Check {
  Say ''
  Say '=== 环境体检 ===' Cyan

  # node
  $nodeOk = $false
  try {
    $v = (& node -v)
    $major = [int]($v.TrimStart('v').Split('.')[0])
    if ($major -ge 18) { Ok "node $v（要求 >=18）"; $nodeOk = $true }
    else { Bad "node $v 太旧，需要 >=18" }
  } catch { Bad '找不到 node，先装 Node.js 18+' }
  if ($nodeOk) {
    $exe = (Get-Command node).Source
    Say ("         " + $exe) DarkGray
    # 计划任务里 node 写死在这两个标准路径（WorkBuddy 内置 node 会随应用升级换版本号，不能用）
    $std1 = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    $std2 = Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'
    if ((Test-Path $std1) -or (Test-Path $std2)) {
      Ok '标准安装路径存在，install-tasks.ps1 能找到 node'
    } else {
      Warn 'C:\Program Files\nodejs\node.exe 不存在，install-tasks.ps1 会报「找不到 node.exe」'
    }
    if ($exe -like '*\.workbuddy\*') {
      Warn '当前 shell 的 node 是 WorkBuddy 内置版，计划任务不该用它（升级即失效）'
    }
  }

  # 零依赖确认
  if (Test-Path (Join-Path $Root 'node_modules')) {
    Warn '存在 node_modules，本应零依赖（可删）'
  } else {
    Ok '零依赖，无需 npm install'
  }

  # 关键文件
  Say ''
  Say '--- 关键文件 ---' Gray
  $critical = @('server.js', 'cli.js', 'AGENTS.md', 'data\autotrade.json', 'data\holidays.json',
                'data\state.seed.json', 'public\vendor\echarts.min.js', 'tools\wake.js')
  $miss = 0
  foreach ($f in $critical) {
    if (-not (Test-Path (Join-Path $Root $f))) { Bad "缺 $f"; $miss++ }
  }
  if ($miss -eq 0) { Ok ($critical.Count.ToString() + ' 个关键文件齐全') }

  # 运行态
  Say ''
  Say '--- 运行态（git 里没有，需手工搬）---' Gray
  foreach ($f in $RuntimeFiles) {
    $p = Join-Path $Root $f.Path
    if (Test-Path $p) {
      $t = (Get-Item $p).LastWriteTime.ToString('MM-dd HH:mm')
      Ok ("{0}  {1}  改于 {2}" -f $f.Level, $f.Path, $t)
    } else {
      if ($f.Path -eq 'data\state.json') { Bad '缺 data\state.json —— 账户会退回 seed（5 万空仓）' }
      else { Warn ("缺 " + $f.Path) }
    }
  }

  # state.json 体检
  $sp = Join-Path $Root 'data\state.json'
  if (Test-Path $sp) {
    try {
      $s = Get-Content $sp -Raw -Encoding UTF8 | ConvertFrom-Json
      $pos = 0
      if ($null -ne $s.positions) { $pos = ($s.positions | Get-Member -MemberType NoteProperty).Count }
      Ok ("现金 {0}  持仓 {1} 只  成交 {2} 笔  观察池 {3} 只" -f $s.cash, $pos, $s.trades.Count, $s.watchlist.Count)
    } catch {
      Bad 'state.json 解析失败，可能写坏或编码不对'
    }
  }

  # 遗留 pid
  $pidFile = Join-Path $Root 'data\live\live.pid'
  if (Test-Path $pidFile) {
    $oldPid = (Get-Content $pidFile -Raw).Trim()
    Warn ("存在 data\live\live.pid（pid=$oldPid），若确认没有盯盘进程在跑，删掉它再启动")
  }

  # 计划任务
  Say ''
  Say '--- Windows 计划任务 ---' Gray
  $tasks = @()
  try { $tasks = @(Get-ScheduledTask -TaskName 'TradeDesk*' -ErrorAction SilentlyContinue) } catch { }
  if ($tasks.Count -ge 7) { Ok ($tasks.Count.ToString() + ' 个任务已注册') }
  elseif ($tasks.Count -gt 0) { Warn ($tasks.Count.ToString() + ' 个任务已注册，应为 7 个：tools\install-tasks.ps1') }
  else { Bad '一个都没注册 → powershell -ExecutionPolicy Bypass -File tools\install-tasks.ps1' }

  # 写死路径
  Say ''
  Say '--- 写死的工作目录 ---' Gray
  $re = [regex]'[A-Za-z]:[\\/][^\s，。；）,、]*trade-desk'
  $targets = @()
  $pd = Join-Path $Root 'tools\prompts'
  if (Test-Path $pd) { $targets += Get-ChildItem $pd -Filter *.md -ErrorAction SilentlyContinue }
  $bj = Join-Path $Root 'data\bands.json'
  if (Test-Path $bj) { $targets += Get-Item $bj }
  $stale = @()
  foreach ($f in $targets) {
    $txt = Get-Content $f.FullName -Raw -Encoding UTF8
    foreach ($m in $re.Matches($txt)) {
      $hit = ($m.Value -replace '\\', '/')
      if ($hit -ne $RootNorm) { $stale += ($f.Name + ' -> ' + $hit) }
    }
  }
  if ($stale.Count -eq 0) {
    Ok ('没有与当前目录 ' + $RootNorm + ' 不符的路径')
  } else {
    foreach ($x in $stale) { Warn $x }
    Say '         改成本机路径；data\bands.json 里的路径在运行时会自动改写，可不动。' DarkGray
  }

  # 端口
  Say ''
  Say '--- 端口 ---' Gray
  foreach ($p in @(5193, 5194)) {
    if (Test-ServerListening $p) { Warn "$p 已被占用（旧进程没退？）" }
    else { Ok "$p 空闲" }
  }

  Say ''
  Say '体检完。下一步：node cli.js status 确认账户数字对得上，再 npm test 跑一遍。' Cyan
  Say ''
}

if ($Export) { Invoke-Export }
elseif ($Check) { Invoke-Check }
else {
  Say ''
  Say '用法：' White
  Say '  tools\migrate.ps1 -Export   打包必须带走的运行态（含清单）' Gray
  Say '  tools\migrate.ps1 -Check    新机器体检' Gray
  Say ''
}
