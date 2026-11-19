# Build the offline release zip from the current git HEAD and compute a matching
# .sha256 from the produced artifact (never reuse an old checksum).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/release.ps1
#   powershell ... -File tools/release.ps1 -OutDir C:\Users\me\Desktop
#
# Prerequisite: working tree committed (git archive HEAD is the source of truth).
param(
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$dirty = git status --porcelain
if ($dirty) {
  throw "working tree is not clean; commit first:`n$dirty"
}
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$zipName = "dsh-click-matrix-$version-win64.zip"

$temp = Join-Path $env:TEMP ('dshcm-release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  $srcZip = Join-Path $temp 'src.zip'
  git archive --format=zip -o $srcZip HEAD
  $pkg = Join-Path $temp 'pkg'
  Expand-Archive -LiteralPath $srcZip -DestinationPath $pkg -Force

  # Deterministic per-file checksums (sorted).
  $pkgFull = (Get-Item -LiteralPath $pkg).FullName.TrimEnd('\')
  $files = Get-ChildItem -LiteralPath $pkg -Recurse -File | Sort-Object FullName
  $lines = foreach ($f in $files) {
    $rel = $f.FullName.Substring($pkgFull.Length).TrimStart('\', '/').Replace('\', '/')
    $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower()
    "$h  $rel"
  }
  [IO.File]::WriteAllText((Join-Path $pkg 'SHA256SUMS.txt'), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))

  if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $zip = Join-Path $OutDir $zipName
  if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($pkg, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
  [IO.File]::WriteAllText("$zip.sha256", "$hash  $zipName`n", (New-Object System.Text.UTF8Encoding($false)))

  Write-Host "zip      : $zip"
  Write-Host "sha256   : $hash"
  Write-Host "sha file : $zip.sha256"
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
