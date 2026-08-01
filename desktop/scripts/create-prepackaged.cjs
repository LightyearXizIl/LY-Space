const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const rootDir = path.resolve(desktopDir, "..");
const appDir = path.join(rootDir, "release", "win-unpacked");
const resourcesDir = path.join(appDir, "resources");

function copyDirectory(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(source), target, fs.statSync(source).isDirectory() ? "junction" : "file");
        } else if (entry.isDirectory()) copyDirectory(source, target);
        else fs.copyFileSync(source, target);
    }
}

fs.rmSync(appDir, { recursive: true, force: true });
copyDirectory(path.join(desktopDir, "node_modules", "electron", "dist"), appDir);
fs.renameSync(path.join(appDir, "electron.exe"), path.join(appDir, "LY Space.exe"));

const packagedApp = path.join(resourcesDir, "app");
fs.mkdirSync(packagedApp, { recursive: true });
for (const file of ["main.cjs", "preload.cjs"]) fs.copyFileSync(path.join(desktopDir, file), path.join(packagedApp, file));
copyDirectory(path.join(desktopDir, "web"), path.join(packagedApp, "web"));
copyDirectory(path.join(desktopDir, "build"), path.join(packagedApp, "build"));
const sourceAgent = path.join(rootDir, "canvas-agent");
const packagedAgent = path.join(resourcesDir, "canvas-agent");
fs.mkdirSync(packagedAgent, { recursive: true });
for (const directory of ["dist", "node_modules"]) copyDirectory(path.join(sourceAgent, directory), path.join(packagedAgent, directory));
for (const file of ["agent-instructions.md", "package.json"]) fs.copyFileSync(path.join(sourceAgent, file), path.join(packagedAgent, file));

const { version } = require(path.join(desktopDir, "package.json"));
fs.writeFileSync(path.join(packagedApp, "package.json"), JSON.stringify({ name: "ly-space", version, main: "main.cjs" }, null, 2));
console.log(`Prepared ${appDir}`);
