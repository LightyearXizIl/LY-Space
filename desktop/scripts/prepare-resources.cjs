const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const source = path.resolve(desktopDir, "..", "web", "dist");
const target = path.join(desktopDir, "web");

function copyDirectory(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const fromPath = path.join(from, entry.name);
        const toPath = path.join(to, entry.name);
        if (entry.isDirectory()) copyDirectory(fromPath, toPath);
        else fs.copyFileSync(fromPath, toPath);
    }
}

if (!fs.existsSync(source)) throw new Error("web/dist 不存在，请先执行 Web 生产构建");
fs.rmSync(target, { recursive: true, force: true });
copyDirectory(source, target);
console.log(`Prepared ${target}`);
