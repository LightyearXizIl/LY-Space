import { afterEach, describe, expect, it, vi } from "vitest";

import { arkRequestJson, arkStreamText, buildArkImageRequest, buildArkResponsesRequest, buildArkSeedanceTaskRequest, normalizeArkSeed } from "@/services/api/ark";
import { requestImageQuestion } from "@/services/api/image";
import { sanitizeConfig } from "@/services/config-file";
import { isSeedanceFastModel, seedanceAudioReferenceError, seedanceReferenceCountError } from "@/lib/seedance-video";
import { ARK_AGENT_PLAN_BASE_URL, ARK_STANDARD_BASE_URL, buildApiUrl, defaultConfig, isArkAgentPlanBaseUrl, type AiConfig } from "@/stores/use-config-store";

function arkConfig(overrides: Partial<AiConfig> = {}) {
    return {
        ...defaultConfig,
        baseUrl: ARK_STANDARD_BASE_URL,
        apiKey: "test-key",
        apiFormat: "ark",
        model: "ep-test",
        textModel: "ep-test",
        imageModel: "ep-seedream",
        videoModel: "ep-seedance",
        channels: [{ id: "ark", name: "方舟", baseUrl: ARK_STANDARD_BASE_URL, apiKey: "test-key", apiFormat: "ark", models: [{ name: "ep-test", capability: "text" }, { name: "ep-seedream", capability: "image" }, { name: "ep-seedance", capability: "video" }] }],
        ...overrides,
    } as AiConfig;
}

describe("火山方舟地址", () => {
    it("标准、Plan、尾部斜杠和已粘贴完整端点都会归一到一次路径", () => {
        expect(buildApiUrl(`${ARK_STANDARD_BASE_URL}/`, "/responses")).toBe(`${ARK_STANDARD_BASE_URL}/responses`);
        expect(buildApiUrl(`${ARK_STANDARD_BASE_URL}/images/generations`, "/images/generations")).toBe(`${ARK_STANDARD_BASE_URL}/images/generations`);
        expect(buildApiUrl(`${ARK_AGENT_PLAN_BASE_URL}/contents/generations/tasks/`, "/contents/generations/tasks")).toBe(`${ARK_AGENT_PLAN_BASE_URL}/contents/generations/tasks`);
        expect(isArkAgentPlanBaseUrl(`${ARK_AGENT_PLAN_BASE_URL}/contents/generations/tasks`)).toBe(true);
        expect(isArkAgentPlanBaseUrl(ARK_STANDARD_BASE_URL)).toBe(false);
        expect(isArkAgentPlanBaseUrl("https://ark.cn-beijing.volces.com/api/plan/v3oops")).toBe(false);
    });
});

describe("方舟配置兼容", () => {
    it("导入缺少新字段的旧配置时补默认值，不覆盖渠道、模型或 API Key", () => {
        const { config } = sanitizeConfig({
            channels: [{ id: "ark", name: "已有方舟", baseUrl: ARK_STANDARD_BASE_URL, apiKey: "old-key", apiFormat: "ark", models: [{ name: "seedream-model", capability: "image" }] }],
            apiFormat: "ark",
            model: "ark::seedream-model",
            imageModel: "ark::seedream-model",
        });
        expect(config.arkThinkingMode).toBe("auto");
        expect(config.imageWatermark).toBe("true");
        expect(config.channels[0]).toMatchObject({ name: "已有方舟", apiKey: "old-key", models: [{ name: "seedream-model", capability: "image" }] });
    });
});

