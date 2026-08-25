import { describe, expect, it } from "vitest";

import { cancelCanvasGenerationRun, cancelCanvasGenerationTarget, finishCanvasGenerationRequest, getActiveCanvasGenerationNodeIds, hasCanvasGenerationRun, isCanvasGenerationRequestActive, startCanvasGenerationRequest } from "@/lib/canvas/canvas-generation-requests";

describe("画布生成请求", () => {
    it("取消一个批量槽位不会中断兄弟槽位", () => {
        const requests = new Map();
        const first = startCanvasGenerationRequest(requests, "image-1", "config", "config");
        const second = startCanvasGenerationRequest(requests, "image-2", "config", "config");

        const canceled = cancelCanvasGenerationTarget(requests, "image-1");

        expect(canceled?.targetNodeIds).toEqual(new Set(["image-1"]));
        expect(canceled?.hasRemainingForRun).toBe(true);
        expect(first.controller.signal.aborted).toBe(true);
        expect(second.controller.signal.aborted).toBe(false);
        expect(Array.from(requests.values()).some((request) => request.targetNodeId === "image-2")).toBe(true);
    });

    it("停止发起节点会中断整批未完成请求", () => {
        const requests = new Map();
        const first = startCanvasGenerationRequest(requests, "image-1", "config", "config");
        const second = startCanvasGenerationRequest(requests, "image-2", "config", "config");

        const canceled = cancelCanvasGenerationRun(requests, "config");

        expect(canceled?.targetNodeIds).toEqual(new Set(["image-1", "image-2"]));
        expect(first.controller.signal.aborted).toBe(true);
        expect(second.controller.signal.aborted).toBe(true);
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

    it("同源连续生成可并发，结束一个不会提前移除运行态", () => {
        const requests = new Map();
        const first = startCanvasGenerationRequest(requests, "image-1", "config", "config", new AbortController(), "run-1");
        const second = startCanvasGenerationRequest(requests, "image-2", "config", "config", new AbortController(), "run-2");

        finishCanvasGenerationRequest(requests, first);

        expect(hasCanvasGenerationRun(requests, "config")).toBe(true);
        expect(getActiveCanvasGenerationNodeIds(requests)).toEqual(new Set(["config"]));
        expect(isCanvasGenerationRequestActive(requests, second)).toBe(true);
    });

    it("不同发起节点并发时停止 A 不影响 B", () => {
        const requests = new Map();
        const first = startCanvasGenerationRequest(requests, "image-a", "config-a", "config-a");
        const second = startCanvasGenerationRequest(requests, "image-b", "config-b", "config-b");

        cancelCanvasGenerationRun(requests, "config-a");

        expect(first.controller.signal.aborted).toBe(true);
        expect(second.controller.signal.aborted).toBe(false);
        expect(getActiveCanvasGenerationNodeIds(requests)).toEqual(new Set(["config-b"]));
    });

    it("旧请求结束不会删除后续请求，停止后旧句柄不再拥有写回权", () => {
        const requests = new Map();
        const oldRequest = startCanvasGenerationRequest(requests, "self", "self", "self");
        const newRequest = startCanvasGenerationRequest(requests, "self", "self", "self");

        finishCanvasGenerationRequest(requests, oldRequest);
        expect(isCanvasGenerationRequestActive(requests, newRequest)).toBe(true);

        cancelCanvasGenerationRun(requests, "self");
        expect(isCanvasGenerationRequestActive(requests, newRequest)).toBe(false);
    });
});
