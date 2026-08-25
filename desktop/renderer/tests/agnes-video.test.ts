import { describe, expect, it } from "vitest";

import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { buildAgnesVideoRequestBody } from "@/services/api/video";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function config(overrides: Partial<AiConfig> = {}) {
    return {
        model: "channel::agnes-video-2.5",
        size: "16:9",
        vquality: "720",
        videoSeconds: "6",
        videoFrameRate: "24",
        videoSeed: "",
        videoNegativePrompt: "",
        videoNumInferenceSteps: "",
        ...overrides,
    } as AiConfig;
}

describe("Agnes Video 请求体", () => {
    it("2.5 当前画布配置不再发送 V2.0 禁用字段", () => {
        const body = buildAgnesVideoRequestBody(config(), "channel::agnes-video-2.5", "测试提示词", { images: [], videos: [], audios: [] });
        expect(body).toMatchObject({ model: "agnes-video-2.5", prompt: "测试提示词", mode: "text", seconds: "6", size: "720P", aspect_ratio: "16:9", n: 1 });
        ["width", "height", "num_frames", "frame_rate", "num_inference_steps", "negative_prompt"].forEach((field) => expect(body).not.toHaveProperty(field));
    });

    it("V2.0 继续使用像素尺寸与帧数协议", () => {
        const body = buildAgnesVideoRequestBody(config({ model: "agnes-video-v2.0", size: "1152x768", videoSeconds: "6", videoFrameRate: "24" }), "agnes-video-v2.0", "测试", { images: [], videos: [], audios: [] });
        expect(body).toMatchObject({ model: "agnes-video-v2.0", width: 1152, height: 768, num_frames: 145, frame_rate: 24 });
    });

    it("按素材自动选择 text、keyframe 与 reference", () => {
        expect(buildAgnesVideoRequestBody(config(), "agnes-video-2.5", "测试", { images: ["https://example.com/first.png"], videos: [], audios: [] })).toMatchObject({ mode: "keyframe", first_frame: "https://example.com/first.png" });
        expect(buildAgnesVideoRequestBody(config(), "agnes-video-2.5", "测试", { images: ["https://example.com/first.png", "https://example.com/last.png"], videos: [], audios: [] })).toMatchObject({ mode: "keyframe", first_frame: "https://example.com/first.png", last_frame: "https://example.com/last.png" });
        expect(buildAgnesVideoRequestBody(config(), "agnes-video-2.5", "测试", { images: ["https://example.com/a.png"], videos: ["https://example.com/reference.mp4"], audios: ["https://example.com/reference.mp3"] })).toMatchObject({
            mode: "reference",
            images: ["https://example.com/a.png"],
            audios: ["https://example.com/reference.mp3"],
            videos: [{ url: "https://example.com/reference.mp4", start_seconds: 0, require_audio: false }],
        });
    });

    it("2.5 归一化时长、分辨率与画幅，Flash 强制其限制", () => {
        const body = buildAgnesVideoRequestBody(config({ size: "1792x1024", vquality: "480", videoSeconds: "18" }), "agnes-video-2.5", "测试", { images: [], videos: [], audios: [] });
        expect(body).toMatchObject({ seconds: "12", size: "720P", aspect_ratio: "16:9" });
        expect(buildAgnesVideoRequestBody(config({ vquality: "2K" }), "agnes-video-2.5-flash", "测试", { images: [], videos: [], audios: [] })).toMatchObject({ size: "720P" });
        expect(() => buildAgnesVideoRequestBody(config(), "agnes-video-2.5-flash", "测试", { images: [], videos: ["https://example.com/reference.mp4"], audios: [] })).toThrow("不支持参考视频");
        expect(() => buildAgnesVideoRequestBody(config(), "agnes-video-2.5-flash", "测试", { images: Array.from({ length: 6 }, (_, index) => `https://example.com/${index}.png`), videos: [], audios: [] })).toThrow("最多支持 5 张参考图");
    });

    it("画布节点模型覆盖和高级视频参数优先于全局 V2.0 配置", () => {
        const node = {
            id: "video-node",
            type: CanvasNodeType.Video,
            metadata: {
                model: "channel::agnes-video-2.5",
                size: "16:9",
                seconds: "6",
                vquality: "720P",
                videoSeed: "42",
            },
        } as CanvasNodeData;
        const generationConfig = buildGenerationConfig(config({
            model: "channel::agnes-video-v2.0",
            videoModel: "channel::agnes-video-v2.0",
            size: "1152x768",
            videoSeconds: "18",
            vquality: "480",
            videoSeed: "7",
            channels: [{ id: "channel", models: [{ name: "agnes-video-2.5", capability: "video" }] }] as AiConfig["channels"],
        }), node, "video");
        const body = buildAgnesVideoRequestBody(generationConfig, generationConfig.model, "画布测试", { images: [], videos: [], audios: [] });

        expect(body).toMatchObject({ model: "agnes-video-2.5", seconds: "6", size: "720P", aspect_ratio: "16:9", seed: 42 });
        expect(body).not.toHaveProperty("width");
    });
});
