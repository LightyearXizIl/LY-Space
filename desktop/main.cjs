const { app, BrowserWindow, dialog, ipcMain, Menu, net: electronNet, protocol, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

protocol.registerSchemesAsPrivileged([
    { scheme: "lyspace", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let mainWindow = null;
let storageSettings = null;
let allowWindowClose = false;
let closingTimer = null;
let installDownloadedUpdate = false;
let downloadRequested = false;
let updateState = { status: "idle", version: "", releaseDate: "", releaseNotes: "", progress: null, error: "", supported: false };

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
    downloadRequested = false;
    updateSnapshot({ status: "error", progress: null, error: error instanceof Error ? error.message : String(error || "更新失败") });
}

function configureAutoUpdater() {
    updateState = { status: "idle", version: displayVersion(app.getVersion()), releaseDate: "", releaseNotes: "", progress: null, error: "", supported: app.isPackaged };
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on("checking-for-update", () => updateSnapshot({ status: "checking", progress: null, error: "" }));
    autoUpdater.on("update-available", (info) => {
        updateSnapshot({ status: "available", version: displayVersion(info.version), releaseDate: info.releaseDate || "", releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : "", progress: null, error: "" });
        if (downloadRequested) void downloadUpdate();
    });
    autoUpdater.on("update-not-available", (info) => {
        downloadRequested = false;
        updateSnapshot({ status: "upToDate", version: displayVersion(info.version || app.getVersion()), releaseDate: info.releaseDate || "", progress: null, error: "" });
    });
    autoUpdater.on("download-progress", (progress) => updateSnapshot({ status: "downloading", progress: { percent: progress.percent, bytesPerSecond: progress.bytesPerSecond, transferred: progress.transferred, total: progress.total }, error: "" }));
    autoUpdater.on("update-downloaded", (info) => updateSnapshot({ status: "downloaded", version: displayVersion(info.version), releaseDate: info.releaseDate || "", releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : "", progress: { percent: 100, bytesPerSecond: 0, transferred: 0, total: 0 }, error: "" }));
    autoUpdater.on("error", updateError);
}

async function downloadUpdate() {
    if (!app.isPackaged || updateState.status === "downloading" || updateState.status === "downloaded") return updateState;
    downloadRequested = false;
    updateSnapshot({ status: "downloading", progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 }, error: "" });
    try {
        await autoUpdater.downloadUpdate();
    } catch (error) {
        updateError(error);
    }
    return updateState;
}

async function checkAndDownloadUpdate() {
    if (!app.isPackaged) return updateSnapshot({ status: "idle", error: "", supported: false });
    if (updateState.status === "downloaded" || updateState.status === "downloading") return updateState;
    if (updateState.status === "available") return downloadUpdate();
    downloadRequested = true;
    try {
        await autoUpdater.checkForUpdates();
    } catch (error) {
        downloadRequested = false;
        updateError(error);
    }
    return updateState;
}

function requestUpdateInstall() {
    if (!app.isPackaged || updateState.status !== "downloaded") throw new Error("更新尚未下载完成");
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("主窗口不可用");
    installDownloadedUpdate = true;
    mainWindow.webContents.send("lyspace:flush-persistence");
}

function storageConfigFile() {
    return path.join(app.getPath("userData"), "app-data", "storage-settings.json");
}

function storageBaseDirectory() {
    return app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
}

function defaultStorageSettings() {
    const base = storageBaseDirectory();
    return { resultRoot: path.join(base, "Result"), cacheRoot: path.join(base, "Data cache"), defaultResultRoot: path.join(base, "Result"), defaultCacheRoot: path.join(base, "Data cache") };
}

function readStorageSettings() {
    const defaults = defaultStorageSettings();
    try {
        const saved = JSON.parse(fs.readFileSync(storageConfigFile(), "utf8"));
        return { ...defaults, resultRoot: saved.resultRoot || defaults.resultRoot, cacheRoot: saved.cacheRoot || defaults.cacheRoot, pendingCacheRoot: saved.pendingCacheRoot || "", lastError: saved.lastError || "" };
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
    storageSettings = readStorageSettings();
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
        const fallbackBase = path.join(app.getPath("documents"), "LY Space");
        storageSettings.resultRoot = path.join(fallbackBase, "Result");
        storageSettings.cacheRoot = path.join(app.getPath("userData"), "app-data", "Data cache");
        storageSettings.pendingCacheRoot = "";
        ensureStorageDirectories();
        writeStorageSettings();
    }
    // sessionData 保持 userData 默认（跨安装/更新目录稳定）；旧版本（≤0.0.8）曾把 IndexedDB/localStorage 放在
    // cacheRoot（默认 exe 目录/Data cache），换目录安装会导致记录"消失"，启动时一次性迁移回 userData。
    migrateLegacySessionData(storageSettings.cacheRoot, app.getPath("sessionData"));
    app.setPath("cache", path.join(storageSettings.cacheRoot, "Cache"));
}

/** 把旧 cacheRoot（exe 目录/Data cache）里的 Chromium profile 数据一次性复制到 userData（sessionData 目标位置）。 */
function migrateLegacySessionData(legacyCacheRoot, targetSessionData) {
    if (!legacyCacheRoot || path.resolve(legacyCacheRoot) === path.resolve(targetSessionData)) return;
    const marker = path.join(targetSessionData, ".ly-space-session-migrated");
    if (fs.existsSync(marker)) return;
    const webDataNames = ["IndexedDB", "Local Storage", "Session Storage", "Cookies", "Preferences"];
    const anySource = webDataNames.some((name) => fs.existsSync(path.join(legacyCacheRoot, name)));
    if (!anySource) {
        try {
            fs.writeFileSync(marker, "1", "utf8");
        } catch {
            // 忽略标记写入失败
        }
        return;
    }
    try {
        fs.mkdirSync(targetSessionData, { recursive: true });
        for (const name of webDataNames) {
            const source = path.join(legacyCacheRoot, name);
            const target = path.join(targetSessionData, name);
            if (!fs.existsSync(source) || fs.existsSync(target)) continue;
            if (fs.statSync(source).isDirectory()) copyDirectory(source, target);
            else fs.copyFileSync(source, target);
        }
        fs.writeFileSync(marker, "1", "utf8");
    } catch {
        // 迁移失败不阻塞启动，旧数据仍留在原目录
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
        event.preventDefault();
        mainWindow.webContents.send("lyspace:flush-persistence");
        if (closingTimer) clearTimeout(closingTimer);
        closingTimer = setTimeout(() => {
            closingTimer = null;
            void dialog.showMessageBox(mainWindow, { type: "warning", buttons: ["继续等待"], title: "数据仍在保存", message: "本次关闭已取消，请等待数据保存完成后再退出。" });
        }, 10000);
    });
    void mainWindow.loadURL("lyspace://app/");
}

app.setName("LY Space");
app.setAppUserModelId("com.lyspace.desktop");
if (!app.requestSingleInstanceLock()) app.quit();
configureStorageBeforeReady();
app.on("second-instance", () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});
app.whenReady().then(async () => {
    registerAppProtocol();
    installApplicationMenu();
    configureAutoUpdater();
    ipcMain.handle("lyspace:update-state", () => updateState);
    ipcMain.handle("lyspace:check-and-download-update", () => checkAndDownloadUpdate());
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
    ipcMain.handle("lyspace:write-generated-output", (_event, payload) => writeGeneratedOutput(payload));
    ipcMain.handle("lyspace:persistence-flushed", () => {
        if (!mainWindow || allowWindowClose) return;
        if (closingTimer) clearTimeout(closingTimer);
        closingTimer = null;
        if (installDownloadedUpdate) {
            installDownloadedUpdate = false;
            allowWindowClose = true;
            autoUpdater.quitAndInstall(false, true);
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
    if (app.isPackaged) void autoUpdater.checkForUpdates().catch(updateError);
});
app.on("window-all-closed", () => app.quit());
