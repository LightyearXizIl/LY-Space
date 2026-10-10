const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");

const { directoryManifest, loadBridgeBackup, restoreBridgeBackup, sameManifest } = require("../storage-migration.cjs");
const backupScript = path.resolve(__dirname, "../build/backup-user-data.ps1");

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lyspace-migration-"));
    const installDir = path.join(root, "安装 目录");
    const userData = path.join(root, "Roaming", "LY Space");
    const localAppData = path.join(root, "Local");
    const documents = path.join(root, "文档");
    write(path.join(installDir, "Data cache", "IndexedDB", "https_app_0.indexeddb.leveldb", "CURRENT"), "MANIFEST-000001\n");
    write(path.join(installDir, "Data cache", "IndexedDB", "https_app_0.indexeddb.leveldb", "MANIFEST-000001"), "画布数据");
    write(path.join(installDir, "Data cache", "Local Storage", "leveldb", "000003.log"), "设置与 API Key 哨兵");
    write(path.join(installDir, "Data cache", "IndexedDB", "重名", "sentinel.bin"), "IndexedDB 重名文件");
    write(path.join(installDir, "Data cache", "Local Storage", "重名", "sentinel.bin"), "Local Storage 重名文件");
    write(path.join(installDir, "Result", "Picture", "生成图片.png"), Buffer.from([0, 1, 2, 3, 4]));
    write(path.join(installDir, "Result", "Video", "生成视频.mp4"), Buffer.from([5, 6, 7]));
    write(path.join(installDir, "Result", "Audio", "嵌套目录", "音频.wav"), Buffer.from([8, 9, 10]));
    write(path.join(installDir, "Result", "text", "嵌套目录", "文本.txt"), "文本结果哨兵");
    write(path.join(userData, "IndexedDB", "legacy.indexeddb.leveldb", "CURRENT"), "旧快照");
    write(path.join(userData, "app-data", "last-save-directory.txt"), "D:\\素材");
    write(path.join(userData, "app-data", "nested", "sentinel.bin"), "应用数据嵌套哨兵");
    write(path.join(userData, "Data cache", "stale.txt"), "旧目标缓存");
    write(path.join(documents, "LY Space", "Result", "old.txt"), "旧目标结果");
    return { root, installDir, userData, localAppData, documents, storageConfigFile: path.join(userData, "app-data", "storage-settings.json") };
}

function runBackup(data) {
    const result = spawnSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", backupScript,
        "-InstallDir", data.installDir,
        "-AppDataDir", data.userData,
        "-LocalAppDataDir", data.localAppData,
        "-ProcessName", "LY Space Migration Test.exe",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return loadBridgeBackup(data.localAppData);
}

