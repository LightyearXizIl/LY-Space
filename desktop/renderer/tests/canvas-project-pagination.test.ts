import { describe, expect, it } from "vitest";

import { CANVAS_PROJECTS_PER_PAGE, clampCanvasProjectPage, getCanvasProjectPage, getCanvasProjectPageCount } from "@/lib/canvas/canvas-project-pagination";

describe("画布库分页", () => {
    it("每页固定 15 个项目并正确计算边界页", () => {
        expect(CANVAS_PROJECTS_PER_PAGE).toBe(15);
        expect([0, 1, 15, 16, 30, 31].map(getCanvasProjectPageCount)).toEqual([1, 1, 1, 2, 2, 3]);
    });

    it("页码越界时回到有效页，并保持项目顺序", () => {
        const projects = Array.from({ length: 31 }, (_, index) => ({ id: index + 1 }));
        expect(clampCanvasProjectPage(5, projects.length)).toBe(3);
        expect(clampCanvasProjectPage(3, 30)).toBe(2);
        expect(getCanvasProjectPage(projects, 2).map((project) => project.id)).toEqual(Array.from({ length: 15 }, (_, index) => index + 16));
        expect(getCanvasProjectPage(projects, 3).map((project) => project.id)).toEqual([31]);
    });
});
