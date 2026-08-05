import type { CanvasTheme } from "@/lib/canvas-theme";

/**
 * 镜头模块：5 组单选按钮（视角/景别/距离/镜头/机位），每组默认"自动"。
 * 点击选项把描述文本追加到提示词末尾（"，"分隔），再次点击（或点"自动"）移除；
 * 选中态由提示词文本派生：文本中已含该文字时（用户手写/优化残留）不重复插入，仅置选中态。
 */

export type CameraGroupKey = "angle" | "shot" | "distance" | "lens" | "position";

export type CameraGroup = {
    key: CameraGroupKey;
    label: string;
    options: string[];
};

export const CAMERA_GROUPS: CameraGroup[] = [
    { key: "angle", label: "视角", options: ["自动", "正面", "45度", "侧面", "背面", "俯视", "仰视"] },
    { key: "shot", label: "景别", options: ["自动", "特写", "半身/中景", "全身", "产品细节", "场景", "远景"] },
    { key: "distance", label: "距离", options: ["自动", "近", "中", "远"] },
    { key: "lens", label: "镜头", options: ["自动", "广角", "标准", "长焦", "微距"] },
    { key: "position", label: "机位", options: ["自动", "平视", "高机位", "低机位"] },
];

/** 分隔符：中文/英文逗号、顿号、句号、分号、冒号、空白 */
const SEPARATOR = "[，,、。；;：:\\s]";

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 提示词中是否已存在该选项文字（按独立词匹配，避免"中"误配"半身/中景"内的字） */
export function cameraTextPresent(prompt: string, text: string): boolean {
    if (!text) return false;
    return new RegExp(`(^|${SEPARATOR})${escapeRegExp(text)}(?=$|${SEPARATOR})`).test(prompt);
}

/** 把选项文字追加到提示词末尾，自动补"，"分隔 */
export function appendCameraText(prompt: string, text: string): string {
    const trimmed = prompt.trimEnd();
    if (!trimmed) return text;
    if (new RegExp(SEPARATOR + "$").test(trimmed)) return trimmed + text;
    return `${trimmed}，${text}`;
}

/** 从提示词中移除最后出现的该选项文字（含前导分隔符）；不存在则原样返回 */
export function removeCameraText(prompt: string, text: string): string {
    const re = new RegExp(`(^|${SEPARATOR})(${escapeRegExp(text)})(?=$|${SEPARATOR})`, "g");
    let last: RegExpExecArray | null = null;
    let match: RegExpExecArray | null;
    while ((match = re.exec(prompt)) !== null) {
        last = match;
        if (match.index + match[0].length === prompt.length) break;
        re.lastIndex = match.index + 1;
    }
    if (!last) return prompt;
    return (prompt.slice(0, last.index) + prompt.slice(last.index + last[0].length))
        .replace(new RegExp(`^${SEPARATOR}+`), "")
        .trimEnd();
}

type CameraModuleProps = {
    /** 当前提示词文本（受控） */
    value: string;
    /** 更新提示词文本 */
    onChange: (next: string) => void;
    /** 画布场景传入 canvasThemes 主题适配配色；页面场景不传走默认明暗样式 */
    theme?: CanvasTheme;
    /** 是否显示"镜头"标题（画布面板传 false 保持紧凑） */
    showTitle?: boolean;
    className?: string;
};

export function CameraModule({ value, onChange, theme, showTitle = true, className = "" }: CameraModuleProps) {
    // 选中态由 value 派生：文本中含该选项词（独立词）即高亮，外部修改文本（优化回填/手动编辑/切节点）后高亮自动同步
    const isActive = (group: CameraGroup, option: string) =>
        option === "自动" ? !group.options.some((item) => item !== "自动" && cameraTextPresent(value, item)) : cameraTextPresent(value, option);

    const toggleOption = (group: CameraGroup, option: string) => {
        if (option === "自动") {
            // 点"自动"= 移除该组当前已插入的所有选项
            let next = value;
            for (const item of group.options) {
                if (item !== "自动" && cameraTextPresent(next, item)) next = removeCameraText(next, item);
            }
            if (next !== value) onChange(next);
            return;
        }
        if (cameraTextPresent(value, option)) {
            // 再点已插入选项 = 移除
            onChange(removeCameraText(value, option));
            return;
        }
        // 组内单选：先移除同组其它已插入选项，再追加新选项（文本中已含则不重复插入，由追加前检查保证）
        let next = value;
        for (const item of group.options) {
            if (item !== "自动" && item !== option && cameraTextPresent(next, item)) next = removeCameraText(next, item);
        }
        onChange(appendCameraText(next, option));
    };

    return (
        <div className={className}>
            {showTitle ? (
                <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-base font-semibold" style={theme ? { color: theme.node.text } : undefined}>
                        镜头
                    </span>
                </div>
            ) : null}
            <div className="space-y-1.5">
                {CAMERA_GROUPS.map((group) => {
                    return (
                        <div key={group.key} className="flex gap-1.5">
                            <span className="w-8 shrink-0 pt-0.5 text-xs font-medium" style={theme ? { color: theme.node.muted } : undefined}>
                                {group.label}
                            </span>
                            <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                                {group.options.map((option) => {
                                    const active = isActive(group, option);
                                    return (
                                        <button
                                            key={option}
                                            type="button"
                                            className={`rounded-md border px-2.5 py-1 text-xs leading-4 transition-colors ${
                                                theme
                                                    ? ""
                                                    : active
                                                      ? "border-stone-900 bg-stone-100 text-stone-900 dark:border-stone-100 dark:bg-stone-800 dark:text-stone-100"
                                                      : "border-stone-300 bg-white/70 text-stone-600 hover:border-stone-400 hover:text-stone-900 dark:border-stone-700 dark:bg-stone-900/70 dark:text-stone-400 dark:hover:border-stone-600 dark:hover:text-stone-200"
                                            }`}
                                            style={
                                                theme
                                                    ? active
                                                        ? { background: theme.toolbar.activeBg, borderColor: theme.node.activeStroke, color: theme.toolbar.activeText }
                                                        : { background: "transparent", borderColor: theme.node.stroke, color: theme.node.text }
                                                    : undefined
                                            }
                                            onClick={() => toggleOption(group, option)}
                                        >
                                            {option}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="mt-1.5 text-xs text-stone-400 dark:text-stone-500" style={theme ? { color: theme.node.placeholder } : undefined}>
                点击按钮将镜头描述插入提示词，再次点击可移除
            </div>
        </div>
    );
}
