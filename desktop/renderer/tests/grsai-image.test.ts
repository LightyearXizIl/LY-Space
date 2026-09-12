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

describe("GRS AI 默认图片模型请求体", () => {
    const models = ["gpt-image-2.5", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2", "gpt-image-2-vip", "nano-banana-2", "nano-banana-2-lite", "nano-banana-fast", "nano-banana-pro"];

    it.each(models)("%s 使用新版 images 字段", (model) => {
        const body = grsaiRequestBody(config(model), "测试", ["aGVsbG8="]);
        expect(body).toMatchObject({ model, prompt: "测试", images: ["aGVsbG8="], replyType: "json" });
        expect(body).not.toHaveProperty("urls");
    });

    it("GPT 标准模型发送显式像素尺寸，且不带 imageSize", () => {
        const body = grsaiRequestBody(config("gpt-image-2", "16:9", "2k"), "测试", []);
        expect(body.aspectRatio).toBe("2048x1152");
        expect(body).not.toHaveProperty("imageSize");
    });

    it("GPT VIP 模型发送显式像素尺寸", () => {
        const body = grsaiRequestBody(config("gpt-image-2-vip", "16:9", "2k"), "测试", []);
        expect(body.aspectRatio).toBe("2048x1152");
        expect(body).not.toHaveProperty("imageSize");
    });

    it("GPT Image 2.5 标准版只允许 1K，扩展版最高 4K", () => {
        expect(() => grsaiRequestBody(config("gpt-image-2.5", "1:1", "2k"), "测试", [])).toThrow("仅支持 1K");
        expect(grsaiRequestBody(config("gpt-image-2.5-sunburst", "1:1", "4k"), "测试", [])).toMatchObject({ aspectRatio: "2880x2880", quality: "auto" });
        expect(() => grsaiRequestBody(config("gpt-image-2.5-flare", "16:9", "8k"), "测试", [])).toThrow("1K / 2K / 4K");
    });

    it("GPT Image 2.5 将比例转换为像素并提交质量和透明背景", () => {
        const body = grsaiRequestBody({ ...config("gpt-image-2.5-sunburst", "1:1"), quality: "high", background: "transparent" }, "测试", []);
        expect(body).toMatchObject({ aspectRatio: "1024x1024", quality: "high", background: "transparent" });
    });

    it("GPT Image 2.5 的宽屏 1K 与非方形 4K 保持在服务端像素范围内", () => {
        expect(grsaiRequestBody(config("gpt-image-2.5-sunburst", "16:9", "1k"), "测试", [])).toMatchObject({ aspectRatio: "1088x608" });
        expect(grsaiRequestBody(config("gpt-image-2.5-sunburst", "4:3", "4k"), "测试", [])).toMatchObject({ aspectRatio: "3312x2480" });
    });

    it("GPT Image 2.5 在提交前拒绝超出服务端范围的手动像素值", () => {
        expect(() => grsaiRequestBody(config("gpt-image-2.5-sunburst", "1024x576", "1k"), "测试", [])).toThrow("总像素需在 655360 到 8294400 之间");
    });

    it("Nano Banana 模型发送比例和分辨率", () => {
        const body = grsaiRequestBody(config("nano-banana-2", "16:9", "2k"), "测试", []);
        expect(body).toMatchObject({ aspectRatio: "16:9", imageSize: "2K" });
    });
});
