import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { create as createTar } from "tar";

const execFileAsync = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const featuresRoot = resolve(root, "..");
const output = join(root, "dist");
const CODEX_VERSION = "0.146.0";
const CODEX_TARBALL = `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-win32-x64.tgz`;
const ASSET_BASE_URL = process.env.LY_SPACE_FEATURE_PLUGIN_ASSET_BASE_URL || "https://cdn.jsdelivr.net/gh/LightyearXizIl/LY-Space@plugins-dist";
const RUNTIME_RELEASE_URL = process.env.LY_SPACE_FEATURE_RUNTIME_URL || `https://github.com/LightyearXizIl/LY-Space/releases/download/feature-runtime-v${CODEX_VERSION}/codex-${CODEX_VERSION}-win32-x64.tgz`;

const definitions = [
    { id: "agent-core", name: "Agent Core", description: "本地 Canvas Agent、对话、历史、模型、权限、附件、画布操作、MCP 与 Agent 凭据。", permissions: ["本地 Agent 服务", "画布读取与写入（每次确认）", "附件", "MCP", "远程 Agent HTTPS"], dependencies: [], serviceEntry: "agent-core-service/service/launcher.cjs" },
    { id: "skill-manager", name: "Skill 管理", description: "查看、创建、编辑、启停和删除 Skills，并可从对话或画布生成草稿。", permissions: ["Agent Skill 管理"], dependencies: [{ id: "agent-core", range: ">=0.2.0 <1.0.0" }] },
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
let agentServiceArchive = null;
for (const definition of definitions) {
    const source = join(featuresRoot, definition.id, "src", "index.js");
    const outfile = join(output, `${definition.id}.mjs`);
    await build({ entryPoints: [source], outfile, bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, loader: { ".css": "text" } });
    if (definition.id === "agent-core") agentServiceArchive = await buildAgentService(join(featuresRoot, "agent-core", "service"), output);
}

const runtime = await runtimeMetadata();
const plugins = [];
for (const definition of definitions) {
    const rootFiles = definition.id === "agent-core" ? [join(output, "agent-core.mjs"), join(output, agentServiceArchive.asset.path)] : [join(output, "skill-manager.mjs")];
    const assets = await Promise.all(rootFiles.map(async (file) => {
        const assetPath = relative(output, file).replaceAll("\\", "/");
        return { path: assetPath, url: `${ASSET_BASE_URL}/${assetPath}`, size: (await stat(file)).size, sha256: await sha256(file) };
    }));
    plugins.push({ schemaVersion: 1, id: definition.id, name: definition.name, description: definition.description, version: "0.2.0", minAppVersion: ">=0.5.9", protocolVersion: "6", hostApiVersion: "2", permissions: definition.permissions, dependencies: definition.dependencies, rendererEntry: `${definition.id}.mjs`, ...(definition.serviceEntry ? { serviceEntry: definition.serviceEntry } : {}), assets, ...(definition.id === "agent-core" ? { runtime, serviceArchive: agentServiceArchive } : {}) });
}
await writeFile(join(output, "official-feature-plugins.json"), `${JSON.stringify({ schemaVersion: 1, plugins }, null, 2)}\n`);
console.log(`wrote ${plugins.length} feature plugins to ${output}`);

async function buildAgentService(source, target) {
    // 只在构建输入目录安装锁定依赖；发布物保留上游的模块边界，不能再用单一 ESM bundle。
    if (process.platform === "win32") await execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund"], { cwd: source });
    else await execFileAsync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: source });
    const stage = join(target, ".agent-service-stage");
    const serviceRoot = join(stage, "agent-core-service");
    await rm(stage, { recursive: true, force: true });
    await mkdir(join(serviceRoot, "service"), { recursive: true });
    await cp(join(source, "launcher.cjs"), join(serviceRoot, "service", "launcher.cjs"));
    await cp(join(source, "node_modules"), join(serviceRoot, "node_modules"), {
        recursive: true,
        filter: (from) => !/\/node_modules\/@openai\/codex[^/]*(?:\/|$)/.test(from.replaceAll("\\", "/")) && !/\/node_modules\/\.bin\/codex(?:\.(?:cmd|ps1))?$/.test(from.replaceAll("\\", "/")),
    });
    await writeFile(join(serviceRoot, "package.json"), '{"name":"ly-space-agent-core-service","private":true,"type":"module"}\n');
    await patchCanvasAgent(serviceRoot);
    const tree = await writeServiceTree(serviceRoot);
    const archiveDir = join(target, ".archive");
    const archivePath = join(archiveDir, "agent-core-service-0.2.0-win32-x64.tar.gz");
    await mkdir(archiveDir, { recursive: true });
    await rm(archivePath, { force: true });
    await createArchive(stage, archivePath);
    const asset = { path: relative(target, archivePath).replaceAll("\\", "/"), url: `${ASSET_BASE_URL}/${relative(target, archivePath).replaceAll("\\", "/")}`, size: (await stat(archivePath)).size, sha256: await sha256(archivePath) };
    await rm(stage, { recursive: true, force: true });
    return { schemaVersion: 1, format: "tar.gz", platform: "win32", arch: "x64", root: "agent-core-service", asset, tree };
}

