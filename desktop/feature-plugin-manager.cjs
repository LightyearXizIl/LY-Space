const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// 原生能力插件与画布 ESM 节点插件完全隔离：前者只能来自此白名单清单，
// 安装、校验、进程生命周期和密钥均由主进程掌控。
const OFFICIAL_FEATURE_PLUGIN_IDS = new Set(["agent-core", "skill-manager"]);
const FEATURE_REGISTRY_URL = process.env.LY_SPACE_FEATURE_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/LightyearXizIl/LY-Space@plugins-dist/official-feature-plugins.json";
const MAX_PLUGIN_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RUNTIME_FILE_BYTES = 512 * 1024 * 1024;
const MAX_SERVICE_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_SERVICE_FILES = 10000;
const MAX_SERVICE_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_RENDERER_SOURCE_BYTES = 4 * 1024 * 1024;
const CODEX_TIMEOUT_MS = 5000;

function createFeaturePluginManager({ app, safeStorage, getMainWindow, log = () => {} }) {
    const pluginRoot = path.join(process.env.LOCALAPPDATA || path.dirname(app.getPath("userData")), "LY Space", "Plugins");
    const dataRoot = path.join(app.getPath("userData"), "Plugin Data");
    const stateFile = path.join(pluginRoot, "state.json");
    let catalog = [];
    let activeDownload = null;
    let agentProcess = null;
    let agentConnection = null;
    let agentEventAbort = null;
    let state = readState();

    function emit() {
        const window = getMainWindow();
        if (window && !window.isDestroyed()) window.webContents.send("lyspace:feature-plugin-state", publicState());
    }

    function readState() {
        try {
            const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
            if (parsed && typeof parsed === "object") return { plugins: parsed.plugins || {}, runtime: parsed.runtime || {}, remoteAgent: parsed.remoteAgent || null };
        } catch {
            // 首次运行或状态文件损坏时安全回退，旧数据不会被删除。
        }
        return { plugins: {}, runtime: {}, remoteAgent: null };
    }

    function writeState() {
        fs.mkdirSync(pluginRoot, { recursive: true });
        const staging = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        fs.renameSync(staging, stateFile);
    }

    function publicState() {
        return {
            catalog,
            plugins: Object.values(state.plugins).map((item) => ({ ...item, error: item.error || "" })),
            runtime: { ...state.runtime, path: state.runtime?.source === "managed" ? "" : String(state.runtime?.path || "") },
            remoteAgent: state.remoteAgent ? { url: state.remoteAgent.url, configured: Boolean(state.remoteAgent.token) } : null,
            downloading: activeDownload ? { id: activeDownload.id, received: activeDownload.received, total: activeDownload.total, stage: activeDownload.stage } : null,
        };
    }

    function assertPluginId(id) {
        if (!OFFICIAL_FEATURE_PLUGIN_IDS.has(id)) throw new Error("不支持的功能插件");
        return id;
    }

    function findManifest(id) {
        const item = catalog.find((entry) => entry.id === id);
        if (!item) throw new Error("官方插件清单中没有该插件，请先刷新");
        return item;
    }

    function validateManifest(raw) {
        if (!raw || typeof raw !== "object" || Number(raw.schemaVersion) !== 1 || !Array.isArray(raw.plugins)) throw new Error("功能插件清单格式无效");
        return raw.plugins.map((item) => {
            if (!item || typeof item !== "object") throw new Error("功能插件条目无效");
            const id = assertPluginId(String(item.id || ""));
            const version = String(item.version || "");
            const rendererEntry = String(item.rendererEntry || "");
            if (!isSemver(version) || !safeRelativePath(rendererEntry)) throw new Error(`功能插件 ${id} 缺少有效版本或入口`);
            const assets = Array.isArray(item.assets) ? item.assets.map(validateAsset) : [];
            if (!assets.length || !assets.some((asset) => asset.path === rendererEntry)) throw new Error(`功能插件 ${id} 缺少渲染入口文件`);
            const dependencies = Array.isArray(item.dependencies) ? item.dependencies.map((dependency) => ({ id: assertPluginId(String(dependency?.id || "")), range: String(dependency?.range || "*") })) : [];
            return {
                schemaVersion: 1,
                id,
                name: String(item.name || id),
                description: String(item.description || ""),
                version,
                minAppVersion: String(item.minAppVersion || "0.0.0"),
                protocolVersion: String(item.protocolVersion || "1"),
                permissions: Array.isArray(item.permissions) ? item.permissions.map((permission) => String(permission)).filter(Boolean) : [],
                dependencies,
                rendererEntry,
                serviceEntry: safeRelativePath(String(item.serviceEntry || "")) ? String(item.serviceEntry || "") : "",
                assets,
                runtime: item.runtime && typeof item.runtime === "object" ? validateRuntime(item.runtime) : null,
                serviceArchive: item.serviceArchive && typeof item.serviceArchive === "object" ? validateServiceArchive(item.serviceArchive, assets) : null,
            };
        });
    }

    function validateAsset(raw) {
        const asset = {
            path: String(raw?.path || ""),
            url: String(raw?.url || ""),
            size: Number(raw?.size || 0),
            sha256: String(raw?.sha256 || "").toLowerCase(),
        };
        if (!safeRelativePath(asset.path) || !isHttps(asset.url) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_PLUGIN_FILE_BYTES || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("功能插件资产信息无效");
        return asset;
    }

    function validateRuntime(raw) {
        const asset = {
            path: String(raw?.asset?.path || ""),
            url: String(raw?.asset?.url || ""),
            size: Number(raw?.asset?.size || 0),
            sha256: String(raw?.asset?.sha256 || "").toLowerCase(),
        };
        if (!safeRelativePath(asset.path) || !isHttps(asset.url) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_RUNTIME_FILE_BYTES || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Codex 运行时资产信息无效");
        const entry = String(raw.entry || "codex.exe");
        if (!safeRelativePath(entry)) throw new Error("Codex 运行时入口无效");
        return { versionRange: String(raw.versionRange || ""), version: String(raw.version || ""), entry, asset, format: raw.format === "tar" ? "tar" : "file" };
    }

    function validateServiceArchive(raw, assets) {
        const asset = validateAsset(raw.asset);
        const root = String(raw.root || "");
        const tree = raw.tree || {};
        if (raw.format !== "tar.gz" || raw.platform !== "win32" || raw.arch !== "x64" || !safeRelativePath(root) || asset.size > MAX_SERVICE_ARCHIVE_BYTES) throw new Error("Agent 服务归档信息无效");
        if (!assets.some((item) => item.path === asset.path && item.sha256 === asset.sha256)) throw new Error("Agent 服务归档必须属于插件资产");
        if (!safeRelativePath(String(tree.path || "")) || !/^[a-f0-9]{64}$/i.test(String(tree.sha256 || "")) || !Number.isSafeInteger(tree.fileCount) || tree.fileCount < 1 || tree.fileCount > MAX_SERVICE_FILES || !Number.isSafeInteger(tree.totalBytes) || tree.totalBytes < 1 || tree.totalBytes > MAX_SERVICE_UNPACKED_BYTES) throw new Error("Agent 服务树清单无效");
        return { schemaVersion: Number(raw.schemaVersion || 1), format: "tar.gz", platform: "win32", arch: "x64", root, asset, tree: { path: String(tree.path), sha256: String(tree.sha256).toLowerCase(), fileCount: tree.fileCount, totalBytes: tree.totalBytes } };
    }

    async function refresh() {
        const response = await fetch(FEATURE_REGISTRY_URL, { headers: { "accept": "application/json" }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`获取功能插件清单失败：HTTP ${response.status}`);
        const value = validateManifest(await response.json());
        catalog = value;
        reconcileInstalled();
        emit();
        return publicState();
    }

    function reconcileInstalled() {
        for (const [id, record] of Object.entries(state.plugins)) {
            const manifest = catalog.find((item) => item.id === id);
            if (!manifest) continue;
            if (!isMinAppVersionCompatible(app.getVersion(), manifest.minAppVersion)) record.status = "incompatible";
            else if (!pluginFilesHealthy(record)) record.status = "repair";
            else if (record.version !== manifest.version) record.status = "update-available";
            else if (record.enabled === false) record.status = "disabled";
            else record.status = "ready";
        }
        writeState();
    }

    async function install(id, options = {}) {
        id = assertPluginId(id);
        const manifest = findManifest(id);
        if (!isMinAppVersionCompatible(app.getVersion(), manifest.minAppVersion)) throw new Error(`当前应用版本不支持 ${manifest.name}`);
        const missing = manifest.dependencies.filter((dependency) => !dependencyReady(dependency));
        if (missing.length && !options.withDependencies) return { needsDependencies: missing, state: publicState() };
        for (const dependency of missing) await install(dependency.id, { withDependencies: true });
        return await installManifest(manifest);
    }

    async function installManifest(manifest) {
        if (activeDownload) throw new Error("已有功能插件下载任务正在进行");
        const targetRoot = path.join(pluginRoot, manifest.id, manifest.version);
        // 暂存路径按插件版本固定：中断后保留 .part，下一次同版本安装可以续传。
        const stagingRoot = path.join(pluginRoot, ".staging", `${manifest.id}-${manifest.version}`);
        const previousRecord = state.plugins[manifest.id] ? { ...state.plugins[manifest.id] } : null;
        const nextRecord = { id: manifest.id, name: manifest.name, version: manifest.version, enabled: true, status: "ready", installedAt: new Date().toISOString(), manifest, error: "" };
        activeDownload = { id: manifest.id, received: 0, total: manifest.assets.reduce((sum, asset) => sum + asset.size, 0), stage: "downloading", controller: new AbortController() };
        emit();
        try {
            for (const asset of manifest.assets) {
                const target = safeJoin(stagingRoot, asset.path);
                await downloadAsset(asset, target, activeDownload);
            }
            activeDownload.stage = "verifying";
            emit();
            for (const asset of manifest.assets) verifyAsset(safeJoin(stagingRoot, asset.path), asset);
            if (manifest.serviceArchive) {
                activeDownload.stage = "extracting";
                emit();
                extractServiceArchive(stagingRoot, manifest.serviceArchive);
            }
            fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
            const backupRoot = `${targetRoot}.previous-${Date.now()}`;
            if (fs.existsSync(targetRoot)) fs.renameSync(targetRoot, backupRoot);
            try {
                fs.renameSync(stagingRoot, targetRoot);
            } catch (switchError) {
                if (fs.existsSync(backupRoot)) fs.renameSync(backupRoot, targetRoot);
                throw switchError;
            }
            // 新版本已完整就绪，旧版本的清理失败不影响当前可用版本。
            fs.rmSync(backupRoot, { recursive: true, force: true });
            nextRecord.status = "ready";
            state.plugins[manifest.id] = nextRecord;
            writeState();
            log({ category: "operation", message: `已安装功能插件：${manifest.name}`, details: { pluginId: manifest.id, version: manifest.version } });
            return publicState();
        } catch (error) {
            // 用户取消时保留固定暂存目录供断点续传；更新失败继续使用旧版本。
            if (error?.name !== "AbortError") fs.rmSync(stagingRoot, { recursive: true, force: true });
            if (previousRecord) state.plugins[manifest.id] = previousRecord;
            else delete state.plugins[manifest.id];
            writeState();
            throw error;
        } finally {
            activeDownload = null;
            emit();
        }
    }

    async function downloadAsset(asset, target, download) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.existsSync(target)) {
            try {
                verifyAsset(target, asset);
                download.received += asset.size;
                emit();
                return;
            } catch {
                fs.rmSync(target, { force: true });
            }
        }
        const part = `${target}.part`;
        const offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (offset > asset.size) fs.rmSync(part, { force: true });
        let resumed = fs.existsSync(part) ? fs.statSync(part).size : 0;
        const response = await fetch(asset.url, { headers: resumed ? { range: `bytes=${resumed}-` } : {}, signal: download.controller.signal });
        if (!response.ok || !response.body) throw new Error(`下载 ${asset.path} 失败：HTTP ${response.status}`);
        if (resumed && response.status !== 206) {
            fs.rmSync(part, { force: true });
            resumed = 0;
        }
        download.received += resumed;
        const stream = fs.createWriteStream(part, { flags: resumed && response.status === 206 ? "a" : "w" });
        const reader = Readable.fromWeb(response.body);
        reader.on("data", (chunk) => {
            download.received += chunk.length;
            emit();
        });
        await pipeline(reader, stream);
        const size = fs.statSync(part).size;
        if (size !== asset.size) throw new Error(`下载文件大小不匹配：${asset.path}`);
        fs.renameSync(part, target);
    }

    function verifyAsset(file, asset) {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size !== asset.size) throw new Error(`文件校验失败：${asset.path}`);
        const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        if (hash !== asset.sha256) throw new Error(`文件哈希校验失败：${asset.path}`);
    }

    function cancelDownload() {
        if (activeDownload) activeDownload.controller.abort();
        return publicState();
    }

    function setEnabled(id, enabled) {
        id = assertPluginId(id);
        const record = state.plugins[id];
        if (!record) throw new Error("插件尚未安装");
        if (enabled) {
            const missing = (record.manifest?.dependencies || []).filter((dependency) => !dependencyReady(dependency));
            if (missing.length) throw new Error(`请先启用依赖：${missing.map((dependency) => dependency.id).join("、")}`);
        }
        if (!enabled && id === "agent-core") {
            stopAgent();
            const skill = state.plugins["skill-manager"];
            if (skill?.enabled) {
                skill.enabled = false;
                skill.status = "disabled";
            }
        }
        record.enabled = Boolean(enabled);
        record.status = record.enabled ? "ready" : "disabled";
        writeState();
        emit();
        return publicState();
    }

    function uninstall(id) {
        id = assertPluginId(id);
        if (id === "agent-core" && state.plugins["skill-manager"]) uninstall("skill-manager");
        if (id === "agent-core") {
            stopAgent();
        }
        const record = state.plugins[id];
        if (record) {
            const target = path.join(pluginRoot, id, record.version);
            fs.rmSync(target, { recursive: true, force: true });
            delete state.plugins[id];
            writeState();
        }
        if (id === "agent-core") removeManagedRuntimeIfUnused();
        emit();
        return publicState();
    }

    function readPluginSource(id) {
        id = assertPluginId(id);
        const record = state.plugins[id];
        if (!record?.enabled || !["ready", "update-available"].includes(record.status)) throw new Error("插件当前不可用");
        const entry = record.manifest?.rendererEntry;
        const file = safeJoin(path.join(pluginRoot, id, record.version), entry);
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_RENDERER_SOURCE_BYTES) throw new Error("插件渲染文件无效或过大");
        return fs.readFileSync(file, "utf8");
    }

    function dependencyReady(dependency) {
        const record = state.plugins[dependency.id];
        return Boolean(record?.enabled && ["ready", "update-available"].includes(record.status) && isVersionCompatible(record.version, dependency.range));
    }

    function pluginFilesHealthy(record) {
        try {
            const root = path.join(pluginRoot, record.id, record.version);
            if (!record.manifest.assets.every((asset) => fs.existsSync(safeJoin(root, asset.path)))) return false;
            if (record.manifest.serviceArchive) verifyServiceTree(root, record.manifest.serviceArchive);
            return !record.manifest.serviceEntry || fs.statSync(safeJoin(root, record.manifest.serviceEntry)).isFile();
        } catch {
            return false;
        }
    }

    function runtimeNeeded(manifest) {
        return Boolean(manifest?.runtime && manifest.id === "agent-core");
    }

    function runtimeMatches(runtime) {
        return Boolean(runtime && state.runtime?.path && state.runtime?.version && isVersionCompatible(state.runtime.version, runtime.versionRange));
    }

    function probeCodexCandidates() {
        const candidates = new Set();
        if (state.runtime?.source === "manual" && state.runtime.path) candidates.add(state.runtime.path);
        const found = spawnSync("where.exe", ["codex"], { encoding: "utf8", windowsHide: true, timeout: CODEX_TIMEOUT_MS });
        if (found.status === 0) String(found.stdout || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean).forEach((item) => candidates.add(item));
        const results = [...candidates].map(probeCodex).filter(Boolean);
        const agent = catalog.find((item) => item.id === "agent-core");
        const compatible = results.find((item) => item.available && (!agent?.runtime || isVersionCompatible(item.version, agent.runtime.versionRange))) || null;
        if (compatible) {
            state.runtime = { source: compatible.path === state.runtime?.path ? state.runtime.source || "manual" : "system", path: compatible.path, version: compatible.version, checkedAt: new Date().toISOString() };
            writeState();
        }
        reconcileInstalled();
        emit();
        return { candidates: results, compatible, state: publicState() };
    }

    function chooseCodexRuntime(file) {
        if (!/\.(?:exe|cmd)$/i.test(String(file || ""))) throw new Error("请选择 codex.exe 或 codex.cmd");
        const result = probeCodex(file);
        const agent = catalog.find((item) => item.id === "agent-core");
        if (!result.available || (agent?.runtime && !isVersionCompatible(result.version, agent.runtime.versionRange))) throw new Error(result.error || "所选 Codex 版本不兼容");
        state.runtime = { source: "manual", path: result.path, version: result.version, checkedAt: new Date().toISOString() };
        writeState();
        reconcileInstalled();
        emit();
        return publicState();
    }

    async function installManagedRuntime() {
        const manifest = findManifest("agent-core");
        const runtime = manifest.runtime;
        if (!runtime) throw new Error("Agent Core 未声明 Codex 运行时");
        if (activeDownload) throw new Error("已有功能插件下载任务正在进行");
        const runtimeRoot = path.join(pluginRoot, "runtime", "codex", runtime.version);
        const target = safeJoin(runtimeRoot, runtime.asset.path);
        activeDownload = { id: "codex-runtime", received: 0, total: runtime.asset.size, stage: "downloading", controller: new AbortController() };
        try {
            await downloadAsset(runtime.asset, target, activeDownload);
            verifyAsset(target, runtime.asset);
            let executable = target;
            if (runtime.format === "tar") executable = extractTarRuntime(target, runtimeRoot, runtime.entry);
            state.runtime = { source: "managed", path: executable, version: runtime.version, checkedAt: new Date().toISOString() };
            writeState();
            reconcileInstalled();
            return publicState();
        } finally {
            activeDownload = null;
            emit();
        }
    }

    function removeManagedRuntimeIfUnused() {
        if (state.runtime?.source !== "managed") return;
        if (Object.values(state.plugins).some((record) => runtimeNeeded(record.manifest))) return;
        const target = path.join(pluginRoot, "runtime", "codex", state.runtime.version || "");
        fs.rmSync(target, { recursive: true, force: true });
        state.runtime = {};
        writeState();
    }

    async function startAgent() {
        if (state.remoteAgent?.url) return decryptRemoteAgent();
        const record = state.plugins["agent-core"];
        if (!record?.enabled) throw new Error("请先安装并启用 Agent Core");
        if (!runtimeMatches(record.manifest.runtime)) throw new Error("需要可用的 Codex 运行时");
        if (agentConnection) return agentConnection;
        if (agentProcess) throw new Error("Agent 服务正在启动");
        const service = safeJoin(path.join(pluginRoot, record.id, record.version), record.manifest.serviceEntry);
        if (!record.manifest.serviceEntry || !fs.existsSync(service)) throw new Error("Agent 服务文件缺失，请执行修复");
        const token = crypto.randomBytes(32).toString("hex");
        const child = spawn(process.execPath, [service], {
            windowsHide: true,
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: "1",
                LY_SPACE_AGENT_TOKEN: token,
                LY_SPACE_CODEX_PATH: state.runtime.path,
                LY_SPACE_AGENT_DATA_DIR: path.join(dataRoot, "agent-core"),
                LY_SPACE_AGENT_PORT: "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        agentProcess = child;
        let connection;
        try {
            connection = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Agent 服务启动超时")), 10000);
                const fail = (error) => {
                    clearTimeout(timer);
                    reject(error);
                };
                const onData = (chunk) => {
                    const text = String(chunk);
                    const match = text.match(/LY_SPACE_AGENT_READY:(\{[^\n]+\})/);
                    if (!match) return;
                    try {
                        const payload = JSON.parse(match[1]);
                        if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(payload.url || "")) throw new Error("Agent 服务地址无效");
                        clearTimeout(timer);
                        resolve({ url: payload.url, token });
                    } catch (error) {
                        fail(error);
                    }
                };
                child.stdout.on("data", onData);
                child.stderr.on("data", (chunk) => log({ category: "error", level: "warn", message: "Agent 服务输出错误", details: { error: redact(String(chunk)) } }));
                child.once("exit", (code) => fail(new Error(`Agent 服务已退出（${code ?? "未知"}）`)));
                child.once("error", fail);
            });
        } catch (error) {
            if (!child.killed) child.kill();
            if (agentProcess === child) agentProcess = null;
            throw error;
        }
        agentConnection = connection;
        child.once("exit", () => {
            agentProcess = null;
            agentConnection = null;
            emit();
        });
        emit();
        return connection;
    }

    function stopAgent() {
        stopAgentEvents();
        if (agentProcess && !agentProcess.killed) agentProcess.kill();
        agentProcess = null;
        agentConnection = null;
    }

    async function agentRequest(payload) {
        const method = String(payload?.method || "GET").toUpperCase();
        const requestPath = String(payload?.path || "");
        if (!/^\/[a-zA-Z0-9_./?=&%-]*$/.test(requestPath) || requestPath.includes("..")) throw new Error("Agent 请求路径无效");
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Agent 请求方法无效");
        const body = payload?.body === undefined ? undefined : JSON.stringify(payload.body);
        if (body && Buffer.byteLength(body, "utf8") > 30 * 1024 * 1024) throw new Error("Agent 请求内容超过限制");
        const connection = state.remoteAgent?.url ? decryptRemoteAgent() : await startAgent();
        const separator = requestPath.includes("?") ? "&" : "?";
        const response = await fetch(`${connection.url}${requestPath}${separator}token=${encodeURIComponent(connection.token)}`, {
            method,
            headers: { "content-type": "application/json", "x-ly-space-agent-token": connection.token },
            body,
            signal: AbortSignal.timeout(45000),
        });
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > 32 * 1024 * 1024) throw new Error("Agent 响应超过限制");
        const data = text ? safeJson(text) : null;
        if (!response.ok) throw new Error(String(data?.error || `Agent 请求失败：HTTP ${response.status}`));
        return data;
    }

    async function subscribeAgent(clientId) {
        clientId = String(clientId || "").trim();
        if (!/^[A-Za-z0-9_-]{6,160}$/.test(clientId)) throw new Error("Agent 客户端标识无效");
        stopAgentEvents();
        const connection = state.remoteAgent?.url ? decryptRemoteAgent() : await startAgent();
        const controller = new AbortController();
        agentEventAbort = controller;
        const response = await fetch(`${connection.url}/events?token=${encodeURIComponent(connection.token)}&clientId=${encodeURIComponent(clientId)}`, {
            headers: { "x-canvas-agent-token": connection.token, accept: "text/event-stream" },
            signal: controller.signal,
        });
        if (!response.ok || !response.body) {
            controller.abort();
            agentEventAbort = null;
            throw new Error(`连接 Agent 事件流失败：HTTP ${response.status}`);
        }
        void consumeAgentEvents(response.body, clientId, () => getMainWindow(), controller).catch((error) => {
            if (!controller.signal.aborted) log({ category: "error", level: "warn", message: "Agent 事件流已断开", details: { error: redact(error instanceof Error ? error.message : String(error)) } });
        }).finally(() => {
            if (agentEventAbort === controller) agentEventAbort = null;
        });
        return { connected: true };
    }

    function stopAgentEvents() {
        agentEventAbort?.abort();
        agentEventAbort = null;
    }

    async function resolveAgentTool(clientId, payload) {
        const requestId = String(payload?.requestId || "");
        if (!/^[A-Za-z0-9_-]{6,160}$/.test(String(clientId || "")) || !requestId) throw new Error("Agent 工具回执无效");
        return await agentRequest({ method: "POST", path: `/canvas/result?clientId=${encodeURIComponent(clientId)}`, body: { requestId, ...(payload?.error ? { error: String(payload.error) } : { result: payload?.result }) } });
    }

    function setRemoteAgentCredentials(input) {
        const url = validateRemoteUrl(String(input?.url || ""));
        const token = String(input?.token || "").trim();
        if (!token) throw new Error("Agent 令牌不能为空");
        if (!safeStorage.isEncryptionAvailable()) throw new Error("当前系统无法安全保存 Agent 凭据，请仅使用本地 Agent");
        state.remoteAgent = { url, token: safeStorage.encryptString(token).toString("base64") };
        writeState();
        emit();
        return publicState();
    }

    function clearRemoteAgentCredentials() {
        state.remoteAgent = null;
        writeState();
        emit();
        return publicState();
    }

    function decryptRemoteAgent() {
        const remote = state.remoteAgent;
        if (!remote || !safeStorage.isEncryptionAvailable()) throw new Error("远程 Agent 凭据不可用");
        return { url: validateRemoteUrl(remote.url), token: safeStorage.decryptString(Buffer.from(remote.token, "base64")) };
    }

    return {
        list: () => publicState(),
        refresh,
        install,
        cancelDownload,
        setEnabled,
        uninstall,
        readPluginSource,
        probeCodexCandidates,
        chooseCodexRuntime,
        installManagedRuntime,
        startAgent,
        stopAgent,
        agentRequest,
        subscribeAgent,
        stopAgentEvents,
        resolveAgentTool,
        setRemoteAgentCredentials,
        clearRemoteAgentCredentials,
        shutdown: stopAgent,
    };
}

