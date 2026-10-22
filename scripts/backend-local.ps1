[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'restart', 'status')]
    [string]$Action = 'status',
    [switch]$Build,
    [ValidateRange(1024, 65535)]
    [int]$Port = 8080,
    [ValidateRange(1, 660)]
    [int]$WaitSeconds = 45
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backendDir = Join-Path $repoRoot 'backend'
$localDir = Join-Path $repoRoot '.local'
$runDir = Join-Path $localDir 'run'
$binDir = Join-Path $localDir 'bin'
$binary = Join-Path $binDir 'canvas-backend.exe'
$nextBinary = Join-Path $binDir 'canvas-backend.next.exe'
$recordPath = Join-Path $runDir 'backend.json'

foreach ($directory in @($runDir, $binDir)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

function Get-ManagedBackend {
    if (-not (Test-Path -LiteralPath $script:recordPath)) { return $null }
    $record = Get-Content -LiteralPath $script:recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $expectedStopFile = Join-Path $script:runDir ("backend-{0}.stop" -f $record.instance)
    $recordPort = [int]$record.port
    $expectedPort = [int]$script:Port
    $validExecutable = [string]::Equals([string]$record.executable, [string]$script:binary, [StringComparison]::OrdinalIgnoreCase)
    $validStopFile = [string]::Equals([string]$record.stopFile, [string]$expectedStopFile, [StringComparison]::OrdinalIgnoreCase)
    if ([string]$record.instance -notmatch '^[a-f0-9]{32}$' -or -not $validExecutable -or -not $validStopFile -or $recordPort -ne $expectedPort) {
        throw 'Backend ownership record is invalid; no process was stopped.'
    }
    $process = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    if ($process.Path -ne $script:binary -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startedTicks) {
        throw 'Backend PID belongs to a different process; no process was stopped.'
    }
    return @{ Record = $record; Process = $process }
}

function Get-BackendListener {
    return Get-NetTCPConnection -LocalPort $script:Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-BackendHealth {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:Port)/api/health/ready" -TimeoutSec 2
        if ($response.code -eq 0) { return $response.data }
    } catch { }
    return $null
}

function Get-BackendStatus {
    $managed = Get-ManagedBackend
    $listener = Get-BackendListener
    $health = $null
    $state = 'stopped'
    if ($managed) {
        $state = 'starting'
        if (Test-Path -LiteralPath $managed.Record.stopFile) {
            $state = 'stopping'
        } elseif ($listener -and $listener.OwningProcess -eq $managed.Process.Id) {
            $health = Get-BackendHealth
            $state = if ($health -and $health.ready) { 'ready' } else { 'unhealthy' }
        }
    } elseif ($listener) {
        $state = 'unmanaged-port'
    }
    [pscustomobject]@{
        State = $state
        ProcessId = $(if ($managed) { $managed.Process.Id } else { $null })
        Port = $script:Port
        ActiveWorkerTasks = $(if ($health) { $health.activeWorkerTasks } else { $null })
        Executable = $script:binary
        LogDirectory = (Join-Path $script:localDir 'logs')
    }
}

function Stop-ManagedBackend {
    $managed = Get-ManagedBackend
    if (-not $managed) {
        if (Get-BackendListener) { throw "Port $Port is owned by an unmanaged process; it was left running." }
        return
    }
    $health = Get-BackendHealth
    if ($health -and $health.activeWorkerTasks -gt 0) {
        Write-Host "Draining backend with $($health.activeWorkerTasks) active worker task(s)."
    }
    [IO.File]::WriteAllText($managed.Record.stopFile, '')
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while (-not $managed.Process.HasExited -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $managed.Process.Refresh()
    }
    if (-not $managed.Process.HasExited) {
        throw 'Backend is still draining. Its ownership record is retained; check status and retry later. No forced termination was performed.'
    }
    Remove-Item -LiteralPath $managed.Record.stopFile -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $script:recordPath -ErrorAction SilentlyContinue
}

function Build-Backend {
    $go = (Get-Command go -ErrorAction Stop).Source
    $buildTemp = Join-Path $script:localDir 'cache\go-temp'
    New-Item -ItemType Directory -Path $buildTemp -Force | Out-Null
    $previousTemp = $env:GOTMPDIR
    $env:GOTMPDIR = $buildTemp
    Push-Location $script:backendDir
    try {
        & $go build -o $script:nextBinary ./cmd/server
        if ($LASTEXITCODE -ne 0) { throw 'Backend build failed. The existing running service was not stopped.' }
    } finally {
        Pop-Location
        $env:GOTMPDIR = $previousTemp
    }
}

