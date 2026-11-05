#requires -Version 5.1
<#
.SYNOPSIS
  把鲸鲸装到一台干净的 Windows 机器上：建 profile、装插件、建数据目录、挂每日存档。
.DESCRIPTION
  只做四件事，全部幂等：写 profile（package.json / cordis.patch.yml）、装 life-innovation、
  建她的家（state/diary/logs/backups）、注册每日存档任务。不改你已有的其他 profile。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install\install.ps1 -DryRun
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install\install.ps1 -DataHome E:\jingjing-home
#>
[CmdletBinding()]
param(
  [string]$DataHome = 'D:\jingjing-home',
  [string]$DshHome = 'D:\dsh-home',
  [string]$Profile = 'jingjing',
  [int]$Port = 60081,
  [string]$PluginPath = '',
  [int]$EntryPort = 60080,
  [switch]$SkipPluginAdd,
  [switch]$NoService,
  [switch]$SkipBackupTask,
  [switch]$StartService,
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "   $text" }
function Warn($text) { Write-Host "   ! $text" -ForegroundColor Yellow }
function Run-If($block) {
  if ($DryRun) { Info '(dry-run) 跳过执行' } else { & $block }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $PluginPath) { $PluginPath = (Resolve-Path (Join-Path $here '..')).Path }
$PluginPath = $PluginPath.TrimEnd('\')
$DataHome = $DataHome.TrimEnd('\')
$DshHome = $DshHome.TrimEnd('\')
$DataFwd = $DataHome.Replace('\', '/')
$PluginFwd = $PluginPath.Replace('\', '/')
$ProfileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$DbPath = Join-Path $DataHome 'state\jingjing.sqlite'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Step "0. 环境检查"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '找不到 node。先装 Node.js 22+（推荐 24）。' }
Info ("node " + (& node --version))
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Warn '找不到 npm；装插件时会用到。' }
$env:PATH = "$env:APPDATA
pm;$env:PATH"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  # 插件管理器靠 pnpm 装包；没有它时旧版只警告，结果插件没装上、web 照常起，
  # 用户看到的是「她没记忆」而不是安装失败。这里直接补装，装不上就停。
  if ($DryRun) {
    Warn '(dry-run) 将执行 npm i -g pnpm@10'
  } else {
    Info '没找到 pnpm，先装：npm i -g pnpm@10'
    & npm.cmd install -g pnpm@10 2>&1 | Out-Null
    $env:PATH = "$env:APPDATA
pm;$env:PATH"
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
      throw 'pnpm 装不上（npm i -g pnpm@10 失败）。装好后再重跑本脚本；或加 -SkipPluginAdd 手动装插件。'
    }
    Info ('pnpm ' + (& pnpm --version))
  }
}
if (-not (Test-Path (Join-Path $PluginPath 'package.json'))) {
  throw "插件目录不像插件：$PluginPath（找不到 package.json）"
}
$apiKey = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
if (-not $apiKey) { Warn '用户环境变量里没有 DEEPSEEK_API_KEY；启动后会连不上模型。' }

Step "1. 建她的家：$DataHome"
foreach ($sub in @('state', 'diary', 'logs', 'backups')) {
  $p = Join-Path $DataHome $sub
  if (Test-Path $p) { Info "已有 $sub" }
  else { Run-If { New-Item -ItemType Directory -Path $p -Force | Out-Null }; Info "建 $sub" }
}

Step "2. 写 profile：$ProfileDir"
$pkgPath = Join-Path $ProfileDir 'package.json'
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$pkg = @"
{
  "name": "dsh-profile-$Profile",
  "private": true,
  "dependencies": {
    "life-innovation": "link:$PluginFwd"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "life-innovation"
      ]
    }
  }
}
"@
$memoryOverride = ''
if ($DataFwd -ne 'D:/jingjing-home') {
  $memoryOverride = @"

- id: life-innovation
  name: 'life-innovation'
  config:
    home: $DataFwd
"@
}
$patch = @"
# 鲸鲸的 profile 补丁层（由 install.ps1 生成）。
# 人格与记忆都住在 life-innovation 插件包里；这里只放环境相关的选择。
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: jingjing-chat

- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high

- id: tool-working-directory
  name: '@deepseek-ai/dsh-tool-working-directory'
  disabled: true

- insert:
    - id: llm-deepseek
      name: '@deepseek-ai/dsh-llm-deepseek-api-key'
      config:
        reasoningEffort: high
        apiKeyEnv: DEEPSEEK_API_KEY
$memoryOverride
"@
if ((Test-Path $pkgPath) -and -not $Force) {
  Info 'package.json 已存在，保留（要重写成全新状态加 -Force）'
} else {
  Run-If {
    if (Test-Path $pkgPath) { Copy-Item $pkgPath "$pkgPath.bak-$Stamp" }
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
    [IO.File]::WriteAllText($pkgPath, $pkg, (New-Object Text.UTF8Encoding($false)))
  }
  if (-not $DryRun) { Info "写 package.json" } else { Info "(dry-run) 将写 package.json" }
}
if ((Test-Path $patchPath) -and -not $Force) {
  Info 'cordis.patch.yml 已存在，保留（加 -Force 会备份后重写）'
} else {
  Run-If {
    if (Test-Path $patchPath) { Copy-Item $patchPath "$patchPath.bak-$Stamp" }
    [IO.File]::WriteAllText($patchPath, $patch, (New-Object Text.UTF8Encoding($false)))
  }
  if (-not $DryRun) { Info '写 cordis.patch.yml' } else { Info '(dry-run) 将写 cordis.patch.yml' }
}

