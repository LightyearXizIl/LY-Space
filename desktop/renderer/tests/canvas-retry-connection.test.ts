import { describe, expect, it } from "vitest";

import { failedBatchChildren } from "@/lib/canvas/canvas-generation-helpers";
import { getConnectionTargetAnchor, nearestConnectionSide, normalizeConnection } from "@/lib/canvas/canvas-node-geometry";
import { readUpstreamError } from "@/services/api/error-message";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function node(id: string, x: number, status?: "success" | "error"): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x, y: 0 }, width: 100, height: 80, metadata: status ? { status } : undefined };
}

describe("画布批量重试", () => {
    it("只选择失败子图，保留成功子图", () => {
        const root = { ...node("root", 0), metadata: { isBatchRoot: true, batchChildIds: ["ok", "failed"] } };
        expect(failedBatchChildren(root, [root, node("ok", 120, "success"), node("failed", 240, "error")]).map((item) => item.id)).toEqual(["failed"]);
    });
});

describe("画布连线侧边", () => {
    it("新连接保留松手侧边，反向从左侧开始时仍保留数据方向", () => {
        const first = node("first", 200);
        const second = node("second", 0);
        expect(normalizeConnection("first", "second", [first, second], "source", "right")).toMatchObject({ fromNodeId: "first", toNodeId: "second", fromSide: "right", toSide: "right" });
        expect(normalizeConnection("first", "second", [first, second], "target", "left")).toMatchObject({ fromNodeId: "second", toNodeId: "first", fromSide: "left", toSide: "left" });
    });

    it("按鼠标位置选择最近侧边，旧连线仍可使用原有默认值", () => {
        const target = node("target", 100);
        expect(nearestConnectionSide(target, 110)).toBe("left");
        expect(nearestConnectionSide(target, 190)).toBe("right");
        expect(getConnectionTargetAnchor(target, { nodeId: "source", handleType: "source" })).toMatchObject({ x: 100, y: 40 });
    });
});

describe("上游错误正文", () => {
    it("优先保留嵌套的真实错误，不用通用 msg 覆盖", () => {
        expect(readUpstreamError({ msg: "GRS AI 图片生成失败", error: { message: "额度不足" } })).toBe("额度不足");
        expect(readUpstreamError("上游原始文本")).toBe("上游原始文本");
    });
});
