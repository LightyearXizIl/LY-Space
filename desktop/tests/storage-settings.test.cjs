const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ensureStorageDirectories, readStorageSettingsFile, writeStorageSettingsFile } = require("../storage-settings.cjs");

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lyspace-storage-settings-"));
    return {
        root,
        file: path.join(root, "app-data", "storage-settings.json"),
        defaults: { resultRoot: path.join(root, "默认结果"), cacheRoot: path.join(root, "默认缓存"), defaultResultRoot: path.join(root, "默认结果"), defaultCacheRoot: path.join(root, "默认缓存") },
    };
}

test("有效配置的自定义和历史样式路径均原样保留", () => {
    const data = fixture();
    try {
        fs.mkdirSync(path.dirname(data.file), { recursive: true });
        fs.writeFileSync(data.file, JSON.stringify({ resultRoot: "E:\\Software\\LY Space\\Result", cacheRoot: "D:\\用户数据\\LY Space\\Data cache", pendingCacheRoot: "F:\\待迁移缓存" }));

        const settings = readStorageSettingsFile(data.file, data.defaults);
        assert.equal(settings.resultRoot, "E:\\Software\\LY Space\\Result");
        assert.equal(settings.cacheRoot, "D:\\用户数据\\LY Space\\Data cache");
        assert.equal(settings.pendingCacheRoot, "F:\\待迁移缓存");
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("缺失配置才使用默认路径，损坏配置不会被覆盖", () => {
    const data = fixture();
    try {
        const missing = readStorageSettingsFile(data.file, data.defaults);
        assert.equal(missing.resultRoot, data.defaults.resultRoot);
        assert.equal(missing.cacheRoot, data.defaults.cacheRoot);

        fs.mkdirSync(path.dirname(data.file), { recursive: true });
        fs.writeFileSync(data.file, "{broken");
        assert.throws(() => readStorageSettingsFile(data.file, data.defaults), /存储配置损坏/);
        assert.equal(fs.readFileSync(data.file, "utf8"), "{broken");
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("保存路径时保留配置中的未知字段", () => {
    const data = fixture();
    try {
        fs.mkdirSync(path.dirname(data.file), { recursive: true });
        fs.writeFileSync(data.file, JSON.stringify({ resultRoot: "D:\\原结果", cacheRoot: "D:\\原缓存", futureSetting: { enabled: true } }));

        writeStorageSettingsFile(data.file, { ...data.defaults, resultRoot: "E:\\新结果", cacheRoot: "F:\\新缓存" });
        const saved = JSON.parse(fs.readFileSync(data.file, "utf8"));
        assert.equal(saved.resultRoot, "E:\\新结果");
        assert.equal(saved.cacheRoot, "F:\\新缓存");
        assert.deepEqual(saved.futureSetting, { enabled: true });
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});

test("不可作为目录使用的配置会阻止启动准备且不改写配置", () => {
    const data = fixture();
    try {
        const cacheFile = path.join(data.root, "不是目录");
        fs.writeFileSync(cacheFile, "sentinel");
        fs.mkdirSync(path.dirname(data.file), { recursive: true });
        fs.writeFileSync(data.file, JSON.stringify({ resultRoot: data.defaults.resultRoot, cacheRoot: cacheFile }));
        const original = fs.readFileSync(data.file, "utf8");
        const settings = readStorageSettingsFile(data.file, data.defaults);

        assert.throws(() => ensureStorageDirectories(settings, { image: "Picture", video: "Video", audio: "Audio", text: "text" }));
        assert.equal(fs.readFileSync(data.file, "utf8"), original);
        assert.equal(fs.readFileSync(cacheFile, "utf8"), "sentinel");
    } finally {
        fs.rmSync(data.root, { recursive: true, force: true });
    }
});
