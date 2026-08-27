// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { REFERENCE_CARET_SENTINEL, insertReferenceChip, removeActiveReferenceMention, serializeReferenceEditor } from "@/components/canvas/contenteditable-reference-utils";

function createReference(label: string) {
    const chip = document.createElement("span");
    chip.dataset.refLabel = label;
    chip.contentEditable = "false";
    chip.textContent = label;
    return chip;
}

function setCaretAtEnd(node: Text) {
    const range = document.createRange();
    range.setStart(node, node.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function insertMention(editor: HTMLElement, query: string, label: string) {
    const typedMention = document.createTextNode(`@${query}`);
    editor.append(typedMention);
    setCaretAtEnd(typedMention);

    expect(removeActiveReferenceMention(editor, "refLabel")).toBe(true);
    insertReferenceChip(editor, createReference(label));
}

describe("contentEditable 引用工具", () => {
    afterEach(() => {
        window.getSelection()?.removeAllRanges();
        document.body.replaceChildren();
    });

    it("连续插入引用时完整替换 @ 查询词，不残留 @", () => {
        const editor = document.createElement("div");
        document.body.append(editor);
        const firstMention = document.createTextNode("前缀@图");
        editor.append(firstMention);
        setCaretAtEnd(firstMention);

        expect(removeActiveReferenceMention(editor, "refLabel")).toBe(true);
        insertReferenceChip(editor, createReference("图片1"));
        insertMention(editor, "文", "文本1");
        insertMention(editor, "", "图片2");

        expect(serializeReferenceEditor(editor, "refLabel")).toBe("前缀图片1文本1图片2");
        expect(editor.textContent).not.toContain("@");
    });

    it("保留文本与既有引用，并按调用方指定格式序列化", () => {
        const editor = document.createElement("div");
        const before = document.createTextNode(`开头${REFERENCE_CARET_SENTINEL}`);
        const after = document.createTextNode(`${REFERENCE_CARET_SENTINEL}结尾`);
        editor.append(before, createReference("图片1"), after);

        expect(serializeReferenceEditor(editor, "refLabel")).toBe("开头图片1结尾");
        expect(serializeReferenceEditor(editor, "refLabel", (label) => `@[node:${label}]`)).toBe("开头@[node:图片1]结尾");
    });
});
