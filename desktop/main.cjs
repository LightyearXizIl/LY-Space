const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net: electronNet, protocol, shell, Tray } = require("electron");
const { autoUpdater } = require("electron-updater");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

protocol.registerSchemesAsPrivileged([
    { scheme: "lyspace", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow = null;
let tray = null; // 系统托盘（模块级引用防 GC）
let storageSettings = null;
let allowWindowClose = false;
let installDownloadedUpdate = false;
let updateFileInfo = null; // update-available 携带的安装包信息（files[0]: url/sha512/size）
let updateDownloadRequest = null; // 自研断点续传下载的进行中请求
let updateDownloadWriteStream = null;
let updateDownloadAborted = false; // 用户暂停/中止下载标记
let lastCheckSource = "manual";
let updateState = { status: "idle", version: "", releaseDate: "", releaseNotes: "", progress: null, error: "", supported: false, triggeredBy: "" };

const RESULT_FOLDERS = { image: "Picture", video: "Video", audio: "Audio", text: "text" };

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
    if (updateState.status === "downloading" || updateState.status === "downloaded") return updateState;
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
        // 已下载完整安装包：直接进入 downloaded
        updateSnapshot({ status: "downloaded", progress: { percent: 100, bytesPerSecond: 0, transferred: total, total }, error: "" });
        return updateState;
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
    if (updateState.status === "downloaded" || updateState.status === "downloading") return updateState;
    lastCheckSource = source;
    try {
        await autoUpdater.checkForUpdates();
    } catch (error) {
        updateError(error);
    }
    return updateState;
}

function requestUpdateInstall() {
    if (!app.isPackaged || updateState.status !== "downloaded") throw new Error("更新尚未下载完成");
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("主窗口不可用");
    if (!fs.existsSync(updateExePath())) throw new Error("安装包不存在，请重新下载");
    installDownloadedUpdate = true;
    mainWindow.webContents.send("lyspace:flush-persistence");
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

function storageBaseDirectory() {
    return app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
}

function defaultStorageSettings() {
    // 数据默认跟随安装目录：Result 与 Data cache 位于安装目录下，换目录安装自动迁移
    const base = storageBaseDirectory();
    return { resultRoot: path.join(base, "Result"), cacheRoot: path.join(base, "Data cache"), defaultResultRoot: path.join(base, "Result"), defaultCacheRoot: path.join(base, "Data cache") };
}

/** 是否为历史默认结果目录（E 盘固定目录、documents/LY Space/Result），命中则切换为新默认（安装目录/Result）。 */
function isLegacyDefaultResultRoot(value) {
    if (!value) return false;
    const resolved = path.resolve(value);
    const candidates = ["E:/Software/LY Space/Result", path.join(app.getPath("documents"), "LY Space", "Result")];
    return candidates.some((candidate) => path.resolve(candidate) === resolved);
}

/** 是否为历史默认缓存目录（E 盘固定目录、userData/app-data/Data cache、documents/LY Space/Data cache），命中则切换为新默认（安装目录/Data cache）。 */
function isLegacyDefaultCacheRoot(value) {
    if (!value) return false;
    const resolved = path.resolve(value);
    const candidates = ["E:/Software/LY Space/Data cache", path.join(app.getPath("userData"), "app-data", "Data cache"), path.join(app.getPath("documents"), "LY Space", "Data cache")];
    return candidates.some((candidate) => path.resolve(candidate) === resolved);
}

function readStorageSettings() {
    const defaults = defaultStorageSettings();
    try {
        const saved = JSON.parse(fs.readFileSync(storageConfigFile(), "utf8"));
        // 以用户设置地址为准：仅首次安装（无配置）才默认跟随安装目录；用户设置过的路径（含历史 E 盘目录）一律保留
        const resultRoot = saved.resultRoot || defaults.resultRoot;
        const cacheRoot = saved.cacheRoot || defaults.cacheRoot;
        return { ...defaults, resultRoot, cacheRoot, pendingCacheRoot: saved.pendingCacheRoot || "", lastError: saved.lastError || "" };
    } catch {
        return { ...defaults, pendingCacheRoot: "", lastError: "" };
    }
}

function writeStorageSettings() {
    fs.mkdirSync(path.dirname(storageConfigFile()), { recursive: true });
    fs.writeFileSync(storageConfigFile(), JSON.stringify({ resultRoot: storageSettings.resultRoot, cacheRoot: storageSettings.cacheRoot, pendingCacheRoot: storageSettings.pendingCacheRoot || "", lastError: storageSettings.lastError || "" }, null, 2), "utf8");
}

function ensureStorageDirectories(settings = storageSettings) {
    fs.mkdirSync(settings.resultRoot, { recursive: true });
    Object.values(RESULT_FOLDERS).forEach((folder) => fs.mkdirSync(path.join(settings.resultRoot, folder), { recursive: true }));
    fs.mkdirSync(settings.cacheRoot, { recursive: true });
    fs.mkdirSync(path.join(settings.cacheRoot, "Cache"), { recursive: true });
}

function isNestedPath(left, right) {
    const relative = path.relative(left, right);
    return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertStoragePath(value, label) {
    if (!value || !path.isAbsolute(value)) throw new Error(`${label}必须是绝对路径`);
    const resolved = path.resolve(value);
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
    return resolved;
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

/** 历史默认结果目录（安装目录/Result 等）已有文件自动迁移到新默认目录：合并复制、重名不覆盖，成功后持久化新路径。 */
function migrateLegacyResultIfNeeded() {
    let savedRoot = "";
    try {
        savedRoot = String((JSON.parse(fs.readFileSync(storageConfigFile(), "utf8")).resultRoot || "")).trim();
    } catch {
        return;
    }
    if (!isLegacyDefaultResultRoot(savedRoot)) return;
    if (path.resolve(savedRoot) === path.resolve(storageSettings.resultRoot)) return;
    if (!fs.existsSync(savedRoot)) return;
    try {
        copyDirectory(savedRoot, storageSettings.resultRoot);
        storageSettings.lastError = "";
        // 迁移成功才持久化新路径，失败时配置保持旧值以便下次启动重试
        writeStorageSettings();
    } catch (error) {
        storageSettings.lastError = `旧结果目录迁移失败：${error.message || error}`;
        // 不写盘：配置仍为旧默认路径，下次启动自动重试迁移
    }
}

/** 历史默认缓存目录（安装目录/Data cache 等）已有数据自动迁移到新默认目录：合并复制、重名不覆盖，成功后持久化新路径。 */
function migrateLegacyCacheIfNeeded() {
    let savedRoot = "";
    try {
        savedRoot = String((JSON.parse(fs.readFileSync(storageConfigFile(), "utf8")).cacheRoot || "")).trim();
    } catch {
        return;
    }
    if (!isLegacyDefaultCacheRoot(savedRoot)) return;
    if (path.resolve(savedRoot) === path.resolve(storageSettings.cacheRoot)) return;
    if (!fs.existsSync(savedRoot)) return;
    if (!isIndexedDbIntact(savedRoot)) {
        // 旧库损坏（如升级清空安装目录导致 leveldb 不完整）时跳过迁移，避免把坏数据带到新目录
        storageSettings.lastError = "旧缓存目录中的 IndexedDB 数据不完整，已跳过迁移（可重新生成）";
        return;
    }
    try {
        copyDirectory(savedRoot, storageSettings.cacheRoot);
        storageSettings.lastError = "";
        // 迁移成功才持久化新路径，失败时配置保持旧值以便下次启动重试
        writeStorageSettings();
    } catch (error) {
        storageSettings.lastError = `旧缓存目录迁移失败：${error.message || error}`;
        // 不写盘：配置仍为旧默认路径，下次启动自动重试迁移
    }
}

/** 检查缓存目录中的 IndexedDB 库文件是否完整（存在 .indexeddb.leveldb 目录时必须含 CURRENT 文件）。 */
function isIndexedDbIntact(directory) {
    const indexDbDir = path.join(directory, "IndexedDB");
    if (!fs.existsSync(indexDbDir)) return true;
    try {
        for (const entry of fs.readdirSync(indexDbDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.includes(".indexeddb.leveldb")) continue;
            if (!fs.existsSync(path.join(indexDbDir, entry.name, "CURRENT"))) return false;
        }
    } catch {
        return false;
    }
    return true;
}

function configureStorageBeforeReady() {
    storageSettings = readStorageSettings();
    loadLastSaveDirectory();
    if (storageSettings.pendingCacheRoot) {
        try {
            const nextCacheRoot = assertStoragePath(storageSettings.pendingCacheRoot, "缓存目录");
            copyDirectory(storageSettings.cacheRoot, nextCacheRoot);
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
    } catch {
        storageSettings.resultRoot = path.join(app.getPath("documents"), "LY Space", "Result");
        storageSettings.cacheRoot = path.join(app.getPath("userData"), "app-data", "Data cache");
        storageSettings.pendingCacheRoot = "";
        ensureStorageDirectories();
        writeStorageSettings();
    }
    // 数据跟随安装目录：换目录安装/更新后自动把旧安装目录的数据迁移到当前安装目录。
    migrateDataToCurrentInstall();
    // 旧默认结果目录（安装目录/Result 等）存在历史文件时自动迁移到新默认目录（放最后，失败提示不被后续逻辑覆盖）
    migrateLegacyResultIfNeeded();
    // 旧默认缓存目录（IndexedDB/localStorage）迁移到新默认目录，必须在 sessionData 指向新目录之前完成
    migrateLegacyCacheIfNeeded();
    // sessionData（IndexedDB/localStorage）指向缓存目录（默认跟随安装目录：安装目录/Data cache）
    app.setPath("sessionData", storageSettings.cacheRoot);
    app.setPath("cache", path.join(storageSettings.cacheRoot, "Cache"));
}

const DATA_LOCATION_MARKER_FILE = () => path.join(app.getPath("userData"), "app-data", "data-location.json");

/** 数据跟随安装目录：把旧安装目录（marker 记录）与 v0.0.9 userData 中的历史数据迁移到当前安装目录。 */
function migrateDataToCurrentInstall() {
    const currentInstallDir = path.dirname(process.execPath);
    const sources = [];
    try {
        const marker = JSON.parse(fs.readFileSync(DATA_LOCATION_MARKER_FILE(), "utf8"));
        if (marker && typeof marker.dataDirectory === "string" && path.resolve(marker.dataDirectory) !== path.resolve(currentInstallDir) && fs.existsSync(marker.dataDirectory)) {
            sources.push(marker.dataDirectory);
        }
    } catch {
        // 首次运行无 marker
    }
    if (path.resolve(app.getPath("userData")) !== path.resolve(currentInstallDir)) sources.push(app.getPath("userData"));
    for (const source of sources) migrateFromSource(source, currentInstallDir);
    try {
        fs.mkdirSync(path.dirname(DATA_LOCATION_MARKER_FILE()), { recursive: true });
        fs.writeFileSync(DATA_LOCATION_MARKER_FILE(), JSON.stringify({ dataDirectory: currentInstallDir }), "utf8");
    } catch {
        // 忽略 marker 写入失败
    }
    updateStoragePathsAfterMigration(sources, currentInstallDir);
}

function migrateFromSource(source, currentInstallDir) {
    // 数据默认跟随安装目录；仅当结果/缓存目录位于安装目录体系内（当前或旧安装目录）时才迁移，
    // 避免默认安装目录配置外（如用户自定义路径）时把旧目录数据复制到安装目录
    const currentResult = path.join(currentInstallDir, "Result");
    const legacyResult = path.join(source, "Result");
    const resultIsInstallDir = path.resolve(storageSettings.resultRoot) === path.resolve(currentResult) || path.resolve(storageSettings.resultRoot) === path.resolve(legacyResult);
    if (resultIsInstallDir && fs.existsSync(legacyResult) && !fs.existsSync(currentResult)) {
        try {
            copyDirectory(legacyResult, currentResult);
        } catch {
            // 单项失败不阻塞
        }
    }
    const currentCache = path.join(currentInstallDir, "Data cache");
    const legacyCacheDir = path.join(source, "Data cache");
    const cacheIsInstallDir = path.resolve(storageSettings.cacheRoot) === path.resolve(currentCache) || path.resolve(storageSettings.cacheRoot) === path.resolve(legacyCacheDir);
    // 旧安装目录的 Data cache（IndexedDB/localStorage/sessionData/Cache）
    if (cacheIsInstallDir && fs.existsSync(legacyCacheDir) && !fs.existsSync(currentCache)) {
        try {
            copyDirectory(legacyCacheDir, currentCache);
        } catch {
            // 单项失败不阻塞
        }
    }
    // userData 根目录的 Chromium web 数据（v0.0.9 的 sessionData 曾在 userData 根）→ 合并到当前生效的缓存目录
    const targetCache = storageSettings.cacheRoot;
    for (const name of ["IndexedDB", "Local Storage", "Session Storage", "Cookies", "Preferences"]) {
        const legacyWeb = path.join(source, name);
        const targetWeb = path.join(targetCache, name);
        if (!fs.existsSync(legacyWeb) || fs.existsSync(targetWeb)) continue;
        try {
            fs.mkdirSync(targetCache, { recursive: true });
            if (fs.statSync(legacyWeb).isDirectory()) copyDirectory(legacyWeb, targetWeb);
            else fs.copyFileSync(legacyWeb, targetWeb);
        } catch {
            // 单项失败不阻塞
        }
    }
}

function updateStoragePathsAfterMigration(sources, currentInstallDir) {
    let changed = false;
    for (const source of sources) {
        const legacyResult = path.join(source, "Result");
        const legacyCache = path.join(source, "Data cache");
        if (storageSettings.resultRoot && path.resolve(storageSettings.resultRoot) === path.resolve(legacyResult)) {
            storageSettings.resultRoot = path.join(currentInstallDir, "Result");
            changed = true;
        }
        if (storageSettings.cacheRoot && path.resolve(storageSettings.cacheRoot) === path.resolve(legacyCache)) {
            storageSettings.cacheRoot = path.join(currentInstallDir, "Data cache");
            changed = true;
        }
    }
    if (changed) {
        storageSettings.lastError = "";
        writeStorageSettings();
    }
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
        { label: "文件", submenu: [{ label: "退出", role: "quit" }] },
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
            { label: "关闭", click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("lyspace:flush-persistence"); } },
        ]),
    );
}

app.setName("LY Space");
app.setAppUserModelId("com.lyspace.desktop");
if (!app.requestSingleInstanceLock()) app.quit();
configureStorageBeforeReady();
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
    ipcMain.handle("lyspace:update-state", () => updateState);
    ipcMain.handle("lyspace:check-update", () => checkForUpdate());
    ipcMain.handle("lyspace:download-update", () => downloadUpdate());
    ipcMain.handle("lyspace:pause-update-download", () => pauseUpdateDownload());
    ipcMain.handle("lyspace:install-downloaded-update", () => requestUpdateInstall());
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
    ipcMain.handle("lyspace:fetch-url", async (_event, url) => {
        if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("仅支持 http/https 地址");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
            const response = await electronNet.fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
            const contentType = response.headers.get("content-type") || "";
            if (!contentType.toLowerCase().startsWith("image/")) throw new Error("下载内容不是图片");
            const buffer = Buffer.from(await response.arrayBuffer());
            return { bytes: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), mimeType: contentType };
        } finally {
            clearTimeout(timer);
        }
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
    // 免费图床（uguu.se 优先，tmpfiles.org、catbox.moe 兜底）上传：主进程代理，无浏览器 CORS 限制
    ipcMain.handle("lyspace:upload-free-host", async (_event, payload) => {
        const name = String(payload?.name || "reference.png");
        const mimeType = String(payload?.mimeType || "application/octet-stream");
        const bytes = payload?.bytes ? Buffer.from(payload.bytes) : null;
        if (!bytes) throw new Error("没有可上传的图片内容");
        const uploadUguu = async () => {
            const form = new FormData();
            form.append("files[]", new Blob([bytes], { type: mimeType }), name);
            const response = await fetch("https://uguu.se/upload.php", { method: "POST", body: form });
            const payloadJson = await response.json().catch(() => null);
            const url = typeof payloadJson?.files?.[0]?.url === "string" ? payloadJson.files[0].url : "";
            if (!response.ok || !/^https:\/\//i.test(url)) throw new Error(`免费图床上传失败（HTTP ${response.status}）`);
            return url;
        };
        const uploadTmpfiles = async () => {
            const form = new FormData();
            form.append("file", new Blob([bytes], { type: mimeType }), name);
            const response = await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: form });
            const payloadJson = await response.json().catch(() => null);
            const url = typeof payloadJson?.data?.url === "string" ? payloadJson.data.url : "";
            if (!response.ok || !/^https:\/\//i.test(url)) throw new Error(`免费图床上传失败（HTTP ${response.status}）`);
            return url.replace("/tmpfiles.org/", "/tmpfiles.org/dl/");
        };
        const uploadCatbox = async () => {
            const form = new FormData();
            form.append("reqtype", "fileupload");
            form.append("fileToUpload", new Blob([bytes], { type: mimeType }), name);
            const response = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form });
            const text = (await response.text()).trim();
            if (!response.ok || !/^https:\/\//i.test(text)) throw new Error(`免费图床上传失败（HTTP ${response.status}）`);
            return text;
        };
        try {
            return { url: await uploadUguu() };
        } catch {
            try {
                return { url: await uploadTmpfiles() };
            } catch {
                return { url: await uploadCatbox() };
            }
        }
    });
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
            if (!path.isAbsolute(target)) {
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
    // 通用请求代理：主进程 fetch 无浏览器网络限制（CORS 等），供渲染层网络层失败时回退
    ipcMain.handle("lyspace:proxy-request", async (_event, payload) => {
        const url = String(payload?.url || "");
        if (!/^https:\/\//i.test(url)) throw new Error("仅支持 HTTPS 请求");
        const method = String(payload?.method || "GET").toUpperCase();
        const headers = payload?.headers && typeof payload.headers === "object" ? payload.headers : {};
        const body = typeof payload?.body === "string" ? payload.body : undefined;
        const response = await fetch(url, { method, headers, body });
        const text = await response.text();
        return { status: response.status, data: text };
    });
    ipcMain.handle("lyspace:persistence-flushed", () => {
        if (!mainWindow || allowWindowClose) return;
        if (installDownloadedUpdate) {
            installDownloadedUpdate = false;
            allowWindowClose = true;
            // 自研安装：NSIS 静默安装到当前安装目录，runAfterFinish 自动重启应用（替代 autoUpdater.quitAndInstall）
            const exePath = updateExePath();
            const installDir = path.dirname(app.getPath("exe"));
            const child = spawn(exePath, ["/S", `/D=${installDir}`], { detached: true, stdio: "ignore" });
            child.unref();
            app.quit();
            return;
        }
        allowWindowClose = true;
        mainWindow.close();
    });
    ipcMain.handle("lyspace:relaunch-after-flush", () => {
        app.relaunch();
        app.quit();
    });
    createWindow();
    createTray();
    if (app.isPackaged) void checkForUpdate("auto");
});
app.on("window-all-closed", () => app.quit());
