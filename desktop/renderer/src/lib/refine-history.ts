import type { RefineAdjustments, RefineFilter, RefineLutState, RefineTransform } from "@/lib/refine-image";

/** 精修编辑状态：裁切与导出参数之外的全部非破坏性编辑 */
export type RefineEditState = { transform: RefineTransform; filter: RefineFilter; adjustments: RefineAdjustments; lut: RefineLutState | null };

/**
 * 撤销/重做历史。history[i] 恒为「第 i+1 个编辑状态的前驱」，historyIndex 指向当前 edits 的前驱；
 * future 为被撤销的状态（按恢复顺序排列），提交新编辑时清空（分支截断）。
 */
export type RefineEditHistory = { history: RefineEditState[]; historyIndex: number; future: RefineEditState[] };

/** 提交新编辑状态：当前状态进入历史链，future 被截断（redo 分支丢弃） */
export function refineCommit(history: RefineEditHistory, current: RefineEditState, next: RefineEditState): RefineEditHistory {
    const pending = [...history.history.slice(0, history.historyIndex + 1), current];
    return { history: pending, historyIndex: pending.length - 1, future: [] };
}

/** 撤销：恢复前驱状态，当前状态进入 future 链头部；返回值可直接作为下一次调用的历史状态；无可撤销时返回 null */
export function refineUndo(history: RefineEditHistory, current: RefineEditState): RefineEditHistory & { edits: RefineEditState } | null {
    if (history.historyIndex < 0) return null;
    return { history: history.history, historyIndex: history.historyIndex - 1, future: [current, ...history.future], edits: history.history[history.historyIndex] };
}

/** 重做：恢复 future 链头部状态；无可重做时返回 null */
export function refineRedo(history: RefineEditHistory): RefineEditHistory & { edits: RefineEditState } | null {
    if (!history.future.length) return null;
    return { history: history.history, historyIndex: history.historyIndex + 1, future: history.future.slice(1), edits: history.future[0] };
}
