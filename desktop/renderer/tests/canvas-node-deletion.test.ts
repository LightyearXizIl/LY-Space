import { describe, expect, it } from "vitest";

import { collectNodeDeletionIds } from "@/lib/canvas/canvas-node-deletion";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

function node(id: string, metadata?: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 80, metadata };
}

describe("画布节点删除", () => {
    const root = node("root", { isBatchRoot: true, batchChildIds: ["connected", "disconnected"] });
    const nodes = [root, node("connected", { batchRootId: "root" }), node("disconnected", { batchRootId: "root" })];

    it("删除批次根节点时只级联删除仍与其相连的子节点", () => {
        const connections: CanvasConnection[] = [{ id: "root-connected", fromNodeId: "root", toNodeId: "connected" }];
        expect([...collectNodeDeletionIds(new Set(["root"]), nodes, connections)]).toEqual(["root", "connected"]);
    });

    it("已断开连接的子节点不会随上游节点删除", () => {
        expect([...collectNodeDeletionIds(new Set(["root"]), nodes, [])]).toEqual(["root"]);
    });
});
