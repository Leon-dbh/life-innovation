# 鲸鲸的守护进程（Windows，由登录时启动的计划任务运行）。
#
# 它做三件事：
#   1. 起一个固定入口 127.0.0.1:<EntryPort>，把请求 302 到当前这次启动的带 token 地址
#      （token 每次启动都会变，但书签不用变）。
#   2. 起 dsh web，把打印出来的带 token 地址写进 <DataHome>\state\web-url.txt。
#   3. dsh web 挂了就等一会儿再拉起来；看到 <DataHome>\state\service.stop 就正常退出。
#
# 停止：删除/新建 state\service.stop 文件，或 schtasks /End /TN JingjingService。
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

$state = Join-Path $DataHome 'state'
$logs  = Join-Path $DataHome 'logs'
New-Item -ItemType Directory -Force -Path $state, $logs | Out-Null
$urlFile  = Join-Path $state 'web-url.txt'
$stopFile = Join-Path $state 'service.stop'
$logFile  = Join-Path $logs 'service.log'
$entryJs  = Join-Path $DataHome 'service\entry.mjs'

function Write-Log([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

if (Test-Path $stopFile) { Remove-Item $stopFile -Force }

$apiKey = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
if (-not $apiKey) { $apiKey = $env:DEEPSEEK_API_KEY }
if (-not $apiKey) {
  Write-Log '缺少 DEEPSEEK_API_KEY（用户环境变量），无法启动。'
  exit 2
}
$env:DSH_HOME = $DshHome
$env:DEEPSEEK_API_KEY = $apiKey
$env:PATH = "$env:APPDATA\npm;$env:PATH"

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Log '找不到 node.exe'; exit 3 }

$npmCmd = Join-Path $env:APPDATA 'npm\npm.cmd'
if (-not (Test-Path $npmCmd)) { $npmCmd = 'npm.cmd' }

# 固定入口的 302 小代理（只监听本机回环地址）
$proxy = $null
if (-not $NoProxy -and (Test-Path $entryJs)) {
  $env:JINGJING_ENTRY_PORT = [string]$EntryPort
  $env:JINGJING_URL_FILE = $urlFile
  $proxy = Start-Process -FilePath $node -ArgumentList @($entryJs) -WorkingDirectory $DataHome -PassThru -WindowStyle Hidden
  Write-Log ('固定入口已启动：http://127.0.0.1:{0}/  (pid {1})' -f $EntryPort, $proxy.Id)
}

$backoff = 5
while (-not (Test-Path $stopFile)) {
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
    if (Test-Path $outLog) {
      $hit = Select-String -Path $outLog -Pattern 'dsh web:\s*(http\S+)' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($hit) {
        $url = $hit.Matches[0].Groups[1].Value
        Set-Content -Path $urlFile -Value $url -Encoding UTF8
        Write-Log ('已发布入口：' + $url)
        $backoff = 5
      }
    }
  }

  if (Test-Path $urlFile) { Write-Log 'dsh web 正在运行。' } else { Write-Log 'dsh web 没有给出可用地址（看 logs\web-*.log）。' }

  # 等它退出；期间响应停止文件。
  while (-not $proc.HasExited -and -not (Test-Path $stopFile)) { Start-Sleep -Seconds 2 }
  if (Test-Path $stopFile) {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    break
  }
  Write-Log ('dsh web 退出（exit {0}），{1} 秒后重试' -f $proc.ExitCode, $backoff)
  Start-Sleep -Seconds $backoff
  if ($backoff -lt 60) { $backoff = [Math]::Min(60, $backoff * 2) }
}

Write-Log '守护进程退出。'
if ($proxy -and -not $proxy.HasExited) { Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue }
