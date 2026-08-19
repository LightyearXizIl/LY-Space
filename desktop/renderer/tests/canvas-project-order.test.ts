import { describe, expect, it } from "vitest";

import { reorderCanvasProjects, shouldInsertProjectBefore } from "@/lib/canvas/canvas-project-order";

const projects = ["a", "b", "c", "d"].map((id) => ({ id }));

describe("画布库排序", () => {
    it("支持向前和向后插入", () => {
        expect(reorderCanvasProjects(projects, "d", "b", true).map((project) => project.id)).toEqual(["a", "d", "b", "c"]);
        expect(reorderCanvasProjects(projects, "a", "c", false).map((project) => project.id)).toEqual(["b", "c", "a", "d"]);
    });

    it("跨行目标仍按目标卡片前后插入", () => {
        expect(reorderCanvasProjects(projects, "a", "d", true).map((project) => project.id)).toEqual(["b", "c", "a", "d"]);
        expect(reorderCanvasProjects(projects, "d", "a", false).map((project) => project.id)).toEqual(["a", "d", "b", "c"]);
    });

    it("自身或不存在的落点保持原顺序", () => {
        expect(reorderCanvasProjects(projects, "b", "b", true)).toBe(projects);
        expect(reorderCanvasProjects(projects, "missing", "b", true)).toBe(projects);
    });

    it("只按水平中线确定目标前后", () => {
        const rect = { left: 100, width: 200 } as DOMRect;
        expect(shouldInsertProjectBefore(199, rect)).toBe(true);
        expect(shouldInsertProjectBefore(200, rect)).toBe(false);
    });
});
