import { describe, expect, it } from "vitest";

import { isImeCompositionActive, isImeComposing, isPlainEnterKey, syncControlledTextChange } from "@/lib/keyboard-event";

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

    it("事件未标记组合态时仍尊重本地组合状态", () => {
        expect(isImeCompositionActive({ key: "Enter" }, true)).toBe(true);
        expect(isImeCompositionActive({ key: "ArrowDown" }, false)).toBe(false);
    });

    it("组合态输入仍同步受控值，稳定态副作用随后再处理", () => {
        let value = "";
        const stableValues: string[] = [];
        const change = syncControlledTextChange({ currentTarget: { value: "n" }, nativeEvent: { isComposing: true } }, true, (next) => {
            value = next;
        }, (next) => {
            stableValues.push(next);
        });

        expect(value).toBe("n");
        expect(change).toEqual({ value: "n", isComposing: true });
        expect(stableValues).toEqual([]);

        const committed = syncControlledTextChange({ currentTarget: { value: "你" } }, false, (next) => {
            value = next;
        }, (next) => {
            stableValues.push(next);
        });

        expect(value).toBe("你");
        expect(committed).toEqual({ value: "你", isComposing: false });
        expect(stableValues).toEqual(["你"]);
    });
});
