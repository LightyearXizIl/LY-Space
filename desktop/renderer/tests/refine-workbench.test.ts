import { describe, expect, it } from "vitest";

import { absoluteViewportScale, actualPixelZoom, fitImageToViewport } from "@/components/canvas/use-image-editor-viewport";
import { defaultRefineAdjustments, defaultRefineTransform, validateRefineSource } from "@/lib/refine-image";
import { refineCommit, refineRedo, refineUndo, type RefineEditState } from "@/lib/refine-history";

const edit = (mark: number): RefineEditState => ({ transform: { ...defaultRefineTransform, rotation: mark }, filter: "original", adjustments: { ...defaultRefineAdjustments }, lut: null });

describe("精修视口计算", () => {
    it("横图与竖图按可用空间（含边距）适应，默认不放大小图", () => {
        const landscape = fitImageToViewport({ width: 2000, height: 1000 }, { width: 400, height: 300 });
        expect(landscape).toEqual({ width: 368, height: 184 });

        const portrait = fitImageToViewport({ width: 1000, height: 2000 }, { width: 400, height: 300 });
        expect(portrait).toEqual({ width: 134, height: 268 });

        const tiny = fitImageToViewport({ width: 100, height: 50 }, { width: 400, height: 300 });
        expect(tiny).toEqual({ width: 100, height: 50 });
    });

    it("fitUpscale 时小图放大铺满视口", () => {
        const upscaled = fitImageToViewport({ width: 100, height: 50 }, { width: 400, height: 300 }, true);
        expect(upscaled).toEqual({ width: 368, height: 184 });
    });

    it("实际像素 1:1 的相对倍率与绝对像素比例换算互为逆运算", () => {
        const base = fitImageToViewport({ width: 2000, height: 1000 }, { width: 400, height: 300 }, true);
        const oneToOne = actualPixelZoom(base, { width: 2000, height: 1000 });
        expect(oneToOne).toBeCloseTo(2000 / base.width);

        // 1:1 缩放下的绝对比例恒为 1，缩放两倍后为 2
        expect(absoluteViewportScale(base, oneToOne, { width: 2000, height: 1000 })).toBeCloseTo(1);
        expect(absoluteViewportScale(base, oneToOne * 2, { width: 2000, height: 1000 })).toBeCloseTo(2);
    });

    it("视口或图片缺失时返回安全兜底值", () => {
        expect(fitImageToViewport(null, { width: 400, height: 300 })).toEqual({ width: 0, height: 0 });
        expect(fitImageToViewport({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({ width: 0, height: 0 });
        expect(actualPixelZoom({ width: 0, height: 0 }, { width: 100, height: 100 })).toBe(1);
        expect(absoluteViewportScale({ width: 0, height: 0 }, 1, { width: 100, height: 100 })).toBe(0);
    });
});

describe("精修编辑历史（撤销/重做/分支截断）", () => {
    it("连续提交后逐级撤销回到初始状态", () => {
        let state = { history: [] as RefineEditState[], historyIndex: -1, future: [] as RefineEditState[] };
        let current = edit(0);
        for (const mark of [1, 2, 3]) {
            state = refineCommit(state, current, edit(mark));
            current = edit(mark);
        }
        expect(state.history).toHaveLength(3);
        expect(state.future).toHaveLength(0);

        const undo3 = refineUndo(state, current)!;
        expect(undo3.edits.transform.rotation).toBe(2);
        const undo2 = refineUndo(undo3, undo3.edits)!;
        expect(undo2.edits.transform.rotation).toBe(1);
        const undo1 = refineUndo(undo2, undo2.edits)!;
        expect(undo1.edits.transform.rotation).toBe(0);
        expect(refineUndo(undo1, undo1.edits)).toBeNull();
    });

    it("撤销后可以重做，往返一致", () => {
        let state = { history: [] as RefineEditState[], historyIndex: -1, future: [] as RefineEditState[] };
        let current = edit(0);
        for (const mark of [1, 2]) {
            state = refineCommit(state, current, edit(mark));
            current = edit(mark);
        }
        const undone = refineUndo(refineUndo(state, current)!, refineUndo(state, current)!.edits)!;
        expect(undone.edits.transform.rotation).toBe(0);
        expect(undone.future.map((item) => item.transform.rotation)).toEqual([1, 2]);

        const redone = refineRedo(undone)!;
        expect(redone.edits.transform.rotation).toBe(1);
        const redone2 = refineRedo(redone)!;
        expect(redone2.edits.transform.rotation).toBe(2);
        expect(refineRedo(redone2)).toBeNull();
    });

    it("撤销后提交新编辑会清空 redo 分支", () => {
        let state = { history: [] as RefineEditState[], historyIndex: -1, future: [] as RefineEditState[] };
        let current = edit(0);
        for (const mark of [1, 2]) {
            state = refineCommit(state, current, edit(mark));
            current = edit(mark);
        }
        const undoStep = refineUndo(state, current)!;
        state = undoStep;
        current = undoStep.edits;

        state = refineCommit(state, current, edit(9));
        current = edit(9);
        expect(state.future).toHaveLength(0);
        expect(state.history.map((item) => item.transform.rotation)).toEqual([0, 1]);
        expect(state.historyIndex).toBe(1);

        // 新分支上撤销一步应回到编辑 1，而不是被截断的编辑 2
        const undoNewBranch = refineUndo(state, current)!;
        expect(undoNewBranch.edits.transform.rotation).toBe(1);
    });

    it("旧会话草稿（无 future 字段）可直接恢复且不可重做", () => {
        // 旧版本会话：history 为已提交状态链、historyIndex 指向当前 edits 的前驱、无 future
        const legacy = { history: [edit(0), edit(1)], historyIndex: 1, future: [] as RefineEditState[] };
        expect(refineRedo(legacy)).toBeNull();
        const undoStep = refineUndo(legacy, edit(2))!;
        expect(undoStep.edits.transform.rotation).toBe(1);
        expect(undoStep.future.map((item) => item.transform.rotation)).toEqual([2]);
    });
});

describe("精修图片来源校验", () => {
    it("仅允许 JPG/PNG/WebP 且不超过 50MB", () => {
        const png = new File([new Uint8Array(8)], "a.png", { type: "image/png" });
        const jpg = new File([new Uint8Array(8)], "a.jpg", { type: "image/jpeg" });
        const gif = new File([new Uint8Array(8)], "a.gif", { type: "image/gif" });
        expect(validateRefineSource(png)).toBeNull();
        expect(validateRefineSource(jpg)).toBeNull();
        expect(validateRefineSource(gif)).toBe("仅支持 JPG、PNG、WebP 格式图片");
        expect(validateRefineSource("data:image/png;base64,xxx")).toBeNull();

        const oversized = new File([new Uint8Array(8)], "a.png", { type: "image/png" });
        Object.defineProperty(oversized, "size", { value: 50 * 1024 * 1024 + 1 });
        expect(validateRefineSource(oversized)).toBe("图片不能超过 50MB");
    });
});
