import { describe, expect, it } from "vitest";

import { CAMERA_GROUPS, buildCameraPrompt, normalizeCameraSelection, toggleCameraSelection } from "@/lib/camera";

describe("camera selection", () => {
    const angle = CAMERA_GROUPS.find((group) => group.key === "angle")!;

    it("keeps one option per group and clears it with the same option or 自动", () => {
        expect(toggleCameraSelection({ angle: "正面" }, angle, "俯视")).toEqual({ angle: "俯视" });
        expect(toggleCameraSelection({ angle: "俯视" }, angle, "俯视")).toEqual({});
        expect(toggleCameraSelection({ angle: "俯视" }, angle, "自动")).toEqual({});
    });

    it("normalizes invalid and automatic values away", () => {
        expect(normalizeCameraSelection({ angle: "自动", lens: "广角", position: "不存在" })).toEqual({ lens: "广角" });
    });

    it("adds camera descriptions in the fixed group order without changing the source prompt", () => {
        const prompt = "一位穿红衣的人物";
        expect(buildCameraPrompt(prompt, { lens: "广角", angle: "俯视", position: "高机位" })).toBe("一位穿红衣的人物，俯视，广角，高机位");
        expect(prompt).toBe("一位穿红衣的人物");
    });

    it("does not add automatic or already present independent descriptions twice", () => {
        expect(buildCameraPrompt("人物，广角", { lens: "广角" })).toBe("人物，广角");
        expect(buildCameraPrompt("半身/中景人物", { distance: "中" })).toBe("半身/中景人物，中");
        expect(buildCameraPrompt("人物", { angle: "自动" })).toBe("人物");
    });
});