async function patchCanvasAgent(target) {
    const configFile = join(target, "node_modules", "@basketikun", "canvas-agent", "dist", "config.js");
    const codexFile = join(target, "node_modules", "@basketikun", "canvas-agent", "dist", "agent", "codex-client.js");
    const versionFile = join(target, "node_modules", "@basketikun", "canvas-agent", "dist", "version-check.js");
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
    codex = codex.replace('logger.info("Starting Codex app-server", { executable: process.execPath, codex: codexBin() });', 'logger.info("Starting Codex app-server", { executable: process.execPath, codex: process.env.LY_SPACE_CODEX_PATH || "managed" });');
    codex = codex.replace('const current = process.argv.find((arg) => /index\\.(t|j)s$/.test(arg)) || "";\n    const entry = path.resolve(current || fileURLToPath(new URL("../index.js", import.meta.url)));', 'const configured = process.env.LY_SPACE_CANVAS_AGENT_MCP_ENTRY || "";\n    const current = configured || process.argv.find((arg) => /index\\.(t|j)s$/.test(arg)) || "";\n    const entry = path.resolve(current || fileURLToPath(new URL("../index.js", import.meta.url)));');
    if (!codex.includes("LY_SPACE_CANVAS_AGENT_MCP_ENTRY")) throw new Error("Canvas Agent MCP 入口补丁未命中，请核对上游版本");
    await writeFile(codexFile, codex);
    let versionCheck = await readFile(versionFile, "utf8");
    versionCheck = versionCheck.replace('const CODEX_VERSION = String(require("@openai/codex/package.json").version);', 'const CODEX_VERSION = String(process.env.LY_SPACE_CODEX_VERSION || "managed");');
    if (!versionCheck.includes("LY_SPACE_CODEX_VERSION")) throw new Error("Canvas Agent 版本检查补丁未命中，请核对上游版本");
    await writeFile(versionFile, versionCheck);
}

async function runtimeMetadata() {
    const response = await fetch(CODEX_TARBALL);
    if (!response.ok) throw new Error(`下载 Codex 运行时元数据失败：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { versionRange: `>=${CODEX_VERSION} <0.147.0`, version: CODEX_VERSION, entry: "package/vendor/x86_64-pc-windows-msvc/bin/codex.exe", format: "tar", asset: { path: "codex-win32-x64.tgz", url: RUNTIME_RELEASE_URL, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") } };
}

async function writeServiceTree(root) {
    const files = await listFiles(root);
    const entries = await Promise.all(files.map(async (file) => ({ path: relative(root, file).replaceAll("\\", "/"), size: (await stat(file)).size, sha256: await sha256(file) })));
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    const treeFile = join(root, "service-tree.json");
    await writeFile(treeFile, `${JSON.stringify({ schemaVersion: 1, fileCount: entries.length, totalBytes, files: entries })}\n`);
    return { path: "service-tree.json", sha256: await sha256(treeFile), fileCount: entries.length, totalBytes };
}

async function createArchive(stage, archive) {
    // Windows bsdtar 在中文工作目录偶发崩溃；归档阶段改用 ASCII 临时目录，输出再复制回构建目录。
    const archiveStage = await mkdtemp(join(tmpdir(), "lyspace-agent-"));
    try {
        const payload = join(archiveStage, "payload");
        const stagedArchive = join(archiveStage, "service.tar.gz");
        await cp(stage, payload, { recursive: true });
        await createTar({ gzip: true, cwd: payload, file: stagedArchive, portable: true, noMtime: true }, ["agent-core-service"]);
        await cp(stagedArchive, archive);
    } finally {
        await rm(archiveStage, { recursive: true, force: true });
    }
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
