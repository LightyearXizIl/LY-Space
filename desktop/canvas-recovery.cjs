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

function isValidTime(value) {
    return typeof value === "string" && Boolean(value.trim()) && Number.isFinite(Date.parse(value));
}

function compareProjectVersions(left, right) {
    const leftTime = isValidTime(left?.updatedAt) ? Date.parse(left.updatedAt) : Number.NaN;
    const rightTime = isValidTime(right?.updatedAt) ? Date.parse(right.updatedAt) : Number.NaN;
    if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? -1 : 0;
    if (!Number.isFinite(rightTime)) return 1;
    return leftTime === rightTime ? 0 : leftTime > rightTime ? 1 : -1;
}

function compareSourceTimes(left, right) {
    const leftTime = isValidTime(left?.createdAt) ? Date.parse(left.createdAt) : Number.NaN;
    const rightTime = isValidTime(right?.createdAt) ? Date.parse(right.createdAt) : Number.NaN;
    if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? -1 : 0;
    if (!Number.isFinite(rightTime)) return 1;
    return leftTime === rightTime ? 0 : leftTime > rightTime ? 1 : -1;
}

function isNewerProject(candidate, current) {
    return compareProjectVersions(candidate, current) > 0;
}

function projectDigest(projects) {
    return crypto.createHash("sha256").update(JSON.stringify(normalizeProjects(projects))).digest("hex");
}

function createRecoveryCatalog(current, sources) {
    const currentProjects = normalizeProjects(current);
    const currentById = new Map(currentProjects.map((project) => [project.id, project]));
    const selected = new Map();
    const validSources = sources.map((source) => ({ ...source, projects: normalizeProjects(source.projects || []) }));
    for (const source of validSources) {
        for (let order = 0; order < source.projects.length; order += 1) {
            const project = source.projects[order];
            const present = currentById.get(project.id);
            const status = !present ? "missing" : isNewerProject(project, present) ? "newer" : "current";
            if (status === "current") continue;
            const candidate = { id: project.id, title: String(project.title || "未命名画布"), updatedAt: String(project.updatedAt || ""), status, sourceId: source.id, source: source.source, sourceType: source.sourceType, createdAt: source.createdAt, project, order };
            const existing = selected.get(project.id);
            if (!existing || compareProjectVersions(candidate.project, existing.project) > 0 || (compareProjectVersions(candidate.project, existing.project) === 0 && compareSourceTimes(candidate, existing) > 0)) selected.set(project.id, candidate);
        }
    }
    const configuration = validSources.filter((source) => source.config && typeof source.config === "object" && (source.config.config || source.config.webdav)).sort((left, right) => compareSourceTimes(right, left))[0] || null;
    const projects = [...selected.values()].sort((left, right) => {
        const sourceTime = compareSourceTimes(right, left);
        return sourceTime || left.order - right.order || left.id.localeCompare(right.id);
    });
    return {
        currentDigest: projectDigest(currentProjects),
        sources: validSources.map(({ id, source, sourceType, createdAt, projects: items }) => ({ id, source, sourceType, createdAt, projects: items.length })),
        projects,
        configuration: configuration ? { sourceId: configuration.id, source: configuration.source, createdAt: configuration.createdAt, config: configuration.config } : null,
    };
}

function applyRecoverySelection(current, catalog, selectedIds) {
    const currentProjects = normalizeProjects(current);
    const selected = new Set(Array.isArray(selectedIds) ? selectedIds.map(String) : []);
    const candidates = catalog.projects.filter((item) => selected.has(item.id));
    const replacements = new Map(candidates.map((item) => [item.id, item.project]));
    const used = new Set();
    const merged = currentProjects.map((project) => {
        const replacement = replacements.get(project.id);
        if (replacement && isNewerProject(replacement, project)) {
            used.add(project.id);
            return replacement;
        }
        return project;
    });
    candidates.forEach((item) => {
        if (!used.has(item.id) && !currentProjects.some((project) => project.id === item.id)) merged.push(item.project);
    });
    return { merged, selected: candidates.map((item) => item.project) };
}

