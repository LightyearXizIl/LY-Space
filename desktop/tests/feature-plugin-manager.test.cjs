const test = require("node:test");
const assert = require("node:assert/strict");

const { isVersionCompatible, isMinAppVersionCompatible, safeRelativePath, validateRemoteUrl } = require("../feature-plugin-manager.cjs");

test("功能插件版本范围使用显式比较，不接受未知语法", () => {
    assert.equal(isVersionCompatible("0.146.0", ">=0.146.0 <0.147.0"), true);
    assert.equal(isVersionCompatible("0.147.0", ">=0.146.0 <0.147.0"), false);
    assert.equal(isVersionCompatible("0.146.0", "^0.146.0"), false);
});

test("清单裸 minAppVersion 表示最低支持版本", () => {
    assert.equal(isMinAppVersionCompatible("0.5.7", "0.5.6"), true);
    assert.equal(isMinAppVersionCompatible("0.5.6", "0.5.6"), true);
    assert.equal(isMinAppVersionCompatible("0.5.5", "0.5.6"), false);
    assert.equal(isMinAppVersionCompatible("0.5.7", ">=0.5.6 <1.0.0"), true);
});

test("功能插件文件路径不能越界", () => {
    assert.equal(safeRelativePath("agent-core.mjs"), true);
    assert.equal(safeRelativePath("service/launcher.cjs"), true);
    assert.equal(safeRelativePath("../codex.exe"), false);
    assert.equal(safeRelativePath("C:\\codex.exe"), false);
});

test("远程 Agent 只允许 HTTPS，localhost 保留本地调试例外", () => {
    assert.equal(validateRemoteUrl("https://agent.example.com/").startsWith("https://"), true);
    assert.equal(validateRemoteUrl("http://127.0.0.1:17371"), "http://127.0.0.1:17371");
    assert.throws(() => validateRemoteUrl("http://agent.example.com"), /HTTPS/);
});
