param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$AppDataDir,
    [Parameter(Mandatory = $true)][string]$LocalAppDataDir,
    [Parameter(Mandatory = $true)][string]$ProcessName
)

$ErrorActionPreference = "Stop"
$version = "v0.4.7"

# 任何中止原因都留下诊断日志（静默升级时用户看不到弹窗，靠此定位）
trap {
    $logFile = Join-Path $LocalAppDataDir "LY Space\Backups\upgrade-backup-error.log"
    try {
        New-Item -ItemType Directory -Path (Split-Path $logFile) -Force | Out-Null
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') upgrade aborted: $($_.Exception.Message)" | Out-File -FilePath $logFile -Encoding UTF8
    } catch { }
    throw
}

function Get-Sha256([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
        finally { $sha.Dispose() }
    } finally {
        $stream.Dispose()
    }
}

function Get-Inventory([string]$Directory) {
    if (-not (Test-Path -LiteralPath $Directory)) { return @() }
    $root = (Resolve-Path -LiteralPath $Directory).Path.TrimEnd("\")
    return @(
        Get-ChildItem -LiteralPath $root -Recurse -Force -File | ForEach-Object {
            [ordered]@{
                path = $_.FullName.Substring($root.Length).TrimStart("\").Replace("\", "/")
                length = $_.Length
                sha256 = Get-Sha256 $_.FullName
            }
        } | Sort-Object path
    )
}

function Test-Inventory([object[]]$Expected, [object[]]$Actual) {
    return (($Expected | ConvertTo-Json -Depth 5 -Compress) -ceq ($Actual | ConvertTo-Json -Depth 5 -Compress))
}

function Copy-VerifiedDirectory([string]$Source, [string]$Destination, [string]$RelativeDestination) {
    $expected = @(Get-Inventory $Source)
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    if (Test-Path -LiteralPath $Source) {
        Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse -Force
    }
    $actual = @(Get-Inventory $Destination)
    if (-not (Test-Inventory $expected $actual)) { throw "备份校验失败：$Source" }
    return [ordered]@{ source = $Source; directory = $RelativeDestination.Replace("\", "/"); files = $actual }
}

function Test-Within([string]$Candidate, [string]$Parent) {
    if (-not $Candidate) { return $false }
    $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd("\")
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd("\")
    return $candidatePath.StartsWith("$parentPath\", [StringComparison]::OrdinalIgnoreCase)
}

$deadline = (Get-Date).AddSeconds(90)
$expectedExe = [IO.Path]::GetFullPath((Join-Path $InstallDir $ProcessName))
do {
    $running = @(
        Get-CimInstance Win32_Process -Filter "Name='$($ProcessName.Replace("'", "''"))'" -ErrorAction SilentlyContinue |
            Where-Object { -not $_.ExecutablePath -or [IO.Path]::GetFullPath($_.ExecutablePath) -eq $expectedExe }
    )
    if ($running.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
if ($running.Count -gt 0) { throw "LY Space 尚未完全退出，已停止升级以保护数据。请右键点击系统托盘（任务栏右下角）中的 LY Space 图标选择「退出」，或在任务管理器中结束 LY Space.exe，然后重新运行安装程序" }

$saved = $null
$settingsFile = Join-Path $AppDataDir "app-data\storage-settings.json"
if (Test-Path -LiteralPath $settingsFile) {
    try { $saved = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "存储配置无法读取，已停止升级以避免遗漏自定义数据：$settingsFile" }
}
$defaultCacheSource = Join-Path $InstallDir "Data cache"
$defaultResultSource = Join-Path $InstallDir "Result"
$cacheSource = if ($saved -and (Test-Within ([string]$saved.cacheRoot) $InstallDir)) { [string]$saved.cacheRoot } else { $defaultCacheSource }
$resultSource = if ($saved -and (Test-Within ([string]$saved.resultRoot) $InstallDir)) { [string]$saved.resultRoot } else { $defaultResultSource }
if (-not (Test-Path -LiteralPath $cacheSource) -and -not (Test-Path -LiteralPath $resultSource)) { exit 0 }

$backupBase = Join-Path $LocalAppDataDir "LY Space\Backups"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $backupBase "$version-$stamp-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

try {
    $currentRoot = Join-Path $backupRoot "current-install"
    $legacyRoot = Join-Path $backupRoot "legacy-user-data"
    $dataCache = Copy-VerifiedDirectory $cacheSource (Join-Path $currentRoot "Data cache") "current-install\Data cache"
    $result = Copy-VerifiedDirectory $resultSource (Join-Path $currentRoot "Result") "current-install\Result"
    $dataCache["restoreTarget"] = if ([IO.Path]::GetFullPath($cacheSource) -ne [IO.Path]::GetFullPath($defaultCacheSource)) { [IO.Path]::GetFullPath($cacheSource) } else { "" }
    $result["restoreTarget"] = if ([IO.Path]::GetFullPath($resultSource) -ne [IO.Path]::GetFullPath($defaultResultSource)) { [IO.Path]::GetFullPath($resultSource) } else { "" }
    $legacy = Copy-VerifiedDirectory $AppDataDir $legacyRoot "legacy-user-data"
    $manifest = [ordered]@{
        version = $version
        status = "ready"
        createdAt = (Get-Date).ToUniversalTime().ToString("o")
        backupRoot = $backupRoot
        installDir = [IO.Path]::GetFullPath($InstallDir)
        appDataDir = [IO.Path]::GetFullPath($AppDataDir)
        snapshots = [ordered]@{
            currentInstall = [ordered]@{ dataCache = $dataCache; result = $result }
            legacyUserData = $legacy
        }
    }
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $backupRoot "manifest.json"), ($manifest | ConvertTo-Json -Depth 12), $utf8)
    New-Item -ItemType Directory -Path $backupBase -Force | Out-Null
    $latestTemp = Join-Path $backupBase "latest.json.tmp"
    [IO.File]::WriteAllText($latestTemp, (([ordered]@{ backupRoot = $backupRoot }) | ConvertTo-Json), $utf8)
    Move-Item -LiteralPath $latestTemp -Destination (Join-Path $backupBase "latest.json") -Force
} catch {
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $backupRoot "backup-error.txt"), $_.Exception.ToString(), $utf8)
    throw
}