Step "3. 装插件 life-innovation"
if ($SkipPluginAdd) {
  Info '按参数跳过（package.json 里已写好 link，启动时会解析）'
} elseif ($DryRun) {
  Info "(dry-run) 会执行：dsh plugin --profile $Profile add $PluginPath"
} else {
  $env:DSH_HOME = $DshHome
  $log = Join-Path $DataHome 'logs\plugin-add.log'
  $cmd = "npm exec --yes --package @deepseek-ai/dsh@0.2.1-rc.5 -- dsh plugin --profile $Profile add `"$PluginPath`""
  Info "执行：$cmd"
  & cmd.exe /c "$cmd > `"$log`" 2>&1"
  if ($LASTEXITCODE -ne 0) {
    # 不能只是警告：插件没装上时 web 仍会启动，只是她成了没有记忆的壳。
    throw "插件安装失败（退出码 $LASTEXITCODE）。看 $log；修好后重跑本脚本（或 -SkipPluginAdd 手动执行 dsh plugin add）。"
  } else {
    Info '插件已安装'
  }
}

Step "4. 每日存档（03:30，保留 14 份）"
$backupCmd = Join-Path $DataHome 'backup.cmd'
if ($SkipBackupTask) { Info '按参数跳过（不写 backup.cmd，也不注册计划任务）' } else {
$backupBody = @"
@echo off
"$((Get-Command node).Source)" "$PluginPath\tools\backup.mjs" --db "$DbPath" --data "$DataHome" --keep 14 >> "$DataHome\logs\backup.log" 2>&1
"@
Run-If {
  [IO.File]::WriteAllText($backupCmd, $backupBody, (New-Object Text.ASCIIEncoding))
  & schtasks.exe /Create /F /SC DAILY /ST 03:30 /TN "JingjingDailyBackup" /TR "`"$backupCmd`"" | Out-Null
  if ($LASTEXITCODE -ne 0) { Warn "计划任务创建失败（退出码 $LASTEXITCODE）；可以手动把 $backupCmd 挂到任务计划程序。" }
  else { Info '已注册计划任务 JingjingDailyBackup' }
}

}

Step "5. 开机自启 + 固定入口（登录时启动守护进程，默认端口 $EntryPort）"
$serviceDir = Join-Path $DataHome 'service'
$svcSrc = Join-Path $here 'service.ps1'
$entrySrc = Join-Path $here 'entry.mjs'
if ($NoService) {
  Info '按参数跳过（可以以后重跑本脚本，或手动注册计划任务）'
} elseif (-not (Test-Path $svcSrc)) {
  Warn "缺少 $svcSrc，跳过服务注册"
} else {
  $svcText = Get-Content -Raw -Encoding UTF8 -Path $svcSrc
  $svcText = $svcText.Replace('@DATA_HOME@', $DataHome).Replace('@DSH_HOME@', $DshHome).Replace('@PROFILE@', $Profile).Replace('@PORT@', [string]$Port).Replace('@ENTRY_PORT@', [string]$EntryPort)
  Run-If {
    New-Item -ItemType Directory -Force -Path $serviceDir | Out-Null
    [IO.File]::WriteAllText((Join-Path $serviceDir 'service.ps1'), $svcText, (New-Object Text.UTF8Encoding($true)))
    Copy-Item $entrySrc (Join-Path $serviceDir 'entry.mjs') -Force
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $runValue = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $serviceDir 'service.ps1') + '"'
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name 'JingjingService' -Value $runValue
    Info '已登记开机自启：HKCU\...\Run\JingjingService（登录时启动，不需要管理员）'
  }
  if ($StartService -and -not $DryRun) {
    $svcPath = Join-Path $serviceDir 'service.ps1'
    Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $svcPath + '"') -WindowStyle Hidden
    Start-Sleep -Seconds 2
    Info '守护进程已在后台启动（固定入口可能还要几秒才可用）'
  }
}

Step "完成"
Info "数据目录：$DataHome"
Info "记忆库：$DbPath"
Info "启动："
Info "  `$env:DSH_HOME='$DshHome'; dsh --profile $Profile --port $Port --no-open"
Info "  或让守护进程拉起：HKCU Run\JingjingService（登录时启动）"
Info "固定入口（书签用这个）：http://127.0.0.1:$EntryPort/"
Info "  它 302 到这一次启动的带 token 地址；token 仍然由 dsh 自己校验。"
Info "备份：$backupCmd（每天 03:30）"
if ($DryRun) { Write-Host "`n(dry-run：没有写任何文件、没有建任务)" -ForegroundColor Yellow }