async function consumeAgentEvents(body, clientId, getWindow, controller) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "message";
    let data = [];
    const dispatch = () => {
        if (!data.length) return;
        const window = getWindow();
        if (window && !window.isDestroyed()) window.webContents.send("lyspace:agent-event", { clientId, event, data: safeJson(data.join("\n")) });
        event = "message";
        data = [];
    };
    while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
            if (!line) dispatch();
            else if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (done) break;
    }
    dispatch();
}

function safeRelativePath(value) {
    return Boolean(value && !path.isAbsolute(value) && !value.includes("..") && !value.includes("\\") && !value.includes(":") && !value.startsWith("//") && value === path.posix.normalize(value));
}

function safeJoin(root, relative) {
    if (!safeRelativePath(relative)) throw new Error("插件文件路径无效");
    const target = path.resolve(root, ...relative.split("/"));
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`) && target !== path.resolve(root)) throw new Error("插件文件路径越界");
    return target;
}

function isHttps(value) {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

function isSemver(value) {
    return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function parseSemver(value) {
    const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(left, right) {
    const a = parseSemver(left);
    const b = parseSemver(right);
    if (!a || !b) return NaN;
    for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
    return 0;
}

function isVersionCompatible(version, range) {
    if (!range || range === "*") return true;
    const clauses = String(range).split(/\s+/).filter(Boolean);
    return clauses.every((clause) => {
        const match = clause.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/);
        if (!match) return false;
        const result = compareSemver(version, match[2]);
        if (!Number.isFinite(result)) return false;
        return match[1] === ">=" ? result >= 0 : match[1] === "<=" ? result <= 0 : match[1] === ">" ? result > 0 : match[1] === "<" ? result < 0 : result === 0;
    });
}

// 清单的 minAppVersion 是最低支持版本，裸版本（例如 0.5.6）不是“仅支持该版本”。
// 依赖和 Codex 运行时范围继续使用 isVersionCompatible 的精确语义。
function isMinAppVersionCompatible(version, minimum) {
    const normalized = String(minimum || "").trim();
    if (/^\d+\.\d+\.\d+$/.test(normalized)) {
        const result = compareSemver(version, normalized);
        return Number.isFinite(result) && result >= 0;
    }
    return isVersionCompatible(version, normalized);
}

function probeCodex(candidate) {
    const target = path.resolve(String(candidate || ""));
    if (!fs.existsSync(target)) return { path: target, available: false, version: "", error: "文件不存在" };
    const isCommand = /\.cmd$/i.test(target);
    const command = isCommand ? "cmd.exe" : target;
    const args = isCommand ? ["/d", "/s", "/c", `\"${target}\" --version`] : ["--version"];
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: CODEX_TIMEOUT_MS });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const version = parseSemver(output)?.join(".") || "";
    return { path: target, available: result.status === 0 && Boolean(version), version, error: result.error ? result.error.message : result.status === 0 ? "无法识别版本" : output.trim().slice(0, 240) || "命令执行失败" };
}

function validateRemoteUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error("Agent 地址无效");
    }
    const local = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !local) throw new Error("远程 Agent 必须使用 HTTPS（localhost 例外）");
    return parsed.toString().replace(/\/$/, "");
}

function safeJson(value) {
    try {
        return JSON.parse(value);
    } catch {
        return { text: value };
    }
}

function redact(value) {
    return String(value).replace(/(token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, "$1: [已脱敏]");
}

function extractTarRuntime(archive, runtimeRoot, entry) {
    const staging = path.join(runtimeRoot, `.extract-${Date.now()}`);
    const listed = spawnSync("tar.exe", ["-tvf", archive], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    if (listed.status !== 0) throw new Error(`无法检查 Codex 运行时归档：${listed.stderr || listed.stdout}`);
    const lines = String(listed.stdout || "").split(/\r?\n/).filter(Boolean);
    if (!lines.length || lines.length > 20000) throw new Error("Codex 运行时归档文件数无效");
    for (const line of lines) {
        const name = line.trim().split(/\s+/).at(-1) || "";
        if (line.startsWith("l") || !safeRelativePath(name.replace(/\\/g, "/"))) throw new Error("Codex 运行时归档包含不安全路径");
    }
    fs.mkdirSync(staging, { recursive: true });
    const extracted = spawnSync("tar.exe", ["-xf", archive, "-C", staging], { encoding: "utf8", windowsHide: true, timeout: 120000 });
    if (extracted.status !== 0) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw new Error(`无法解压 Codex 运行时：${extracted.stderr || extracted.stdout}`);
    }
    const executable = safeJoin(staging, entry);
    if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw new Error("Codex 运行时归档缺少入口程序");
    }
    const finalRoot = path.join(runtimeRoot, "package");
    if (fs.existsSync(finalRoot)) fs.rmSync(finalRoot, { recursive: true, force: true });
    fs.renameSync(safeJoin(staging, "package"), finalRoot);
    fs.rmSync(staging, { recursive: true, force: true });
    return safeJoin(runtimeRoot, entry);
}

