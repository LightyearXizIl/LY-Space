const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..", "..");
const version = fs.readFileSync(path.join(rootDir, "VERSION"), "utf8").trim();
const normalizedVersion = version.replace(/^v/i, "");
const packageFiles = ["desktop/package.json", "desktop/renderer/package.json"];

if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION must be a v-prefixed semantic version, received ${version}`);
for (const file of packageFiles) {
    const value = JSON.parse(fs.readFileSync(path.join(rootDir, file), "utf8")).version;
    if (value !== normalizedVersion) throw new Error(`${file} version ${value} does not match ${normalizedVersion}`);
}
const changelog = fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## ${version} - `)) throw new Error(`CHANGELOG.md is missing ${version}`);
const tag = process.env.GITHUB_REF_NAME || process.argv[2] || "";
if (tag && tag !== version) throw new Error(`Release tag ${tag} does not match ${version}`);
console.log(`Verified release version ${version}`);
