const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyRecoverySelection, createRecoveryCatalog, listUpgradeRecoverySources, mergeProjects, missingProjects, projectDigest } = require("../canvas-recovery.cjs");

const project = (id, updatedAt, title = id) => ({ id, title, updatedAt, nodes: [], connections: [] });

test("画布恢复合并保留当前项目并补回缺失项目", () => {
    const current = [project("current", "2026-08-28"), project("same", "2026-08-27")];
    const backup = [project("same", "2026-08-28"), project("missing", "2026-08-20")];
    assert.deepEqual(missingProjects(current, backup).map((item) => item.id), ["missing"]);
    assert.deepEqual(mergeProjects(current, backup).map((item) => item.id), ["current", "same", "missing"]);
    assert.equal(mergeProjects(current, backup)[1].updatedAt, "2026-08-28");
});

test("配置存在但没有缺失项目的最新备份不会遮挡更早的完整画布", () => {
    const current = [project("before-august-15", "2026-08-15")];
    const catalog = createRecoveryCatalog(current, [
        { id: "newest", source: "升级前 AppData 备份", sourceType: "legacy", createdAt: "2026-08-28T02:00:00Z", projects: [project("before-august-15", "2026-08-15")], config: { config: { channels: [] } } },
        { id: "older", source: "安装前缓存备份", sourceType: "current-install", createdAt: "2026-08-28T01:20:00Z", projects: [project("after-august-15", "2026-08-27", "八月下旬项目")] },
    ]);
    assert.deepEqual(catalog.projects.map((item) => item.id), ["after-august-15"]);
    assert.equal(catalog.projects[0].sourceId, "older");
    assert.equal(catalog.configuration.sourceId, "newest");
});

test("恢复预览默认可补回缺失项目并替换真正较新的版本", () => {
    const current = [project("older", "2026-08-15"), project("keep", "2026-08-28")];
    const catalog = createRecoveryCatalog(current, [{
        id: "backup",
        source: "迁移前缓存副本",
        sourceType: "replaced",
        createdAt: "2026-08-28T01:20:00Z",
        projects: [project("older", "2026-08-27"), project("missing", "2026-08-26"), project("keep", "2026-08-20")],
    }]);
    assert.deepEqual(catalog.projects.map((item) => [item.id, item.status]), [["older", "newer"], ["missing", "missing"]]);
    const result = applyRecoverySelection(current, catalog, catalog.projects.map((item) => item.id));
    assert.deepEqual(result.merged.map((item) => item.id), ["older", "keep", "missing"]);
    assert.equal(result.merged[0].updatedAt, "2026-08-27");
    assert.equal(result.merged[1].updatedAt, "2026-08-28");
});

test("无效或相同更新时间不会覆盖当前项目，扫描摘要会随数据变化", () => {
    const current = [project("same", "2026-08-28")];
    const catalog = createRecoveryCatalog(current, [{ id: "backup", source: "备份", sourceType: "legacy", createdAt: "2026-08-29", projects: [project("same", "not-a-time")] }]);
    assert.equal(catalog.projects.length, 0);
    assert.notEqual(projectDigest(current), projectDigest([...current, project("new", "2026-08-28")]));
});

test("升级备份扫描覆盖 legacy、current-install 与迁移前缓存副本", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ly-space-recovery-"));
    try {
        const root = path.join(temp, "LY Space", "Backups", "v0.4.7-fixture");
        fs.mkdirSync(path.join(root, "legacy-user-data", "Data cache"), { recursive: true });
        fs.mkdirSync(path.join(root, "current-install", "Data cache"), { recursive: true });
        fs.mkdirSync(path.join(root, "replaced-destinations", "Data cache-2"), { recursive: true });
        fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
            status: "ready",
            createdAt: "2026-08-28T01:20:00Z",
            snapshots: {
                legacyUserData: { directory: "legacy-user-data", files: [] },
                currentInstall: { dataCache: { directory: "current-install/Data cache", files: [] } },
            },
        }));
        const sources = listUpgradeRecoverySources(temp);
        assert.deepEqual(sources.map((item) => item.sourceType).sort(), ["current-install", "legacy", "replaced"]);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test("损坏升级备份不会阻断其他有效恢复来源", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ly-space-recovery-"));
    try {
        const base = path.join(temp, "LY Space", "Backups");
        fs.mkdirSync(path.join(base, "broken"), { recursive: true });
        fs.writeFileSync(path.join(base, "broken", "manifest.json"), "{");
        const valid = path.join(base, "valid");
        fs.mkdirSync(path.join(valid, "current-install", "Data cache"), { recursive: true });
        fs.writeFileSync(path.join(valid, "manifest.json"), JSON.stringify({ status: "ready", snapshots: { currentInstall: { dataCache: { directory: "current-install/Data cache", files: [] } } } }));
        assert.deepEqual(listUpgradeRecoverySources(temp).map((item) => item.id), ["valid:install"]);
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
