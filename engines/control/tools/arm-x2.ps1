param([int]$Minutes = 20)
# Human authorization window for dsh-x2. Writes %TEMP%\dsh-x2\arm.json
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:TEMP 'dsh-x2'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$until = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ($Minutes * 60000)
$state = @{ armedUntil = $until; cancelAt = 0; note = "manual $Minutes min" } | ConvertTo-Json -Compress
Set-Content -LiteralPath (Join-Path $dir 'arm.json') -Value $state -Encoding UTF8
Write-Output ("AUTHORIZED for {0} min (until {1})" -f $Minutes, ([DateTimeOffset]::FromUnixTimeMilliseconds($until).LocalDateTime))
