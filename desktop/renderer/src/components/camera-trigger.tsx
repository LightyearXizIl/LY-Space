import { Aperture } from "lucide-react";
import { Popover } from "antd";

import { CameraModule } from "@/components/camera-module";
import type { CameraSelection } from "@/lib/camera";
import { cn } from "@/lib/utils";

/**
 * 页面场景（生图/视频工作台）镜头按钮：按钮 + 点击展开 popover。
 * 内容复用 CameraModule（默认明暗样式），镜头选择在生成时随请求发送。
 */

type CameraTriggerProps = {
    selection?: CameraSelection;
    onSelectionChange: (next: CameraSelection) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CameraTrigger({ selection, onSelectionChange, buttonClassName, placement = "bottomRight" }: CameraTriggerProps) {
    return (
        <Popover
            trigger="click"
            placement={placement}
            arrow={false}
            content={<CameraModule selection={selection} onSelectionChange={onSelectionChange} className="w-72" />}
        >
            <button
                type="button"
                className={cn(
                    "flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors hover:bg-black/5 hover:text-stone-900 dark:hover:bg-white/10 dark:hover:text-stone-100",
                    buttonClassName,
                )}
            >
                <Aperture className="size-3.5 shrink-0 opacity-70" />
                镜头
            </button>
        </Popover>
    );
}
