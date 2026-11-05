# life-innovation 的守护进程（Windows，由登录时启动的 HKCU Run 键运行）。
#
# 它做四件事：
#   1. 起一个固定入口 127.0.0.1:<EntryPort>，把请求 302 到当前这次启动的带 token 地址
#      （token 每次启动都会变，但书签不用变）。入口自己挂了就重新拉起来。
#   2. 起 dsh web，把打印出来的带 token 地址写进 <DataHome>\state\web-url.txt。
#   3. dsh web 挂了就等一会儿再拉起来；看到 <DataHome>\state\service.stop 就正常退出。
#   4. 同一个 DataHome 只允许一个守护进程（state\service.pid 单例锁）。
#
# 停止：新建 state\service.stop 文件（下一轮检查时退出），或删掉 HKCU Run 键后重启。
param(
  [switch]$NoProxy
)
$ErrorActionPreference = 'Continue'

# 下面这些占位符由 install.ps1 写入真实值。
$DataHome  = '@DATA_HOME@'
$DshHome   = '@DSH_HOME@'
$Profile   = '@PROFILE@'
$Port      = '@PORT@'
$EntryPort = '@ENTRY_PORT@'
$AgentName = '@AGENT_NAME@'
$DbPath    = '@DB_PATH@'

$state = Join-Path $DataHome 'state'
$logs  = Join-Path $DataHome 'logs'
New-Item -ItemType Directory -Force -Path $state, $logs | Out-Null
$urlFile  = Join-Path $state 'web-url.txt'
$stopFile = Join-Path $state 'service.stop'
$pidFile  = Join-Path $state 'service.pid'
$logFile  = Join-Path $logs 'service.log'
$entryJs  = Join-Path $DataHome 'service\entry.mjs'

function Write-Log([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

# ---- 单例：同一个 DataHome 不跑第二个守护进程（否则两个 node 抢 60081） ----
if (Test-Path $pidFile) {
  $other = 0
  $rawPid = $null
  try { $rawPid = Get-Content -Path $pidFile -Raw -ErrorAction Stop } catch {
    Write-Log ('pid 文件读取失败（{0}），忽略旧 pid。' -f $_.Exception.Message)
  }
  if ($null -ne $rawPid) {
    $rawPid = ([string]$rawPid).Trim()
    if ($rawPid -and -not [int]::TryParse($rawPid, [ref]$other)) { $other = 0 }
  }
  if ($other -gt 0) {
    $alive = Get-Process -Id $other -ErrorAction SilentlyContinue
    if ($alive) {
      $cmd = $null
      try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$other" -ErrorAction Stop).CommandLine } catch { $cmd = $null }
      # 只认“本 DataHome 的 service.ps1”，别的 profile 的 pid 不算单例。
      $homePattern = [regex]::Escape($DataHome)
      if ($cmd -and $cmd -match 'service\.ps1' -and $cmd -match $homePattern) {
        Write-Log ('已有守护进程在跑（pid {0}），本进程退出。' -f $other)
        exit 0
      }
      if ($cmd -and $cmd -match 'service\.ps1') {
        Write-Log ('pid {0} 是别的 DataHome 的守护进程（缺 {1}），忽略。' -f $other, $DataHome)
      } else {
        Write-Log ('pid {0} 不是本服务的守护进程，忽略。' -f $other)
      }
    }
  }
}
Set-Content -Path $pidFile -Value $PID -Encoding ASCII

if (Test-Path $stopFile) { Remove-Item $stopFile -Force }

$apiKey = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
if (-not $apiKey) { $apiKey = $env:DEEPSEEK_API_KEY }
if (-not $apiKey) {
  Write-Log '缺少 DEEPSEEK_API_KEY（用户环境变量），无法启动。'
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  exit 2
}
$env:DSH_HOME = $DshHome
$env:DEEPSEEK_API_KEY = $apiKey
$env:PATH = "$env:APPDATA\npm;$env:PATH"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Log '找不到 node.exe'
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  exit 3
}

$npmCmd = Join-Path $env:APPDATA 'npm\npm.cmd'
if (-not (Test-Path $npmCmd)) { $npmCmd = 'npm.cmd' }

# 记忆库、家目录、端口只在这里设置一次；不管是否启用代理、是否手动启动，
# 后面拉起的 dsh web 都继承同一组值，避免插件/家页面/备份各写一个库。
$env:LIFE_INNOVATION_ENTRY_PORT = [string]$EntryPort
$env:LIFE_INNOVATION_URL_FILE = $urlFile
$env:LIFE_INNOVATION_HOME = $DataHome
$env:LIFE_INNOVATION_DB = $DbPath
$env:LIFE_INNOVATION_AGENT_NAME = $AgentName
# 兼容 0.1.x 的旧环境变量名
$env:JINGJING_ENTRY_PORT = [string]$EntryPort
$env:JINGJING_URL_FILE = $urlFile
$env:JINGJING_HOME = $DataHome
$env:JINGJING_DB = $DbPath

function Start-EntryProxy {
  if ($NoProxy -or -not (Test-Path $entryJs)) { return $null }
  $entryArg = '"' + $entryJs + '"'
  $p = Start-Process -FilePath $node -ArgumentList @($entryArg) -WorkingDirectory $DataHome -PassThru -WindowStyle Hidden
  Write-Log ('固定入口已启动：http://127.0.0.1:{0}/  (pid {1})' -f $EntryPort, $p.Id)
  return $p
}

# 固定入口的 302 小代理（只监听本机回环地址）。它也由本脚本看护。
$proxy = Start-EntryProxy

# 结束一个进程及其子进程：npm.cmd 只是壳，node 才是真正占着端口的那个。
function Stop-Tree([int]$id) {
  if (-not $id) { return }
  $out = & taskkill.exe /PID $id /T /F 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Log ('结束进程树失败（pid {0}，退出码 {1}）：{2}' -f $id, $LASTEXITCODE, (($out | Out-String).Trim()))
  }
}

