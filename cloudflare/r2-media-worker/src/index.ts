export interface Env {
    MEDIA_BUCKET: R2Bucket;
    UPLOAD_TOKEN: string;
    PUBLIC_BASE_URL: string;
    OBJECT_PREFIX?: string;
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-LY-Space-Filename",
};

function response(body: BodyInit | null, init: ResponseInit = {}) {
    return new Response(body, { ...init, headers: { ...corsHeaders, ...init.headers } });
}

function safeFilename(value: string) {
    try {
        return decodeURIComponent(value).replace(/[\\/:*?"<>|\x00-\x1F]/g, "_").slice(-160) || "reference.bin";
    } catch {
        return "reference.bin";
    }
}

function extension(filename: string, mimeType: string) {
    const fromName = filename.match(/\.[a-z0-9]{1,10}$/i)?.[0];
    if (fromName) return fromName.toLowerCase();
    return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/wav": ".wav" } as Record<string, string>)[mimeType] || ".bin";
}

function encodeKey(key: string) {
    return key.split("/").map(encodeURIComponent).join("/");
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.method === "OPTIONS") return response(null, { status: 204 });
        const url = new URL(request.url);
        if (url.pathname !== "/upload" || request.method !== "POST") return response("Not found", { status: 404 });
        if (!env.UPLOAD_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.UPLOAD_TOKEN}`) return response("Unauthorized", { status: 401 });
        const contentLength = Number(request.headers.get("Content-Length") || "0");
        if (contentLength > MAX_UPLOAD_BYTES) return response("File too large", { status: 413 });
        const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].toLowerCase() || "application/octet-stream";
        if (!/^(image|video|audio)\//.test(contentType)) return response("Unsupported media type", { status: 415 });
        if (!request.body) return response("Missing request body", { status: 400 });
        const filename = safeFilename(request.headers.get("X-LY-Space-Filename") || "reference.bin");
        const prefix = (env.OBJECT_PREFIX || "ly-space/references").replace(/^\/+|\/+$/g, "");
        const key = `${prefix}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${extension(filename, contentType)}`;
        const publicBaseUrl = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
        if (!/^https:\/\//i.test(publicBaseUrl)) return response("PUBLIC_BASE_URL must be HTTPS", { status: 500 });
        await env.MEDIA_BUCKET.put(key, request.body, { httpMetadata: { contentType, contentDisposition: `inline; filename="${filename.replace(/"/g, "")}"` } });
        return response(JSON.stringify({ url: `${publicBaseUrl}/${encodeKey(key)}` }), { status: 201, headers: { "Content-Type": "application/json" } });
    },
};
