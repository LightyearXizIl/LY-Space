import { useEffect, useState, type ChangeEvent } from "react";

// 输入框本地草稿 + 失焦提交:避免每键同步全局 store(触发全量 persist 序列化与订阅者重渲染)。
// value 为受控来源(如 config 字段);外部变化(导入配置/回显)时自动同步草稿。
// 用法:<Input value={draft.value} onChange={draft.onChange} onBlur={() => commit(draft.value)} />
export function useDraftInput(value: string | number) {
    const [draft, setDraft] = useState(() => String(value));
    useEffect(() => setDraft(String(value)), [value]);
    return {
        value: draft,
        onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
    };
}