$backoff = 5
try {
  while (-not (Test-Path $stopFile)) {
    # 代理挂了就重新拉起来（它没有自己的守护）。
    if ($proxy -and $proxy.HasExited) {
      Write-Log '固定入口退出，重新拉起。'
      $proxy = Start-EntryProxy
    }

    Remove-Item $urlFile -Force -ErrorAction SilentlyContinue
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outLog = Join-Path $logs ("web-{0}.log" -f $stamp)
    $errLog = $outLog + '.err'

    Write-Log ('启动 dsh web（profile={0} port={1}）' -f $Profile, $Port)
    $arguments = 'exec --yes --package @deepseek-ai/dsh@0.2.1-rc.5 -- dsh --profile {0} --port {1} --no-open' -f $Profile, $Port
    try {
      $proc = Start-Process -FilePath $npmCmd -ArgumentList $arguments -WorkingDirectory $DataHome `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
    } catch {
      Write-Log ('启动失败：{0}' -f $_.Exception.Message)
      Start-Sleep -Seconds $backoff
      continue
    }

    # 等它把带 token 的地址打印出来（最多 120 秒）。
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $urlFile) -and -not $proc.HasExited) {
      Start-Sleep -Milliseconds 500
      if ($proxy -and $proxy.HasExited) { $proxy = Start-EntryProxy }
      if (Test-Path $outLog) {
        $hit = Select-String -Path $outLog -Pattern 'dsh web:\s*(http\S+)' -ErrorAction SilentlyContinue | Select-Object -Last 1
        if ($hit) {
          $url = $hit.Matches[0].Groups[1].Value
          Set-Content -Path $urlFile -Value $url -Encoding UTF8
          Write-Log ('已发布入口：' + $url)
          $backoff = 5
        }
      }
    }

    if (Test-Path $urlFile) { Write-Log 'dsh web 正在运行。' } else { Write-Log 'dsh web 没有给出可用地址（看 logs\web-*.log）。' }

    # 等它退出；期间响应停止文件，并顺手看护代理。
    while (-not $proc.HasExited -and -not (Test-Path $stopFile)) {
      Start-Sleep -Seconds 2
      if ($proxy -and $proxy.HasExited) { $proxy = Start-EntryProxy }
    }
    if (Test-Path $stopFile) {
      if (-not $proc.HasExited) { Stop-Tree $proc.Id }
      break
    }
    # 壳退了，node 子进程可能还活着并占着端口——整棵树一起收掉再重试。
    Stop-Tree $proc.Id
    Write-Log ('dsh web 退出（exit {0}），{1} 秒后重试' -f $proc.ExitCode, $backoff)
    Start-Sleep -Seconds $backoff
    if ($backoff -lt 60) { $backoff = [Math]::Min(60, $backoff * 2) }
  }
} finally {
  Write-Log '守护进程退出。'
  if ($proxy -and -not $proxy.HasExited) { Stop-Tree $proxy.Id }
  if ($proc -and -not $proc.HasExited) { Stop-Tree $proc.Id }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