function extractServiceArchive(stagingRoot, descriptor) {
    const archive = safeJoin(stagingRoot, descriptor.asset.path);
    const listed = spawnSync("tar.exe", ["-tvzf", archive], { encoding: "utf8", windowsHide: true, timeout: 30000 });
    if (listed.status !== 0) throw new Error(`无法检查 Agent 服务归档：${listed.stderr || listed.stdout}`);
    const lines = String(listed.stdout || "").split(/\r?\n/).filter(Boolean);
    if (!lines.length || lines.length > MAX_SERVICE_FILES + 8) throw new Error("Agent 服务归档文件数无效");
    const prefix = `${descriptor.root}/`;
    for (const line of lines) {
        const name = (line.trim().split(/\s+/).at(-1) || "").replace(/\\/g, "/");
        if (/^[lh]/.test(line) || !safeRelativePath(name) || (name !== descriptor.root && !name.startsWith(prefix))) throw new Error("Agent 服务归档包含不安全路径或链接");
    }
    const extracted = spawnSync("tar.exe", ["-xzf", archive, "-C", stagingRoot], { encoding: "utf8", windowsHide: true, timeout: 120000 });
    if (extracted.status !== 0) throw new Error(`无法解压 Agent 服务：${extracted.stderr || extracted.stdout}`);
    verifyServiceTree(stagingRoot, descriptor);
}

