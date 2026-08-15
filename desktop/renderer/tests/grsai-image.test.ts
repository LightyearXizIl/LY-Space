import { describe, expect, it } from "vitest";

import { grsaiRequestBody, normalizeGrsaiReference } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";

function config(model: string, size = "1:1", imageResolution = "1k") {
    return { model, size, imageResolution, systemPrompt: "" } as AiConfig;
}

describe("GRS AI 参考图", () => {
    it("远程图片 URL 原样保留", () => {
        expect(normalizeGrsaiReference("https://example.com/reference.png")).toBe("https://example.com/reference.png");
    });

    it("data URL 转换为裸 Base64", () => {
        expect(normalizeGrsaiReference("data:image/png;base64,aGVsbG8=")).toBe("aGVsbG8=");
    });

    it("拒绝无效参考图", () => {
        expect(() => normalizeGrsaiReference("blob:not-available")).toThrow("参考图格式无效");
    });
});

describe("GRS AI 六个默认图片模型请求体", () => {
    const models = ["gpt-image-2", "gpt-image-2-vip", "nano-banana-2", "nano-banana-2-lite", "nano-banana-fast", "nano-banana-pro"];

    it.each(models)("%s 使用新版 images 字段", (model) => {
        const body = grsaiRequestBody(config(model), "测试", ["aGVsbG8="]);
        expect(body).toMatchObject({ model, prompt: "测试", images: ["aGVsbG8="], replyType: "json" });
        expect(body).not.toHaveProperty("urls");
    });

    it("GPT 标准模型按比例发送，且不带 imageSize", () => {
        const body = grsaiRequestBody(config("gpt-image-2", "16:9", "2k"), "测试", []);
        expect(body.aspectRatio).toBe("16:9");
        expect(body).not.toHaveProperty("imageSize");
    });

    it("GPT VIP 模型发送显式像素尺寸", () => {
        const body = grsaiRequestBody(config("gpt-image-2-vip", "16:9", "2k"), "测试", []);
        expect(body.aspectRatio).toBe("2048x1152");
        expect(body).not.toHaveProperty("imageSize");
    });

    it("Nano Banana 模型发送比例和分辨率", () => {
        const body = grsaiRequestBody(config("nano-banana-2", "16:9", "2k"), "测试", []);
        expect(body).toMatchObject({ aspectRatio: "16:9", imageSize: "2K" });
    });
});
