import React, { useMemo } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, ConnectionSide, Position } from "@/types/canvas";

function pointOnSide(node: CanvasNodeData, side: ConnectionSide) {
    return { x: side === "left" ? node.position.x : node.position.x + node.width, y: node.position.y + node.height / 2 };
}

function connectionPath(start: Position, startSide: ConnectionSide, end: Position, endSide: ConnectionSide) {
    const curvature = Math.max(Math.abs(end.x - start.x) * 0.5, 50);
    const startDirection = startSide === "right" ? 1 : -1;
    const endDirection = endSide === "right" ? 1 : -1;
    return `M ${start.x} ${start.y} C ${start.x + curvature * startDirection} ${start.y}, ${end.x + curvature * endDirection} ${end.y}, ${end.x} ${end.y}`;
}

// memo:pan/缩放/悬停时连线不重渲染(节点引用稳定则 pathD 不变);onSelect/onContextMenu 需传稳定引用
// (以 connectionId 为参数的回调),否则 memo 失效。
export const ConnectionPath = React.memo(function ConnectionPath({
    connection,
    from,
    to,
    active,
    onSelect,
    onContextMenu,
}: {
    connection: CanvasConnection;
    from: CanvasNodeData;
    to: CanvasNodeData;
    active: boolean;
    onSelect: (connectionId: string) => void;
    onContextMenu?: (event: ReactMouseEvent<SVGPathElement>, connectionId: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const pathD = useMemo(() => {
        const start = pointOnSide(from, connection.fromSide || "right");
        const end = pointOnSide(to, connection.toSide || "left");
        return connectionPath(start, connection.fromSide || "right", end, connection.toSide || "left");
    }, [connection.fromSide, connection.toSide, from, to]);

    return (
        <g>
            <path
                data-connection-id={connection.id}
                d={pathD}
                stroke="transparent"
                strokeWidth="16"
                fill="none"
                style={{ cursor: "pointer", pointerEvents: "stroke" }}
                onClick={(event) => {
                    event.stopPropagation();
                    onSelect(connection.id);
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onContextMenu?.(event, connection.id);
                }}
            />
            <path
                d={pathD}
                stroke={active ? theme.node.activeStroke : theme.node.muted}
                strokeWidth={active ? 3 : 2}
                strokeOpacity={active ? 1 : 0.82}
                fill="none"
                style={{ filter: active ? `drop-shadow(0 0 8px ${theme.node.activeStroke}66)` : undefined, pointerEvents: "none" }}
            />
        </g>
    );
});

export function ActiveConnectionPath({ node, handle, mouseWorld, target, targetSide }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position; target?: CanvasNodeData; targetSide?: ConnectionSide }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!node) return null;

    const handleSide: ConnectionSide = handle.handleType === "source" ? "right" : "left";
    const nodePoint = pointOnSide(node, handleSide);
    const targetPoint = target ? pointOnSide(target, targetSide || "left") : mouseWorld;
    const start = handle.handleType === "source" ? nodePoint : targetPoint;
    const end = handle.handleType === "source" ? targetPoint : nodePoint;
    const startSide = handle.handleType === "source" ? handleSide : targetSide || "right";
    const endSide = handle.handleType === "source" ? targetSide || "left" : handleSide;
    const pathD = connectionPath(start, startSide, end, endSide);

    return <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="2" fill="none" strokeDasharray="5,5" />;
}
