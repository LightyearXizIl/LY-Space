const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..", "..");
const releaseDir = path.join(rootDir, "release");
const version = fs.readFileSync(path.join(rootDir, "VERSION"), "utf8").trim().replace(/^v/i, "");
const installer = path.join(releaseDir, `LY Space Setup ${version}.exe`);
const blockmap = `${installer}.blockmap`;
const updateMetadata = path.join(releaseDir, "latest.yml");
const unpackedDir = path.join(releaseDir, "win-unpacked");
const appExe = path.join(unpackedDir, "LY Space.exe");
const maxInstallerBytes = 180 * 1024 * 1024;

for (const target of [installer, blockmap, updateMetadata, appExe]) {
    if (!fs.existsSync(target)) throw new Error(`Missing packaged artifact: ${target}`);
}
const installerSize = fs.statSync(installer).size;
if (installerSize > maxInstallerBytes) throw new Error(`Installer is ${(installerSize / 1024 / 1024).toFixed(2)} MiB; maximum is ${(maxInstallerBytes / 1024 / 1024).toFixed(0)} MiB`);
if (!fs.readFileSync(updateMetadata, "utf8").includes(`version: ${version}`)) throw new Error(`latest.yml does not describe version ${version}`);

const files = listFiles(unpackedDir);
const codexExecutables = files.filter((file) => path.basename(file).toLowerCase() === "codex.exe");
if (codexExecutables.length) throw new Error(`Codex must not be bundled: ${codexExecutables.slice(0, 5).join(", ")}`);
const bundledAgentFiles = files.filter((file) => /\\resources\\canvas-agent(?:\\|$)/i.test(file));
if (bundledAgentFiles.length) throw new Error(`Canvas Agent must not be bundled: ${bundledAgentFiles.slice(0, 5).join(", ")}`);

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
        "if ($info.FileVersion -notmatch '^" + version.split(".").join("\\.") + "') { throw \"Unexpected FileVersion: $($info.FileVersion)\" }",
        "if ($info.ProductVersion -notmatch '^" + version.split(".").join("\\.") + "') { throw \"Unexpected ProductVersion: $($info.ProductVersion)\" }",
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
