const assert = require("node:assert/strict");
const test = require("node:test");
const { mergeProjects, missingProjects } = require("../canvas-recovery.cjs");

const project = (id, updatedAt) => ({ id, updatedAt, nodes: [], connections: [] });

test("画布恢复合并保留当前项目并补回缺失项目", () => {
    const current = [project("current", "2026-08-28"), project("same", "2026-08-27")];
    const backup = [project("same", "2026-08-28"), project("missing", "2026-08-20")];
    assert.deepEqual(missingProjects(current, backup).map((item) => item.id), ["missing"]);
    assert.deepEqual(mergeProjects(current, backup).map((item) => item.id), ["current", "same", "missing"]);
    assert.equal(mergeProjects(current, backup)[1].updatedAt, "2026-08-28");
});
