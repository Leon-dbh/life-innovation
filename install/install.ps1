#requires -Version 5.1
<#
.SYNOPSIS
  把 life-innovation 装到一台干净的 Windows 机器上：建 profile、装插件、建数据目录、挂每日存档。
.DESCRIPTION
  只做四件事，全部幂等：写 profile（package.json / cordis.patch.yml）、装 life-innovation、
  建 agent 的家（state/diary/logs/backups）、注册每日存档任务。不改你已有的其他 profile。
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install\install.ps1 -DryRun
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install\install.ps1 -DataHome E:\life-innovation-home
#>
[CmdletBinding()]
param(
  [string]$DataHome = 'D:\life-innovation-home',
  [string]$DshHome = 'D:\dsh-home',
  [string]$Profile = 'life-innovation',
  [int]$Port = 60081,
  [string]$PluginPath = '',
  [int]$EntryPort = 60080,
  [string]$AgentName = '',
  [switch]$SkipPluginAdd,
  [switch]$NoService,
  [switch]$SkipBackupTask,
  [switch]$StartService,
  [switch]$Force,
  [switch]$ForceNewInstance,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "   $text" }
function Warn($text) { Write-Host "   ! $text" -ForegroundColor Yellow }
function Run-If($block) {
  if ($DryRun) { Info '(dry-run) 跳过执行' } else { & $block }
}

