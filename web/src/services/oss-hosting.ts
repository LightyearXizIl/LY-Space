import localforage from "localforage";
import { nanoid } from "nanoid";

const STORE_KEY = "ly-space:oss-hosting";

export type OssHostingConfig = {
    signatureEndpoint: string;
    /** Public HTTPS domain, e.g. https://my-bucket.oss-cn-hangzhou.aliyuncs.com */
    publicBaseUrl: string;
    objectPrefix: string;
};

export const defaultOssHostingConfig: OssHostingConfig = { signatureEndpoint: "", publicBaseUrl: "", objectPrefix: "ly-space/references" };

type OssPostSignature = Record<string, unknown> & { host?: string; dir?: string };

export async function loadOssHostingConfig() {
    return (await localforage.getItem<OssHostingConfig>(STORE_KEY)) || defaultOssHostingConfig;
}

export async function saveOssHostingConfig(config: OssHostingConfig) {
    await localforage.setItem(STORE_KEY, { ...config, signatureEndpoint: config.signatureEndpoint.trim(), publicBaseUrl: config.publicBaseUrl.trim().replace(/\/+$/, ""), objectPrefix: config.objectPrefix.trim().replace(/^\/+|\/+$/g, "") });
}

/**
 * Upload with a server-issued STS/PostObject signature. The desktop app never receives or stores a permanent AccessKey.
 * The endpoint must return OSS form fields such as host, dir, policy and signature (or OSS4 x-oss-* fields).
 */
export async function hostImageOnOss(input: Blob, name: string, config: OssHostingConfig) {
    if (!config.signatureEndpoint) throw new Error("请先在 OSS 设置中填写签名接口地址");
    if (!/^https:\/\//i.test(config.publicBaseUrl)) throw new Error("OSS 公网域名必须是 HTTPS 地址");
    let signature: OssPostSignature;
    try {
        const response = await fetch(config.signatureEndpoint, { credentials: "omit" });
        if (!response.ok) throw new Error(`签名接口返回 ${response.status}`);
        signature = await response.json() as OssPostSignature;
    } catch (error) {
        throw new Error(error instanceof Error ? `无法获取 OSS 临时上传签名：${error.message}` : "无法获取 OSS 临时上传签名");
    }
    const host = String(signature.host || "").replace(/\/+$/, "");
    if (!/^https:\/\//i.test(host)) throw new Error("签名接口必须返回 HTTPS host");
    const extension = (name.match(/\.[a-z0-9]+$/i)?.[0] || mimeExtension(input.type) || ".png").toLowerCase();
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
    const uploaded = await fetch(host, { method: "POST", body: form });
    if (!uploaded.ok) throw new Error(`OSS 上传失败（${uploaded.status}）`);
    return `${config.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function mimeExtension(type: string) {
    return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" } as Record<string, string>)[type.toLowerCase()];
}
