import type { CanvasTheme } from "@/lib/canvas-theme";
import { CAMERA_GROUPS, toggleCameraSelection, type CameraSelection } from "@/lib/camera";

/**
 * 镜头模块：5 组单选按钮（视角/景别/距离/镜头/机位），每组默认"自动"。
 * 选择状态独立于提示词保存，生成请求发出前才把描述附加到实际 prompt。
 */

type CameraModuleProps = {
    selection?: CameraSelection;
    onSelectionChange: (next: CameraSelection) => void;
    /** 画布场景传入 canvasThemes 主题适配配色；页面场景不传走默认明暗样式 */
    theme?: CanvasTheme;
    /** 是否显示"镜头"标题（画布面板传 false 保持紧凑） */
    showTitle?: boolean;
    className?: string;
};

export function CameraModule({ selection, onSelectionChange, theme, showTitle = true, className = "" }: CameraModuleProps) {
    const isActive = (group: (typeof CAMERA_GROUPS)[number], option: string) => (option === "自动" ? !selection?.[group.key] : selection?.[group.key] === option);

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
                                            onClick={() => onSelectionChange(toggleCameraSelection(selection, group, option))}
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
                生成时随提示词发送，再次点击可移除
            </div>
        </div>
    );
}
