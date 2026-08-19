import { describe, expect, it } from "vitest";

import { cancelCanvasGenerationRun, cancelCanvasGenerationTarget, startCanvasGenerationRequest } from "@/lib/canvas/canvas-generation-requests";

describe("画布生成请求", () => {
    it("取消一个批量槽位不会中断兄弟槽位", () => {
        const requests = new Map();
        const first = startCanvasGenerationRequest(requests, "image-1", "config", "config");
        const second = startCanvasGenerationRequest(requests, "image-2", "config", "config");

        const canceled = cancelCanvasGenerationTarget(requests, "image-1");

        expect(canceled?.targetNodeIds).toEqual(new Set(["image-1"]));
        expect(canceled?.hasRemainingForRun).toBe(true);
        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(false);
        expect(requests.has("image-2")).toBe(true);
    });

    it("停止发起节点会中断整批未完成请求", () => {
        const requests = new Map();
        const first = startCanvasGenerationRequest(requests, "image-1", "config", "config");
        const second = startCanvasGenerationRequest(requests, "image-2", "config", "config");

        const canceled = cancelCanvasGenerationRun(requests, "config");

        expect(canceled?.targetNodeIds).toEqual(new Set(["image-1", "image-2"]));
        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(true);
        expect(requests.size).toBe(0);
    });

    it("取消共享控制器的结果节点会一并清理别名", () => {
        const requests = new Map();
        const controller = new AbortController();
        startCanvasGenerationRequest(requests, "source", "source", "source", controller);
        startCanvasGenerationRequest(requests, "result", "source", "source", controller);

        const canceled = cancelCanvasGenerationTarget(requests, "result");

        expect(canceled?.targetNodeIds).toEqual(new Set(["source", "result"]));
        expect(controller.signal.aborted).toBe(true);
        expect(requests.size).toBe(0);
    });

    it("不会取消不存在或已完成的请求", () => {
        const requests = new Map();

        expect(cancelCanvasGenerationTarget(requests, "missing")).toBeNull();
        expect(cancelCanvasGenerationRun(requests, "missing")).toBeNull();
    });
});
