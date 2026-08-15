const fs = require("node:fs");
const path = require("node:path");

function configuredPath(value, fallback) {
    return typeof value === "string" && value.trim() ? value : fallback;
}

function readStorageSettingsFile(file, defaults) {
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        if (error?.code === "ENOENT") return { ...defaults, pendingCacheRoot: "", lastError: "" };
        if (error instanceof SyntaxError) throw new Error(`存储配置损坏，未修改任何用户路径：${file}`);
        throw new Error(`无法读取存储配置，未修改任何用户路径：${file}。${error?.message || error}`);
    }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error(`存储配置格式无效，未修改任何用户路径：${file}`);
    return {
        ...defaults,
        resultRoot: configuredPath(saved.resultRoot, defaults.resultRoot),
        cacheRoot: configuredPath(saved.cacheRoot, defaults.cacheRoot),
        pendingCacheRoot: typeof saved.pendingCacheRoot === "string" ? saved.pendingCacheRoot : "",
        lastError: typeof saved.lastError === "string" ? saved.lastError : "",
    };
}

function writeStorageSettingsFile(file, settings) {
    let existing = {};
    if (fs.existsSync(file)) {
        try {
            existing = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (error) {
            if (error instanceof SyntaxError) throw new Error(`存储配置损坏，未修改任何用户路径：${file}`);
            throw new Error(`无法读取存储配置，未修改任何用户路径：${file}。${error?.message || error}`);
        }
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error(`存储配置格式无效，未修改任何用户路径：${file}`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
        ...existing,
        resultRoot: settings.resultRoot,
        cacheRoot: settings.cacheRoot,
        pendingCacheRoot: settings.pendingCacheRoot || "",
        lastError: settings.lastError || "",
    }, null, 2), "utf8");
}

function assertWritableDirectory(value, label) {
    if (!value || !path.isAbsolute(value)) throw new Error(`${label}必须是绝对路径`);
    const resolved = path.resolve(value);
    fs.mkdirSync(resolved, { recursive: true });
    fs.accessSync(resolved, fs.constants.W_OK);
    return resolved;
}

function ensureStorageDirectories(settings, resultFolders) {
    const resultRoot = assertWritableDirectory(settings.resultRoot, "结果保存目录");
    const cacheRoot = assertWritableDirectory(settings.cacheRoot, "缓存目录");
    for (const folder of Object.values(resultFolders)) fs.mkdirSync(path.join(resultRoot, folder), { recursive: true });
    fs.mkdirSync(path.join(cacheRoot, "Cache"), { recursive: true });
}

module.exports = { assertWritableDirectory, ensureStorageDirectories, readStorageSettingsFile, writeStorageSettingsFile };