function Start-ManagedBackend {
    $managed = Get-ManagedBackend
    if ($managed) {
        $status = Get-BackendStatus
        if ($status.State -ne 'ready') { throw "Managed backend is $($status.State); inspect its logs or restart it." }
        return
    }
    if (Get-BackendListener) { throw "Port $Port is owned by an unmanaged process; it was left running." }
    $instance = [Guid]::NewGuid().ToString('N')
    $stopFile = Join-Path $script:runDir "backend-$instance.stop"
    $logs = Join-Path $script:localDir 'logs'
    $dataDir = Join-Path $script:localDir 'project-workbench-debug'
    New-Item -ItemType Directory -Path $logs, $dataDir -Force | Out-Null
    $stdout = Join-Path $logs "backend-$instance.stdout.log"
    $stderr = Join-Path $logs "backend-$instance.stderr.log"
    $settings = @{
        CANVAS_BACKEND_ADDR = "127.0.0.1:$($script:Port)"
        CANVAS_BACKEND_DATA_DIR = $dataDir
        CANVAS_DATABASE_DRIVER = 'sqlite'
        CANVAS_CORS_ORIGINS = 'http://localhost:3000'
        CANVAS_LOCAL_STOP_FILE = $stopFile
    }
    $localConfigPath = Join-Path $script:localDir 'backend-config.json'
    if (Test-Path -LiteralPath $localConfigPath) {
        $localConfig = Get-Content -LiteralPath $localConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $localConfig.corsOrigins) {
            if ($localConfig.corsOrigins -isnot [array] -or @($localConfig.corsOrigins | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
                throw 'Local backend corsOrigins must be an array of non-empty origin strings.'
            }
            $settings.CANVAS_CORS_ORIGINS = $localConfig.corsOrigins -join ','
        }
        if ($null -ne $localConfig.publicBaseUrl) {
            if ($localConfig.publicBaseUrl -isnot [string] -or [string]::IsNullOrWhiteSpace($localConfig.publicBaseUrl)) {
                throw 'Local backend publicBaseUrl must be a non-empty URL string.'
            }
            $settings.CANVAS_PUBLIC_BASE_URL = $localConfig.publicBaseUrl.Trim()
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CANVAS_CORS_ORIGINS)) {
        $settings.CANVAS_CORS_ORIGINS = $env:CANVAS_CORS_ORIGINS
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CANVAS_PUBLIC_BASE_URL)) {
        $settings.CANVAS_PUBLIC_BASE_URL = $env:CANVAS_PUBLIC_BASE_URL.Trim()
    }
    $previous = @{}
    foreach ($key in $settings.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
    }
    try {
        $process = Start-Process -FilePath $script:binary -WorkingDirectory $script:backendDir -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        $record = [ordered]@{
            processId = $process.Id
            startedTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
            executable = $script:binary
            instance = $instance
            stopFile = $stopFile
            port = $script:Port
            stdout = $stdout
            stderr = $stderr
        }
        $record | ConvertTo-Json | Set-Content -LiteralPath $script:recordPath -Encoding UTF8
    } finally {
        foreach ($key in $previous.Keys) {
            [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
        }
    }
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw "Backend exited. See $stderr" }
        $listener = Get-BackendListener
        if ($listener -and $listener.OwningProcess -ne $process.Id) {
            [IO.File]::WriteAllText($stopFile, '')
            throw "Another process acquired port $Port. Requested shutdown of this managed instance only."
        }
        if ($listener -and (Get-BackendHealth)) { return }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    throw "Backend startup timed out. Ownership is retained for status/stop/restart. See $stderr"
}

# Serialize build/start/stop so simultaneous invocations cannot lose PID ownership.
$lock = $null
try {
    $lock = [IO.File]::Open((Join-Path $runDir 'backend.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    if ($Build -and $Action -notin @('start', 'restart')) { throw '-Build requires start or restart.' }
    if ($Action -eq 'status') { Get-BackendStatus; return }
    if ($Action -eq 'stop') { Stop-ManagedBackend; Get-BackendStatus; return }
    $managed = Get-ManagedBackend
    if (-not $managed -and (Get-BackendListener)) { throw "Port $Port is occupied by an unmanaged process." }
    if ($Action -eq 'start' -and $managed -and $Build) { throw 'Use restart -Build to update a running backend.' }
    $needsBuild = $Build -or -not (Test-Path -LiteralPath $binary)
    if ($needsBuild) { Build-Backend }
    if ($Action -eq 'restart') { Stop-ManagedBackend }
    if ($needsBuild) {
        if (Test-Path -LiteralPath $binary) {
            Copy-Item -LiteralPath $binary -Destination (Join-Path $binDir 'canvas-backend.previous.exe') -Force
        }
        Move-Item -LiteralPath $nextBinary -Destination $binary -Force
    }
    Start-ManagedBackend
    Get-BackendStatus
} finally {
    if ($lock) { $lock.Dispose() }
}
