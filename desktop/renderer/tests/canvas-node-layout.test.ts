import { describe, expect, it } from "vitest";
import { positionNodeToRightOf } from "@/lib/canvas/canvas-node-geometry";

describe("canvas generation node layout", () => {
    it("uses the source node's actual size when placing a generated node to its right", () => {
        const source = {
            position: { x: 100, y: 200 },
            width: 520,
            height: 530,
        };

        const position = positionNodeToRightOf(source, { width: 340, height: 240 });

        expect(position).toEqual({ x: 716, y: 345 });
        expect(position.x).toBeGreaterThan(source.position.x + source.width);
    });
});
