/**
 * contentEditable 里的不可编辑引用需要稳定的文本锚点。不能把 textarea 的
 * value/selectionStart 逻辑套进来：浏览器会把 chip 当作一个原子 DOM 节点。
 */
export const REFERENCE_CARET_SENTINEL = "\uFEFF";

export function appendReferenceChip(editor: HTMLElement, chip: HTMLElement) {
    editor.append(document.createTextNode(REFERENCE_CARET_SENTINEL), chip, document.createTextNode(REFERENCE_CARET_SENTINEL));
}

export function insertReferenceChip(editor: HTMLElement, chip: HTMLElement) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const before = document.createTextNode(REFERENCE_CARET_SENTINEL);
    const after = document.createTextNode(REFERENCE_CARET_SENTINEL);
    if (range && editor.contains(range.startContainer)) {
        range.insertNode(after);
        range.insertNode(chip);
        range.insertNode(before);
        range.setStart(after, after.length);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
    }
    editor.append(before, chip, after);
    setCaret(after, after.length);
}

export function serializeReferenceEditor(editor: HTMLElement, referenceKey: string, formatReference: (value: string) => string = (value) => value) {
    return serializeNodes(editor.childNodes, referenceKey, formatReference);
}

function serializeNodes(nodes: NodeListOf<ChildNode> | ChildNode[], referenceKey: string, formatReference: (value: string) => string = (value) => value): string {
    let result = "";
    Array.from(nodes).forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            result += (node.textContent || "").replaceAll(REFERENCE_CARET_SENTINEL, "");
            return;
        }
        if (!(node instanceof HTMLElement)) return;
        const reference = node.dataset[referenceKey];
        if (reference) result += formatReference(reference);
        else if (node.tagName === "BR") result += "\n";
        else result += serializeNodes(node.childNodes, referenceKey, formatReference);
    });
    return result;
}

export function textBeforeReferenceCaret(editor: HTMLElement, referenceKey: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return "";
    const current = selection.getRangeAt(0);
    if (!editor.contains(current.startContainer)) return "";
    const before = current.cloneRange();
    before.selectNodeContents(editor);
    before.setEnd(current.startContainer, current.startOffset);
    // 引用 chip 在 DOM 光标偏移中只占一个节点位置；这里也必须按一个逻辑字符计算，
    // 不能使用其完整序列化内容，否则连续引用时删除 @ 查询词会发生偏移错位。
    return serializeNodes(before.cloneContents().childNodes, referenceKey, () => "\uFFFC");
}

/** 删除 caret 前连续的 @query；逻辑偏移而非 Range.startOffset，避免删到 chip。 */
export function removeActiveReferenceMention(editor: HTMLElement, referenceKey: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const current = selection.getRangeAt(0);
    if (!editor.contains(current.startContainer)) return false;
    const text = textBeforeReferenceCaret(editor, referenceKey);
    const match = /@([^\s@\uFFFC]*)$/.exec(text);
    if (!match) return false;
    const start = rangeAtLogicalOffset(editor, text.length - match[0].length, referenceKey);
    if (!start) return false;
    start.setEnd(current.startContainer, current.startOffset);
    start.deleteContents();
    start.collapse(true);
    selection.removeAllRanges();
    selection.addRange(start);
    return true;
}

export function deleteAdjacentReference(editor: HTMLElement, key: "Backspace" | "Delete", referenceKey: string) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return false;
    const target = adjacentReferenceNode(range, key, referenceKey);
    if (!target) return false;
    const caret = document.createTextNode(REFERENCE_CARET_SENTINEL);
    target.replaceWith(caret);
    setCaret(caret, caret.length);
    return true;
}

function adjacentReferenceNode(range: Range, key: "Backspace" | "Delete", referenceKey: string) {
    const previous = key === "Backspace";
    const container = range.startContainer;
    const offset = range.startOffset;
    if (container.nodeType === Node.TEXT_NODE) {
        const text = container.textContent || "";
        if ((previous && offset > 0 && text.slice(0, offset).replaceAll(REFERENCE_CARET_SENTINEL, "").length > 0)
            || (!previous && offset < text.length && text.slice(offset).replaceAll(REFERENCE_CARET_SENTINEL, "").length > 0)) return null;
        return findReferenceSibling(container, previous, referenceKey);
    }
    const children = Array.from(container.childNodes);
    return findReferenceSibling(children[previous ? offset - 1 : offset] || container, previous, referenceKey, true);
}

function findReferenceSibling(node: Node, previous: boolean, referenceKey: string, includeSelf = false): HTMLElement | null {
    let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
    while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent || "").replaceAll(REFERENCE_CARET_SENTINEL, "").trim()) current = previous ? current.previousSibling : current.nextSibling;
    return current instanceof HTMLElement && current.dataset[referenceKey] ? current : null;
}

function rangeAtLogicalOffset(editor: HTMLElement, target: number, referenceKey: string) {
    const range = document.createRange();
    let logicalOffset = 0;
    let found = false;
    const visit = (node: Node): boolean => {
        if (node.nodeType === Node.TEXT_NODE) {
            const value = node.textContent || "";
            const visibleLength = value.replaceAll(REFERENCE_CARET_SENTINEL, "").length;
            if (target >= logicalOffset && target <= logicalOffset + visibleLength) {
                const wanted = target - logicalOffset;
                let visible = 0;
                let source = 0;
                while (source < value.length && visible < wanted) {
                    if (value[source] !== REFERENCE_CARET_SENTINEL) visible += 1;
                    source += 1;
                }
                range.setStart(node, source);
                found = true;
                return true;
            }
            logicalOffset += visibleLength;
            return false;
        }
        if (!(node instanceof HTMLElement)) return false;
        const isReference = Boolean(node.dataset[referenceKey]);
        const isBreak = node.tagName === "BR";
        if (isReference || isBreak) {
            if (target === logicalOffset) {
                range.setStartBefore(node);
                found = true;
                return true;
            }
            logicalOffset += 1;
            if (target === logicalOffset) {
                range.setStartAfter(node);
                found = true;
                return true;
            }
            return false;
        }
        return Array.from(node.childNodes).some(visit);
    };
    Array.from(editor.childNodes).some(visit);
    if (!found && target === logicalOffset) {
        range.selectNodeContents(editor);
        range.collapse(false);
        found = true;
    }
    return found ? range : null;
}

export function caretRect(editor: HTMLElement): DOMRect | null {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0).cloneRange();
    if (!editor.contains(range.startContainer)) return null;
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    return rect.width || rect.height || rect.left || rect.top ? rect : editor.getBoundingClientRect();
}

export function placeCaretAtEnd(editor: HTMLElement) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function setCaret(node: Text, offset: number) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
}
