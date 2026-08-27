export interface Env {
    MEDIA_BUCKET: R2Bucket;
    UPLOAD_TOKEN: string;
    PUBLIC_BASE_URL: string;
    OBJECT_PREFIX?: string;
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
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

function decodeKey(pathname: string) {
    try {
        const key = pathname.slice(1).split("/").map(decodeURIComponent).join("/");
        return key && !key.split("/").some((part) => !part || part === "." || part === "..") ? key : "";
    } catch {
        return "";
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.method === "OPTIONS") return response(null, { status: 204 });
        const url = new URL(request.url);
        if (request.method === "GET" || request.method === "HEAD") {
            const key = decodeKey(url.pathname);
            if (!key) return response("Not found", { status: 404 });
            const object = await env.MEDIA_BUCKET.get(key);
            if (!object) return response("Not found", { status: 404 });
            return response(request.method === "HEAD" ? null : object.body, {
                headers: {
                    "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
                    "Content-Disposition": object.httpMetadata?.contentDisposition || "inline",
                    "Cache-Control": "public, max-age=31536000, immutable",
                    ETag: object.httpEtag,
                },
            });
        }
        if (url.pathname !== "/upload" || request.method !== "POST") return response("Not found", { status: 404 });
        if (!env.UPLOAD_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.UPLOAD_TOKEN}`) return response("Unauthorized", { status: 401 });
        const multipart = request.headers.get("Content-Type")?.toLowerCase().startsWith("multipart/form-data");
        const contentLength = Number(request.headers.get("Content-Length") || "0");
        if (!multipart && contentLength > MAX_UPLOAD_BYTES) return response("File too large", { status: 413 });
        let body: ReadableStream | null = request.body;
        let contentType = request.headers.get("Content-Type")?.split(";", 1)[0].toLowerCase() || "application/octet-stream";
        let filename = request.headers.get("X-LY-Space-Filename") || "reference.bin";
        let size = contentLength;
        if (multipart) {
            try {
                const file = (await request.formData()).get("file");
                if (!(file instanceof File)) return response("Missing file", { status: 400 });
                body = file.stream();
                contentType = file.type.toLowerCase() || "application/octet-stream";
                filename = file.name || filename;
                size = file.size;
            } catch {
                return response("Invalid multipart form", { status: 400 });
            }
        }
        if (size > MAX_UPLOAD_BYTES) return response("File too large", { status: 413 });
        if (!/^(image|video|audio)\//.test(contentType)) return response("Unsupported media type", { status: 415 });
        if (!body) return response("Missing request body", { status: 400 });
        filename = safeFilename(filename);
        const prefix = (env.OBJECT_PREFIX || "ly-space/references").replace(/^\/+|\/+$/g, "");
        const key = `${prefix}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${extension(filename, contentType)}`;
        const publicBaseUrl = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
        if (!/^https:\/\//i.test(publicBaseUrl)) return response("PUBLIC_BASE_URL must be HTTPS", { status: 500 });
        await env.MEDIA_BUCKET.put(key, body, { httpMetadata: { contentType, contentDisposition: `inline; filename="${filename.replace(/"/g, "")}"` } });
        const url = `${publicBaseUrl}/${encodeKey(key)}`;
        return response(JSON.stringify({ ok: true, success: true, key, url, publicUrl: url }), { status: 201, headers: { "Content-Type": "application/json" } });
    },
};
