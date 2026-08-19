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

export function isImeComposing(event: EventLike) {
    const nativeEvent = event.nativeEvent as NativeKeyboardEventLike | undefined;
    return Boolean(event.isComposing || nativeEvent?.isComposing || event.keyCode === 229 || event.which === 229 || nativeEvent?.keyCode === 229 || nativeEvent?.which === 229);
}

export function isPlainEnterKey(event: KeyboardEventLike) {
    return event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !isImeComposing(event);
}
