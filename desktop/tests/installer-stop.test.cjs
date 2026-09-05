const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const script = path.resolve(__dirname, "../build/stop-for-install.ps1");

test("安装退出脚本：保存后退出、精确路径隔离、超时不杀进程、无运行实例", { skip: process.platform !== "win32" }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lyspace-installer-stop-"));
    const processName = `LYSpaceTest-${process.pid}.exe`;
    const children = [];
    const first = path.join(root, "安装 目录");
    const other = path.join(root, "other");
    fs.mkdirSync(first);
    fs.mkdirSync(other);
    const run = (directory) => spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-InstallDir", directory, "-ProcessName", processName, "-TimeoutSeconds", "2"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    const start = async (directory, args = []) => {
        const child = spawn(path.join(directory, processName), args, { stdio: "ignore", windowsHide: true });
        children.push(child);
        for (let i = 0; i < 100 && !fs.existsSync(path.join(directory, "ready.txt")); i++) await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(fs.existsSync(path.join(directory, "ready.txt")), "isolated process started");
        return child;
    };
    try {
        const compiler = path.join(process.env.WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
        const compiled = spawnSync(compiler, ["/nologo", `/out:${path.join(first, processName)}`, path.join(__dirname, "fixtures/installer-process.cs")], { encoding: "utf8", windowsHide: true });
        assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
        fs.copyFileSync(path.join(first, processName), path.join(other, processName));
        assert.equal(run(first).status, 0, "no running process needs no notification");
        assert.equal(fs.existsSync(path.join(first, "request.txt")), false);

        await start(first);
        const unrelated = await start(other, ["--refuse"]);
        const saved = run(first);
        assert.equal(saved.status, 0, saved.stderr);
        assert.equal(fs.readFileSync(path.join(first, "saved.txt"), "utf8"), "saved before exit");
        assert.match(fs.readFileSync(path.join(first, "request.txt"), "utf8"), /--lyspace-install-dir=.*安装 目录/);
        assert.equal(fs.existsSync(path.join(other, "request.txt")), false, "same-name process in other directory untouched");

        const refused = run(other);
        assert.notEqual(refused.status, 0);
        assert.match(refused.stderr, /did not finish saving/);
        process.kill(unrelated.pid, 0);
        assert.equal(fs.existsSync(path.join(other, "saved.txt")), false);
    } finally {
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) {
                const exited = new Promise((resolve) => child.once("exit", resolve));
                child.kill(); // Only the isolated fixture processes created above.
                await exited;
            }
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("安装器仅在安装阶段保存退出和备份，不在初始化阻塞或强制结束进程", () => {
    const nsis = fs.readFileSync(path.resolve(__dirname, "../build/nsis-custom.nsh"), "utf8");
    assert.match(nsis, /!macro customCheckAppRunning/);
    assert.doesNotMatch(nsis, /!macro customInit/);
    assert.ok(nsis.indexOf("stop-for-install.ps1") < nsis.indexOf("backup-user-data.ps1"));
    const commands = fs.readFileSync(script, "utf8").split(/\r?\n/).filter((line) => !line.trim().startsWith("#")).join("\n");
    // Windows PowerShell 5 reads BOM-less scripts using the system code page.
    assert.doesNotMatch(fs.readFileSync(script, "utf8"), /[^\x00-\x7f]/);
    assert.doesNotMatch(commands, /taskkill|Stop-Process|\.Kill\(/i);
    assert.match(commands, /ExecutablePath/);
    assert.match(commands, /SessionId/);
});
