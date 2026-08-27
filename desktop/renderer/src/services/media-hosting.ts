import localforage from "localforage";

import { assertOssHostingConfigReady, hostFileOnOss, loadOssHostingConfig, normalizeOssHostingConfig } from "@/services/oss-hosting";

const MAX_RECENT_UPLOADS = 50;
const recentStore = localforage.createInstance({ name: "infinite-canvas", storeName: "reference_uploads" });
const RECENT_UPLOADS_KEY = "recent";

export const REFERENCE_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_REFERENCE_IMAGE_UPLOAD_BYTES = 100 * 1024 * 1024;

export type MediaHostingConfig = {
    provider: "cloudflare-r2-worker";
    workerUrl: string;
    uploadToken: string;
    publicBaseUrl: string;
};

export type UploadResult = { key: string; url: string };

export type UploadedReferenceAsset = UploadResult & {
    id: string;
    fileName: string;
    type: string;
    createdAt: number;
};

export class ReferenceHostingConfigurationError extends Error {
    constructor() {
        super("尚未配置参考素材托管，请先在“OSS设置”完成 Cloudflare R2 + Worker 的 Worker 地址、上传令牌和公网域名。");
        this.name = "ReferenceHostingConfigurationError";
    }
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function isHttpsUrl(value: string) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname !== "localhost" && !/^127(?:\.\d{1,3}){3}$/.test(url.hostname) && url.hostname !== "::1";
    } catch {
        return false;
    }
}

export function normalizeMediaHostingConfig(input: unknown): MediaHostingConfig {
    const config = normalizeOssHostingConfig(input);
    return {
        provider: "cloudflare-r2-worker",
        workerUrl: config.r2WorkerEndpoint,
        uploadToken: config.r2UploadToken,
        publicBaseUrl: config.publicBaseUrl,
    };
}

export function validateReferenceImageFile(file: File) {
    if (!REFERENCE_IMAGE_MIME_TYPES.includes(file.type as (typeof REFERENCE_IMAGE_MIME_TYPES)[number])) throw new Error("不支持该文件格式，请选择 PNG、JPG、JPEG 或 WEBP 图片");
    if (file.size > MAX_REFERENCE_IMAGE_UPLOAD_BYTES) throw new Error("文件超过 100MB，无法上传");
}

export async function uploadReferenceImage(file: File): Promise<UploadResult> {
    validateReferenceImageFile(file);
    let config;
    try {
        config = normalizeOssHostingConfig(await loadOssHostingConfig());
        if (config.provider !== "cloudflare-r2") throw new ReferenceHostingConfigurationError();
        assertOssHostingConfigReady(config);
    } catch (error) {
        if (error instanceof ReferenceHostingConfigurationError) throw error;
        throw new ReferenceHostingConfigurationError();
    }
    try {
        const url = await hostFileOnOss(file, file.name, config);
        const key = decodeReferenceKey(url, config.publicBaseUrl);
        return { key, url };
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/failed to fetch|networkerror|网络请求失败/i.test(message) || error instanceof TypeError) throw new Error("网络连接失败，请稍后重试");
        if (/^Cloudflare R2 上传失败：/.test(message)) throw error;
        throw error;
    }
}

function decodeReferenceKey(url: string, publicBaseUrl: string) {
    const prefix = `${publicBaseUrl.replace(/\/+$/, "")}/`;
    if (!url.startsWith(prefix)) return "";
    return url.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
}

function normalizeUploadedReferenceAsset(value: unknown): UploadedReferenceAsset | null {
    const source = record(value);
    if (!source) return null;
    const url = text(source.url);
    if (!isHttpsUrl(url)) return null;
    return {
        id: text(source.id) || url,
        key: text(source.key),
        url,
        fileName: text(source.fileName) || "参考图",
        type: REFERENCE_IMAGE_MIME_TYPES.includes(text(source.type) as (typeof REFERENCE_IMAGE_MIME_TYPES)[number]) ? text(source.type) : "image/png",
        createdAt: typeof source.createdAt === "number" && Number.isFinite(source.createdAt) ? source.createdAt : 0,
    };
}

export async function loadRecentReferenceUploads(): Promise<UploadedReferenceAsset[]> {
    const stored = await recentStore.getItem<unknown>(RECENT_UPLOADS_KEY);
    return Array.isArray(stored) ? stored.map(normalizeUploadedReferenceAsset).filter((item): item is UploadedReferenceAsset => Boolean(item)).slice(0, MAX_RECENT_UPLOADS) : [];
}

export async function saveRecentReferenceUpload(input: UploadResult & Pick<UploadedReferenceAsset, "fileName" | "type">) {
    const item: UploadedReferenceAsset = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
    const current = await loadRecentReferenceUploads();
    const next = [item, ...current.filter((entry) => entry.url !== item.url)].slice(0, MAX_RECENT_UPLOADS);
    await recentStore.setItem(RECENT_UPLOADS_KEY, next);
    return next;
}
