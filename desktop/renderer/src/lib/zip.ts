import { unzipSync, zipSync } from "fflate";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 5000;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

type ZipFile = {
    name: string;
    data: BlobPart;
};

export async function createZip(files: ZipFile[]) {
    const entries = await Promise.all(
        files.map(async (file) => {
            const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            return [file.name, data] as const;
        }),
    );
    return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: "application/zip" });
}

export async function readZip(file: Blob) {
    if (file.size > MAX_ARCHIVE_BYTES) throw new Error("压缩包过大");
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const names = Object.keys(entries);
    if (names.length > MAX_ARCHIVE_FILES) throw new Error("压缩包文件数量过多");
    let totalBytes = 0;
    for (const name of names) {
        if (!name || name.startsWith("/") || name.split("/").some((part) => part === "..")) throw new Error("压缩包包含非法路径");
        totalBytes += entries[name].byteLength;
        if (totalBytes > MAX_UNPACKED_BYTES) throw new Error("压缩包解压后过大");
    }
    return new Map(Object.entries(entries).map(([name, data]) => [name, new Blob([data])]));
}
