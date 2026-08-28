const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeRetentionDays, pruneLogContent } = require("../app-logs.cjs");

test("日志保留周期仅接受 7、14、30 天，默认 7 天", () => {
    assert.equal(normalizeRetentionDays(14), 14);
    assert.equal(normalizeRetentionDays(8), 7);
});

test("清理只移除超过保留期且时间有效的日志", () => {
    const now = Date.parse("2026-08-28T00:00:00.000Z");
    const old = JSON.stringify({ time: "2026-08-20T00:00:00.000Z", message: "old" });
    const recent = JSON.stringify({ time: "2026-08-22T00:00:00.000Z", message: "recent" });
    const broken = "not-json";
    const result = pruneLogContent(`${old}\n${recent}\n${broken}\n`, 7, now);
    assert.equal(result.includes("old"), false);
    assert.equal(result.includes("recent"), true);
    assert.equal(result.includes(broken), true);
});
