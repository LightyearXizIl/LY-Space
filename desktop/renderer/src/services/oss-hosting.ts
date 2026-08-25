import localforage from "localforage";
import { nanoid } from "nanoid";

const STORE_KEY = "ly-space:oss-hosting";

export type OssHostingConfig = {
    provider?: "aliyun-oss" | "cloudflare-r2";
    signatureEndpoint: string;
    r2WorkerEndpoint?: string;
    r2UploadToken?: string;
    /** Public HTTPS domain, e.g. https://my-bucket.oss-cn-hangzhou.aliyuncs.com */
    publicBaseUrl: string;
    objectPrefix: string;
};

export const defaultOssHostingConfig: OssHostingConfig = { provider: "aliyun-oss", signatureEndpoint: "", r2WorkerEndpoint: "", r2UploadToken: "", publicBaseUrl: "", objectPrefix: "ly-space/references" };
export const CLOUDFLARE_R2_WORKER_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

type OssPostSignature = Record<string, unknown> & { host?: string; dir?: string };
type OssUploadOptions = { signal?: AbortSignal };

export async function loadOssHostingConfig() {
    return (await localforage.getItem<OssHostingConfig>(STORE_KEY)) || defaultOssHostingConfig;
}

export async function saveOssHostingConfig(config: OssHostingConfig) {
    await localforage.setItem(STORE_KEY, { ...config, provider: config.provider || "aliyun-oss", signatureEndpoint: config.signatureEndpoint.trim(), r2WorkerEndpoint: (config.r2WorkerEndpoint || "").trim().replace(/\/+$/, ""), r2UploadToken: (config.r2UploadToken || "").trim(), publicBaseUrl: config.publicBaseUrl.trim().replace(/\/+$/, ""), objectPrefix: config.objectPrefix.trim().replace(/^\/+|\/+$/g, "") });
}

/**
 * Upload with a server-issued STS/PostObject signature. The desktop app never receives or stores a permanent AccessKey.
 * The endpoint must return OSS form fields such as host, dir, policy and signature (or OSS4 x-oss-* fields).
 */
export async function hostFileOnOss(input: Blob, name: string, config: OssHostingConfig, options?: OssUploadOptions) {
    if (config.provider === "cloudflare-r2") return hostFileOnCloudflareR2(input, name, config, options);
    if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!config.signatureEndpoint) throw new Error("请先在 OSS 设置中填写签名接口地址");
    if (!/^https:\/\//i.test(config.publicBaseUrl)) throw new Error("OSS 公网域名必须是 HTTPS 地址");
    let signature: OssPostSignature;
    try {
        const response = await fetch(config.signatureEndpoint, { credentials: "omit", signal: options?.signal });
        if (!response.ok) throw new Error(`签名接口返回 ${response.status}`);
        signature = await response.json() as OssPostSignature;
    } catch (error) {
        throw new Error(error instanceof Error ? `无法获取 OSS 临时上传签名：${error.message}` : "无法获取 OSS 临时上传签名");
    }
    const host = String(signature.host || "").replace(/\/+$/, "");
    if (!/^https:\/\//i.test(host)) throw new Error("签名接口必须返回 HTTPS host");
    const extension = (name.match(/\.[a-z0-9]+$/i)?.[0] || mimeExtension(input.type) || ".bin").toLowerCase();
    const prefix = (String(signature.dir || config.objectPrefix || "ly-space/references")).replace(/^\/+|\/+$/g, "");
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
    return `${config.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function hostFileOnCloudflareR2(input: Blob, name: string, config: OssHostingConfig, options?: OssUploadOptions) {
    if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const workerEndpoint = (config.r2WorkerEndpoint || "").replace(/\/+$/, "");
    const uploadToken = config.r2UploadToken || "";
    const publicBaseUrl = config.publicBaseUrl.trim().replace(/\/+$/, "");
    if (!/^https:\/\//i.test(workerEndpoint)) throw new Error("请先填写 Cloudflare R2 Worker 上传地址");
    if (!uploadToken) throw new Error("请先填写 Cloudflare R2 Worker 上传令牌");
    if (!/^https:\/\//i.test(publicBaseUrl)) throw new Error("R2 公网域名必须是 HTTPS 地址");
    if (input.size > CLOUDFLARE_R2_WORKER_MAX_UPLOAD_BYTES) throw new Error("Cloudflare 免费 Worker 单个参考素材最大 100MB，请压缩素材或使用阿里云 OSS 直传");
    const extension = (name.match(/\.[a-z0-9]+$/i)?.[0] || mimeExtension(input.type) || ".bin").toLowerCase();
    try {
        const response = await fetch(`${workerEndpoint.replace(/\/upload$/i, "")}/upload`, {
            method: "POST",
            credentials: "omit",
            headers: {
                Authorization: `Bearer ${uploadToken}`,
                "Content-Type": input.type || "application/octet-stream",
                "X-LY-Space-Filename": encodeURIComponent(name || `reference${extension}`),
            },
            body: input,
            signal: options?.signal,
        });
        if (!response.ok) throw new Error(`Worker 返回 ${response.status}`);
        const payload = await response.json() as { url?: string };
        if (!payload.url || !payload.url.startsWith(`${publicBaseUrl}/`)) throw new Error("Worker 返回的素材地址与所填 R2 公网域名不一致");
        return payload.url;
    } catch (error) {
        throw new Error(error instanceof Error ? `Cloudflare R2 上传失败：${error.message}` : "Cloudflare R2 上传失败");
    }
}

/** @deprecated 图片调用请迁移到 hostFileOnOss；保留该入口避免影响既有调用。 */
export function hostImageOnOss(input: Blob, name: string, config: OssHostingConfig, options?: OssUploadOptions) {
    return hostFileOnOss(input, name, config, options);
}

function mimeExtension(type: string) {
    return ({
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
    } as Record<string, string>)[type.toLowerCase()];
}
