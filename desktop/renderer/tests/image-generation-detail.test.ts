import { describe, expect, it } from "vitest";

import { buildTransientGenerationLog, createTransientGenerationBatch, findTransientGenerationLog, updateTransientGenerationSlot, type GeneratedImage, type GenerationLogConfig } from "@/pages/image/generation-detail";

const image = (id: string): GeneratedImage => ({ id, dataUrl: `data:image/png;base64,${id}`, durationMs: 10, width: 1, height: 1, bytes: 1 });
const config: GenerationLogConfig = { model: "test", imageModel: "test", quality: "standard", imageResolution: "1k", size: "1:1", count: "2", background: "" };

describe("生图进行中详情", () => {
    it("同批第一张成功时立即返回进行中详情", () => {
        const batch = createTransientGenerationBatch({ id: "batch-a", slotIds: ["slot-a", "slot-b"], prompt: "测试提示词", camera: {}, model: "test", config, references: [], startedAt: 100, createdAt: 1, time: "time" });
        updateTransientGenerationSlot(batch, "slot-a", "success", image("image-a"));

        expect(findTransientGenerationLog([batch].values(), "image-a", 150)).toMatchObject({ id: "batch-a", status: "生成中", successCount: 1, pendingCount: 1, imageCount: 2, images: [image("image-a")] });
    });

    it("并发批次按图片关联，不会串详情", () => {
        const first = createTransientGenerationBatch({ id: "batch-a", slotIds: ["slot-a"], prompt: "第一批", camera: {}, model: "test", config, references: [] });
        const second = createTransientGenerationBatch({ id: "batch-b", slotIds: ["slot-b"], prompt: "第二批", camera: {}, model: "test", config, references: [] });
        updateTransientGenerationSlot(first, "slot-a", "success", image("image-a"));
        updateTransientGenerationSlot(second, "slot-b", "success", image("image-b"));

        expect(findTransientGenerationLog([first, second], "image-b")?.prompt).toBe("第二批");
        expect(buildTransientGenerationLog(first).status).toBe("成功");
    });
});
