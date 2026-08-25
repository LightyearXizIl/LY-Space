import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const output = new URL("./dist/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("official-feature-plugins.json", output), "utf8"));
const agent = manifest.plugins.find((item) => item.id === "agent-core");
assert(agent?.serviceArchive, "缺少 Agent 服务归档");
const archive = new URL(agent.serviceArchive.asset.path, output);
const bytes = await readFile(archive);
assert.equal(bytes.length, agent.serviceArchive.asset.size, "归档大小不一致");
assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), agent.serviceArchive.asset.sha256, "归档哈希不一致");

const staging = await mkdtemp(join(tmpdir(), "lyspace-agent-verify-"));
try {
    const archivePath = fileURLToPath(archive);
    const listed = spawnSync("tar.exe", ["-tzf", archivePath], { encoding: "utf8", windowsHide: true });
    assert.equal(listed.status, 0, listed.stderr || "无法列出 Agent 服务归档");
    const entries = String(listed.stdout).split(/\r?\n/).filter(Boolean);
    assert(entries.every((entry) => entry === agent.serviceArchive.root || entry.startsWith(`${agent.serviceArchive.root}/`)), "归档根目录越界");
    const extracted = spawnSync("tar.exe", ["-xzf", archivePath, "-C", staging], { encoding: "utf8", windowsHide: true });
    assert.equal(extracted.status, 0, extracted.stderr || "无法解压 Agent 服务归档");
    const tools = await listTools(join(staging, agent.serviceArchive.root, "node_modules", "@basketikun", "canvas-agent", "dist", "index.js"));
    assert.equal(tools.length, 34, `MCP tools/list 应返回 34 个工具，实际为 ${tools.length}`);
    console.log(`Agent archive verified: ${tools.length} MCP tools`);
} finally {
    await rm(staging, { recursive: true, force: true });
}

function listTools(entry) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [entry, "mcp"], { windowsHide: true, env: { ...process.env, LY_SPACE_AGENT_DATA_DIR: join(tmpdir(), "lyspace-agent-verify-data"), LY_SPACE_AGENT_TOKEN: "verify-token" }, stdio: ["pipe", "pipe", "pipe"] });
        const timer = setTimeout(() => fail(new Error("MCP tools/list 超时")), 10000);
        let buffer = "";
        let listed = false;
        const fail = (error) => {
            clearTimeout(timer);
            if (!child.killed) child.kill();
            reject(error);
        };
        child.once("error", fail);
        child.stderr.on("data", (chunk) => { if (!listed) fail(new Error(String(chunk))); });
        child.stdout.on("data", (chunk) => {
            buffer += String(chunk);
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const line of lines) {
                const message = JSON.parse(line);
                if (message.id === 1) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
                if (message.id === 2) {
                    listed = true;
                    clearTimeout(timer);
                    child.kill();
                    resolve(message.result?.tools || []);
                }
            }
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ly-space-verify", version: "0" } } })}\n`);
    });
}
