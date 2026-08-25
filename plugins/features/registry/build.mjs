import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const featuresRoot = resolve(root, "..");
const output = join(root, "dist");
const CODEX_VERSION = "0.146.0";
const CODEX_TARBALL = `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-win32-x64.tgz`;
const ASSET_BASE_URL = process.env.LY_SPACE_FEATURE_PLUGIN_ASSET_BASE_URL || "https://cdn.jsdelivr.net/gh/LightyearXizIl/LY-Space@plugins-dist";
const RUNTIME_RELEASE_URL = process.env.LY_SPACE_FEATURE_RUNTIME_URL || `https://github.com/LightyearXizIl/LY-Space/releases/download/feature-runtime-v${CODEX_VERSION}/codex-${CODEX_VERSION}-win32-x64.tgz`;

const definitions = [
    { id: "agent-core", name: "Agent Core", description: "本地 Canvas Agent、对话、历史、模型、权限、附件、画布操作、MCP 与 Agent 凭据。", permissions: ["本地 Agent 服务", "画布读取与写入（每次确认）", "附件", "MCP", "远程 Agent HTTPS"], dependencies: [], serviceEntry: "service/launcher.cjs" },
    { id: "skill-manager", name: "Skill 管理", description: "查看、创建、编辑、启停和删除 Skills，并可从对话或画布生成草稿。", permissions: ["Agent Skill 管理"], dependencies: [{ id: "agent-core", range: ">=0.1.0 <1.0.0" }] },
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const definition of definitions) {
    const source = join(featuresRoot, definition.id, "src", "index.js");
    const outfile = join(output, `${definition.id}.mjs`);
    await build({ entryPoints: [source], outfile, bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, loader: { ".css": "text" } });
    if (definition.id === "agent-core") await buildAgentService(join(featuresRoot, "agent-core", "service"), join(output, "agent-core-service"));
}

const runtime = await runtimeMetadata();
const plugins = [];
for (const definition of definitions) {
    const rootFiles = definition.id === "agent-core" ? [join(output, "agent-core.mjs"), ...(await listFiles(join(output, "agent-core-service")))] : [join(output, "skill-manager.mjs")];
    const assets = await Promise.all(rootFiles.map(async (file) => {
        const assetPath = relative(output, file).replaceAll("\\", "/");
        return { path: assetPath, url: `${ASSET_BASE_URL}/${assetPath}`, size: (await stat(file)).size, sha256: await sha256(file) };
    }));
    plugins.push({ schemaVersion: 1, id: definition.id, name: definition.name, description: definition.description, version: "0.1.0", minAppVersion: ">=0.5.6", protocolVersion: "6", permissions: definition.permissions, dependencies: definition.dependencies, rendererEntry: `${definition.id}.mjs`, ...(definition.serviceEntry ? { serviceEntry: `agent-core-service/${definition.serviceEntry}` } : {}), assets, ...(definition.id === "agent-core" ? { runtime } : {}) });
}
await writeFile(join(output, "official-feature-plugins.json"), `${JSON.stringify({ schemaVersion: 1, plugins }, null, 2)}\n`);
console.log(`wrote ${plugins.length} feature plugins to ${output}`);

async function buildAgentService(source, target) {
    // Windows 的 Node 在包含中文路径的工作目录下直接 spawn npm.cmd 会报 EINVAL；
    // 这里固定调用 cmd.exe，不拼接外部输入。
    if (process.platform === "win32") await execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd install --omit=dev --ignore-scripts --no-audit --no-fund"], { cwd: source });
    else await execFileAsync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: source });
    await patchCanvasAgent(source);
    await mkdir(join(target, "service"), { recursive: true });
    await cp(join(source, "launcher.cjs"), join(target, "service", "launcher.cjs"));
    await cp(join(source, "node_modules", "@basketikun", "canvas-agent", "agent-instructions.md"), join(target, "agent-instructions.md"));
    await writeFile(join(target, "package.json"), '{"name":"ly-space-agent-core-service","private":true,"type":"module"}\n');
    await build({
        entryPoints: [join(source, "node_modules", "@basketikun", "canvas-agent", "dist", "index.js")],
        outfile: join(target, "service", "agent-service.mjs"),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node20",
        minify: true,
        external: ["@openai/codex", "@openai/codex/*"],
    });
}

async function patchCanvasAgent(target) {
    const configFile = join(target, "node_modules", "@basketikun", "canvas-agent", "dist", "config.js");
    const codexFile = join(target, "node_modules", "@basketikun", "canvas-agent", "dist", "agent", "codex-client.js");
    let config = await readFile(configFile, "utf8");
    config = config.replace('export const CONFIG_DIR = path.join(os.homedir(), ".infinite-canvas");', 'export const CONFIG_DIR = process.env.LY_SPACE_AGENT_DATA_DIR || path.join(os.homedir(), ".infinite-canvas");');
    config = config.replace('return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));', 'const stored = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));\n        return process.env.LY_SPACE_AGENT_TOKEN ? { ...stored, token: process.env.LY_SPACE_AGENT_TOKEN } : stored;');
    config = config.replace('token: crypto.randomBytes(18).toString("hex")', 'token: process.env.LY_SPACE_AGENT_TOKEN || crypto.randomBytes(18).toString("hex")');
    if (!config.includes("LY_SPACE_AGENT_DATA_DIR") || !config.includes("LY_SPACE_AGENT_TOKEN") || !config.includes("const stored =")) throw new Error("Canvas Agent 配置补丁未命中，请核对上游版本");
    await writeFile(configFile, config);
    let codex = await readFile(codexFile, "utf8");
    const before = 'const child = spawn(process.execPath, [codexBin(), "app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });';
    const after = 'const runtime = process.env.LY_SPACE_CODEX_PATH;\n        const child = runtime ? spawn(runtime, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) : spawn(process.execPath, [codexBin(), "app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });';
    if (codex.includes(before)) codex = codex.replace(before, after);
    else if (!codex.includes("const runtime = process.env.LY_SPACE_CODEX_PATH;")) throw new Error("Canvas Agent Codex 运行时补丁未命中，请核对上游版本");
    await writeFile(codexFile, codex);
}

async function runtimeMetadata() {
    const response = await fetch(CODEX_TARBALL);
    if (!response.ok) throw new Error(`下载 Codex 运行时元数据失败：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { versionRange: `>=${CODEX_VERSION} <0.147.0`, version: CODEX_VERSION, entry: "package/codex.exe", format: "tar", asset: { path: "codex-win32-x64.tgz", url: RUNTIME_RELEASE_URL, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") } };
}

async function listFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(async (entry) => {
        const target = join(directory, entry.name);
        return entry.isDirectory() ? await listFiles(target) : [target];
    }))).flat();
}

async function sha256(file) {
    return crypto.createHash("sha256").update(await readFile(file)).digest("hex");
}
