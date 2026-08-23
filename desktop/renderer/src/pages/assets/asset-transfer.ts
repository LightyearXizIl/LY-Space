import { saveAs } from "file-saver";
import { nanoid } from "nanoid";

import { createZip, readZip } from "@/lib/zip";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import type { Asset } from "@/stores/use-asset-store";

type AssetExportFile = { app: "infinite-canvas"; version: 1; exportedAt: string; assets: Asset[]; files: AssetExportItem[] };
type AssetExportItem = { storageKey: string; path: string; mimeType: string; bytes: number };

function assetStorageKey(asset: Asset) {
    return asset.kind === "text" ? "" : asset.data.storageKey || "";
}

export async function exportAssets(assets: Asset[]) {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];
    await Promise.all(assets.map(async (asset) => {
        const storageKey = assetStorageKey(asset);
        if (!storageKey) return;
        const blob = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (!blob) throw new Error(`资产“${asset.title}”缺少本地文件，已停止导出`);
        const path = `files/${safeFileName(storageKey)}.${fileExtension(blob.type, asset.kind)}`;
        const mimeType = asset.kind === "text" ? "text/plain" : asset.data.mimeType;
        files.push({ storageKey, path, mimeType: blob.type || mimeType, bytes: blob.size });
        zipFiles.push({ name: path, data: blob });
    }));
    const data: AssetExportFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets, files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, "我的资产.zip");
}

export async function readAssetPackage(file: File) {
    const zip = await readZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("缺少 assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    if (data.app !== "infinite-canvas" || data.version !== 1 || !Array.isArray(data.assets) || !Array.isArray(data.files)) throw new Error("资产包格式不正确");
    const imported = new Map<string, { storageKey: string; url: string }>();
    for (const item of data.files) {
        if (!item || typeof item.storageKey !== "string" || typeof item.path !== "string" || typeof item.mimeType !== "string" || !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new Error("资产包文件清单无效");
        const blob = zip.get(item.path);
        if (!blob || blob.size !== item.bytes) throw new Error(`资产包缺少或损坏文件：${item.path}`);
        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
        const storageKey = item.storageKey.startsWith("image:") ? `image:${nanoid()}` : `media:${nanoid()}`;
        const url = item.storageKey.startsWith("image:") ? await setImageBlob(storageKey, typedBlob) : await setMediaBlob(storageKey, typedBlob);
        imported.set(item.storageKey, { storageKey, url });
    }
    return data.assets.map((asset) => {
        const previous = assetStorageKey(asset);
        if (!previous) return asset;
        const restored = imported.get(previous);
        if (!restored) throw new Error(`资产包缺少“${asset.title}”的文件`);
        if (asset.kind === "image") return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? restored.url : asset.coverUrl, data: { ...asset.data, storageKey: restored.storageKey, dataUrl: restored.url } };
        return { ...asset, data: { ...asset.data, storageKey: restored.storageKey, url: restored.url } };
    });
}

function safeFileName(value: string) { return value.replace(/[\\/:*?"<>|]/g, "_"); }
function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    return kind === "image" ? "png" : "bin";
}
