param()
# dsh-x2 config panel (ASCII only: safe for any code page).
# Writes %USERPROFILE%\.dsh-x2\config.json -- takes effect on the next action (no DSH restart).
$ErrorActionPreference = 'Stop'

$dir = Join-Path $HOME '.dsh-x2'
$file = Join-Path $dir 'config.json'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$keys = @(
  @{ k = 'settleMs';            t = 'int';  d = 'wait before the after-action screenshot (ms)' },
  @{ k = 'armSeconds';          t = 'int';  d = 'F9 authorization window length (seconds)' },
  @{ k = 'hotkeyArm';           t = 'bool'; d = 'enable Ctrl+Alt+F9 / F10 / F8 hotkeys' },
  @{ k = 'overlay';             t = 'bool'; d = 'show the "DSH is driving" status pill' },
  @{ k = 'overlayIdleMs';       t = 'int';  d = 'how long the pill stays after the last action (ms)' },
  @{ k = 'audit';               t = 'bool'; d = 'write the hash-chain audit log' },
  @{ k = 'typeChunkChars';      t = 'int';  d = 'characters per batch when typing long text (0 = no batching)' },
  @{ k = 'typeChunkDelayMs';    t = 'int';  d = 'pause between typing batches (ms)' },
  @{ k = 'typeVerifyMinChars';  t = 'int';  d = 'auto read-back verify above this many chars (0 = never)' },
  @{ k = 'typePasteThreshold';  t = 'int';  d = 'use clipboard paste above this many chars (0 = off)' },
  @{ k = 'imageBudget';         t = 'int';  d = 'soft image budget per turn, advisory only (0 = off)' }
)

function Read-Cfg {
  $h = @{}
  if (Test-Path -LiteralPath $file) {
    try {
      $obj = Get-Content -Raw -LiteralPath $file -Encoding UTF8 | ConvertFrom-Json
      if ($obj) { $obj.PSObject.Properties | ForEach-Object { $h[$_.Name] = $_.Value } }
    } catch { Write-Host "WARN: config.json unreadable, starting fresh." -ForegroundColor Yellow }
  }
  return $h
}

function Save-Cfg($h) {
  $json = $h | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$cfg = Read-Cfg
Write-Host ""
Write-Host "dsh-x2 config" -ForegroundColor Cyan
Write-Host ("file: " + $file)
Write-Host ""

while ($true) {
  $i = 0
  foreach ($item in $keys) {
    $i++
    $cur = $cfg[$item.k]
    if ($null -eq $cur) { $cur = '(default)' }
    Write-Host ("  {0,2}. {1,-22} = {2,-12} {3}" -f $i, $item.k, $cur, $item.d)
  }
  Write-Host "   0. quit and save"
  Write-Host ""
  $choice = Read-Host "pick a number"
  if ($choice -eq '0' -or $choice -eq '') { Save-Cfg $cfg; Write-Host "saved." -ForegroundColor Green; break }

  $n = 0
  if (-not [int]::TryParse($choice, [ref]$n) -or $n -lt 1 -or $n -gt $keys.Count) {
    Write-Host "not a valid choice" -ForegroundColor Yellow
    continue
  }
  $item = $keys[$n - 1]
  $raw = Read-Host ("new value for " + $item.k + " (" + $item.t + ", empty = remove)")
  if ($raw -eq '') { $cfg.Remove($item.k); continue }
  if ($item.t -eq 'bool') {
    $cfg[$item.k] = ($raw -match '^(1|true|yes|y|on)$')
  } else {
    $v = 0
    if ([int]::TryParse($raw, [ref]$v)) { $cfg[$item.k] = $v } else { Write-Host "needs an integer" -ForegroundColor Yellow }
  }
}
