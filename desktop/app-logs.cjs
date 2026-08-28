const fs = require("node:fs");
const path = require("node:path");

const RETENTION_DAYS = [7, 14, 30];

function normalizeRetentionDays(value) {
    const days = Number(value);
    return RETENTION_DAYS.includes(days) ? days : 7;
}

function readLogSettings(file) {
    try {
        return { retentionDays: normalizeRetentionDays(JSON.parse(fs.readFileSync(file, "utf8")).retentionDays) };
    } catch (error) {
        if (error?.code === "ENOENT") return { retentionDays: 7 };
        throw new Error(`运行日志设置无法读取：${error.message || error}`);
    }
}

function writeLogSettings(file, settings) {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ retentionDays: normalizeRetentionDays(settings.retentionDays) }, null, 2), "utf8");
    fs.renameSync(temporary, file);
    return readLogSettings(file);
}

function pruneLogContent(content, retentionDays, now = Date.now()) {
    const cutoff = now - normalizeRetentionDays(retentionDays) * 24 * 60 * 60 * 1000;
    const lines = String(content || "").split("\n").filter(Boolean);
    const kept = lines.filter((line) => {
        try {
            const time = Date.parse(JSON.parse(line).time);
            return Number.isNaN(time) || time >= cutoff;
        } catch {
            return true;
        }
    });
    return kept.length ? `${kept.join("\n")}\n` : "";
}

function pruneLogFile(file, retentionDays, now = Date.now()) {
    let content = "";
    try { content = fs.readFileSync(file, "utf8"); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    const next = pruneLogContent(content, retentionDays, now);
    if (next === content) return false;
    fs.writeFileSync(file, next, "utf8");
    return true;
}

module.exports = { RETENTION_DAYS, normalizeRetentionDays, pruneLogContent, pruneLogFile, readLogSettings, writeLogSettings };