function mergeProjects(current, recovered) {
    const catalog = createRecoveryCatalog(current, [{ id: "recovered", source: "恢复来源", sourceType: "manual", createdAt: "", projects: recovered }]);
    return applyRecoverySelection(current, catalog, catalog.projects.map((item) => item.id)).merged;
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

function readProjectSnapshot(file) {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return { projects: normalizeProjects(value.projects), createdAt: String(value.savedAt || value.createdAt || fs.statSync(file).mtime.toISOString()) };
}

// 扫描用异步版本：I/O 不阻塞主进程事件循环（JSON.parse 仍在主线程，量级可接受）。
async function readProjectSnapshotAsync(file) {
    const value = JSON.parse(await fs.promises.readFile(file, "utf8"));
    const createdAt = String(value.savedAt || value.createdAt || (await fs.promises.stat(file)).mtime.toISOString());
    return { projects: normalizeProjects(value.projects), createdAt };
}

function readCurrentSnapshot(appData) {
    try { return readProjectSnapshot(currentSnapshotFile(appData)).projects; } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function saveCurrentSnapshot(appData, projects) {
    const next = normalizeProjects(projects);
    const previous = readCurrentSnapshot(appData);
    const root = snapshotDirectory(appData);
    if (previous && JSON.stringify(previous.map((item) => item.id)) !== JSON.stringify(next.map((item) => item.id))) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeJsonAtomic(path.join(root, "history", `${stamp}.json`), { projects: previous, savedAt: new Date().toISOString() });
        const historyDirectory = path.join(root, "history");
        const history = fs.readdirSync(historyDirectory).filter((name) => name.endsWith(".json")).sort();
        history.slice(0, Math.max(0, history.length - SNAPSHOT_LIMIT)).forEach((name) => fs.rmSync(path.join(historyDirectory, name), { force: true }));
    }
    return writeJsonAtomic(currentSnapshotFile(appData), { projects: next, savedAt: new Date().toISOString() });
}

function ensureCurrentSnapshot(appData, projects) {
    if (readCurrentSnapshot(appData)) return null;
    return saveCurrentSnapshot(appData, projects);
}

function saveRecoveryBundle(appData, current, recovered, merged) {
    const root = path.join(snapshotDirectory(appData), "recoveries", new Date().toISOString().replace(/[:.]/g, "-"));
    const files = ["current", "recovered", "merged"].map((name) => ({ name, hash: writeJsonAtomic(path.join(root, `${name}.json`), { projects: { current, recovered, merged }[name], savedAt: new Date().toISOString() }) }));
    writeJsonAtomic(path.join(root, "manifest.json"), { createdAt: new Date().toISOString(), files });
    return root;
}

function childPath(root, relative) {
    const target = path.resolve(root, relative);
    const between = path.relative(path.resolve(root), target);
    if (!between || between.startsWith("..") || path.isAbsolute(between)) throw new Error("恢复来源路径无效");
    return target;
}

// 扫描阶段只做只读预览，用「大小 + 修改时间」轻量清单检测来源是否在复制期间变化，
// 避免对整个备份目录（可能数百 MB）做同步 SHA-256 全量哈希冻结主进程。
async function directoryLightManifest(directory) {
    if (!fs.existsSync(directory)) return [];
    const root = path.resolve(directory);
    const files = [];
    const visit = async (current) => {
        for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
            const target = path.join(current, entry.name);
            if (entry.isSymbolicLink()) throw new Error(`数据目录包含不支持的链接：${target}`);
            if (entry.isDirectory()) await visit(target);
            else if (entry.isFile()) {
                const stat = await fs.promises.stat(target);
                files.push({ path: path.relative(root, target).replace(/\\/g, "/"), length: stat.size, mtimeMs: stat.mtimeMs });
            }
        }
    };
    await visit(root);
    return files.sort((left, right) => left.path.localeCompare(right.path));
}

