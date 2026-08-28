const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_VERSION = "v0.4.7";

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, file);
}

function directoryManifest(directory) {
    if (!fs.existsSync(directory)) return [];
    const root = path.resolve(directory);
    const files = [];
    const visit = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const target = path.join(current, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`数据目录包含不支持的链接：${target}`);
            if (entry.isDirectory()) visit(target);
            else if (entry.isFile()) {
                const hash = crypto.createHash("sha256");
                const handle = fs.openSync(target, "r");
                const buffer = Buffer.allocUnsafe(1024 * 1024);
                let offset = 0;
                try {
                    for (;;) {
                        const read = fs.readSync(handle, buffer, 0, buffer.length, offset);
                        if (!read) break;
                        hash.update(buffer.subarray(0, read));
                        offset += read;
                    }
                } finally {
                    fs.closeSync(handle);
                }
                files.push({ path: path.relative(root, target).replace(/\\/g, "/"), length: offset, sha256: hash.digest("hex") });
            }
        }
    };
    visit(root);
    return files.sort((left, right) => left.path.localeCompare(right.path));
}

function sameManifest(left, right) {
    const normalize = (items) => (items || [])
        .map((item) => ({ path: String(item.path), length: Number(item.length), sha256: String(item.sha256).toLowerCase() }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function assertManifest(directory, expected, label) {
    const actual = directoryManifest(directory);
    if (!sameManifest(actual, expected || [])) throw new Error(`${label}文件校验失败`);
    return actual;
}

function assertChildPath(target, parent, label) {
    const resolvedTarget = path.resolve(target);
    const resolvedParent = path.resolve(parent);
    const relative = path.relative(resolvedParent, resolvedTarget);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label}路径越界`);
    return resolvedTarget;
}

function removeChildDirectory(target, parent) {
    const resolved = assertChildPath(target, parent, "清理临时目录");
    if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

function nextBackupDirectory(base, expected) {
    if (!fs.existsSync(base)) return base;
    if (sameManifest(directoryManifest(base), expected)) return base;
    for (let index = 2; index < 1000; index += 1) {
        const candidate = `${base}-${index}`;
        if (!fs.existsSync(candidate)) return candidate;
        if (sameManifest(directoryManifest(candidate), expected)) return candidate;
    }
    throw new Error(`无法为原目标目录分配安全备份位置：${base}`);
}

function acquireMigrationLock(userData) {
    const lockFile = path.join(userData, "app-data", `migration-${MIGRATION_VERSION}.lock`);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const handle = fs.openSync(lockFile, "wx");
            fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
            return () => {
                try { fs.closeSync(handle); } catch { /* 已关闭 */ }
                try { fs.rmSync(lockFile, { force: true }); } catch { /* 下次启动会清理陈旧锁 */ }
            };
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            let ownerPid = 0;
            try { ownerPid = Number(readJson(lockFile).pid) || 0; } catch { /* 损坏锁按陈旧锁处理 */ }
            let ownerRunning = false;
            if (ownerPid > 0 && ownerPid !== process.pid) {
                try { process.kill(ownerPid, 0); ownerRunning = true; } catch { /* 进程已退出 */ }
            }
            if (ownerRunning) throw new Error("另一 LY Space 进程正在恢复用户数据，请等待其完成后重试");
            fs.rmSync(lockFile, { force: true });
        }
    }
    throw new Error("无法取得用户数据恢复锁，请关闭全部 LY Space 进程后重试");
}

function copyDirectoryExact(source, target) {
    if (!fs.existsSync(source)) return;
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name);
        const targetPath = path.join(target, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`数据目录包含不支持的链接：${sourcePath}`);
        if (entry.isDirectory()) copyDirectoryExact(sourcePath, targetPath);
        else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath);
    }
}

function replaceDirectoryFromSnapshot({ source, target, expected, backupRoot, label }) {
    if (!expected?.length) return false;
    assertManifest(source, expected, `${label}快照`);
    if (fs.existsSync(target) && sameManifest(directoryManifest(target), expected)) return false;
    const parent = path.dirname(target);
    const stage = `${target}.migrating-${MIGRATION_VERSION}-${process.pid}`;
    fs.mkdirSync(parent, { recursive: true });
    removeChildDirectory(stage, parent);
    copyDirectoryExact(source, stage);
    assertManifest(stage, expected, `${label}迁移副本`);

    let replaced = "";
    try {
        if (fs.existsSync(target)) {
            const targetManifest = directoryManifest(target);
            replaced = nextBackupDirectory(path.join(backupRoot, "replaced-destinations", label), targetManifest);
            if (!fs.existsSync(replaced)) {
                copyDirectoryExact(target, replaced);
                assertManifest(replaced, targetManifest, `${label}原目标备份`);
            }
            removeChildDirectory(target, parent);
        }
        try {
            fs.renameSync(stage, target);
        } catch (error) {
            // 另一个进程若已完成同一份恢复，直接接受；仅自动清理竞态产生的空目录。
            if (!fs.existsSync(target) || !["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
            const racedManifest = directoryManifest(target);
            if (sameManifest(racedManifest, expected)) return true;
            if (racedManifest.length) throw error;
            removeChildDirectory(target, parent);
            fs.renameSync(stage, target);
        }
        assertManifest(target, expected, `${label}最终目录`);
        return true;
    } catch (error) {
        if (!fs.existsSync(target) && replaced && fs.existsSync(replaced)) copyDirectoryExact(replaced, target);
        throw error;
    } finally {
        removeChildDirectory(stage, parent);
    }
}

function loadBridgeBackup(localAppData) {
    const base = path.join(localAppData, "LY Space", "Backups");
    const latestFile = path.join(base, "latest.json");
    if (!fs.existsSync(latestFile)) return null;
    const latest = readJson(latestFile);
    const backupRoot = assertChildPath(String(latest.backupRoot || ""), base, "升级备份");
    const manifestFile = path.join(backupRoot, "manifest.json");
    const manifest = readJson(manifestFile);
    if (manifest.version !== MIGRATION_VERSION || manifest.status !== "ready") return null;
    return { backupRoot, manifestFile, manifest };
}

function isOldDefault(value, installDir, folder) {
    return Boolean(value && installDir && path.resolve(value) === path.resolve(installDir, folder));
}

function restoreBridgeBackup({ userData, localAppData, documents, storageConfigFile }) {
    const bridge = loadBridgeBackup(localAppData);
    if (!bridge) return { migrated: false, installDir: "", backupRoot: "" };
    const releaseLock = acquireMigrationLock(userData);
    try {
    const stateFile = path.join(userData, "app-data", "migration-v0.4.7.json");
    if (fs.existsSync(stateFile)) {
        const state = readJson(stateFile);
        // v0.4.7 的目录迁移只应执行一次。每次覆盖安装都会产生新的升级备份，不能因为 latest.json 改变再次用旧安装目录替换已分离的用户缓存。
        if (state.status === "completed") {
            return { migrated: false, installDir: bridge.manifest.installDir, backupRoot: bridge.backupRoot };
        }
    }

    let saved = {};
    if (fs.existsSync(storageConfigFile)) {
        saved = readJson(storageConfigFile);
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error(`存储配置格式无效，未修改任何用户路径：${storageConfigFile}`);
    }
    const defaultCacheRoot = path.join(userData, "Data cache");
    const defaultResultRoot = path.join(documents, "LY Space", "Result");
    const useDefaultCache = !saved.cacheRoot || isOldDefault(saved.cacheRoot, bridge.manifest.installDir, "Data cache");
    const useDefaultResult = !saved.resultRoot || isOldDefault(saved.resultRoot, bridge.manifest.installDir, "Result");
    const current = bridge.manifest.snapshots?.currentInstall || {};

    try {
        const cacheTarget = current.dataCache?.restoreTarget || defaultCacheRoot;
        const resultTarget = current.result?.restoreTarget || defaultResultRoot;
        const cacheMigrated = (useDefaultCache || current.dataCache?.restoreTarget) && current.dataCache
            ? replaceDirectoryFromSnapshot({ source: path.join(bridge.backupRoot, current.dataCache.directory), target: cacheTarget, expected: current.dataCache.files, backupRoot: bridge.backupRoot, label: "Data cache" })
            : false;
        const resultMigrated = (useDefaultResult || current.result?.restoreTarget) && current.result
            ? replaceDirectoryFromSnapshot({ source: path.join(bridge.backupRoot, current.result.directory), target: resultTarget, expected: current.result.files, backupRoot: bridge.backupRoot, label: "Result" })
            : false;
        let settingsChanged = false;
        if (cacheMigrated && isOldDefault(saved.cacheRoot, bridge.manifest.installDir, "Data cache")) {
            saved.cacheRoot = cacheTarget;
            settingsChanged = true;
        }
        if (resultMigrated && isOldDefault(saved.resultRoot, bridge.manifest.installDir, "Result")) {
            saved.resultRoot = resultTarget;
            settingsChanged = true;
        }
        if (settingsChanged) writeJsonAtomic(storageConfigFile, saved);
        writeJsonAtomic(stateFile, { version: MIGRATION_VERSION, status: "completed", backupRoot: bridge.backupRoot, cacheMigrated, resultMigrated, completedAt: new Date().toISOString() });
        return { migrated: cacheMigrated || resultMigrated, installDir: bridge.manifest.installDir, backupRoot: bridge.backupRoot };
    } catch (error) {
        writeJsonAtomic(stateFile, { version: MIGRATION_VERSION, status: "failed", backupRoot: bridge.backupRoot, error: error instanceof Error ? error.message : String(error), failedAt: new Date().toISOString() });
        throw new Error(`用户数据恢复失败，程序未使用空白数据启动。备份位置：${bridge.backupRoot}。${error instanceof Error ? error.message : error}`);
    }
    } finally {
        releaseLock();
    }
}

module.exports = { MIGRATION_VERSION, assertManifest, copyDirectoryExact, directoryManifest, loadBridgeBackup, restoreBridgeBackup, sameManifest };
