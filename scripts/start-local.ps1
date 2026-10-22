[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "windows-proxy.ps1")
Import-CanvasWindowsProxy

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$webDir = Join-Path $repoRoot "web"
$logsDir = Join-Path $repoRoot ".local\logs"

foreach ($commandName in @("bun")) {
    if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
        throw "未找到 $commandName，请先安装项目要求的运行时。"
    }
}

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$viteBinary = Join-Path $webDir "node_modules\vite\bin\vite.js"
if (-not (Test-Path -LiteralPath $viteBinary)) {
    Write-Host "web/node_modules 不存在，正在执行 bun install --frozen-lockfile..." -ForegroundColor Yellow
    Push-Location $webDir
    try {
        & bun install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) {
            throw "bun install 失败，无法启动前端。"
        }
    } finally {
        Pop-Location
    }
}

function Test-ListeningPort([int]$Port) {
    try {
        return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1)
    } catch {
        return $false
    }
}

function Show-CanvasAddresses {
    Write-Host '本机访问：http://localhost:3000' -ForegroundColor Cyan
    $addresses = Get-NetIPAddress -AddressFamily IPv4 -AddressState Preferred -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' -and $_.SkipAsSource -eq $false } |
        Select-Object -ExpandProperty IPAddress -Unique
    foreach ($address in $addresses) {
        Write-Host "局域网访问：http://$($address):3000" -ForegroundColor Cyan
    }
}

$webAlreadyRunning = Test-ListeningPort 3000
if ($webAlreadyRunning) {
    $webListener = Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -First 1
    $webOwner = Get-CimInstance Win32_Process -Filter "ProcessId = $($webListener.OwningProcess)"
    if (-not $webOwner.CommandLine -or -not $webOwner.CommandLine.Contains($webDir) -or $webOwner.CommandLine -notmatch 'vite') {
        throw '端口 3000 不属于当前项目的 Vite，未停止其他程序。'
    }
}

& (Join-Path $PSScriptRoot 'backend-local.ps1') start
if ($webAlreadyRunning) {
    Write-Host '影策前后端已在运行。'
    Show-CanvasAddresses
    return
}

$powerShellPath = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $powerShellPath) {
    $powerShellPath = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
}
if (-not $powerShellPath) {
    throw "未找到 PowerShell，无法启动前端。"
}

function ConvertTo-PowerShellLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
}

$webDirLiteral = ConvertTo-PowerShellLiteral $webDir

$webCommand = @"
`$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $webDirLiteral
`$env:VITE_API_PROXY_TARGET = 'http://127.0.0.1:8080'
Write-Host '影策前端：http://localhost:3000' -ForegroundColor Cyan
bun run dev --strictPort
"@

$encodedWebCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($webCommand))
$webProcess = Start-Process -FilePath $powerShellPath -WindowStyle Hidden -WorkingDirectory $webDir -PassThru -RedirectStandardOutput (Join-Path $logsDir 'web.stdout.log') -RedirectStandardError (Join-Path $logsDir 'web.stderr.log') -ArgumentList @("-NoLogo", "-NoProfile", "-EncodedCommand", $encodedWebCommand)

Write-Host "前后端已在后台启动，前端启动进程 PID: $($webProcess.Id)" -ForegroundColor Green
Show-CanvasAddresses
Write-Host "日志位于 .local/logs。后端启停使用 scripts/backend-local.ps1。"
