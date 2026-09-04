const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net: electronNet, protocol, safeStorage, session, shell, Tray } = require("electron");
const { autoUpdater } = require("electron-updater");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { copyDirectoryExact, directoryManifest, restoreBridgeBackup, sameManifest } = require("./storage-migration.cjs");
const { assertWritableDirectory, ensureStorageDirectories: ensureConfiguredStorageDirectories, readStorageSettingsFile, writeStorageSettingsFile } = require("./storage-settings.cjs");
const { buildInstallerArgs, buildInstallerLaunchOptions, createPersistenceFlushCoordinator } = require("./update-install-coordinator.cjs");
const { createFeaturePluginManager } = require("./feature-plugin-manager.cjs");
const { applyRecoverySelection, createRecoveryCatalog, directoryLightManifest, ensureCurrentSnapshot, listSafetyRecoverySources, listUpgradeRecoverySources, normalizeProjects, projectDigest, redactPathText, sameLightManifest, saveCurrentSnapshot, saveRecoveryBundle } = require("./canvas-recovery.cjs");
const { normalizeRetentionDays, pruneLogFile, readLogSettings, writeLogSettings } = require("./app-logs.cjs");

protocol.registerSchemesAsPrivileged([
    { scheme: "lyspace", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow = null;
let tray = null; // 系统托盘（模块级引用防 GC）
let storageSettings = null;
let allowWindowClose = false;
let updateFileInfo = null; // update-available 携带的安装包信息（files[0]: url/sha512/size）
let updateDownloadRequest = null; // 自研断点续传下载的进行中请求
let updateDownloadWriteStream = null;
let updateDownloadAborted = false; // 用户暂停/中止下载标记
let lastCheckSource = "manual";
let updateState = { status: "idle", version: "", releaseDate: "", releaseNotes: "", progress: null, error: "", supported: false, triggeredBy: "" };
const persistenceFlushCoordinator = createPersistenceFlushCoordinator({
    timeoutMs: 15000,
    onTimeout: (request, error) => {
        writeUpdateInstallLog("flush-timeout", { id: request.id, action: request.action, error: error.message });
        if (request.action === "install") updateSnapshot({ status: "downloaded", error: error.message });
    },
});

const RESULT_FOLDERS = { image: "Picture", video: "Video", audio: "Audio", text: "text" };
const APP_LOG_MAX_BYTES = 4 * 1024 * 1024;
const APP_LOG_KEEP_BYTES = 2 * 1024 * 1024;
let logSettings = { retentionDays: 7 };
let lastLogPruneAt = 0;
const CANVAS_RECOVERY_SCAN_TTL_MS = 20 * 60 * 1000;
const canvasRecoveryScans = new Map();

function displayVersion(version) {
    const value = String(version || "").trim().replace(/^v/i, "");
    return value ? `v${value}` : "";
}

function updateSnapshot(patch) {
    updateState = { ...updateState, ...patch };
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("lyspace:update-state-changed", updateState);
    return updateState;
}

function updateError(error) {
    updateSnapshot({ status: "error", progress: null, error: error instanceof Error ? error.message : String(error || "更新失败") });
}

function writeUpdateInstallLog(event, details = {}) {
    try {
        const file = path.join(app.getPath("userData"), "app-data", "update-install.log");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`, "utf8");
        writeAppLog({ category: "system", level: "info", message: `更新安装：${event}`, details });
    } catch {
        // 日志失败不能影响安装或退出。
    }
}

function appLogDirectory() {
    return path.join(app.getPath("userData"), "app-data");
}

function appLogFile() {
    return path.join(appLogDirectory(), "app.log");
}

function appLogSettingsFile() {
    return path.join(appLogDirectory(), "app-log-settings.json");
}

function pruneExpiredLogs(force = false) {
    if (!force && Date.now() - lastLogPruneAt < 24 * 60 * 60 * 1000) return false;
    lastLogPruneAt = Date.now();
    return pruneLogFile(appLogFile(), logSettings.retentionDays);
}

function redactLogValue(value, depth = 0) {
    if (depth > 4 || value == null) return value;
    if (typeof value === "string") {
        const truncated = value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
        return truncated
            .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[已脱敏]")
            .replace(/((?:api[_.-]?key|authorization|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[已脱敏]");
    }
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactLogValue(item, depth + 1));
    if (typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /api.?key|authorization|password|secret|token/i.test(key) ? "[已脱敏]" : redactLogValue(item, depth + 1)]));
}

function redactUrlForLog(value) {
    try {
        const url = new URL(String(value));
        // URL 查询参数可能携带签名或临时令牌，日志中只保留脱敏后的请求路径。
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        return "[无效 URL]";
    }
}

function writeAppLog(entry) {
    try {
        const level = ["info", "warn", "error"].includes(entry?.level) ? entry.level : "info";
        const category = ["system", "network", "operation", "error"].includes(entry?.category) ? entry.category : "system";
        const record = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            time: typeof entry?.time === "string" ? entry.time : new Date().toISOString(),
            level,
            category,
            message: String(entry?.message || "未命名日志").slice(0, 500),
            details: redactLogValue(entry?.details),
        };
        const file = appLogFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
        if (fs.statSync(file).size > APP_LOG_MAX_BYTES) {
            const content = fs.readFileSync(file);
            const tail = content.subarray(Math.max(0, content.length - APP_LOG_KEEP_BYTES));
            const firstLine = tail.indexOf(0x0a);
            fs.writeFileSync(file, firstLine >= 0 ? tail.subarray(firstLine + 1) : tail);
        }
        pruneExpiredLogs();
    } catch {
        // 日志失败不能影响主流程。
    }
}

async function readAppLogs(limit = 500) {
    try {
        const content = await fs.promises.readFile(appLogFile(), "utf8");
        const max = Math.max(1, Math.min(Number(limit) || 500, 2000));
        return content
            .trim()
            .split("\n")
            .filter(Boolean)
            .slice(-max)
            .reverse()
            .flatMap((line) => {
                try {
                    return [JSON.parse(line)];
                } catch {
                    return [];
                }
            });
    } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
    }
}

async function clearAppLogs() {
    await fs.promises.mkdir(appLogDirectory(), { recursive: true });
    await fs.promises.writeFile(appLogFile(), "", "utf8");
}

async function extractCanvasProjects(source) {
    const cacheRoot = source.cache;
    const tempRoot = path.join(appLogDirectory(), "canvas-recovery-temp", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    // 扫描只做只读预览：用轻量清单（大小+修改时间）检测来源与副本一致性，
    // 不再对整个备份目录做同步 SHA-256 全量哈希（会冻结主进程，且严格校验会误伤可读来源）。
    const cacheManifest = await directoryLightManifest(cacheRoot);
    const copy = async (from, destination) => { if (fs.existsSync(from)) await fs.promises.cp(from, destination, { recursive: true, errorOnExist: false }); };
    try {
        await copy(path.join(cacheRoot, "IndexedDB"), path.join(tempRoot, "IndexedDB"));
        await copy(path.join(cacheRoot, "Local Storage"), path.join(tempRoot, "Local Storage"));
        if (!sameLightManifest(await directoryLightManifest(cacheRoot), cacheManifest)) throw new Error("恢复来源在读取期间发生变化");
        const copiedExpected = [];
        for (const item of cacheManifest) {
            if (item.path.startsWith("IndexedDB/") || item.path.startsWith("Local Storage/")) copiedExpected.push(item);
        }
        if (!sameLightManifest(await directoryLightManifest(tempRoot), copiedExpected)) throw new Error("恢复副本校验失败");
        const recoverySession = session.fromPath(tempRoot);
        await recoverySession.protocol.handle("lyspace", () => new Response("<!doctype html><title>LY Space recovery</title>", { headers: { "content-type": "text/html" } }));
        const window = new BrowserWindow({ show: false, webPreferences: { session: recoverySession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
        try {
            await window.loadURL("lyspace://app/recovery");
            const value = await window.webContents.executeJavaScript(`new Promise((resolve) => { const config = localStorage.getItem("infinite-canvas:ai_config_store"); const request = indexedDB.open("infinite-canvas"); request.onerror = () => resolve({ canvas: null, config }); request.onsuccess = () => { const db = request.result; if (!db.objectStoreNames.contains("app_state")) return resolve({ canvas: null, config }); const get = db.transaction("app_state", "readonly").objectStore("app_state").get("infinite-canvas:canvas_store"); get.onerror = () => resolve({ canvas: null, config }); get.onsuccess = () => resolve({ canvas: typeof get.result === "string" ? get.result : null, config }); }; })`, true);
            let config = null;
            try { config = value?.config ? JSON.parse(value.config).state || null : null; } catch { /* 配置损坏不影响画布恢复。 */ }
            if (!value?.canvas) return config ? { projects: [], config } : null;
            return { projects: normalizeProjects(JSON.parse(value.canvas).state?.projects), config };
        } finally {
            window.destroy();
            await recoverySession.clearStorageData().catch(() => {});
        }
    } finally {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
}

function registerCanvasRecoveryScan(current, sources) {
    for (const [id, scan] of canvasRecoveryScans) if (Date.now() - scan.createdAt > CANVAS_RECOVERY_SCAN_TTL_MS) canvasRecoveryScans.delete(id);
    const id = crypto.randomUUID();
    const catalog = createRecoveryCatalog(current, sources);
    canvasRecoveryScans.set(id, { createdAt: Date.now(), catalog });
    return { id, catalog };
}

const UPDATE_OWNER = "LightyearXizIl";
const UPDATE_REPO = "LY-Space";

function updateDownloadsDir() {
    return path.join(app.getPath("userData"), "updates");
}

function updateDownloadBaseUrl(version) {
    return `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/download/${displayVersion(version)}`;
}

function updateFileName() {
    return updateFileInfo?.url || `LY-Space-Setup-${displayVersion(updateState.version).replace(/^v/, "")}.exe`;
}

function updatePartPath() {
    return path.join(updateDownloadsDir(), `${updateFileName()}.part`);
}

function updateExePath() {
    return path.join(updateDownloadsDir(), updateFileName());
}

function hashFileBase64(filePath, algorithm = "sha512") {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash(algorithm);
        const stream = fs.createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("base64")));
        stream.on("error", reject);
    });
}

async function hasVerifiedCachedUpdate(filePath, expectedSize, expectedHash) {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || (expectedSize > 0 && stat.size !== expectedSize)) return false;
    if (!expectedHash) return false;
    const actual = (await hashFileBase64(filePath)).replace(/=+$/, "");
    return actual === expectedHash.replace(/=+$/, "");
}

async function readResponseBytes(response, maximumBytes) {
    const declaredLength = Number(response.headers.get("content-length")) || 0;
    if (declaredLength > maximumBytes) throw new Error(`下载内容超过 ${Math.floor(maximumBytes / 1024 / 1024)} MiB 限制`);
    if (!response.body) return Buffer.from(await response.arrayBuffer());
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maximumBytes) {
                await reader.cancel();
                throw new Error(`下载内容超过 ${Math.floor(maximumBytes / 1024 / 1024)} MiB 限制`);
            }
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, length);
}

function configureAutoUpdater() {
    updateState = { status: "idle", version: displayVersion(app.getVersion()), releaseDate: "", releaseNotes: "", progress: null, error: "", supported: app.isPackaged, triggeredBy: "" };
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on("checking-for-update", () => updateSnapshot({ status: "checking", progress: null, error: "" }));
    autoUpdater.on("update-available", (info) => {
        updateFileInfo = info.files && info.files.length ? info.files[0] : null;
        updateSnapshot({ status: "available", version: displayVersion(info.version), releaseDate: info.releaseDate || "", releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : "", progress: null, error: "", triggeredBy: lastCheckSource });
    });
    autoUpdater.on("update-not-available", (info) => {
        updateSnapshot({ status: "upToDate", version: displayVersion(info.version || app.getVersion()), releaseDate: info.releaseDate || "", progress: null, error: "" });
    });
    autoUpdater.on("error", updateError);
}

// 自研断点续传下载：保留 electron-updater 的版本检查（files[0].url/sha512），
// 下载用 net.request + Range 续传写 .part，完成后 sha512 校验并改名为 .exe；
// 暂停（pauseUpdateDownload）保留 .part 已下载字节，再次下载自动从断点继续。
async function downloadUpdate() {
    if (!app.isPackaged) return updateState;
    if (["downloading", "downloaded", "installing"].includes(updateState.status)) return updateState;
    if (!updateFileInfo || !updateState.version) return updateState;

    const dir = updateDownloadsDir();
    fs.mkdirSync(dir, { recursive: true });
    // 清理其它版本的残留安装包（不影响当前版本的 .part 续传）
    const currentName = updateFileName();
    for (const name of fs.readdirSync(dir)) {
        if (name !== currentName && name !== `${currentName}.part`) fs.rmSync(path.join(dir, name), { force: true });
    }

    const partPath = updatePartPath();
    const exePath = updateExePath();
    const total = Number(updateFileInfo.size) || 0;
    if (fs.existsSync(exePath)) {
        const expected = updateFileInfo.sha512 ? String(updateFileInfo.sha512) : "";
        if (await hasVerifiedCachedUpdate(exePath, total, expected)) {
            updateSnapshot({ status: "downloaded", progress: { percent: 100, bytesPerSecond: 0, transferred: total, total }, error: "" });
            return updateState;
        }
        fs.rmSync(exePath, { force: true });
    }

    let existing = 0;
    try {
        existing = fs.statSync(partPath).size;
    } catch {
        existing = 0;
    }
    const url = `${updateDownloadBaseUrl(updateState.version)}/${updateFileName()}`;
    const headers = existing > 0 ? { Range: `bytes=${existing}-` } : {};
    updateDownloadAborted = false;

    const request = electronNet.request({ url, headers });
    updateDownloadRequest = request;
    const stream = fs.createWriteStream(partPath, { flags: existing > 0 ? "a" : "w" });
    updateDownloadWriteStream = stream;

    let received = 0;
    let lastTransferred = existing;
    let lastTime = Date.now();
    let effectiveTotal = total;

    const emitProgress = () => {
        const transferred = existing + received;
        const now = Date.now();
        const elapsed = Math.max(now - lastTime, 1);
        const bytesPerSecond = transferred >= lastTransferred ? ((transferred - lastTransferred) / elapsed) * 1000 : 0;
        lastTransferred = transferred;
        lastTime = now;
        updateSnapshot({ status: "downloading", progress: { percent: effectiveTotal > 0 ? (transferred / effectiveTotal) * 100 : 0, bytesPerSecond, transferred, total: effectiveTotal }, error: "" });
    };

    const finishDownload = async () => {
        updateDownloadRequest = null;
        updateDownloadWriteStream = null;
        try {
            // sha512（base64，去 padding 容错）与 latest.yml/files[0].sha512 比对
            const expected = updateFileInfo.sha512 ? String(updateFileInfo.sha512).replace(/=+$/, "") : "";
            const actual = (await hashFileBase64(partPath)).replace(/=+$/, "");
            if (expected && actual !== expected) {
                fs.rmSync(partPath, { force: true });
                updateSnapshot({ status: "error", progress: null, error: "安装包校验失败，已删除缓存，请重新下载" });
                return;
            }
            fs.renameSync(partPath, exePath);
            updateSnapshot({ status: "downloaded", progress: { percent: 100, bytesPerSecond: 0, transferred: effectiveTotal, total: effectiveTotal }, error: "" });
        } catch (error) {
            updateError(error);
        }
    };

    request.on("response", (response) => {
        if (updateDownloadAborted) return;
        if (response.statusCode >= 400) {
            stream.destroy();
            request.abort();
            updateSnapshot({ status: "error", progress: null, error: `下载失败（HTTP ${response.statusCode}）` });
            return;
        }
        if (response.statusCode === 200 && existing > 0) {
            // 服务器不支持 Range：从头下载
            existing = 0;
            received = 0;
            fs.truncateSync(partPath, 0);
        }
        const contentLength = Number(response.headers["content-length"]) || 0;
        if (effectiveTotal <= 0) effectiveTotal = existing + contentLength;
        response.on("data", (chunk) => {
            if (updateDownloadAborted) return;
            received += chunk.length;
            stream.write(chunk);
            const now = Date.now();
            if (now - lastTime >= 200) emitProgress();
        });
        response.on("end", () => stream.end());
        response.on("error", (error) => {
            if (updateDownloadAborted) return;
            stream.destroy();
            updateError(error);
        });
    });

    request.on("error", (error) => {
        if (updateDownloadAborted) return;
        stream.destroy();
        updateError(error);
    });

    stream.on("finish", () => {
        if (updateDownloadAborted) return;
        void finishDownload();
    });
    stream.on("error", (error) => {
        if (updateDownloadAborted) return;
        updateError(error);
    });

    updateSnapshot({ status: "downloading", progress: { percent: total > 0 ? (existing / total) * 100 : 0, bytesPerSecond: 0, transferred: existing, total }, error: "" });
    request.end();
    return updateState;
}

function pauseUpdateDownload() {
    if (updateState.status !== "downloading") return updateState;
    updateDownloadAborted = true;
    if (updateDownloadRequest) updateDownloadRequest.abort();
    if (updateDownloadWriteStream) updateDownloadWriteStream.end();
    updateSnapshot({ status: "paused", progress: updateState.progress ? { ...updateState.progress, bytesPerSecond: 0 } : null, error: "" });
    return updateState;
}

async function checkForUpdate(source = "manual") {
    if (!app.isPackaged) return updateSnapshot({ status: "idle", error: "", supported: false });
    if (["downloaded", "downloading", "installing"].includes(updateState.status)) return updateState;
    lastCheckSource = source;
    try {
        await autoUpdater.checkForUpdates();
    } catch (error) {
        updateError(error);
    }
    return updateState;
}

function requestPersistenceFlush(action, details = {}) {
    const started = persistenceFlushCoordinator.begin(action, details);
    if (!started.reused) {
        writeUpdateInstallLog("flush-requested", { id: started.request.id, action });
        mainWindow.webContents.send("lyspace:flush-persistence", started.request);
    }
    return started.promise;
}

function launchUpdateInstaller(installerPath, installDir) {
    return new Promise((resolve, reject) => {
        // 使用 assisted NSIS 向导，让用户看见并确认安装过程；/D= 必须保持最后一个参数。
        const child = spawn(installerPath, buildInstallerArgs(installDir), buildInstallerLaunchOptions());
        child.once("error", reject);
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}

function requestUpdateInstall() {
    if (!app.isPackaged || updateState.status !== "downloaded") throw new Error("更新尚未下载完成");
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("主窗口不可用");
    const installerPath = updateExePath();
    if (!fs.existsSync(installerPath)) throw new Error("安装包不存在，请重新下载");
    updateSnapshot({ status: "installing", error: "" });
    return requestPersistenceFlush("install", { installerPath, installDir: path.dirname(app.getPath("exe")), version: updateState.version });
}

function storageConfigFile() {
    return path.join(app.getPath("userData"), "app-data", "storage-settings.json");
}

function lastSaveDirectoryFile() {
    return path.join(app.getPath("userData"), "app-data", "last-save-directory.txt");
}

// 记住用户上次保存文件的目录：下载/保存对话框默认沿用，跨重启持久化
let lastSaveDirectory = "";
function loadLastSaveDirectory() {
    try {
        lastSaveDirectory = fs.readFileSync(lastSaveDirectoryFile(), "utf8").trim();
    } catch {
        lastSaveDirectory = "";
    }
}
function rememberSaveDirectory(directory) {
    if (!directory) return;
    lastSaveDirectory = directory;
    try {
        fs.mkdirSync(path.dirname(lastSaveDirectoryFile()), { recursive: true });
        fs.writeFileSync(lastSaveDirectoryFile(), directory, "utf8");
    } catch {
        // 忽略持久化失败，内存值本次会话仍有效
    }
}
function defaultSaveDirectory() {
    return lastSaveDirectory || app.getPath("downloads");
}

function defaultStorageSettings() {
    const resultRoot = path.join(app.getPath("documents"), "LY Space", "Result");
    const cacheRoot = path.join(app.getPath("userData"), "Data cache");
    return { resultRoot, cacheRoot, defaultResultRoot: resultRoot, defaultCacheRoot: cacheRoot };
}

function readStorageSettings() {
    return readStorageSettingsFile(storageConfigFile(), defaultStorageSettings());
}

function writeStorageSettings() {
    writeStorageSettingsFile(storageConfigFile(), storageSettings);
}

function ensureStorageDirectories(settings = storageSettings) {
    ensureConfiguredStorageDirectories(settings, RESULT_FOLDERS);
}

function isNestedPath(left, right) {
    const relative = path.relative(left, right);
    return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertStoragePath(value, label) {
    return assertWritableDirectory(value, label);
}

function collisionFreePath(target) {
    if (!fs.existsSync(target)) return target;
    const extension = path.extname(target);
    const name = path.basename(target, extension);
    const parent = path.dirname(target);
    let index = 1;
    let candidate = target;
    while (fs.existsSync(candidate)) candidate = path.join(parent, `${name}-${index++}${extension}`);
    return candidate;
}

function copyDirectory(source, target) {
    if (!fs.existsSync(source) || path.resolve(source) === path.resolve(target)) return;
    // 防止目标目录嵌套于源目录导致无限递归复制
    if (isNestedPath(target, source) || isNestedPath(source, target)) throw new Error("目标目录不能与源目录互相嵌套");
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        if (entry.isDirectory()) {
            copyDirectory(sourcePath, targetPath);
        } else if (entry.isFile()) {
            fs.copyFileSync(sourcePath, collisionFreePath(targetPath));
        }
    }
}

function isChildPath(parent, target) {
    const relative = path.relative(path.resolve(parent), path.resolve(target));
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function moveCacheDirectoryExact(source, target) {
    const resolvedSource = path.resolve(source);
    const resolvedTarget = path.resolve(target);
    if (resolvedSource === resolvedTarget) return;
    if (!fs.existsSync(resolvedSource)) throw new Error("原缓存目录不存在，已保留当前设置");
    if (isNestedPath(resolvedSource, resolvedTarget) || isNestedPath(resolvedTarget, resolvedSource)) throw new Error("缓存目录不能与原目录互相嵌套");
    const expected = directoryManifest(resolvedSource);
    if (fs.existsSync(resolvedTarget)) {
        const targetManifest = directoryManifest(resolvedTarget);
        if (targetManifest.length) throw new Error("新缓存目录必须为空，避免混合浏览器数据");
    }
    const parent = path.dirname(resolvedTarget);
    const stage = path.join(parent, `.${path.basename(resolvedTarget)}.lyspace-cache-${process.pid}`);
    if (!isChildPath(parent, stage)) throw new Error("缓存迁移临时目录路径无效");
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    try {
        copyDirectoryExact(resolvedSource, stage);
        if (!sameManifest(directoryManifest(stage), expected)) throw new Error("缓存迁移副本校验失败");
        if (fs.existsSync(resolvedTarget)) fs.rmdirSync(resolvedTarget);
        fs.renameSync(stage, resolvedTarget);
        if (!sameManifest(directoryManifest(resolvedTarget), expected)) throw new Error("缓存迁移最终校验失败");
    } finally {
        if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    }
}

function isTrustedGeneratedFile(rawPath) {
    if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) return false;
    try {
        const root = fs.realpathSync(storageSettings.resultRoot);
        const target = fs.realpathSync(rawPath);
        return isChildPath(root, target);
    } catch {
        return false;
    }
}

function configureStorageBeforeReady() {
    restoreBridgeBackup({
        userData: app.getPath("userData"),
        localAppData: process.env.LOCALAPPDATA || path.dirname(app.getPath("appData")),
        documents: app.getPath("documents"),
        storageConfigFile: storageConfigFile(),
    });
    storageSettings = readStorageSettings();
    loadLastSaveDirectory();
    if (storageSettings.pendingCacheRoot) {
        try {
            const nextCacheRoot = assertStoragePath(storageSettings.pendingCacheRoot, "缓存目录");
            moveCacheDirectoryExact(storageSettings.cacheRoot, nextCacheRoot);
            storageSettings.cacheRoot = nextCacheRoot;
            storageSettings.pendingCacheRoot = "";
            storageSettings.lastError = "";
            writeStorageSettings();
        } catch (error) {
            storageSettings.pendingCacheRoot = "";
            storageSettings.lastError = `缓存目录迁移失败，已继续使用原目录：${error.message || error}`;
            writeStorageSettings();
        }
    }
    try {
        ensureStorageDirectories();
    } catch (error) {
        throw new Error(`无法访问用户配置的存储目录，程序未修改路径也不会使用空白数据启动。${error instanceof Error ? error.message : error}`);
    }
    writeStorageSettings();
    logSettings = readLogSettings(appLogSettingsFile());
    pruneExpiredLogs(true);
    // sessionData 包含 IndexedDB、Local Storage、Cookie 与 Chromium 会话数据，必须在 ready 前固定到用户目录。
    app.setPath("sessionData", storageSettings.cacheRoot);
}

function storageInfo() {
    return { ...storageSettings, folders: Object.fromEntries(Object.entries(RESULT_FOLDERS).map(([kind, folder]) => [kind, path.join(storageSettings.resultRoot, folder)])) };
}

async function writeGeneratedOutput(payload) {
    const kind = payload?.kind;
    const folder = RESULT_FOLDERS[kind];
    if (!folder) throw new Error("不支持的生成文件类型");
    const directory = path.join(storageSettings.resultRoot, folder);
    await fs.promises.mkdir(directory, { recursive: true });
    const extension = String(payload.extension || (kind === "text" ? "txt" : "bin")).replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
    const target = path.join(directory, name);
    const temporary = `${target}.part`;
    const content = kind === "text" ? String(payload.text || "") : Buffer.from(payload.bytes || []);
    await fs.promises.writeFile(temporary, content);
    await fs.promises.rename(temporary, target);
    return { path: target, name };
}

function installApplicationMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: "文件", submenu: [{ label: "退出", click: () => void requestPersistenceFlush("quit").catch((error) => writeUpdateInstallLog("quit-flush-failed", { error: error.message })) }] },
        {
            label: "编辑",
            submenu: [
                { label: "撤销", role: "undo" },
                { label: "重做", role: "redo" },
                { type: "separator" },
                { label: "剪切", role: "cut" },
                { label: "复制", role: "copy" },
                { label: "粘贴", role: "paste" },
                { label: "粘贴并匹配样式", role: "pasteAndMatchStyle" },
                { label: "删除", role: "delete" },
                { type: "separator" },
                { label: "全选", role: "selectAll" },
            ],
        },
        {
            label: "视图",
            submenu: [
                { label: "重新加载", role: "reload" },
                { label: "强制重新加载", role: "forceReload" },
                { label: "切换开发者工具", role: "toggleDevTools" },
                { type: "separator" },
                { label: "实际大小", role: "resetZoom" },
                { label: "放大", role: "zoomIn" },
                { label: "缩小", role: "zoomOut" },
                { type: "separator" },
                { label: "切换全屏", role: "togglefullscreen" },
            ],
        },
        { label: "窗口", submenu: [{ label: "最小化", role: "minimize" }, { label: "缩放", role: "zoom" }, { label: "关闭", role: "close" }] },
    ]));
}

function webDirectory() {
    return path.join(__dirname, "renderer", "dist");
}

function registerAppProtocol() {
    protocol.handle("lyspace", (request) => {
        const root = webDirectory();
        const pathname = decodeURIComponent(new URL(request.url).pathname || "/");
        const candidate = path.resolve(root, `.${pathname}`);
        const isSafeFile = candidate.startsWith(root) && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
        const file = isSafeFile ? candidate : path.join(root, "index.html");
        return electronNet.fetch(pathToFileURL(file).toString());
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1360,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        backgroundColor: "#090909",
        title: "LY Space",
        icon: path.join(__dirname, "build", "icon.png"),
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, preload: path.join(__dirname, "preload.cjs") },
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) void shell.openExternal(url);
        return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith("lyspace://")) {
            event.preventDefault();
            if (/^https?:/i.test(url)) void shell.openExternal(url);
        }
    });
    mainWindow.on("close", (event) => {
        if (allowWindowClose) return;
        // 关闭按钮默认最小化到系统托盘（隐藏窗口，不退出）；数据由现有防抖/异步机制持续落盘
        event.preventDefault();
        mainWindow.hide();
    });
    void mainWindow.loadURL("lyspace://app/");
}

function createTray() {
    if (tray) return;
    const icon = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png")).resize({ width: 32, height: 32 });
    tray = new Tray(icon);
    tray.setToolTip("LY Space");
    const showMainWindow = () => {
        if (!mainWindow) return;
        if (!mainWindow.isVisible()) mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    };
    tray.on("click", showMainWindow);
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: "显示主界面", click: showMainWindow },
            { type: "separator" },
            // 关闭：走 flush 后退出流程（persistence-flushed 时 allowWindowClose=true 再真正关闭），保证数据落盘
            { label: "关闭", click: () => {
                if (!mainWindow || mainWindow.isDestroyed()) return;
                void requestPersistenceFlush("quit").catch((error) => writeUpdateInstallLog("quit-flush-failed", { error: error.message }));
            } },
        ]),
    );
}

app.setName("LY Space");
app.setPath("userData", path.join(app.getPath("appData"), "LY Space"));
app.setAppUserModelId("com.lyspace.desktop");
const featurePluginManager = createFeaturePluginManager({
    app,
    safeStorage,
    getMainWindow: () => mainWindow,
    log: (entry) => writeAppLog(entry),
});
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    app.quit();
} else {
let storageReady = true;
try {
    configureStorageBeforeReady();
} catch (error) {
    dialog.showErrorBox("LY Space 用户数据保护", error instanceof Error ? error.message : String(error));
    storageReady = false;
    app.quit();
}
if (storageReady) {
app.on("second-instance", () => {
    if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});
app.whenReady().then(async () => {
    registerAppProtocol();
    installApplicationMenu();
    configureAutoUpdater();
    writeAppLog({ category: "system", message: "主进程已启动", details: { version: app.getVersion(), packaged: app.isPackaged } });
    app.on("render-process-gone", (_event, webContents, details) => writeAppLog({ category: "error", level: "error", message: "渲染进程异常退出", details: { reason: details.reason, exitCode: details.exitCode, url: webContents.getURL().split("?")[0] } }));
    app.on("child-process-gone", (_event, details) => writeAppLog({ category: "error", level: "error", message: "子进程异常退出", details: { type: details.type, reason: details.reason, exitCode: details.exitCode } }));
    ipcMain.handle("lyspace:set-native-theme", (_event, source) => {
        // 窗口标题栏等原生 UI 明暗跟随应用主题
        nativeTheme.themeSource = source === "dark" ? "dark" : "light";
    });
    ipcMain.handle("lyspace:update-state", () => updateState);
    ipcMain.handle("lyspace:check-update", () => checkForUpdate());
    ipcMain.handle("lyspace:download-update", () => downloadUpdate());
    ipcMain.handle("lyspace:pause-update-download", () => pauseUpdateDownload());
    ipcMain.handle("lyspace:install-downloaded-update", () => requestUpdateInstall());
    ipcMain.handle("lyspace:append-app-log", (_event, entry) => writeAppLog(entry));
    ipcMain.handle("lyspace:read-app-logs", (_event, limit) => readAppLogs(limit));
    ipcMain.handle("lyspace:clear-app-logs", () => clearAppLogs());
    ipcMain.handle("lyspace:app-log-settings", () => logSettings);
    ipcMain.handle("lyspace:set-app-log-retention", (_event, days) => {
        logSettings = writeLogSettings(appLogSettingsFile(), { retentionDays: normalizeRetentionDays(days) });
        pruneExpiredLogs(true);
        return logSettings;
    });
    ipcMain.handle("lyspace:canvas-snapshot", (_event, projects) => saveCurrentSnapshot(appLogDirectory(), normalizeProjects(projects)));
    ipcMain.handle("lyspace:ensure-canvas-snapshot", (_event, projects) => ensureCurrentSnapshot(appLogDirectory(), normalizeProjects(projects)));
    ipcMain.handle("lyspace:canvas-recovery-scan", async (event, current) => {
        const projects = normalizeProjects(current);
        const sources = await listSafetyRecoverySources(appLogDirectory());
        let unreadableSources = 0;
        const failedSources = [];
        const upgradeSources = listUpgradeRecoverySources(process.env.LOCALAPPDATA || path.dirname(app.getPath("appData")));
        // 每检查完一个来源回报进度，渲染层据此显示「正在检查备份（n/总）」。
        const reportProgress = (checked) => {
            try { event.sender.send("lyspace:canvas-recovery-progress", { checked, total: upgradeSources.length, unreadable: unreadableSources }); } catch { /* 渲染层窗口可能已关闭。 */ }
        };
        reportProgress(0);
        for (const [index, source] of upgradeSources.entries()) {
            try {
                const extracted = await extractCanvasProjects(source);
                if (extracted) sources.push({ ...source, ...extracted });
            } catch (error) {
                unreadableSources += 1;
                failedSources.push({ sourceType: source.sourceType, error: redactPathText(error instanceof Error ? error.message : String(error)) });
                writeAppLog({ category: "error", level: "warn", message: "画布恢复来源无法读取", details: { sourceType: source.sourceType, error: error instanceof Error ? error.message : String(error) } });
            }
            reportProgress(index + 1);
        }
        const scan = registerCanvasRecoveryScan(projects, sources);
        return {
            scanId: scan.id,
            sources: scan.catalog.sources,
            projects: scan.catalog.projects.map(({ project, order, ...item }) => item),
            configuration: scan.catalog.configuration ? { source: scan.catalog.configuration.source, createdAt: scan.catalog.configuration.createdAt } : null,
            unreadableSources,
            diagnostics: { createdAt: new Date().toISOString(), sources: scan.catalog.sources.map(({ id, ...source }) => source), unreadableSources, failedSources },
        };
    });
    ipcMain.handle("lyspace:canvas-recovery-apply", (_event, current, request) => {
        const projects = normalizeProjects(current);
        const scanId = String(request?.scanId || "");
        const scan = canvasRecoveryScans.get(scanId);
        if (!scan || Date.now() - scan.createdAt > CANVAS_RECOVERY_SCAN_TTL_MS) {
            canvasRecoveryScans.delete(scanId);
            throw new Error("恢复预览已失效，请重新扫描备份");
        }
        if (projectDigest(projects) !== scan.catalog.currentDigest) throw new Error("画布在扫描后已变化，请重新扫描备份后再恢复");
        const result = applyRecoverySelection(projects, scan.catalog, request?.projectIds);
        if (!result.selected.length) throw new Error("请至少选择一个可恢复画布");
        saveRecoveryBundle(appLogDirectory(), projects, result.selected, result.merged);
        saveCurrentSnapshot(appLogDirectory(), result.merged);
        canvasRecoveryScans.delete(scanId);
        const config = request?.restoreConfiguration ? scan.catalog.configuration?.config || null : null;
        return { projects: result.merged, recovered: result.selected.length, configuration: config };
    });
    ipcMain.handle("lyspace:open-app-log-directory", () => {
        fs.mkdirSync(appLogDirectory(), { recursive: true });
        return shell.openPath(appLogDirectory());
    });
    // 功能插件只能按官方清单 id 操作；渲染层没有原生路径、命令或下载地址入口。
    ipcMain.handle("lyspace:feature-plugins-list", () => featurePluginManager.list());
    ipcMain.handle("lyspace:feature-plugins-refresh", () => featurePluginManager.refresh());
    ipcMain.handle("lyspace:feature-plugins-install", (_event, id, options) => featurePluginManager.install(String(id || ""), { withDependencies: Boolean(options?.withDependencies) }));
    ipcMain.handle("lyspace:feature-plugins-cancel-download", () => featurePluginManager.cancelDownload());
    ipcMain.handle("lyspace:feature-plugins-set-enabled", (_event, id, enabled) => featurePluginManager.setEnabled(String(id || ""), Boolean(enabled)));
    ipcMain.handle("lyspace:feature-plugins-uninstall", (_event, id) => featurePluginManager.uninstall(String(id || "")));
    ipcMain.handle("lyspace:feature-plugins-source", (_event, id) => featurePluginManager.readPluginSource(String(id || "")));
    ipcMain.handle("lyspace:feature-runtime-probe", () => featurePluginManager.probeCodexCandidates());
    ipcMain.handle("lyspace:feature-runtime-choose", async () => {
        const selected = await dialog.showOpenDialog(mainWindow, { title: "选择现有 Codex", properties: ["openFile"], filters: [{ name: "Codex", extensions: ["exe", "cmd"] }] });
        if (selected.canceled || !selected.filePaths[0]) return featurePluginManager.list();
        return featurePluginManager.chooseCodexRuntime(selected.filePaths[0]);
    });
    ipcMain.handle("lyspace:feature-runtime-install", () => featurePluginManager.installManagedRuntime());
    ipcMain.handle("lyspace:agent-start", async () => {
        const connection = await featurePluginManager.startAgent();
        return { url: connection.url };
    });
    ipcMain.handle("lyspace:agent-stop", () => featurePluginManager.stopAgent());
    ipcMain.handle("lyspace:agent-request", (_event, payload) => featurePluginManager.agentRequest(payload));
    ipcMain.handle("lyspace:agent-subscribe", (_event, clientId) => featurePluginManager.subscribeAgent(clientId));
    ipcMain.handle("lyspace:agent-stop-events", () => featurePluginManager.stopAgentEvents());
    ipcMain.handle("lyspace:agent-tool-result", (_event, clientId, payload) => featurePluginManager.resolveAgentTool(clientId, payload));
    ipcMain.handle("lyspace:agent-remote-credentials", (_event, payload) => featurePluginManager.setRemoteAgentCredentials(payload));
    ipcMain.handle("lyspace:agent-clear-remote-credentials", () => featurePluginManager.clearRemoteAgentCredentials());
    ipcMain.handle("lyspace:storage-settings", () => storageInfo());
    ipcMain.handle("lyspace:choose-storage-directory", async (_event, kind) => {
        const selected = await dialog.showOpenDialog(mainWindow, { title: kind === "cache" ? "选择缓存目录" : "选择结果保存目录", properties: ["openDirectory", "createDirectory"] });
        return selected.canceled ? "" : selected.filePaths[0] || "";
    });
    ipcMain.handle("lyspace:update-result-directory", async (_event, directory) => {
        const next = assertStoragePath(directory, "结果目录");
        if (isNestedPath(next, storageSettings.cacheRoot) || isNestedPath(storageSettings.cacheRoot, next)) throw new Error("结果目录不能与缓存目录相同或互相嵌套");
        if (path.resolve(next) !== path.resolve(storageSettings.resultRoot)) copyDirectory(storageSettings.resultRoot, next);
        storageSettings.resultRoot = next;
        ensureStorageDirectories();
        writeStorageSettings();
        return storageInfo();
    });
    ipcMain.handle("lyspace:stage-cache-directory", async (_event, directory) => {
        const next = assertStoragePath(directory, "缓存目录");
        if (isNestedPath(next, storageSettings.resultRoot) || isNestedPath(storageSettings.resultRoot, next)) throw new Error("缓存目录不能与结果目录相同或互相嵌套");
        storageSettings.pendingCacheRoot = next;
        writeStorageSettings();
        return storageInfo();
    });
    ipcMain.handle("lyspace:reset-storage-directory", async (_event, kind) => {
        const defaults = defaultStorageSettings();
        if (kind === "cache") {
            const next = assertStoragePath(defaults.cacheRoot, "缓存目录");
            if (isNestedPath(next, storageSettings.resultRoot) || isNestedPath(storageSettings.resultRoot, next)) throw new Error("缓存目录不能与结果目录相同或互相嵌套");
            storageSettings.pendingCacheRoot = next;
        } else {
            const next = assertStoragePath(defaults.resultRoot, "结果目录");
            if (isNestedPath(next, storageSettings.cacheRoot) || isNestedPath(storageSettings.cacheRoot, next)) throw new Error("结果目录不能与缓存目录相同或互相嵌套");
            copyDirectory(storageSettings.resultRoot, next);
            storageSettings.resultRoot = next;
            ensureStorageDirectories();
        }
        writeStorageSettings();
        return storageInfo();
    });
    ipcMain.handle("lyspace:open-storage-directory", async (_event, directory) => shell.openPath(directory));
    ipcMain.handle("lyspace:fetch-url", async (_event, url, mediaKind = "image") => {
        if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("仅支持 http/https 地址");
        const limits = { image: 32 * 1024 * 1024, video: 512 * 1024 * 1024, audio: 128 * 1024 * 1024 };
        if (!Object.hasOwn(limits, mediaKind)) throw new Error("不支持的媒体类型");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await electronNet.fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
            const contentType = response.headers.get("content-type") || "";
            if (!contentType.toLowerCase().startsWith(`${mediaKind}/`)) throw new Error(`下载内容不是${mediaKind === "image" ? "图片" : mediaKind === "video" ? "视频" : "音频"}`);
            const buffer = await readResponseBytes(response, limits[mediaKind]);
            return { bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), mimeType: contentType };
        } finally {
            clearTimeout(timer);
        }
    });
    ipcMain.handle("lyspace:copy-image-to-clipboard", async (_event, payload) => {
        const bytes = payload?.bytes ? Buffer.from(payload.bytes) : null;
        if (!bytes?.length) throw new Error("没有可复制的图片内容");
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) throw new Error("图片格式无效，无法复制");
        clipboard.writeImage(image);
        const size = image.getSize();
        return { width: size.width, height: size.height };
    });
    ipcMain.handle("lyspace:save-file-dialog", async (_event, payload) => {
        const bytes = payload?.bytes ? Buffer.from(payload.bytes) : null;
        if (!bytes) throw new Error("没有可保存的文件内容");
        const safeName = String(payload?.defaultPath || "image.png").replace(/[\\/:*?"<>|]/g, "_");
        const selected = await dialog.showSaveDialog(mainWindow, {
            title: payload?.title || "保存文件",
            defaultPath: path.join(defaultSaveDirectory(), safeName),
            filters: payload?.filters || [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
        });
        if (selected.canceled || !selected.filePath) return { canceled: true, path: "" };
        await fs.promises.writeFile(selected.filePath, bytes);
        rememberSaveDirectory(path.dirname(selected.filePath));
        return { canceled: false, path: selected.filePath };
    });
    // 批量保存：只弹一次保存对话框，全部文件写入所选目录（首张用所选路径，其余按传入 name 命名、重名自动加序号）
    ipcMain.handle("lyspace:save-files-dialog", async (_event, payload) => {
        const files = Array.isArray(payload?.files) ? payload.files : [];
        if (!files.length) return { canceled: true, paths: [] };
        const safeName = String(files[0]?.name || "image-1.png").replace(/[\\/:*?"<>|]/g, "_");
        const selected = await dialog.showSaveDialog(mainWindow, {
            title: payload?.title || "保存文件",
            defaultPath: path.join(defaultSaveDirectory(), safeName),
            filters: payload?.filters || [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
        });
        if (selected.canceled || !selected.filePath) return { canceled: true, paths: [] };
        const directory = path.dirname(selected.filePath);
        rememberSaveDirectory(directory);
        const savedPaths = [];
        for (let i = 0; i < files.length; i += 1) {
            const bytes = files[i]?.bytes ? Buffer.from(files[i].bytes) : null;
            if (!bytes) continue;
            let target = i === 0 ? selected.filePath : path.join(directory, String(files[i]?.name || `image-${i + 1}.png`).replace(/[\\/:*?"<>|]/g, "_"));
            if (i > 0) {
                const ext = path.extname(target);
                const stem = path.basename(target, ext);
                let counter = 1;
                while (fs.existsSync(target)) {
                    target = path.join(directory, `${stem}-${counter}${ext}`);
                    counter += 1;
                }
            }
            await fs.promises.writeFile(target, bytes);
            savedPaths.push(target);
        }
        return { canceled: false, paths: savedPaths };
    });
    ipcMain.handle("lyspace:write-generated-output", (_event, payload) => writeGeneratedOutput(payload));
    // 删除已落盘的生成文件；localPath 全部由本进程 writeGeneratedOutput 生成（可信来源），仅校验绝对路径防止误删
    ipcMain.handle("lyspace:delete-generated-files", async (_event, paths) => {
        if (!Array.isArray(paths)) return { deleted: 0, missing: 0, failed: 0, skipped: 0 };
        let deleted = 0;
        let missing = 0;
        let failed = 0;
        let skipped = 0;
        for (const rawPath of paths) {
            if (typeof rawPath !== "string") continue;
            const target = path.resolve(rawPath);
            if (!isTrustedGeneratedFile(target)) {
                skipped += 1;
                continue;
            }
            try {
                await fs.promises.unlink(target);
                deleted += 1;
            } catch (error) {
                if (error?.code === "ENOENT") {
                    missing += 1;
                    continue;
                }
                // 文件被占用/权限不足等：延迟重试 3 次后再计失败
                let resolved = false;
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    try {
                        await fs.promises.unlink(target);
                        deleted += 1;
                        resolved = true;
                        break;
                    } catch (retryError) {
                        if (retryError?.code === "ENOENT") {
                            missing += 1;
                            resolved = true;
                            break;
                        }
                    }
                }
                if (!resolved) failed += 1;
            }
        }
        return { deleted, missing, failed, skipped };
    });
    const proxyResponseHeaders = (response) => Object.fromEntries(
        ["content-type", "x-request-id", "x-tt-logid", "x-volc-request-id"]
            .map((name) => [name, response.headers.get(name)])
            .filter(([, value]) => typeof value === "string" && value),
    );
    const arkProxyRequests = new Map();
    const ARK_PROXY_MAX_CONCURRENCY = 6;
    const ARK_PROXY_MAX_BODY_BYTES = 64 * 1024 * 1024;
    const ARK_PROXY_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
    const ARK_PROXY_TIMEOUT_MS = 120000;
    const proxyRequestId = (sender, requestId) => `${sender.id}:${String(requestId || "")}`;
    const proxyRequestOptions = (payload) => {
        const url = String(payload?.url || "");
        if (!/^https:\/\//i.test(url)) throw new Error("仅支持 HTTPS 请求");
        const method = String(payload?.method || "GET").toUpperCase();
        const headers = payload?.headers && typeof payload.headers === "object" ? payload.headers : {};
        const body = typeof payload?.body === "string" ? payload.body : undefined;
        const ark = payload?.kind === "ark";
        const maximumBodyBytes = ark ? ARK_PROXY_MAX_BODY_BYTES : 4 * 1024 * 1024;
        if (body && Buffer.byteLength(body, "utf8") > maximumBodyBytes) throw new Error(`请求体超过 ${Math.floor(maximumBodyBytes / 1024 / 1024)} MiB 限制`);
        return { url, method, headers, body, ark };
    };
    const logProxyRequest = ({ method, url, status, startedAt, headers, error }) => writeAppLog({
        category: "network",
        level: error ? "warn" : "info",
        message: "主进程网络代理",
        details: {
            method,
            url: redactUrlForLog(url),
            status: status || 0,
            durationMs: Date.now() - startedAt,
            requestId: headers?.["x-request-id"] || headers?.["x-tt-logid"] || headers?.["x-volc-request-id"] || "",
            ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
        },
    });
    // 通用请求代理：主进程 fetch 无浏览器网络限制（CORS 等）。方舟可使用更大的素材上限和流式通道。
    ipcMain.handle("lyspace:proxy-request", async (_event, payload) => {
        const request = proxyRequestOptions(payload);
        const requestId = request.ark ? String(payload?.requestId || "") : "";
        const key = requestId ? proxyRequestId(_event.sender, requestId) : "";
        if (key && arkProxyRequests.size >= ARK_PROXY_MAX_CONCURRENCY) throw new Error("方舟并发请求过多，请等待现有请求完成后再试");
        if (key && arkProxyRequests.has(key)) throw new Error("方舟请求 ID 重复");
        const controller = new AbortController();
        if (key) arkProxyRequests.set(key, controller);
        const timer = setTimeout(() => controller.abort(), request.ark ? ARK_PROXY_TIMEOUT_MS : 30000);
        const startedAt = Date.now();
        let responseHeaders;
        let status;
        let failed = false;
        try {
            const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: controller.signal });
            status = response.status;
            responseHeaders = proxyResponseHeaders(response);
            const bytes = await readResponseBytes(response, request.ark ? ARK_PROXY_MAX_RESPONSE_BYTES : 8 * 1024 * 1024);
            return { status, headers: responseHeaders, data: bytes.toString("utf8") };
        } catch (error) {
            failed = true;
            logProxyRequest({ ...request, status, startedAt, headers: responseHeaders, error });
            throw error;
        } finally {
            clearTimeout(timer);
            if (key) arkProxyRequests.delete(key);
            if (status && !failed) logProxyRequest({ ...request, status, startedAt, headers: responseHeaders });
        }
    });
    ipcMain.handle("lyspace:proxy-stream-request", async (event, payload) => {
        const request = proxyRequestOptions(payload);
        if (!request.ark) throw new Error("流式代理仅供方舟请求使用");
        const requestId = String(payload?.requestId || "");
        if (!requestId || requestId.length > 128) throw new Error("流式请求缺少有效请求 ID");
        const key = proxyRequestId(event.sender, requestId);
        if (arkProxyRequests.size >= ARK_PROXY_MAX_CONCURRENCY) throw new Error("方舟并发请求过多，请等待现有请求完成后再试");
        if (arkProxyRequests.has(key)) throw new Error("方舟流式请求 ID 重复");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ARK_PROXY_TIMEOUT_MS);
        const startedAt = Date.now();
        let status;
        let responseHeaders;
        let failed = false;
        arkProxyRequests.set(key, controller);
        try {
            const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: controller.signal });
            status = response.status;
            responseHeaders = proxyResponseHeaders(response);
            event.sender.send("lyspace:proxy-stream-event", { requestId, type: "headers", status, headers: responseHeaders });
            const declaredLength = Number(response.headers.get("content-length")) || 0;
            if (declaredLength > ARK_PROXY_MAX_RESPONSE_BYTES) throw new Error("响应内容超过 32 MiB 限制");
            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            const chunks = [];
            let length = 0;
            if (reader) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        length += value.byteLength;
                        if (length > ARK_PROXY_MAX_RESPONSE_BYTES) {
                            await reader.cancel();
                            throw new Error("响应内容超过 32 MiB 限制");
                        }
                        const chunk = decoder.decode(value, { stream: true });
                        if (chunk) event.sender.send("lyspace:proxy-stream-event", { requestId, type: "chunk", data: chunk });
                        chunks.push(Buffer.from(value));
                    }
                } finally {
                    reader.releaseLock();
                }
            } else {
                const bytes = Buffer.from(await response.arrayBuffer());
                length = bytes.byteLength;
                if (length > ARK_PROXY_MAX_RESPONSE_BYTES) throw new Error("响应内容超过 32 MiB 限制");
                const chunk = bytes.toString("utf8");
                if (chunk) event.sender.send("lyspace:proxy-stream-event", { requestId, type: "chunk", data: chunk });
                chunks.push(bytes);
            }
            const tail = decoder.decode();
            if (tail) event.sender.send("lyspace:proxy-stream-event", { requestId, type: "chunk", data: tail });
            const data = Buffer.concat(chunks, length).toString("utf8");
            event.sender.send("lyspace:proxy-stream-event", { requestId, type: "complete" });
            return { status, headers: responseHeaders, data };
        } catch (error) {
            failed = true;
            event.sender.send("lyspace:proxy-stream-event", { requestId, type: "error", error: error instanceof Error ? error.message : String(error) });
            logProxyRequest({ ...request, status, startedAt, headers: responseHeaders, error });
            throw error;
        } finally {
            clearTimeout(timer);
            arkProxyRequests.delete(key);
            if (status && !failed) logProxyRequest({ ...request, status, startedAt, headers: responseHeaders });
        }
    });
    ipcMain.handle("lyspace:proxy-stream-cancel", (event, requestId) => {
        const controller = arkProxyRequests.get(proxyRequestId(event.sender, requestId));
        if (controller) controller.abort();
        return { cancelled: Boolean(controller) };
    });
    ipcMain.handle("lyspace:proxy-request-cancel", (event, requestId) => {
        const controller = arkProxyRequests.get(proxyRequestId(event.sender, requestId));
        if (controller) controller.abort();
        return { cancelled: Boolean(controller) };
    });
    ipcMain.handle("lyspace:persistence-flushed", async (_event, requestId) => {
        const pending = persistenceFlushCoordinator.acknowledge(String(requestId || ""));
        if (!pending || !mainWindow || allowWindowClose) return { accepted: false };
        writeUpdateInstallLog("flush-acknowledged", { id: pending.id, action: pending.action });
        if (pending.action === "install") {
            try {
                await launchUpdateInstaller(pending.details.installerPath, pending.details.installDir);
                writeUpdateInstallLog("installer-spawned", { id: pending.id, version: pending.details.version });
                persistenceFlushCoordinator.succeed(pending);
                allowWindowClose = true;
                setImmediate(() => app.quit());
                return { accepted: true };
            } catch (error) {
                const message = `无法启动安装程序：${error instanceof Error ? error.message : error}`;
                writeUpdateInstallLog("installer-spawn-failed", { id: pending.id, error: message });
                updateSnapshot({ status: "downloaded", error: message });
                persistenceFlushCoordinator.fail(pending, new Error(message));
                return { accepted: false };
            }
        }
        persistenceFlushCoordinator.succeed(pending);
        allowWindowClose = true;
        if (pending.action === "relaunch") {
            app.relaunch();
            app.quit();
        } else {
            mainWindow.close();
        }
        return { accepted: true };
    });
    ipcMain.handle("lyspace:relaunch-after-flush", () => {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error("主窗口不可用");
        return requestPersistenceFlush("relaunch");
    });
    createWindow();
    createTray();
    if (app.isPackaged) void checkForUpdate("auto");
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => featurePluginManager.shutdown());
}
}
