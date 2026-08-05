import { Aperture } from "lucide-react";
import { Button, Popover } from "antd";

import { CameraModule } from "@/components/camera-module";

/**
 * 页面场景（生图/视频工作台）镜头按钮：按钮 + 点击展开 popover。
 * 内容复用 CameraModule（默认明暗样式），点击选项把描述插入提示词。
 */

type CameraTriggerProps = {
    /** 当前提示词文本（受控） */
    value: string;
    /** 更新提示词文本 */
    onChange: (next: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
};

export function CameraTrigger({ value, onChange, buttonClassName, placement = "bottomRight" }: CameraTriggerProps) {
    return (
        <Popover
            trigger="click"
            placement={placement}
            arrow={false}
            content={<CameraModule value={value} onChange={onChange} className="w-72" />}
        >
            <Button icon={<Aperture className="size-3.5" />} className={buttonClassName || "!h-8 !px-3"}>
                镜头
            </Button>
        </Popover>
    );
}
