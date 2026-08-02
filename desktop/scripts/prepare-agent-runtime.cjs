const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.resolve(__dirname, "..");
const agentDir = path.resolve(desktopDir, "..", "canvas-agent");
const runtimeDir = path.join(desktopDir, ".runtime", "canvas-agent");
const ignoredDirectories = new Set([".github", "@types", "docs", "example", "examples", "test", "tests", "__tests__", "typescript", "tsx", "esbuild"]);

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 安装包必须在 Windows x64 环境构建");
fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(runtimeDir), { recursive: true });

const deployArgs = ["--filter", ".", "deploy", runtimeDir, "--prod", "--legacy"];
const result = runPnpm(deployArgs);
if (result.status !== 0) process.exit(result.status || 1);

// pnpm 11 legacy deploy can omit dependencies when the package uses a files allowlist.
// Preserve the deploy path, then materialize production dependencies from its locked graph.
if (!fs.existsSync(path.join(runtimeDir, "node_modules"))) {
    fs.copyFileSync(path.join(agentDir, "pnpm-lock.yaml"), path.join(runtimeDir, "pnpm-lock.yaml"));
    const installResult = runPnpm(["install", "--ignore-workspace", "--prod", "--frozen-lockfile", "--config.node-linker=hoisted"], runtimeDir);
    if (installResult.status !== 0) process.exit(installResult.status || 1);
    fs.rmSync(path.join(runtimeDir, "pnpm-lock.yaml"), { force: true });
}

prune(runtimeDir);
const files = listFiles(runtimeDir);
const codexExecutables = files.filter((file) => path.basename(file).toLowerCase() === "codex.exe");
if (codexExecutables.length !== 1) throw new Error(`Canvas Agent 运行包应只包含一份 codex.exe，实际为 ${codexExecutables.length} 份`);
const prohibited = files.filter((file) => /\\node_modules\\(?:typescript|tsx|esbuild)(?:\\|$)|\\node_modules\\@types(?:\\|$)/i.test(file));
if (prohibited.length) throw new Error(`Canvas Agent 运行包包含开发依赖：${prohibited.slice(0, 5).join(", ")}`);
fs.renameSync(path.join(runtimeDir, "node_modules"), path.join(runtimeDir, "production-dependencies"));
console.log(`Prepared production Canvas Agent runtime: ${runtimeDir}`);

function prune(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            if (ignoredDirectories.has(entry.name)) fs.rmSync(target, { recursive: true, force: true });
            else prune(target);
            continue;
        }
        if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".map") || /^(readme|changelog|history)\.(md|txt)$/i.test(entry.name)) fs.rmSync(target, { force: true });
    }
}

function listFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? listFiles(target) : [target];
    });
}

function runPnpm(args, cwd = agentDir) {
    const pnpmEntry = process.env.npm_execpath;
    if (pnpmEntry && fs.existsSync(pnpmEntry)) {
        return childProcess.spawnSync(process.execPath, [pnpmEntry, ...args], { cwd, stdio: "inherit", windowsHide: true });
    }
    if (process.platform !== "win32") return childProcess.spawnSync("pnpm", args, { cwd, stdio: "inherit" });
    const pnpmCommand = (process.env.Path || process.env.PATH || "")
        .split(path.delimiter)
        .map((entry) => path.join(entry, "pnpm.cmd"))
        .find((candidate) => fs.existsSync(candidate));
    if (!pnpmCommand) throw new Error("Unable to locate pnpm.cmd");
    const dependencyRoot = path.resolve(path.dirname(pnpmCommand), "..", "..");
    return childProcess.spawnSync(
        path.join(dependencyRoot, "node", "bin", "node.exe"),
        [path.join(dependencyRoot, "node", "node_modules", "pnpm", "bin", "pnpm.mjs"), ...args],
        { cwd, stdio: "inherit", windowsHide: true },
    );
}
