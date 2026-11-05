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
function Set-MemoryOverride([string]$text, [string]$homePath, [bool]$appendIfMissing) {
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
    $block = $nl + '- id: life-innovation' + $nl + "  name: 'life-innovation'" + $nl + '  config:' + $nl + ('    home: ' + $homePath) + $nl
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
  $homeIdx = -1
  for ($j = $keep.Start + 1; $j -le $keep.End; $j++) {
    if ($lines[$j] -match '^\s*home:\s*') { $homeIdx = $j; break }
  }
  if ($homeIdx -ge 0) {
    $ind = $lines[$homeIdx].Length - $lines[$homeIdx].TrimStart().Length
    $old = ($lines[$homeIdx] -replace '^\s*home:\s*', '').Trim()
    if ((Normalize-PathValue $old) -ne (Normalize-PathValue $homePath)) {
      $lines[$homeIdx] = (' ' * $ind) + 'home: ' + $homePath
    }
  } else {
    $cfgIdx = -1
    for ($j = $keep.Start + 1; $j -le $keep.End; $j++) {
      if ($lines[$j] -match '^\s*config:\s*$') { $cfgIdx = $j; break }
    }
    if ($cfgIdx -ge 0) {
      $cfgIndent = $lines[$cfgIdx].Length - $lines[$cfgIdx].TrimStart().Length
      $lines.Insert($cfgIdx + 1, ((' ' * ($cfgIndent + 2)) + 'home: ' + $homePath))
    } else {
      $lines.InsertRange($keep.Start + 1, [string[]]@(
        ((' ' * ($keep.Indent + 2)) + 'config:'),
        ((' ' * ($keep.Indent + 4)) + 'home: ' + $homePath)
      ))
    }
  }
  return ($lines -join $nl)
}

# 迁移 patch：旧插件名 -> life-innovation，并把唯一的 home 覆盖项改成 -DataHome。
function Migrate-PatchFile([string]$path) {
  $text = Read-Utf8Text $path
  $orig = $text
  $text = $text -replace '@local/dsh-jingjing', 'life-innovation'
  $text = $text -replace 'dsh-jingjing', 'life-innovation'
  $text = Set-MemoryOverride -text $text -homePath $DataFwd -appendIfMissing ($DataFwd -ne 'D:/jingjing-home')
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
$pkgExists = Test-Path $pkgPath
$patchExists = Test-Path $patchPath
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
$backupBody = @"
`$ErrorActionPreference = 'Stop'
& '$nodePath' '$PluginPath\tools\backup.mjs' --db '$DbPath' --data '$DataHome' --keep 14 *>> '$DataHome\logs\backup.log'
exit `$LASTEXITCODE
"@
Run-If {
  [IO.File]::WriteAllText($backupPs1, $backupBody, (New-Object Text.UTF8Encoding($true)))
  $wrapper = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0backup.ps1`"`r`n"
  [IO.File]::WriteAllText($backupCmd, $wrapper, [Text.Encoding]::ASCII)
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
