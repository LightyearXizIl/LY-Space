param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$ProcessName,
    [ValidateRange(1, 120)][int]$TimeoutSeconds = 25
)

$ErrorActionPreference = "Stop"
$expectedExe = [IO.Path]::GetFullPath((Join-Path $InstallDir $ProcessName))
if ([IO.Path]::GetFileName($ProcessName) -ne $ProcessName -or -not [IO.Path]::IsPathRooted($InstallDir)) {
    throw "Invalid installation path"
}
$sessionId = (Get-Process -Id $PID).SessionId

function Get-InstalledProcesses {
    # Fail closed when a same-name process cannot be attributed to an install.
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name='$($ProcessName.Replace("'", "''"))'" | Where-Object { $_.SessionId -eq $sessionId })
    foreach ($candidate in $candidates) {
        if (-not $candidate.ExecutablePath) { throw "Cannot verify running application path; close LY Space and retry" }
        if ([IO.Path]::GetFullPath($candidate.ExecutablePath) -eq $expectedExe) { $candidate }
    }
}

$running = @(Get-InstalledProcesses)
if (-not $running.Count) { exit 0 }
if (-not (Test-Path -LiteralPath $expectedExe -PathType Leaf)) { throw "Installed application is missing" }

# Forward through Electron's single-instance lock; never force termination.
# Old versions may only focus their window. Timeout aborts without killing them.
$directory = [IO.Path]::GetDirectoryName($expectedExe).TrimEnd('\')
$startInfo = New-Object Diagnostics.ProcessStartInfo
$startInfo.FileName = $expectedExe
$startInfo.Arguments = '--lyspace-quit-for-install "--lyspace-install-dir=' + $directory + '"'
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$notification = [Diagnostics.Process]::Start($startInfo)
if ($notification) { $notification.Dispose() }

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
    if (@(Get-InstalledProcesses).Count -eq 0) { exit 0 }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
throw "LY Space did not finish saving and exit. Close it using File > Exit, then retry."
