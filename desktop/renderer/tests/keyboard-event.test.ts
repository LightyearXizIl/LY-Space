import { describe, expect, it } from "vitest";

import { isImeComposing, isPlainEnterKey } from "@/lib/keyboard-event";

describe("中文输入法键盘事件", () => {
    it("识别组合态、旧式 keyCode=229 与原生组合态", () => {
        expect(isImeComposing({ isComposing: true })).toBe(true);
        expect(isImeComposing({ keyCode: 229 })).toBe(true);
        expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
        expect(isImeComposing({ nativeEvent: { which: 229 } })).toBe(true);
    });

    it("组合中的 Enter 不作为提交快捷键", () => {
        expect(isPlainEnterKey({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(false);
        expect(isPlainEnterKey({ key: "Enter", keyCode: 229 })).toBe(false);
        expect(isPlainEnterKey({ key: "Enter" })).toBe(true);
    });
});