function verifyServiceTree(pluginRoot, descriptor) {
    const root = safeJoin(pluginRoot, descriptor.root);
    const treeFile = safeJoin(root, descriptor.tree.path);
    if (!fs.existsSync(treeFile) || crypto.createHash("sha256").update(fs.readFileSync(treeFile)).digest("hex") !== descriptor.tree.sha256) throw new Error("Agent 服务树清单校验失败");
    const tree = JSON.parse(fs.readFileSync(treeFile, "utf8"));
    if (!Array.isArray(tree.files) || tree.fileCount !== descriptor.tree.fileCount || tree.totalBytes !== descriptor.tree.totalBytes || tree.files.length !== descriptor.tree.fileCount) throw new Error("Agent 服务树清单内容无效");
    let totalBytes = 0;
    for (const entry of tree.files) {
        if (!safeRelativePath(String(entry?.path || "")) || !Number.isSafeInteger(entry?.size) || entry.size < 0 || !/^[a-f0-9]{64}$/i.test(String(entry?.sha256 || ""))) throw new Error("Agent 服务树条目无效");
        const file = safeJoin(root, entry.path);
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== entry.sha256) throw new Error(`Agent 服务文件校验失败：${entry.path}`);
        totalBytes += info.size;
    }
    if (totalBytes !== descriptor.tree.totalBytes || totalBytes > MAX_SERVICE_UNPACKED_BYTES) throw new Error("Agent 服务解压体积无效");
}

module.exports = { createFeaturePluginManager, OFFICIAL_FEATURE_PLUGIN_IDS, FEATURE_REGISTRY_URL, isVersionCompatible, isMinAppVersionCompatible, safeRelativePath, validateRemoteUrl };
