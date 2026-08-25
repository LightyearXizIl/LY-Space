type NativeKeyboardEventLike = {
    isComposing?: boolean;
    keyCode?: number;
    which?: number;
};

type EventLike = NativeKeyboardEventLike & {
    nativeEvent?: Event | NativeKeyboardEventLike;
};

type KeyboardEventLike = EventLike & {
    key?: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
};

type ControlledTextChangeEventLike = EventLike & {
    currentTarget: {
        value: string;
    };
};

export function isImeComposing(event: EventLike) {
    const nativeEvent = event.nativeEvent as NativeKeyboardEventLike | undefined;
    return Boolean(event.isComposing || nativeEvent?.isComposing || event.keyCode === 229 || event.which === 229 || nativeEvent?.keyCode === 229 || nativeEvent?.which === 229);
}

/** React 本地组合态是事件标记缺失时的兜底，优先保障候选键不被快捷键抢走。 */
export function isImeCompositionActive(event: KeyboardEventLike, localComposing = false) {
    return localComposing || isImeComposing(event);
}

export function isPlainEnterKey(event: KeyboardEventLike) {
    return event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !isImeComposing(event);
}

// 受控输入在组合态也必须同步 value，否则 React 会把 DOM 恢复为旧值而打断拼音输入。
// 引用匹配、提交等稳定态副作用只在候选词确认后执行。
export function syncControlledTextChange(event: ControlledTextChangeEventLike, composing: boolean, onChange: (value: string) => void, onStableChange: (value: string) => void) {
    const value = event.currentTarget.value;
    onChange(value);
    const isComposingNow = composing || isImeComposing(event);
    if (!isComposingNow) onStableChange(value);
    return { value, isComposing: isComposingNow };
}
