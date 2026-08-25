import { afterEach, describe, expect, it, vi } from "vitest";

const localforageMock = vi.hoisted(() => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    createInstance: vi.fn(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), keys: vi.fn() })),
}));

vi.mock("localforage", () => ({ default: localforageMock }));

import { hostReferenceVideo } from "@/services/image-hosting";
import { assertOssHostingConfigReady, defaultOssHostingConfig, hostFileOnOss, loadOssHostingConfig, normalizeOssHostingConfig, saveOssHostingConfig, type OssHostingConfig } from "@/services/oss-hosting";

const config: OssHostingConfig = {
    ...defaultOssHostingConfig,
    signatureEndpoint: "https://sign.example.com",
    publicBaseUrl: "https://bucket.example.com",
};
const r2Config: OssHostingConfig = {
    ...defaultOssHostingConfig,
    provider: "cloudflare-r2",
    r2WorkerEndpoint: "https://ly-space-r2.example.workers.dev",
    r2UploadToken: "test-token",
    publicBaseUrl: "https://media.example.com",
};
const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
});

describe("OSS 参考素材托管", () => {
    it("为旧版、缺失和异常字段补齐稳定默认值", () => {
        expect(normalizeOssHostingConfig({ signatureEndpoint: " https://sign.example.com/ ", publicBaseUrl: "https://bucket.example.com/" })).toEqual({
            ...defaultOssHostingConfig,
            signatureEndpoint: "https://sign.example.com",
            publicBaseUrl: "https://bucket.example.com",
        });
        expect(normalizeOssHostingConfig({ provider: "cloudflare-r2", signatureEndpoint: null, r2WorkerEndpoint: undefined, r2UploadToken: 1, publicBaseUrl: null, objectPrefix: 1 })).toEqual({
            ...defaultOssHostingConfig,
            provider: "cloudflare-r2",
        });
    });

    it("读取和保存均使用归一化配置，存储读取失败可由界面恢复处理", async () => {
        localforageMock.getItem.mockResolvedValueOnce({ provider: "cloudflare-r2" });
        await expect(loadOssHostingConfig()).resolves.toEqual({ ...defaultOssHostingConfig, provider: "cloudflare-r2" });

        await expect(saveOssHostingConfig({ provider: "cloudflare-r2", r2WorkerEndpoint: " https://worker.example.com/ ", r2UploadToken: undefined, publicBaseUrl: null, objectPrefix: " /refs/ " } as unknown as Partial<OssHostingConfig>)).resolves.toEqual(
            {
                ...defaultOssHostingConfig,
                provider: "cloudflare-r2",
                r2WorkerEndpoint: "https://worker.example.com",
                objectPrefix: "refs",
            },
        );
        expect(localforageMock.setItem).toHaveBeenCalledWith("ly-space:oss-hosting", expect.objectContaining({ r2UploadToken: "", publicBaseUrl: "", objectPrefix: "refs" }));

        localforageMock.getItem.mockRejectedValueOnce(new Error("IndexedDB unavailable"));
        await expect(loadOssHostingConfig()).rejects.toThrow("IndexedDB unavailable");
    });

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

    it("缺少配置、错误响应和已取消请求均给出可恢复错误", async () => {
        await expect(hostFileOnOss(new Blob(["audio"]), "reference.mp3", { ...config, signatureEndpoint: "" })).rejects.toThrow("签名接口");
        await expect(Promise.resolve().then(() => assertOssHostingConfigReady({ provider: "cloudflare-r2" }))).rejects.toThrow("Worker 地址");
        const controller = new AbortController();
        controller.abort();
        await expect(hostFileOnOss(new Blob(["audio"]), "reference.mp3", config, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });

        globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(null), { status: 201 }));
        await expect(hostFileOnOss(new Blob(["video"]), "reference.mp4", r2Config)).rejects.toThrow("Worker 返回的素材地址");
    });

    it("通过受令牌保护的 Cloudflare R2 Worker 上传媒体，无需阿里云签名接口", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ url: "https://media.example.com/ly-space/references/video.mp4" }), { status: 201 }));
        globalThis.fetch = fetchMock;

        await expect(hostFileOnOss(new Blob(["video"], { type: "video/mp4" }), "reference.mp4", { ...r2Config, signatureEndpoint: "" })).resolves.toBe("https://media.example.com/ly-space/references/video.mp4");

        expect(fetchMock).toHaveBeenCalledWith(
            "https://ly-space-r2.example.workers.dev/upload",
            expect.objectContaining({
                method: "POST",
                headers: expect.objectContaining({ Authorization: "Bearer test-token", "X-LY-Space-Filename": "reference.mp4" }),
            }),
        );
    });

    it("参考素材入口可使用 R2 配置上传，不会误要求阿里云签名接口", async () => {
        localforageMock.getItem.mockResolvedValueOnce({ ...r2Config, signatureEndpoint: "" });
        globalThis.fetch = vi
            .fn()
            .mockResolvedValueOnce(new Response(new Blob(["video"], { type: "video/mp4" }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://media.example.com/ly-space/references/video.mp4" }), { status: 201 }));

        await expect(hostReferenceVideo({ id: "reference", name: "reference.mp4", type: "video/mp4", url: "https://source.example.com/reference.mp4" })).resolves.toMatchObject({
            url: "https://media.example.com/ly-space/references/video.mp4",
        });
    });
});