test("双快照完整复制并把当前安装数据恢复到稳定目录", () => {
    const data = fixture();
    try {
        const expectedCache = directoryManifest(path.join(data.installDir, "Data cache"));
        const expectedResult = directoryManifest(path.join(data.installDir, "Result"));
        const expectedLegacy = directoryManifest(data.userData);
        const bridge = runBackup(data);
        assert.ok(bridge);
        assert.ok(sameManifest(bridge.manifest.snapshots.currentInstall.dataCache.files, expectedCache));
        assert.ok(sameManifest(bridge.manifest.snapshots.currentInstall.result.files, expectedResult));
        assert.ok(sameManifest(bridge.manifest.snapshots.legacyUserData.files, expectedLegacy));
        fs.rmSync(path.join(data.userData, "Data cache"), { recursive: true, force: true });
        fs.rmSync(path.join(data.documents, "LY Space", "Result"), { recursive: true, force: true });

        const restored = restoreBridgeBackup(data);
        assert.equal(restored.migrated, true);
        assert.ok(sameManifest(directoryManifest(path.join(data.userData, "Data cache")), expectedCache));
        assert.ok(sameManifest(directoryManifest(path.join(data.documents, "LY Space", "Result")), expectedResult));
        assert.equal(fs.readFileSync(path.join(data.userData, "app-data", "nested", "sentinel.bin"), "utf8"), "应用数据嵌套哨兵");

        const second = restoreBridgeBackup(data);
        assert.equal(second.migrated, false);
        assert.ok(sameManifest(directoryManifest(path.join(data.userData, "Data cache")), expectedCache));
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("非空目标目录始终保留，不因缺失或失败状态再次覆盖", () => {
    const data = fixture();
    try {
        const bridge = runBackup(data);
        const currentConfig = path.join(data.userData, "Data cache", "Local Storage", "leveldb", "CURRENT-USER-DATA");
        write(data.storageConfigFile, JSON.stringify({
            cacheRoot: path.join(data.installDir, "Data cache"),
            resultRoot: path.join(data.installDir, "Result"),
        }));
        write(currentConfig, "用户后来添加的渠道 API");
        const stateFile = path.join(data.userData, "app-data", "migration-v0.4.7.json");
        const beforeCache = directoryManifest(path.join(data.userData, "Data cache"));
        const beforeResult = directoryManifest(path.join(data.documents, "LY Space", "Result"));

        const restored = restoreBridgeBackup(data);
        assert.equal(restored.migrated, false);
        assert.ok(sameManifest(directoryManifest(path.join(data.userData, "Data cache")), beforeCache));
        assert.ok(sameManifest(directoryManifest(path.join(data.documents, "LY Space", "Result")), beforeResult));
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        assert.equal(state.status, "completed");
        assert.deepEqual(state.preservedExisting, ["Data cache", "Result"]);
        assert.equal(fs.readFileSync(currentConfig, "utf8"), "用户后来添加的渠道 API");
        const saved = JSON.parse(fs.readFileSync(data.storageConfigFile, "utf8"));
        assert.equal(saved.cacheRoot, path.join(data.userData, "Data cache"));
        assert.equal(saved.resultRoot, path.join(data.documents, "LY Space", "Result"));

        write(currentConfig, "用户重新确认后的渠道 API");
        write(stateFile, JSON.stringify({ version: "v0.4.7", status: "failed" }));
        const second = restoreBridgeBackup(data);
        assert.equal(second.migrated, false);
        assert.equal(fs.readFileSync(currentConfig, "utf8"), "用户重新确认后的渠道 API");
        assert.ok(bridge);
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("用户自定义路径保持不变且不写入新默认目录", () => {
    const data = fixture();
    try {
        const customCache = path.join(data.root, "自定义缓存");
        const customResult = path.join(data.root, "自定义结果");
        write(path.join(customCache, "keep.txt"), "保留缓存");
        write(path.join(customResult, "keep.txt"), "保留结果");
        write(data.storageConfigFile, JSON.stringify({ cacheRoot: customCache, resultRoot: customResult }));
        fs.rmSync(path.join(data.userData, "Data cache"), { recursive: true, force: true });
        fs.rmSync(path.join(data.documents, "LY Space", "Result"), { recursive: true, force: true });
        runBackup(data);

        const restored = restoreBridgeBackup(data);
        assert.equal(restored.migrated, false);
        assert.equal(fs.readFileSync(path.join(customCache, "keep.txt"), "utf8"), "保留缓存");
        assert.equal(fs.readFileSync(path.join(customResult, "keep.txt"), "utf8"), "保留结果");
        assert.equal(fs.existsSync(path.join(data.userData, "Data cache")), false);
        assert.equal(fs.existsSync(path.join(data.documents, "LY Space", "Result")), false);
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("旧默认目录恢复完成后才原子写入新的稳定目录", () => {
    const data = fixture();
    try {
        write(data.storageConfigFile, JSON.stringify({
            cacheRoot: path.join(data.installDir, "Data cache"),
            resultRoot: path.join(data.installDir, "Result"),
            keep: "保留其他配置",
        }));
        runBackup(data);
        fs.rmSync(path.join(data.userData, "Data cache"), { recursive: true, force: true });
        fs.rmSync(path.join(data.documents, "LY Space", "Result"), { recursive: true, force: true });

        restoreBridgeBackup(data);
        const saved = JSON.parse(fs.readFileSync(data.storageConfigFile, "utf8"));
        assert.equal(saved.cacheRoot, path.join(data.userData, "Data cache"));
        assert.equal(saved.resultRoot, path.join(data.documents, "LY Space", "Result"));
        assert.equal(saved.keep, "保留其他配置");
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("损坏的存储配置阻止恢复且不会写入迁移状态", () => {
    const data = fixture();
    try {
        runBackup(data);
        write(data.storageConfigFile, "{broken");

        assert.throws(() => restoreBridgeBackup(data), SyntaxError);
        assert.equal(fs.readFileSync(data.storageConfigFile, "utf8"), "{broken");
        assert.equal(fs.existsSync(path.join(data.userData, "app-data", "migration-v0.4.7.json")), false);
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("安装目录内的自定义路径会备份并恢复到原位置", () => {
    const data = fixture();
    try {
        const customCache = path.join(data.installDir, "我的缓存");
        const customResult = path.join(data.installDir, "我的结果");
        write(path.join(customCache, "IndexedDB", "db", "CURRENT"), "自定义画布");
        write(path.join(customResult, "Picture", "custom.png"), "自定义结果");
        write(data.storageConfigFile, JSON.stringify({ cacheRoot: customCache, resultRoot: customResult }));
        const expectedCache = directoryManifest(customCache);
        const expectedResult = directoryManifest(customResult);
        const bridge = runBackup(data);
        assert.equal(bridge.manifest.snapshots.currentInstall.dataCache.restoreTarget, customCache);
        assert.equal(bridge.manifest.snapshots.currentInstall.result.restoreTarget, customResult);
        fs.rmSync(customCache, { recursive: true, force: true });
        fs.rmSync(customResult, { recursive: true, force: true });

        const restored = restoreBridgeBackup(data);
        assert.equal(restored.migrated, true);
        assert.ok(sameManifest(directoryManifest(customCache), expectedCache));
        assert.ok(sameManifest(directoryManifest(customResult), expectedResult));
        const saved = JSON.parse(fs.readFileSync(data.storageConfigFile, "utf8"));
        assert.equal(saved.cacheRoot, customCache);
        assert.equal(saved.resultRoot, customResult);
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("快照损坏时拒绝恢复并保留原目标", () => {
    const data = fixture();
    try {
        const bridge = runBackup(data);
        const snapshotFile = path.join(bridge.backupRoot, "current-install", "Data cache", "Local Storage", "leveldb", "000003.log");
        write(snapshotFile, "已损坏");
        fs.rmSync(path.join(data.userData, "Data cache"), { recursive: true, force: true });
        assert.throws(() => restoreBridgeBackup(data), /快照.*校验失败/);
        assert.equal(fs.readFileSync(path.join(data.documents, "LY Space", "Result", "old.txt"), "utf8"), "旧目标结果");
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("恢复复制中断时保留原目标并进入恢复状态", () => {
    const data = fixture();
    const originalCopyFileSync = fs.copyFileSync;
    try {
        runBackup(data);
        fs.rmSync(path.join(data.userData, "Data cache"), { recursive: true, force: true });
        fs.rmSync(path.join(data.documents, "LY Space", "Result"), { recursive: true, force: true });
        let injected = false;
        fs.copyFileSync = (...args) => {
            if (!injected) {
                injected = true;
                throw new Error("模拟复制失败");
            }
            return originalCopyFileSync(...args);
        };
        assert.throws(() => restoreBridgeBackup(data), /模拟复制失败/);
        assert.equal(fs.existsSync(path.join(data.userData, "Data cache")), false);

        fs.copyFileSync = originalCopyFileSync;
        const blocked = restoreBridgeBackup(data);
        assert.equal(blocked.migrated, false);
        assert.equal(blocked.storageStatus, "needs-recovery");
        assert.equal(fs.existsSync(path.join(data.userData, "Data cache")), false);
    } finally {
        fs.copyFileSync = originalCopyFileSync;
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("安装目录没有数据时退休旧 latest 指针并保留历史快照", () => {
    const data = fixture();
    try {
        const bridge = runBackup(data);
        assert.ok(bridge);
        const beforeCache = directoryManifest(path.join(data.userData, "Data cache"));
        fs.rmSync(path.join(data.installDir, "Data cache"), { recursive: true, force: true });
        fs.rmSync(path.join(data.installDir, "Result"), { recursive: true, force: true });
        const result = spawnSync("powershell.exe", [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", backupScript,
            "-InstallDir", data.installDir, "-AppDataDir", data.userData, "-LocalAppDataDir", data.localAppData,
            "-ProcessName", "LY Space Migration Test.exe",
        ], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const latest = JSON.parse(fs.readFileSync(path.join(data.localAppData, "LY Space", "Backups", "latest.json"), "utf8"));
        assert.equal(latest.status, "retired");
        assert.equal(latest.reason, "no-install-source");
        assert.equal(fs.existsSync(bridge.backupRoot), true);
        assert.equal(loadBridgeBackup(data.localAppData), null);
        const restored = restoreBridgeBackup(data);
        assert.equal(restored.migrated, false);
        assert.equal(restored.storageStatus, "ready");
        assert.ok(sameManifest(directoryManifest(path.join(data.userData, "Data cache")), beforeCache));
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("目标目录只有子目录或锁文件时也视为已有数据", () => {
    const data = fixture();
    try {
        runBackup(data);
        fs.rmSync(path.join(data.userData, "Data cache"), { recursive: true, force: true });
        fs.mkdirSync(path.join(data.userData, "Data cache", "IndexedDB"), { recursive: true });
        fs.writeFileSync(path.join(data.userData, "Data cache", "LOCK"), "占用");
        write(data.storageConfigFile, JSON.stringify({ cacheRoot: path.join(data.installDir, "Data cache"), resultRoot: path.join(data.installDir, "Result") }));
        const before = directoryManifest(path.join(data.userData, "Data cache"));
        const restored = restoreBridgeBackup(data);
        assert.equal(restored.migrated, false);
        assert.ok(sameManifest(directoryManifest(path.join(data.userData, "Data cache")), before));
        const state = JSON.parse(fs.readFileSync(path.join(data.userData, "app-data", "migration-v0.4.7.json"), "utf8"));
        assert.deepEqual(state.preservedExisting, ["Data cache", "Result"]);
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("迁移标记缺失且没有有效备份时进入恢复状态", () => {
    const data = fixture();
    try {
        fs.rmSync(path.join(data.installDir, "Data cache"), { recursive: true, force: true });
        fs.rmSync(path.join(data.installDir, "Result"), { recursive: true, force: true });
        fs.rmSync(path.join(data.userData, "Data cache"), { recursive: true, force: true });
        fs.rmSync(path.join(data.documents, "LY Space", "Result"), { recursive: true, force: true });
        write(data.storageConfigFile, JSON.stringify({ cacheRoot: path.join(data.installDir, "Data cache"), resultRoot: path.join(data.installDir, "Result") }));
        write(path.join(data.localAppData, "LY Space", "Backups", "latest.json"), JSON.stringify({ backupRoot: path.join(data.root, "outside") }));

        const restored = restoreBridgeBackup(data);
        assert.equal(restored.migrated, false);
        assert.equal(restored.storageStatus, "needs-recovery");
        assert.equal(fs.existsSync(path.join(data.userData, "Data cache")), false);
        assert.match(fs.readFileSync(path.join(data.userData, "app-data", "storage-migration.log"), "utf8"), /migration-skipped/);
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("目标目录已是完整快照但完成标记缺失时直接补记完成", () => {
    const data = fixture();
    try {
        const bridge = runBackup(data);
        const expectedCache = bridge.manifest.snapshots.currentInstall.dataCache.files;
        fs.rmSync(path.join(data.userData, "Data cache"), { recursive: true, force: true });
        fs.mkdirSync(path.join(data.userData, "Data cache"), { recursive: true });
        const source = path.join(bridge.backupRoot, bridge.manifest.snapshots.currentInstall.dataCache.directory);
        fs.cpSync(source, path.join(data.userData, "Data cache"), { recursive: true });

        const restored = restoreBridgeBackup(data);
        assert.ok(sameManifest(directoryManifest(path.join(data.userData, "Data cache")), expectedCache));
        const state = JSON.parse(fs.readFileSync(path.join(data.userData, "app-data", "migration-v0.4.7.json"), "utf8"));
        assert.equal(state.status, "completed");
        assert.equal(fs.existsSync(path.join(data.userData, "Data cache.migrating-v0.4.7")), false);
        assert.equal(typeof restored.migrated, "boolean");
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("原子切换前目标被并发创建为空目录时清理后重试", () => {
    const data = fixture();
    const originalRenameSync = fs.renameSync;
    try {
        runBackup(data);
        fs.rmSync(path.join(data.userData, "Data cache"), { recursive: true, force: true });
        let injected = false;
        fs.renameSync = (source, target) => {
            if (!injected && source.includes("Data cache.migrating-v0.4.7-") && target.endsWith("Data cache")) {
                injected = true;
                fs.mkdirSync(target, { recursive: true });
                const error = new Error("Directory not empty");
                error.code = "ENOTEMPTY";
                throw error;
            }
            return originalRenameSync(source, target);
        };

        const restored = restoreBridgeBackup(data);
        assert.equal(restored.migrated, true);
        assert.equal(injected, true);
        assert.ok(fs.existsSync(path.join(data.userData, "Data cache", "IndexedDB", "重名", "sentinel.bin")));
    } finally {
        fs.renameSync = originalRenameSync;
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("另一存活进程持有迁移锁时拒绝并发恢复", async () => {
    const data = fixture();
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
        runBackup(data);
        const lockFile = path.join(data.userData, "app-data", "migration-v0.4.7.lock");
        write(lockFile, JSON.stringify({ pid: holder.pid, createdAt: new Date().toISOString() }));
        assert.throws(() => restoreBridgeBackup(data), /另一 LY Space 进程正在恢复用户数据/);
        assert.equal(fs.existsSync(lockFile), true);
    } finally {
        holder.kill();
        await new Promise((resolve) => holder.once("exit", resolve));
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});