# ---- 读写 profile 的小工具（保留原编码，迁移前先备份） ----
function Read-Utf8Text([string]$path) {
  return [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
}
function Test-Utf8Bom([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  return ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
}
function Write-Utf8Text([string]$path, [string]$text, [bool]$bom) {
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($bom)))
}
function Normalize-PathValue([string]$value) {
  if (-not $value) { return '' }
  $v = $value.Trim()
  if ($v.Length -ge 2) {
    if (($v.StartsWith("'") -and $v.EndsWith("'")) -or ($v.StartsWith('"') -and $v.EndsWith('"'))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
  }
  return $v.Replace('\', '/').TrimEnd('/').ToLowerInvariant()
}

# 把老 profile 的 dsh-jingjing bundle 名迁移到 life-innovation，只动 bundles。
function Migrate-ProfileBundles([string]$path) {
  try {
    $obj = ConvertFrom-Json -InputObject (Read-Utf8Text $path)
  } catch {
    Warn ("package.json 解析失败，跳过 bundle 迁移：{0}" -f $_.Exception.Message)
    return
  }
  $bundles = @()
  if ($obj.dsh -and $obj.dsh.profile -and $obj.dsh.profile.bundles) {
    $bundles = @($obj.dsh.profile.bundles)
  }
  $new = New-Object System.Collections.Generic.List[string]
  $changed = $false
  foreach ($b in $bundles) {
    $name = [string]$b
    if ($name -eq 'dsh-jingjing' -or $name -eq '@local/dsh-jingjing') { $changed = $true; continue }
    if (-not $new.Contains($name)) { $new.Add($name) }
  }
  if (-not $new.Contains('life-innovation')) { $new.Add('life-innovation'); $changed = $true }
  if (-not $changed) { return }

  if (-not $obj.dsh) {
    $obj | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if (-not $obj.dsh.profile) {
    $obj.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  if (-not $obj.dsh.profile.PSObject.Properties['bundles']) {
    $obj.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
  }
  $obj.dsh.profile.bundles = @($new)
  $hadBom = Test-Utf8Bom $path
  Copy-Item -LiteralPath $path -Destination ("{0}.bak-{1}" -f $path, $Stamp)
  Write-Utf8Text $path ($obj | ConvertTo-Json -Depth 20) $hadBom
  Info ("已迁移 package.json：bundles 改为 {0}（旧文件备份为 .bak-{1}）" -f (($new -join ', ')), $Stamp)
}

# 在 patch 文本里 upsert 唯一的 life-innovation（兼容旧 id jingjing-memory）home 覆盖项。
function Quote-Yaml([string]$value) {
  return "'" + $value.Replace("'", "''") + "'"
}

# 判断 SQLite 库里有没有真实记忆。只 Test-Path 会把「空库」当成已有实例，
# 从而让旧家永远不会回退。Node 不可用时退回文件大小，但只作为最后兜底。
function Test-DatabaseHasRows([string]$file) {
  if (-not (Test-Path -LiteralPath $file)) { return $false }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { return ((Get-Item -LiteralPath $file).Length -gt 120000) }
  $js = "const {DatabaseSync}=require('node:sqlite');try{const db=new DatabaseSync(process.argv[1],{readOnly:true});let n=0;for(const t of ['raw_turns','raw_archive','summaries','assertions','profiles','actions']){try{n+=db.prepare('SELECT COUNT(*) c FROM '+t).get().c}catch{}}db.close();process.exit(n>0?0:1)}catch{process.exit(2)}"
  & $nodeCmd.Source -e $js $file 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

# 在 patch 文本里 upsert 唯一的 life-innovation（兼容旧 id jingjing-memory）的 config 项。
# home 总是跟随本次 -DataHome；dbPath 也一起更新（否则插件写旧库、备份写新库）；
# agentName 只在显式传了 -AgentName 时更新，没传就保留用户原来的名字。
function Set-MemoryOverride([string]$text, [string]$homePath, [string]$dbPath, [string]$agentName, [bool]$appendIfMissing) {
  $nl = "`n"
  if ($text.Contains("`r`n")) { $nl = "`r`n" }
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.AddRange([string[]]([regex]::Split($text, "\r?\n")))

  $idPattern = '^\s*-\s+id:\s*(life-innovation|jingjing-memory)\s*$'
  $blocks = New-Object System.Collections.Generic.List[object]
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $idPattern) {
      $id = $matches[1]
      $indent = $lines[$i].Length - $lines[$i].TrimStart().Length
      $end = $lines.Count - 1
      for ($j = $i + 1; $j -lt $lines.Count; $j++) {
        $line = $lines[$j]
        if ($line.Trim() -eq '') { continue }
        $ind = $line.Length - $line.TrimStart().Length
        if ($ind -lt $indent -and $line -notmatch '^\s*#') { $end = $j - 1; break }
        if ($ind -eq $indent -and $line -match '^\s*-\s') { $end = $j - 1; break }
        if ($indent -eq 0 -and $ind -eq 0 -and $line -notmatch '^\s*[-#]') { $end = $j - 1; break }
      }
      $blocks.Add([pscustomobject]@{ Start = $i; End = $end; Indent = $indent; Id = $id })
      $i = $end
    }
  }

  if ($blocks.Count -eq 0) {
    if (-not $appendIfMissing) { return $text }
    $first = $nl + '- id: life-innovation'
    $blockLines = @(
      $first,
      "  name: 'life-innovation'",
      '  config:',
      ('    home: ' + (Quote-Yaml $homePath)),
      ('    dbPath: ' + (Quote-Yaml $dbPath))
    )
    if ($agentName) { $blockLines += ('    agentName: ' + (Quote-Yaml $agentName)) }
    $block = ($blockLines -join $nl) + $nl
    if ($text.Length -eq 0) { return $block.TrimStart("`r", "`n") }
    if (-not $text.EndsWith("`n")) { $text += $nl }
    return ($text + $block)
  }

  # 只保留一个插件实例：优先 life-innovation，否则第一个旧 id 块。
  $keep = $null
  foreach ($b in $blocks) { if ($b.Id -eq 'life-innovation') { $keep = $b; break } }
  if (-not $keep) { $keep = $blocks[0] }

  foreach ($b in ($blocks | Where-Object { $_.Start -ne $keep.Start } | Sort-Object Start -Descending)) {
    $count = $b.End - $b.Start + 1
    if ($b.End -lt $keep.Start) {
      $keep.Start -= $count
      $keep.End -= $count
    } elseif ($b.Start -le $keep.End) {
      $keep.End -= $count
    }
    $lines.RemoveRange($b.Start, $count)
  }

  $lines[$keep.Start] = $lines[$keep.Start] -replace 'jingjing-memory', 'life-innovation'

  # 找/建 config: 块；只改 config 下的键，不碰其他配置。
  $cfgIdx = -1
  for ($j = $keep.Start + 1; $j -le $keep.End; $j++) {
    if ($lines[$j] -match '^\s*config:\s*$') { $cfgIdx = $j; break }
  }
  if ($cfgIdx -lt 0) {
    $cfgIndent = $keep.Indent + 2
    $lines.Insert($keep.Start + 1, ((' ' * $cfgIndent) + 'config:'))
    $cfgIdx = $keep.Start + 1
    $keep.End += 1
  }
  $cfgIndent = $lines[$cfgIdx].Length - $lines[$cfgIdx].TrimStart().Length
  $cfgEnd = $keep.End
  for ($j = $cfgIdx + 1; $j -le $keep.End; $j++) {
    if ($lines[$j].Trim() -eq '') { continue }
    $ind = $lines[$j].Length - $lines[$j].TrimStart().Length
    if ($ind -le $cfgIndent) { $cfgEnd = $j - 1; break }
  }

  $values = [ordered]@{ home = $homePath; dbPath = $dbPath }
  if ($agentName) { $values['agentName'] = $agentName }
  foreach ($key in $values.Keys) {
    $value = [string]$values[$key]
    $idx = -1
    for ($j = $cfgIdx + 1; $j -le $cfgEnd; $j++) {
      if ($lines[$j] -match ('^\s*' + [regex]::Escape($key) + ':\s*')) { $idx = $j; break }
    }
    if ($idx -ge 0) {
      $ind = $lines[$idx].Length - $lines[$idx].TrimStart().Length
      $lines[$idx] = (' ' * $ind) + $key + ': ' + (Quote-Yaml $value)
    } else {
      $insertAt = $cfgEnd + 1
      $lines.Insert($insertAt, ((' ' * ($cfgIndent + 2)) + $key + ': ' + (Quote-Yaml $value)))
      $cfgEnd += 1
      $keep.End += 1
    }
  }
  return ($lines -join $nl)
}

# 升级后旧版本的自启/计划任务还留着，会同时拉起两个实例、备份两份库。
# 只删本产品旧版本用过的两个固定名字；查询/删除失败只告警，不阻断安装。
function Remove-LegacyRunValue {
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  try {
    $prop = Get-ItemProperty -Path $runKey -Name 'JingjingService' -ErrorAction SilentlyContinue
    if ($prop -and $prop.PSObject.Properties['JingjingService']) {
      Remove-ItemProperty -Path $runKey -Name 'JingjingService' -ErrorAction Stop
      Info '已移除旧开机自启 JingjingService'
    }
  } catch {
    Warn ("旧自启项 JingjingService 清理失败：{0}" -f $_.Exception.Message)
  }
}
function Remove-LegacyBackupTask {
  try {
    $oldTask = Get-ScheduledTask -TaskName 'JingjingDailyBackup' -ErrorAction SilentlyContinue
    if ($oldTask) {
      Unregister-ScheduledTask -TaskName 'JingjingDailyBackup' -Confirm:$false -ErrorAction Stop
      Info '已移除旧计划任务 JingjingDailyBackup'
    }
  } catch {
    Warn ("旧计划任务 JingjingDailyBackup 清理失败：{0}" -f $_.Exception.Message)
  }
}

# 升级时旧守护进程还占着固定入口端口；只写新 service.ps1 不杀旧进程，
# 新入口会 listen 失败。只杀 pid 文件里、命令行确实是本产品 service.ps1 的进程。
function Stop-OldService {
  $pidFile = Join-Path $DataHome 'state\service.pid'
  if (-not (Test-Path -LiteralPath $pidFile)) { return }
  $rawPid = $null
  try { $rawPid = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction Stop).Trim() } catch { $rawPid = $null }
  $oldPid = 0
  if (-not $rawPid -or -not [int]::TryParse($rawPid, [ref]$oldPid) -or $oldPid -le 0) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    return
  }
  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $oldPid) -ErrorAction SilentlyContinue
  if (-not $proc) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    return
  }
  $cmdLine = [string]$proc.CommandLine
  if ($cmdLine -notmatch 'service\.ps1') {
    Warn ("忽略旧 pid {0}：命令行不像本产品的 service.ps1" -f $oldPid)
    return
  }
  Warn ("停止旧守护进程（pid {0}），避免新旧实例抢端口" -f $oldPid)
  & taskkill.exe /PID $oldPid /T /F 2>&1 | Out-Null
  Start-Sleep -Milliseconds 800
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