describe("方舟 Responses 请求", () => {
    it.each(["auto", "enabled", "disabled"] as const)("思考模式 %s 使用 thinking.type，不发送 OpenAI reasoning.effort", (arkThinkingMode) => {
        const body = buildArkResponsesRequest(arkConfig({ arkThinkingMode }), [{ role: "user", content: "你好" }]);
        expect(body).toMatchObject({ model: "ep-test", thinking: { type: arkThinkingMode } });
        expect(body).not.toHaveProperty("reasoning");
    });

    it("保留函数工具定义和图片输入", () => {
        const body = buildArkResponsesRequest(arkConfig(), [{ role: "user", content: [{ type: "input_text", text: "看图" }, { type: "input_image", image_url: "https://example.com/a.png" }] }], [{ type: "function", name: "lookup", parameters: { type: "object" } }], "auto");
        expect(body).toMatchObject({ tools: [{ type: "function", name: "lookup" }], tool_choice: "auto" });
    });

    it("SSE 增量与完整响应均能回填文本", async () => {
        const originalWindow = globalThis.window;
        Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
        const fetchMock = vi.fn().mockResolvedValue(new Response("data: {\"type\":\"response.output_text.delta\",\"delta\":\"你\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"output_text\":\"你好\"}}\n\n", { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        const deltas: string[] = [];
        await expect(requestImageQuestion(arkConfig(), [{ role: "user", content: "你好" }], (delta) => deltas.push(delta))).resolves.toBe("你");
        const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
        expect(sent).toMatchObject({ stream: true, thinking: { type: "auto" } });
        expect(deltas).toEqual(["你"]);
        Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
    });

    it("桌面端文本流经 IPC 增量传输，不发起浏览器 fetch", async () => {
        const events: Array<(event: { requestId: string; type: "chunk"; data: string }) => void> = [];
        const proxyStreamRequest = vi.fn(async (request: { requestId: string }) => {
            events.forEach((listener) => listener({ requestId: request.requestId, type: "chunk", data: "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你\"}\n\n" }));
            return { status: 200, headers: { "x-request-id": "req-text" }, data: "data: {\"type\":\"response.output_text.delta\",\"delta\":\"你\"}\n\n" };
        });
        vi.stubGlobal("window", { lySpaceDesktop: {
            proxyStreamRequest,
            cancelProxyStream: vi.fn(),
            onProxyStreamEvent: (listener: (event: { requestId: string; type: "chunk"; data: string }) => void) => { events.push(listener); return () => events.splice(events.indexOf(listener), 1); },
        } });
        const fetchMock = vi.fn(() => { throw new Error("desktop Ark must not use fetch"); });
        vi.stubGlobal("fetch", fetchMock);
        const chunks: string[] = [];
        await arkStreamText(arkConfig(), "/responses", { stream: true }, (chunk) => chunks.push(chunk));
        expect(chunks.join("")).toContain("response.output_text.delta");
        expect(proxyStreamRequest.mock.calls[0][0]).toMatchObject({ kind: "ark", url: `${ARK_STANDARD_BASE_URL}/responses` });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("桌面端模型、图片和视频共用普通 IPC 请求，不发起浏览器 fetch", async () => {
        const proxyRequest = vi.fn().mockResolvedValue({ status: 200, headers: { "x-request-id": "req-json" }, data: JSON.stringify({ data: [{ id: "ep-test" }] }) });
        vi.stubGlobal("window", { lySpaceDesktop: { proxyRequest, cancelProxyRequest: vi.fn() } });
        const fetchMock = vi.fn(() => { throw new Error("desktop Ark must not use fetch"); });
        vi.stubGlobal("fetch", fetchMock);
        await expect(arkRequestJson<{ data: Array<{ id: string }> }>(arkConfig(), "/models")).resolves.toEqual({ data: [{ id: "ep-test" }] });
        expect(proxyRequest.mock.calls[0][0]).toMatchObject({ kind: "ark", url: `${ARK_STANDARD_BASE_URL}/models`, headers: { Authorization: "Bearer test-key" } });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("Seedream 请求体", () => {
    it("文生图不带 image，单图与多图按方舟字段发送", () => {
        const plain = buildArkImageRequest(arkConfig({ model: "ep-seedream" }), "文生图", 1, "1024x1024");
        expect(plain).toMatchObject({ stream: false, watermark: true, sequential_image_generation: "disabled", response_format: "b64_json" });
        expect(plain).not.toHaveProperty("image");
        expect(plain).not.toHaveProperty("n");
        expect(plain).not.toHaveProperty("quality");
        const single = buildArkImageRequest(arkConfig({ model: "ep-seedream", imageWatermark: "false" }), "编辑", 1, undefined, ["data:image/png;base64,AA=="]);
        expect(single).toMatchObject({ image: "data:image/png;base64,AA==", watermark: false, sequential_image_generation: "disabled" });
        const multiple = buildArkImageRequest(arkConfig({ model: "ep-seedream" }), "编辑", 3, undefined, ["https://example.com/a.png", "asset://b"]);
        expect(multiple).toMatchObject({ image: ["https://example.com/a.png", "asset://b"], sequential_image_generation: "auto", max_images: 3 });
    });
});

describe("Seedance 参数边界", () => {
    it("保留合法 seed，拒绝越界值，并识别 Fast 1080p 限制所需型号", () => {
        expect(normalizeArkSeed("-1")).toBe(-1);
        expect(normalizeArkSeed("4294967295")).toBe(4294967295);
        expect(normalizeArkSeed("4294967296")).toBeUndefined();
        expect(buildArkSeedanceTaskRequest(arkConfig({ model: "seedance-2.0", videoSeed: "42", videoWatermark: "true" }), [{ type: "text", text: "测试" }], "16:9", "720p", 5)).toMatchObject({ seed: 42, watermark: true, generate_audio: true });
        expect(isSeedanceFastModel("seedance-2.0-fast")).toBe(true);
    });

    it("超额素材和不支持的音频格式会明确报错", () => {
        expect(seedanceReferenceCountError(Array.from({ length: 10 }, (_, id) => ({ id: String(id), name: "a.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" })), [], [])).toContain("最多支持 9 张");
        expect(seedanceAudioReferenceError([{ id: "a", name: "a.ogg", type: "audio/ogg", url: "https://example.com/a.ogg", durationMs: 3000 }])).toContain("仅支持 mp3/wav");
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});
