[CmdletBinding()]
param([int]$TimeoutSeconds = 120)

# Windows Docker Desktop can leave inaccessible AF_UNIX reparse points behind.
# Only rotate runtime directories when Desktop/backend are fully stopped.
# Images, settings, WSL distributions and data volumes are never modified.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$dockerExecutable = (Get-Command docker.exe -CommandType Application).Source
$desktopExecutable = Join-Path $env:ProgramFiles 'Docker/Docker/Docker Desktop.exe'
$localDirectory = [Environment]::GetFolderPath('LocalApplicationData')
$runtimeDirectories = @(
    (Join-Path $localDirectory 'Docker/run'),
    (Join-Path $localDirectory 'docker-secrets-engine')
)

function Test-DockerEngine {
    $probe = [Diagnostics.Process]::new()
    $probe.StartInfo = [Diagnostics.ProcessStartInfo]@{
        FileName = $dockerExecutable
        Arguments = 'info --format {{.ServerVersion}}'
        UseShellExecute = $false
        CreateNoWindow = $true
        RedirectStandardOutput = $true
        RedirectStandardError = $true
    }
    try {
        [void]$probe.Start()
        if (-not $probe.WaitForExit(5000)) {
            $probe.Kill()
            $probe.WaitForExit()
            return $false
        }
        return $probe.ExitCode -eq 0
    } finally {
        $probe.Dispose()
    }
}

$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$startLock = [Threading.Mutex]::new($false, "Local\ScovaDockerStart-$userSid")
$hasLock = $false
try {
    try {
        $hasLock = $startLock.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))
    } catch [Threading.AbandonedMutexException] {
        $hasLock = $true
    }
    if (-not $hasLock) { throw 'Another Docker launch is still in progress.' }
    if (Test-DockerEngine) {
        Write-Output 'Docker engine is ready.'
        return
    }
    if (-not (Test-Path -LiteralPath $desktopExecutable -PathType Leaf)) {
        throw "Docker Desktop not found: $desktopExecutable"
    }

    $running = Get-Process -Name 'Docker Desktop', 'com.docker.backend' -ErrorAction SilentlyContinue
    if (-not $running) {
        # Validate every target before the first rename, and never follow junctions.
        foreach ($directory in $runtimeDirectories) {
            if (Test-Path -LiteralPath $directory) {
                $item = Get-Item -LiteralPath $directory -Force
                if (-not $item.PSIsContainer -or
                    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                    throw "Unexpected runtime directory; left unchanged: $directory"
                }
            }
        }
        $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' +
            [Guid]::NewGuid().ToString('N').Substring(0, 8)
        foreach ($directory in $runtimeDirectories) {
            if (Test-Path -LiteralPath $directory) {
                $backupName = (Split-Path -Leaf $directory) + '.backup-' + $stamp
                Rename-Item -LiteralPath $directory -NewName $backupName
                Write-Output "Backed up stale runtime directory: $directory"
            }
            [void](New-Item -ItemType Directory -Path $directory)
        }
        Start-Process -FilePath $desktopExecutable -WindowStyle Hidden
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-DockerEngine) {
            Write-Output 'Docker engine is ready.'
            return
        }
        Start-Sleep -Seconds 2
    }
    throw 'Docker did not become ready. Quit Docker Desktop normally, then retry. No running process was stopped.'
} finally {
    if ($hasLock) { $startLock.ReleaseMutex() }
    $startLock.Dispose()
}