# 迁移 patch：旧插件名 -> life-innovation，并把 home/dbPath（以及显式给出的 agentName）改成本次安装值。
function Migrate-PatchFile([string]$path) {
  $text = Read-Utf8Text $path
  $orig = $text
  $text = $text -replace '@local/dsh-jingjing', 'life-innovation'
  $text = $text -replace 'dsh-jingjing', 'life-innovation'
  $text = $text -replace 'default:\s*jingjing-chat', 'default: life-innovation'
  $text = Set-MemoryOverride -text $text -homePath $DataFwd -dbPath $DbPath -agentName $AgentName -appendIfMissing ($DataFwd -ne 'D:/life-innovation-home' -or $AgentName)
  if ($text -ne $orig) {
    $hadBom = Test-Utf8Bom $path
    Copy-Item -LiteralPath $path -Destination ("{0}.bak-{1}" -f $path, $Stamp)
    Write-Utf8Text $path $text $hadBom
    Info ("已迁移 cordis.patch.yml（旧文件备份为 .bak-{0}）" -f $Stamp)
  }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $PluginPath) { $PluginPath = (Resolve-Path (Join-Path $here '..')).Path }
$PluginPath = $PluginPath.TrimEnd('\')
$DataHome = $DataHome.TrimEnd('\')
$DshHome = $DshHome.TrimEnd('\')
# 0.1.x 的默认家是 D:\jingjing-home，0.2.x 改成了 D:\life-innovation-home。
# 只升级插件、不重跑安装器时，插件自己会回退旧库；重跑安装器时这里也按升级处理，
# 避免用默认参数一跑就新开一个空实例。
$LegacyDataHome = 'D:\jingjing-home'
$LegacyProfileName = 'jingjing'
$LegacyDefaultDb = Join-Path $LegacyDataHome 'state\jingjing.sqlite'
$NewDefaultHome = 'D:\life-innovation-home'
if (-not $PSBoundParameters.ContainsKey('DataHome') -and -not $ForceNewInstance -and -not (Test-DatabaseHasRows (Join-Path $DataHome 'state\life-innovation.sqlite')) -and (Test-DatabaseHasRows $LegacyDefaultDb)) {
  Warn ("发现旧家 {0}（含旧记忆库），按升级处理，继续使用旧家；要新建空实例请显式 -DataHome ... -ForceNewInstance" -f $LegacyDataHome)
  $DataHome = $LegacyDataHome
  if (-not $PSBoundParameters.ContainsKey('Profile') -and (Test-Path (Join-Path $DshHome ("profiles\{0}" -f $LegacyProfileName)))) {
    $Profile = $LegacyProfileName
  }
} elseif ($DataHome -ne $LegacyDataHome -and (Test-Path $LegacyDefaultDb) -and -not $ForceNewInstance) {
  Warn ("旧家 {0} 仍在（含旧记忆库）；本次使用 {1}。旧实例/旧备份不会被自动删除。" -f $LegacyDataHome, $DataHome)
}
$DataFwd = $DataHome.Replace('\', '/')
$PluginFwd = $PluginPath.Replace('\', '/')
$ProfileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$DbPath = Join-Path $DataHome 'state\life-innovation.sqlite'
$LegacyDbPath = Join-Path $DataHome 'state\jingjing.sqlite'
if (-not (Test-DatabaseHasRows $DbPath) -and (Test-DatabaseHasRows $LegacyDbPath)) { $DbPath = $LegacyDbPath }
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Step "0. 环境检查"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '找不到 node。先装 Node.js 22+（推荐 24）。' }
Info ("node " + (& node --version))
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Warn '找不到 npm；装插件时会用到。' }
$env:PATH = "$env:APPDATA\npm;$env:PATH"
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  # 插件管理器靠 pnpm 装包；没有它时旧版只警告，结果插件没装上、web 照常起，
  # 用户看到的是「她没记忆」而不是安装失败。这里直接补装，装不上就停。
  if ($DryRun) {
    Warn '(dry-run) 将执行 npm i -g pnpm@10'
  } else {
    Info '没找到 pnpm，先装：npm i -g pnpm@10'
    & npm.cmd install -g pnpm@10 2>&1 | Out-Null
    $env:PATH = "$env:APPDATA\npm;$env:PATH"
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

Step "1. 建 agent 的家：$DataHome"
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
$AgentNameYaml = Quote-Yaml $AgentName
$DataYaml = Quote-Yaml $DataFwd
$DbYaml = Quote-Yaml $DbPath
$memoryOverride = ''
if ($DataFwd -ne 'D:/life-innovation-home' -or $AgentName) {
  $memoryOverride = @"

- id: life-innovation
  name: 'life-innovation'
  config:
    home: $DataYaml
    dbPath: $DbYaml
    agentName: $AgentNameYaml
"@
}
$patch = @"
# life-innovation 的 profile 补丁层（由 install.ps1 生成）。
# 人格与记忆都住在 life-innovation 插件包里；这里只放环境相关的选择。
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: life-innovation

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
$pkgExists = Test-Path $pkgPath
$patchExists = Test-Path $patchPath
if (-not $patch.EndsWith("`n")) { $patch += "`n" }
if ($pkgExists -and -not $Force) {
  Info 'package.json 已存在，保留（要重写成全新状态加 -Force）'
  if ($DryRun) {
    Info '(dry-run) 会检查并迁移旧的 dsh-jingjing bundle 名'
  } else {
    Migrate-ProfileBundles $pkgPath
  }
} else {
  Run-If {
    if ($pkgExists) { Copy-Item $pkgPath "$pkgPath.bak-$Stamp" }
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
    Write-Utf8Text $pkgPath $pkg $false
  }
  if (-not $DryRun) { Info "写 package.json" } else { Info "(dry-run) 将写 package.json" }
}
if ($patchExists -and -not $Force) {
  Info 'cordis.patch.yml 已存在，保留（加 -Force 会备份后重写）'
  if ($DryRun) {
    Info '(dry-run) 会迁移旧插件 id / 按 -DataHome 更新 home'
  } else {
    Migrate-PatchFile $patchPath
  }
} else {
  Run-If {
    if ($patchExists) { Copy-Item $patchPath "$patchPath.bak-$Stamp" }
    Write-Utf8Text $patchPath $patch $false
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
# .cmd 只留 ASCII：cmd.exe 按 OEM 代码页读批处理，中文路径会被解码成乱码。
# 真正的备份逻辑放进 backup.ps1（PowerShell 按 UTF-8 BOM 读），cmd 只做转发。
$nodePath = (Get-Command node).Source
$backupPs1 = Join-Path $DataHome 'backup.ps1'
# 路径里有单引号（例如 O'Brien）时，PowerShell 单引号字符串要写成两个单引号。
$nodePs = $nodePath.Replace("'", "''")
$pluginPs = $PluginPath.Replace("'", "''")
$dbPs = $DbPath.Replace("'", "''")
$dataPs = $DataHome.Replace("'", "''")
$logPs = (Join-Path $DataHome 'logs/backup.log').Replace("'", "''")
$backupBody = @"
`$ErrorActionPreference = 'Continue'
& '$nodePs' '$pluginPs/tools/backup.mjs' --db '$dbPs' --data '$dataPs' --keep 14 *>> '$logPs'
exit `$LASTEXITCODE
"@
Run-If {
  [IO.File]::WriteAllText($backupPs1, $backupBody, (New-Object Text.UTF8Encoding($true)))
  $wrapper = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0backup.ps1`"`r`n"
  [IO.File]::WriteAllText($backupCmd, $wrapper, [Text.Encoding]::ASCII)
  & schtasks.exe /Create /F /SC DAILY /ST 03:30 /TN "LifeInnovationDailyBackup" /TR "`"$backupCmd`"" | Out-Null
  if ($LASTEXITCODE -ne 0) { Warn "计划任务创建失败（退出码 $LASTEXITCODE）；可以手动把 $backupCmd 挂到任务计划程序。" }
  else { Info '已注册计划任务 LifeInnovationDailyBackup'; Remove-LegacyBackupTask }
}

}

Step "5. 开机自启 + 固定入口（登录时启动守护进程，默认端口 $EntryPort）"
$serviceDir = Join-Path $DataHome 'service'
$svcSrc = Join-Path $here 'service.ps1'
$entrySrc = Join-Path $here 'entry.mjs'
$homeSrc = Join-Path $here 'home.mjs'
if ($NoService) {
  Info '按参数跳过（可以以后重跑本脚本，或手动注册计划任务）'
} elseif (-not (Test-Path $svcSrc)) {
  Warn "缺少 $svcSrc，跳过服务注册"
} else {
  if (-not (Test-Path $homeSrc)) { throw "缺少 $homeSrc——固定入口的 /home 页面需要它" }
  $svcText = Get-Content -Raw -Encoding UTF8 -Path $svcSrc
  # 这些值会落进 service.ps1 的单引号字符串；路径/名字里有 O'Brien 这种单引号时必须翻倍。
  $dataPs = $DataHome.Replace("'", "''")
  $dshPs = $DshHome.Replace("'", "''")
  $profilePs = $Profile.Replace("'", "''")
  $agentPs = $AgentName.Replace("'", "''")
  $dbPs = $DbPath.Replace("'", "''")
  $svcText = $svcText.Replace('@DATA_HOME@', $dataPs).Replace('@DSH_HOME@', $dshPs).Replace('@PROFILE@', $profilePs).Replace('@PORT@', [string]$Port).Replace('@ENTRY_PORT@', [string]$EntryPort).Replace('@AGENT_NAME@', $agentPs).Replace('@DB_PATH@', $dbPs)
  Run-If {
    New-Item -ItemType Directory -Force -Path $serviceDir | Out-Null
    [IO.File]::WriteAllText((Join-Path $serviceDir 'service.ps1'), $svcText, (New-Object Text.UTF8Encoding($true)))
    Copy-Item $entrySrc (Join-Path $serviceDir 'entry.mjs') -Force
    Copy-Item $homeSrc (Join-Path $serviceDir 'home.mjs') -Force
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $runValue = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $serviceDir 'service.ps1') + '"'
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name 'LifeInnovationService' -Value $runValue
    Info '已登记开机自启：HKCU\...\Run\LifeInnovationService（登录时启动，不需要管理员）'
    Remove-LegacyRunValue
  }
  if ($StartService -and -not $DryRun) {
    Stop-OldService
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
Info "  或让守护进程拉起：HKCU Run\LifeInnovationService（登录时启动）"
Info "固定入口（书签用这个）：http://127.0.0.1:$EntryPort/"
Info "  它 302 到这一次启动的带 token 地址；token 仍然由 dsh 自己校验。"
Info "备份：$backupCmd（每天 03:30）"
Info "自检：node `"$PluginPath\tools\doctor.mjs`" --home `"$DataHome`" --no-ports"
if ($DryRun) { Write-Host "`n(dry-run：没有写任何文件、没有建任务)" -ForegroundColor Yellow }
