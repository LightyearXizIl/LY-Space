import { afterEach, describe, expect, it, vi } from "vitest";

import { hostFileOnOss } from "@/services/oss-hosting";

const config = { signatureEndpoint: "https://sign.example.com", publicBaseUrl: "https://bucket.example.com", objectPrefix: "ly-space/references" };
const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("OSS 参考素材托管", () => {
    it("按原始媒体扩展名上传并返回 HTTPS 公网地址", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ host: "https://upload.example.com", dir: "refs", policy: "policy", signature: "signature" }), { status: 200 }))
            .mockResolvedValueOnce(new Response("", { status: 200 }));
        globalThis.fetch = fetchMock;
        const url = await hostFileOnOss(new Blob(["video"], { type: "video/mp4" }), "reference.mp4", config);
        expect(url).toMatch(/^https:\/\/bucket\.example\.com\/refs\/.+\.mp4$/);
        const form = fetchMock.mock.calls[1][1]?.body as FormData;
        expect(form.get("file")).toBeInstanceOf(Blob);
    });

    it("缺少 OSS 配置或已取消请求时给出可恢复错误", async () => {
        await expect(hostFileOnOss(new Blob(["audio"]), "reference.mp3", { ...config, signatureEndpoint: "" })).rejects.toThrow("签名接口");
        const controller = new AbortController();
        controller.abort();
        await expect(hostFileOnOss(new Blob(["audio"]), "reference.mp3", config, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    });

    it("通过受令牌保护的 Cloudflare R2 Worker 上传媒体", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: "https://media.example.com/ly-space/references/video.mp4" }), { status: 201 }));
        globalThis.fetch = fetchMock;

        await expect(hostFileOnOss(new Blob(["video"], { type: "video/mp4" }), "reference.mp4", {
            ...config,
            provider: "cloudflare-r2",
            r2WorkerEndpoint: "https://ly-space-r2.example.workers.dev",
            r2UploadToken: "test-token",
            publicBaseUrl: "https://media.example.com",
        })).resolves.toBe("https://media.example.com/ly-space/references/video.mp4");

        expect(fetchMock).toHaveBeenCalledWith("https://ly-space-r2.example.workers.dev/upload", expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({ Authorization: "Bearer test-token", "X-LY-Space-Filename": "reference.mp4" }),
        }));
    });
});
