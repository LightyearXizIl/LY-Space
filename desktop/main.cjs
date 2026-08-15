const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net: electronNet, protocol, shell, Tray } = require("electron");
const { autoUpdater } = require("electron-updater");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { restoreBridgeBackup } = require("./storage-migration.cjs");
const { assertWritableDirectory, ensureStorageDirectories: ensureConfiguredStorageDirectories, readStorageSettingsFile, writeStorageSettingsFile } = require("./storage-settings.cjs");
const { buildInstallerArgs, buildInstallerLaunchOptions, createPersistenceFlushCoordinator } = require("./update-install-coordinator.cjs");

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
    } catch {
        // 日志失败不能影响安装或退出。
    }
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
    } catch (error) {
        throw new Error(`无法访问用户配置的存储目录，程序未修改路径也不会使用空白数据启动。${error instanceof Error ? error.message : error}`);
    }
    writeStorageSettings();
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
    ipcMain.handle("lyspace:set-native-theme", (_event, source) => {
        // 窗口标题栏等原生 UI 明暗跟随应用主题
        nativeTheme.themeSource = source === "dark" ? "dark" : "light";
    });
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
        mainWindow.close();
        return { accepted: true };
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
}
}