function sameLightManifest(left, right) {
    const normalize = (items) => (items || [])
        .map((item) => ({ path: String(item.path), length: Number(item.length), mtimeMs: Number(item.mtimeMs) }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

// 诊断导出不得包含本机路径：把错误文本中的盘符路径与 UNC 路径替换为占位符。
// 路径内的空格（如 "LY Space"）仅在其后紧跟分隔符时视为路径延续，避免吞掉错误正文。
function redactPathText(text) {
    return String(text)
        .replace(/[A-Za-z]:[\\/](?:[^\s\\/]+(?: [^\s\\/]+)*[\\/])*[^\s\\/]+/g, "<路径>")
        .replace(/\\\\(?:[^\s\\/]+(?: [^\s\\/]+)*[\\/])*[^\s\\/]+/g, "<路径>");
}

function readManifest(root) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    if (!manifest || manifest.status !== "ready") throw new Error("升级备份未完成");
    return manifest;
}

function listUpgradeRecoverySources(localAppData) {
    const base = path.join(localAppData, "LY Space", "Backups");
    if (!fs.existsSync(base)) return [];
    const sources = [];
    for (const entry of fs.readdirSync(base, { withFileTypes: true }).filter((item) => item.isDirectory())) {
        const root = childPath(base, entry.name);
        try {
            const manifest = readManifest(root);
            const createdAt = String(manifest.createdAt || fs.statSync(root).mtime.toISOString());
            const legacy = manifest.snapshots?.legacyUserData;
            if (legacy?.directory && Array.isArray(legacy.files)) {
                const legacyRoot = childPath(root, legacy.directory);
                const cache = childPath(legacyRoot, "Data cache");
                if (fs.existsSync(cache)) sources.push({ id: `${entry.name}:legacy`, root, cache, source: "升级前 AppData 备份", sourceType: "legacy", createdAt });
            }
            const current = manifest.snapshots?.currentInstall?.dataCache;
            if (current?.directory && Array.isArray(current.files)) {
                const cache = childPath(root, current.directory);
                if (fs.existsSync(cache)) sources.push({ id: `${entry.name}:install`, root, cache, source: "安装前缓存备份", sourceType: "current-install", createdAt });
            }
            const replacedRoot = childPath(root, "replaced-destinations");
            if (fs.existsSync(replacedRoot)) {
                for (const replacement of fs.readdirSync(replacedRoot, { withFileTypes: true }).filter((item) => item.isDirectory() && /^Data cache(?:-\d+)?$/i.test(item.name))) {
                    const cache = childPath(replacedRoot, replacement.name);
                    sources.push({ id: `${entry.name}:replaced:${replacement.name}`, root, cache, source: "迁移前缓存副本", sourceType: "replaced", createdAt: fs.statSync(cache).mtime.toISOString() || createdAt });
                }
            }
        } catch {
            // 单个备份损坏不阻断其他来源的恢复扫描。
        }
    }
    return sources.sort((left, right) => compareSourceTimes(right, left));
}

async function listSafetyRecoverySources(appData) {
    const root = snapshotDirectory(appData);
    if (!fs.existsSync(root)) return [];
    const sources = [];
    const add = async (id, source, sourceType, file) => {
        try {
            const snapshot = await readProjectSnapshotAsync(file);
            sources.push({ id, source, sourceType, createdAt: snapshot.createdAt, projects: snapshot.projects });
        } catch {
            // 安全快照本身损坏时继续查找其他历史副本。
        }
    };
    const current = currentSnapshotFile(appData);
    if (fs.existsSync(current)) await add("safety:current", "当前安全快照", "safety", current);
    const history = path.join(root, "history");
    if (fs.existsSync(history)) {
        for (const entry of await fs.promises.readdir(history, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith(".json")) await add(`safety:history:${entry.name}`, "历史安全快照", "history", childPath(history, entry.name));
        }
    }
    const recoveries = path.join(root, "recoveries");
    if (fs.existsSync(recoveries)) {
        for (const entry of await fs.promises.readdir(recoveries, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const recoveryRoot = childPath(recoveries, entry.name);
            for (const name of ["recovered.json", "merged.json"]) {
                const file = childPath(recoveryRoot, name);
                if (fs.existsSync(file)) await add(`safety:recovery:${entry.name}:${name}`, "过往恢复副本", "recovery", file);
            }
        }
    }
    return sources.sort((left, right) => compareSourceTimes(right, left));
}

function listUpgradeBackups(localAppData) {
    const byRoot = new Map();
    for (const source of listUpgradeRecoverySources(localAppData)) byRoot.set(source.root, { id: path.basename(source.root), root: source.root, cache: source.cache, createdAt: source.createdAt });
    return [...byRoot.values()].sort((left, right) => compareSourceTimes(right, left));
}

module.exports = { SNAPSHOT_LIMIT, applyRecoverySelection, compareProjectVersions, createRecoveryCatalog, directoryLightManifest, ensureCurrentSnapshot, isNewerProject, listSafetyRecoverySources, listUpgradeBackups, listUpgradeRecoverySources, mergeProjects, missingProjects, normalizeProjects, projectDigest, readCurrentSnapshot, redactPathText, sameLightManifest, saveCurrentSnapshot, saveRecoveryBundle, writeJsonAtomic };
