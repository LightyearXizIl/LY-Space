import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export function collectNodeDeletionIds(ids: Set<string>, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const allIds = new Set(ids);
    nodes.forEach((node) => {
        if (!ids.has(node.id)) return;
        const connectedChildIds = new Set(connections.filter((connection) => connection.fromNodeId === node.id).map((connection) => connection.toNodeId));
        node.metadata?.batchChildIds?.forEach((childId) => {
            if (connectedChildIds.has(childId)) allIds.add(childId);
        });
    });
    return allIds;
}
