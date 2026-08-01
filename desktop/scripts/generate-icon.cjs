const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const buildDir = path.resolve(__dirname, "..", "build");
const source = path.join(buildDir, "icon.svg");
const sizes = [16, 24, 32, 48, 64, 128, 256];

async function main() {
    fs.mkdirSync(buildDir, { recursive: true });
    const logo = fs.readFileSync(source, "utf8");
    const pngs = await Promise.all(sizes.map((size) => renderIcon(logo, size)));
    fs.writeFileSync(path.join(buildDir, "icon.png"), pngs[pngs.length - 1]);
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let offset = header.length + sizes.length * 16;
    const entries = sizes.map((size, index) => {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(size === 256 ? 0 : size, 0);
        entry.writeUInt8(size === 256 ? 0 : size, 1);
        entry.writeUInt8(0, 2);
        entry.writeUInt8(0, 3);
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(pngs[index].length, 8);
        entry.writeUInt32LE(offset, 12);
        offset += pngs[index].length;
        return entry;
    });
    fs.writeFileSync(path.join(buildDir, "icon.ico"), Buffer.concat([header, ...entries, ...pngs]));
}

async function renderIcon(logo, size) {
    return sharp(Buffer.from(logo)).resize(size, size).png().toBuffer();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
