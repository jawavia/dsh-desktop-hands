<#
.SYNOPSIS
  Install dsh-click-matrix into a DSH desktop profile (Windows).

.DESCRIPTION
  Creates a junction from the profile's node_modules to this plugin directory,
  then adds the dependency + bundle entry to the profile package.json.
  Idempotent: re-running is safe. The existing profile package.json is backed up.

.PARAMETER PluginDir
  Plugin source directory. Defaults to the folder containing this script.

.PARAMETER ProfileDir
  DSH profile directory. Defaults to %USERPROFILE%\.dsh\profiles\desktop.

.PARAMETER Force
  Replace an existing non-junction node_modules entry.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
param(
  [string]$PluginDir = $PSScriptRoot,
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "  OK  $Text" -ForegroundColor Green }

if ($env:OS -ne 'Windows_NT') { throw 'dsh-click-matrix is Windows-only.' }
$PluginDir = (Resolve-Path -LiteralPath $PluginDir).Path
$ProfileDir = [IO.Path]::GetFullPath($ProfileDir)
$pkgPath = Join-Path $PluginDir 'package.json'
if (-not (Test-Path -LiteralPath $pkgPath)) { throw "package.json not found in $PluginDir" }
$pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
if ($pkg.name -ne 'dsh-click-matrix') { throw "unexpected package name: $($pkg.name)" }
if (-not (Test-Path -LiteralPath (Join-Path $ProfileDir 'package.json'))) {
  throw "DSH desktop profile not found: $ProfileDir (pass -ProfileDir)"
}

Write-Step "Plugin:  $PluginDir (v$($pkg.version))"
Write-Step "Profile: $ProfileDir"

$nodeModules = Join-Path $ProfileDir 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModules)) { New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null }
$link = Join-Path $nodeModules 'dsh-click-matrix'
if (Test-Path -LiteralPath $link) {
  $item = Get-Item -LiteralPath $link -Force
  $isLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  if ($isLink) { Remove-Item -LiteralPath $link -Force }
  elseif ($Force) { Remove-Item -LiteralPath $link -Recurse -Force }
  else { throw "$link already exists and is not a junction; re-run with -Force to replace it." }
}
New-Item -ItemType Junction -Path $link -Target $PluginDir | Out-Null
Write-Ok "junction: $link -> $PluginDir"

$profilePkgPath = Join-Path $ProfileDir 'package.json'
$backup = "$profilePkgPath.bak-install-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item -LiteralPath $profilePkgPath -Destination $backup -Force
$json = Get-Content -LiteralPath $profilePkgPath -Raw | ConvertFrom-Json
if (-not $json.PSObject.Properties['dependencies']) {
  $json | Add-Member -NotePropertyName dependencies -NotePropertyValue (New-Object PSObject -Property @{}) -Force
}
$linkSpec = 'link:' + ($PluginDir -replace '\\', '/')
$json.dependencies | Add-Member -NotePropertyName 'dsh-click-matrix' -NotePropertyValue $linkSpec -Force
if (-not $json.PSObject.Properties['dsh']) {
  $json | Add-Member -NotePropertyName dsh -NotePropertyValue (New-Object PSObject) -Force
}
if (-not $json.dsh.PSObject.Properties['profile']) {
  $json.dsh | Add-Member -NotePropertyName profile -NotePropertyValue (New-Object PSObject) -Force
}
$bundles = @($json.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-click-matrix') {
  $json.dsh.profile.bundles = @($bundles + 'dsh-click-matrix')
}
$text = $json | ConvertTo-Json -Depth 100
[IO.File]::WriteAllText($profilePkgPath, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "profile package.json updated (backup: $backup)"

Write-Host ''
Write-Host 'Next:' -ForegroundColor Yellow
Write-Host '  1) Restart DSH once (the composer chip needs a restart).'
Write-Host '  2) In a new DSH session, call click_matrix_doctor; expect PASS with 23 tools.'
Write-Host '  3) First capture/click compiles the local helper (~seconds; .NET Framework 4.x).'
Write-Host '  4) Authorize with Ctrl+Alt+F12 or /click-matrix arm; emergency stop: Esc / Ctrl+Alt+F11.'
