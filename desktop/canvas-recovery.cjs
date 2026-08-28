const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SNAPSHOT_LIMIT = 20;

function isProject(value) {
    return value && typeof value === "object" && typeof value.id === "string" && Array.isArray(value.nodes) && Array.isArray(value.connections);
}

function normalizeProjects(value) {
    if (!Array.isArray(value) || !value.every(isProject)) throw new Error("画布数据格式无效");
    return value;
}

function mergeProjects(current, recovered) {
    const currentProjects = normalizeProjects(current);
    const recoveredProjects = normalizeProjects(recovered);
    const recoveredById = new Map(recoveredProjects.map((project) => [project.id, project]));
    const used = new Set();
    const merged = currentProjects.map((project) => {
        const backup = recoveredById.get(project.id);
        used.add(project.id);
        return backup && String(backup.updatedAt || "") > String(project.updatedAt || "") ? backup : project;
    });
    recoveredProjects.forEach((project) => { if (!used.has(project.id)) merged.push(project); });
    return merged;
}

function missingProjects(current, recovered) {
    const ids = new Set(normalizeProjects(current).map((project) => project.id));
    return normalizeProjects(recovered).filter((project) => !ids.has(project.id));
}

function writeJsonAtomic(file, value) {
    const data = Buffer.from(JSON.stringify(value, null, 2), "utf8");
    const temporary = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const handle = fs.openSync(temporary, "w");
    try { fs.writeFileSync(handle, data); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, file);
    return crypto.createHash("sha256").update(data).digest("hex");
}

function snapshotDirectory(appData) { return path.join(appData, "canvas-recovery"); }
function currentSnapshotFile(appData) { return path.join(snapshotDirectory(appData), "current.json"); }

function readCurrentSnapshot(appData) {
    try { return normalizeProjects(JSON.parse(fs.readFileSync(currentSnapshotFile(appData), "utf8")).projects); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function saveCurrentSnapshot(appData, projects) {
    const next = normalizeProjects(projects);
    const previous = readCurrentSnapshot(appData);
    const root = snapshotDirectory(appData);
    if (previous && JSON.stringify(previous.map((item) => item.id)) !== JSON.stringify(next.map((item) => item.id))) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeJsonAtomic(path.join(root, "history", `${stamp}.json`), { projects: previous });
        const history = fs.readdirSync(path.join(root, "history")).filter((name) => name.endsWith(".json")).sort();
        history.slice(0, Math.max(0, history.length - SNAPSHOT_LIMIT)).forEach((name) => fs.rmSync(path.join(root, "history", name), { force: true }));
    }
    return writeJsonAtomic(currentSnapshotFile(appData), { projects: next, savedAt: new Date().toISOString() });
}

function ensureCurrentSnapshot(appData, projects) {
    if (readCurrentSnapshot(appData)) return null;
    return saveCurrentSnapshot(appData, projects);
}

function saveRecoveryBundle(appData, current, recovered, merged) {
    const root = path.join(snapshotDirectory(appData), "recoveries", new Date().toISOString().replace(/[:.]/g, "-"));
    const files = ["current", "recovered", "merged"].map((name) => ({ name, hash: writeJsonAtomic(path.join(root, `${name}.json`), { projects: { current, recovered, merged }[name] }) }));
    writeJsonAtomic(path.join(root, "manifest.json"), { createdAt: new Date().toISOString(), files });
    return root;
}

function listUpgradeBackups(localAppData) {
    const base = path.join(localAppData, "LY Space", "Backups");
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
        const root = path.join(base, entry.name);
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
            const cache = path.join(root, "legacy-user-data", "Data cache");
            return manifest?.status === "ready" && fs.existsSync(cache) ? [{ id: entry.name, root, cache, createdAt: manifest.createdAt || fs.statSync(root).mtime.toISOString() }] : [];
        } catch { return []; }
    }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = { SNAPSHOT_LIMIT, ensureCurrentSnapshot, listUpgradeBackups, mergeProjects, missingProjects, normalizeProjects, readCurrentSnapshot, saveCurrentSnapshot, saveRecoveryBundle };
