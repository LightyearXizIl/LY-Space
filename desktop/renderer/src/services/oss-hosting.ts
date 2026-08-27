import localforage from "localforage";
import { nanoid } from "nanoid";

const STORE_KEY = "ly-space:oss-hosting";

export type OssHostingProvider = "aliyun-oss" | "cloudflare-r2";

export type OssHostingConfig = {
    provider: OssHostingProvider;
    signatureEndpoint: string;
    r2WorkerEndpoint: string;
    r2UploadToken: string;
    /** Public HTTPS domain, e.g. https://my-bucket.oss-cn-hangzhou.aliyuncs.com */
    publicBaseUrl: string;
    objectPrefix: string;
};

export const defaultOssHostingConfig: OssHostingConfig = { provider: "aliyun-oss", signatureEndpoint: "", r2WorkerEndpoint: "", r2UploadToken: "", publicBaseUrl: "", objectPrefix: "ly-space/references" };
export const CLOUDFLARE_R2_WORKER_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

type OssPostSignature = Record<string, unknown>;
type OssUploadOptions = { signal?: AbortSignal };

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, fallback = "") {
    return typeof value === "string" ? value : fallback;
}

function normalizeUrl(value: unknown) {
    return text(value).trim().replace(/\/+$/, "");
}

function isHttpsUrl(value: string) {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

export function normalizeOssHostingConfig(input: unknown): OssHostingConfig {
    const source = record(input) || {};
    return {
        provider: source.provider === "cloudflare-r2" ? "cloudflare-r2" : "aliyun-oss",
        signatureEndpoint: normalizeUrl(source.signatureEndpoint),
        r2WorkerEndpoint: normalizeUrl(source.r2WorkerEndpoint),
        r2UploadToken: text(source.r2UploadToken).trim(),
        publicBaseUrl: normalizeUrl(source.publicBaseUrl),
        objectPrefix: text(source.objectPrefix, defaultOssHostingConfig.objectPrefix)
            .trim()
            .replace(/^\/+|\/+$/g, ""),
    };
}

export function assertOssHostingConfigReady(input: unknown): OssHostingConfig {
    const config = normalizeOssHostingConfig(input);
    if (config.provider === "cloudflare-r2") {
        if (!isHttpsUrl(config.r2WorkerEndpoint)) throw new Error("请先在“OSS设置”中填写 HTTPS Worker 地址");
        if (!config.r2UploadToken) throw new Error("请先在“OSS设置”中填写 Worker 上传令牌");
        if (!isHttpsUrl(config.publicBaseUrl)) throw new Error("请先在“OSS设置”中填写 HTTPS R2 公网域名");
        return config;
    }
    if (!isHttpsUrl(config.signatureEndpoint)) throw new Error("请先在“OSS设置”中填写 HTTPS 签名接口地址");
    if (!isHttpsUrl(config.publicBaseUrl)) throw new Error("请先在“OSS设置”中填写 HTTPS OSS 公网域名");
    return config;
}

export async function loadOssHostingConfig(): Promise<OssHostingConfig> {
    return normalizeOssHostingConfig(await localforage.getItem<unknown>(STORE_KEY));
}

export async function saveOssHostingConfig(config: Partial<OssHostingConfig>): Promise<OssHostingConfig> {
    const normalized = normalizeOssHostingConfig(config);
    await localforage.setItem(STORE_KEY, normalized);
    return normalized;
}

/**
 * Upload with a server-issued STS/PostObject signature. The desktop app never receives or stores a permanent AccessKey.
 * The endpoint must return OSS form fields such as host, dir, policy and signature (or OSS4 x-oss-* fields).
 */
export async function hostFileOnOss(input: Blob, name: string, config: Partial<OssHostingConfig>, options?: OssUploadOptions) {
    if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const normalizedConfig = assertOssHostingConfigReady(config);
    if (normalizedConfig.provider === "cloudflare-r2") return hostFileOnCloudflareR2(input, name, normalizedConfig, options);
    let signature: OssPostSignature;
    try {
        const response = await fetch(normalizedConfig.signatureEndpoint, { credentials: "omit", signal: options?.signal });
        if (!response.ok) throw new Error(`签名接口返回 ${response.status}`);
        const signaturePayload = record(await response.json());
        if (!signaturePayload) throw new Error("签名接口返回格式无效");
        signature = signaturePayload;
    } catch (error) {
        throw new Error(error instanceof Error ? `无法获取 OSS 临时上传签名：${error.message}` : "无法获取 OSS 临时上传签名");
    }
    const host = String(signature.host || "").replace(/\/+$/, "");
    if (!/^https:\/\//i.test(host)) throw new Error("签名接口必须返回 HTTPS host");
    const extension = (name.match(/\.[a-z0-9]+$/i)?.[0] || mimeExtension(input.type) || ".bin").toLowerCase();
    const prefix = String(signature.dir || normalizedConfig.objectPrefix || "ly-space/references").replace(/^\/+|\/+$/g, "");
    const key = `${prefix ? `${prefix}/` : ""}${new Date().toISOString().slice(0, 10)}/${Date.now()}-${nanoid(10)}${extension}`;
    const form = new FormData();
    const ignored = new Set(["host", "dir", "key", "callback"]);
    for (const [field, value] of Object.entries(signature)) {
        if (ignored.has(field) || value === undefined || value === null || typeof value === "object") continue;
        form.append(field, String(value));
    }
    form.set("key", key);
    form.set("success_action_status", "200");
    form.set("x-oss-forbid-overwrite", "true");
    form.append("file", input, name || `reference${extension}`);
    const uploaded = await fetch(host, { method: "POST", body: form, signal: options?.signal });
    if (!uploaded.ok) throw new Error(`OSS 上传失败（${uploaded.status}）`);
    return `${normalizedConfig.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function hostFileOnCloudflareR2(input: Blob, name: string, config: OssHostingConfig, options?: OssUploadOptions) {
    if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const workerEndpoint = config.r2WorkerEndpoint;
    const uploadToken = config.r2UploadToken;
    const publicBaseUrl = config.publicBaseUrl;
    if (input.size > CLOUDFLARE_R2_WORKER_MAX_UPLOAD_BYTES) throw new Error("Cloudflare 免费 Worker 单个参考素材最大 100MB，请压缩素材或使用阿里云 OSS 直传");
    const extension = (name.match(/\.[a-z0-9]+$/i)?.[0] || mimeExtension(input.type) || ".bin").toLowerCase();
    try {
        const form = new FormData();
        form.append("file", input, name || `reference${extension}`);
        const response = await fetch(`${workerEndpoint.replace(/\/upload$/i, "")}/upload`, {
            method: "POST",
            credentials: "omit",
            headers: {
                Authorization: `Bearer ${uploadToken}`,
            },
            body: form,
            signal: options?.signal,
        });
        if (!response.ok) throw new Error(workerUploadError(response.status));
        const payload = record(await response.json());
        const key = text(payload?.key).trim().replace(/^\/+/, "");
        const uploadedUrl = text(payload?.publicUrl).trim() || text(payload?.url).trim() || (key ? `${publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}` : "");
        if (!isHttpsUrl(uploadedUrl)) throw new Error("Worker 返回的素材地址无效");
        return uploadedUrl;
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error(error instanceof Error ? `Cloudflare R2 上传失败：${error.message}` : "Cloudflare R2 上传失败");
    }
}

function workerUploadError(status: number) {
    if (status === 401 || status === 403) return "上传令牌无效";
    if (status === 413) return "文件超过 100MB，无法上传";
    if (status === 415) return "不支持该文件格式";
    if (status >= 500) return "素材存储服务配置异常";
    return `Worker 返回 ${status}`;
}

/** @deprecated 图片调用请迁移到 hostFileOnOss；保留该入口避免影响既有调用。 */
export function hostImageOnOss(input: Blob, name: string, config: Partial<OssHostingConfig>, options?: OssUploadOptions) {
    return hostFileOnOss(input, name, config, options);
}

function mimeExtension(type: string) {
    return (
        {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/webp": ".webp",
            "image/gif": ".gif",
            "video/mp4": ".mp4",
            "video/quicktime": ".mov",
            "audio/mpeg": ".mp3",
            "audio/mp3": ".mp3",
            "audio/wav": ".wav",
            "audio/x-wav": ".wav",
        } as Record<string, string>
    )[type.toLowerCase()];
}
