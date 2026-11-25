# 把本插件「复制」安装到 DSH profile 的插件目录（工作区只作为镜像源）
#
# 为什么需要它：`dsh plugin add` 建的是 Junction（链接），DSH 实际加载的是工作区文件；
# 整理工作区会连带影响已安装的插件。这个脚本改成复制安装，插件目录里放的是独立副本。
#
# 用法（在插件根目录或在任意位置指定 -Source）：
#   powershell -ExecutionPolicy Bypass -File scripts\install-copy.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-copy.ps1 -Profile desktop
#   powershell -ExecutionPolicy Bypass -File scripts\install-copy.ps1 -WhatIf          # 只打印将要做的事
#
# 之后每次改完代码：先 `pnpm run build`，再跑一次本脚本，然后重启 DSH。

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Profile = 'desktop',
  [string]$Source = '',
  [string]$PackageName = 'dsh-infinite-context-orchestrator'
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot 在 param 默认值里可能是空的（Windows PowerShell 5.1），所以放到函数体里解析。
if ([string]::IsNullOrWhiteSpace($Source)) {
  $Source = Split-Path -Parent $PSScriptRoot
}

$profileRoot = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
if (-not (Test-Path -LiteralPath $profileRoot)) { throw "profile 不存在: $profileRoot" }

$target = Join-Path $profileRoot "node_modules\$PackageName"
$pkgJson = Join-Path $profileRoot 'package.json'
if (-not (Test-Path -LiteralPath $pkgJson)) { throw "profile package.json 不存在: $pkgJson" }
if (-not (Test-Path -LiteralPath (Join-Path $Source 'package.json'))) { throw "源目录不是插件包: $Source" }

# 需要同步的内容（不带走 node_modules / 临时文件 / 本地配置）
$include = @('lib', 'client.js', 'cordis.patch.yml', 'package.json', 'README.md', 'USERGUIDE.md',
  'CHANGELOG.md', 'CREDITS.md', 'LICENSE', 'PUBLISHING.md', 'docs')

Write-Host "源    : $Source"
Write-Host "目标  : $target"

# 1. 目标若是 Junction（旧式链接安装），先删链接：否则复制会写进工作区
if (Test-Path -LiteralPath $target) {
  $item = Get-Item -LiteralPath $target -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    if ($PSCmdlet.ShouldProcess($target, '删除旧 Junction（不删目标内容）')) {
      cmd /c rmdir "$target" | Out-Null
      Write-Host '  → 已删除旧 Junction'
    }
  } elseif ($PSCmdlet.ShouldProcess($target, '覆盖已有副本')) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host '  → 已删除旧副本'
  }
}

# 2. 复制
if ($PSCmdlet.ShouldProcess($target, '复制插件文件')) {
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  foreach ($name in $include) {
    $from = Join-Path $Source $name
    if (-not (Test-Path -LiteralPath $from)) { continue }
    Copy-Item -LiteralPath $from -Destination $target -Recurse -Force
  }
  Write-Host '  → 复制完成'
}

# 3. 依赖声明改成 file:（下次 pnpm/npm install 会按此重新复制，而不是建链接）
if ($PSCmdlet.ShouldProcess($pkgJson, "把 $PackageName 的依赖改成 file:$Source")) {
  $raw = [System.IO.File]::ReadAllText($pkgJson, [System.Text.Encoding]::UTF8)
  $obj = $raw | ConvertFrom-Json
  if ($null -eq $obj.dependencies) { $obj | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
  $spec = 'file:' + ($Source -replace '\\', '/')
  $obj.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue $spec -Force
  $out = $obj | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($pkgJson, $out + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  → 依赖已声明为 $spec"
}

# 4. 校验（用 .NET 算哈希：Get-FileHash 会被 -WhatIf 影响而返回空）
function Get-Sha256Prefix([string]$Path, [int]$Length = 12) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hex = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
    return $hex.Substring(0, [Math]::Min($Length, $hex.Length))
  } finally {
    $sha.Dispose()
  }
}

$srcIndex = Join-Path $Source 'lib\index.js'
$dstIndex = Join-Path $target 'lib\index.js'
if (-not (Test-Path -LiteralPath $dstIndex)) {
  Write-Warning "目标里没有 lib\index.js，检查是否漏了 build"
} else {
  $srcHash = Get-Sha256Prefix $srcIndex
  $dstHash = Get-Sha256Prefix $dstIndex
  if ($srcHash -eq $dstHash) { Write-Host "`nOK: 已安装副本与工作区一致（$srcHash）" }
  else { Write-Warning "哈希不一致：源 $srcHash / 目标 $dstHash（-WhatIf 预览时预期不一致）" }
}

Write-Host "`n完成。重启 DSH 生效；之后改代码请：pnpm run build → 再跑本脚本 → 重启。"
