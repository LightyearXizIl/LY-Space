const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..", "..");
const releaseDir = path.join(rootDir, "release");
const installer = path.join(releaseDir, "LY Space Setup 0.0.2.exe");
const unpackedDir = path.join(releaseDir, "win-unpacked");
const appExe = path.join(unpackedDir, "LY Space.exe");
const maxInstallerBytes = 220 * 1024 * 1024;

for (const target of [installer, appExe]) {
    if (!fs.existsSync(target)) throw new Error(`Missing packaged artifact: ${target}`);
}
const installerSize = fs.statSync(installer).size;
if (installerSize > maxInstallerBytes) throw new Error(`Installer is ${(installerSize / 1024 / 1024).toFixed(2)} MiB; maximum is 220 MiB`);

const files = listFiles(unpackedDir);
const codexExecutables = files.filter((file) => path.basename(file).toLowerCase() === "codex.exe");
if (codexExecutables.length !== 1) throw new Error(`Expected one bundled codex.exe, found ${codexExecutables.length}`);
const prohibited = files.filter((file) => /\\resources\\canvas-agent\\node_modules\\(?:typescript|tsx|esbuild)(?:\\|$)|\\resources\\canvas-agent\\node_modules\\@types(?:\\|$)/i.test(file));
if (prohibited.length) throw new Error(`Development dependencies were packaged: ${prohibited.slice(0, 5).join(", ")}`);

verifyWindowsMetadata(appExe);
console.log(`Verified installer: ${(installerSize / 1024 / 1024).toFixed(2)} MiB`);

function listFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? listFiles(target) : [target];
    });
}

function verifyWindowsMetadata(executable) {
    const escapedPath = executable.replace(/'/g, "''");
    const script = [
        "Add-Type -AssemblyName System.Drawing",
        `$item = Get-Item -LiteralPath '${escapedPath}'`,
        "$info = $item.VersionInfo",
        "if ($info.ProductName -ne 'LY Space') { throw \"Unexpected ProductName: $($info.ProductName)\" }",
        "if ($info.FileVersion -notmatch '^0\\.0\\.2') { throw \"Unexpected FileVersion: $($info.FileVersion)\" }",
        "if ($info.ProductVersion -notmatch '^0\\.0\\.2') { throw \"Unexpected ProductVersion: $($info.ProductVersion)\" }",
        "$bitmap = [System.Drawing.Icon]::ExtractAssociatedIcon($item.FullName).ToBitmap()",
        "$hasColor = $false",
        "for ($x = 0; $x -lt $bitmap.Width; $x++) { for ($y = 0; $y -lt $bitmap.Height; $y++) { $pixel = $bitmap.GetPixel($x, $y); if ($pixel.A -gt 16 -and ([Math]::Abs($pixel.R - $pixel.G) -gt 8 -or [Math]::Abs($pixel.G - $pixel.B) -gt 8)) { $hasColor = $true; break } } if ($hasColor) { break } }",
        "$bitmap.Dispose()",
        "if ($hasColor) { throw 'Application icon is not the monochrome LY Space triangle icon' }",
        "Write-Output \"Verified Windows metadata: $($info.ProductName) $($info.FileVersion)\"",
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Windows metadata or icon verification failed: ${result.stderr || result.stdout}`);
    process.stdout.write(result.stdout);
}
