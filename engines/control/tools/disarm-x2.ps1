$dir = Join-Path $env:TEMP 'dsh-x2'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$state = @{ armedUntil = 0; cancelAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); note = 'disarmed' } | ConvertTo-Json -Compress
Set-Content -LiteralPath (Join-Path $dir 'arm.json') -Value $state -Encoding UTF8
Write-Output 'DISARMED (all further actions blocked)'
