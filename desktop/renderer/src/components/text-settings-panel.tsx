import { type ReactNode } from "react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { resolveModelRequestConfig, type AiConfig, type ArkThinkingMode, type ReasoningEffort } from "@/stores/use-config-store";

const reasoningEffortOptions: Array<{ value: ReasoningEffort; label: string }> = [
    { value: "auto", label: "自动" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "极高" },
];
const arkThinkingOptions: Array<{ value: ArkThinkingMode; label: string }> = [
    { value: "auto", label: "自动" },
    { value: "enabled", label: "开启" },
    { value: "disabled", label: "关闭" },
];

type TextSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "reasoningEffort" | "arkThinkingMode", value: ReasoningEffort | ArkThinkingMode) => void;
    theme: CanvasTheme;
    className?: string;
};

export function TextSettingsPanel({ config, onConfigChange, theme, className = "space-y-4" }: TextSettingsPanelProps) {
    const isArk = resolveModelRequestConfig(config, config.model || config.textModel).apiFormat === "ark";
    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                <div className="text-lg font-semibold">文本设置</div>
                <div className="space-y-2.5">
                    <div className="text-sm font-medium" style={{ color: theme.node.muted }}>
                        {isArk ? "方舟思考" : "推理强度"}
                    </div>
                    <div className={`grid gap-2 ${isArk ? "grid-cols-3" : "grid-cols-5"}`}>
                        {(isArk ? arkThinkingOptions : reasoningEffortOptions).map((item) => (
                            <OptionPill key={item.value} selected={isArk ? config.arkThinkingMode === item.value : config.reasoningEffort === item.value} theme={theme} onClick={() => onConfigChange(isArk ? "arkThinkingMode" : "reasoningEffort", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </div>
            </div>
        </ImageSettingsTheme>
    );
}

export function reasoningEffortLabel(value: ReasoningEffort) {
    return reasoningEffortOptions.find((item) => item.value === value)?.label || value;
}

export function arkThinkingModeLabel(value: ArkThinkingMode) {
    return arkThinkingOptions.find((item) => item.value === value)?.label || value;
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}
