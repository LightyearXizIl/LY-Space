import type { CanvasExportAsset, CanvasExportFile, CanvasProjectExportItem } from "@/types/canvas-export";

export class CanvasImportError extends Error {}

export type CanvasImportAsset = CanvasExportAsset & { blob: Blob };

export type CanvasImportPackage = Omit<CanvasExportFile, "projects"> & {
    projects: CanvasProjectExportItem[];
    assets: CanvasImportAsset[];
};

export async function readCanvasImportPackage(zip: Map<string, Blob>): Promise<CanvasImportPackage> {
    const projectFile = zip.get("projects.json");
    if (!projectFile) throw new CanvasImportError("压缩包中缺少 projects.json");

    let data: CanvasExportFile;
    try {
        data = JSON.parse(await projectFile.text()) as CanvasExportFile;
    } catch {
        throw new CanvasImportError("画布项目清单无法读取");
    }
    if (data.app !== "infinite-canvas" || data.version !== 3 || !Array.isArray(data.projects)) throw new CanvasImportError("不是有效的 LY Space 画布包");

    const assets: CanvasImportAsset[] = [];
    for (const item of data.projects) {
        if (!item || typeof item !== "object" || !item.project || typeof item.project !== "object" || !Array.isArray(item.files)) throw new CanvasImportError("画布项目清单格式不正确");
        for (const file of item.files) {
            if (!isValidAsset(file)) throw new CanvasImportError("画布素材清单格式不正确");
            const blob = zip.get(file.path);
            if (!blob) throw new CanvasImportError("画布包缺少素材文件");
            if (blob.size !== file.bytes) throw new CanvasImportError("画布素材文件尺寸不一致");
            assets.push({ ...file, blob: blob.type ? blob : blob.slice(0, blob.size, file.mimeType) });
        }
    }
    return { ...data, assets };
}

export async function areCanvasImportBlobsEqual(left: Blob, right: Blob) {
    if (left.size !== right.size) return false;
    const [leftBytes, rightBytes] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
    const a = new Uint8Array(leftBytes);
    const b = new Uint8Array(rightBytes);
    return a.every((value, index) => value === b[index]);
}

export async function uniqueCanvasImportAssets(assets: CanvasImportAsset[]) {
    const unique = new Map<string, CanvasImportAsset>();
    for (const asset of assets) {
        const previous = unique.get(asset.storageKey);
        if (previous && !(await areCanvasImportBlobsEqual(previous.blob, asset.blob))) throw new CanvasImportError("画布包中存在内容不同的同键素材");
        unique.set(asset.storageKey, asset);
    }
    return [...unique.values()];
}

function isValidAsset(value: unknown): value is CanvasExportAsset {
    if (!value || typeof value !== "object") return false;
    const asset = value as CanvasExportAsset;
    return (
        typeof asset.storageKey === "string" && Boolean(asset.storageKey) && typeof asset.path === "string" && Boolean(asset.path) && typeof asset.mimeType === "string" && Boolean(asset.mimeType) && Number.isSafeInteger(asset.bytes) && asset.bytes >= 0
    );
}
