import { useEffect, useState } from "react";
import { Modal } from "antd";
import { Maximize2, RotateCcw } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

/**
 * 图片详情预览：双击/工具栏/侧栏放大预览入口共用。
 * 鼠标滚轮直接放大缩小（0.2x–5x），底部显示缩放比例与重置按钮。
 */

type CanvasImagePreviewModalProps = {
    node: CanvasNodeData | null;
    open: boolean;
    onClose: () => void;
};

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

export function CanvasImagePreviewModal({ node, open, onClose }: CanvasImagePreviewModalProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [scale, setScale] = useState(1);

    useEffect(() => {
        if (open) setScale(1);
    }, [node?.id, open]);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        event.preventDefault();
        setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * (event.deltaY < 0 ? 1.1 : 0.9))));
    };

    return (
        <Modal
            title="图片详情"
            open={open && Boolean(node?.metadata?.content)}
            centered
            onCancel={onClose}
            footer={null}
            width="auto"
            styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh", overflow: "hidden" } }}
        >
            {node?.metadata?.content ? (
                <div className="relative" onWheel={handleWheel}>
                    <img
                        src={node.metadata.content}
                        alt={node.title || "图片"}
                        draggable={false}
                        style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain", transform: `scale(${scale})`, transformOrigin: "center center", transition: "transform 80ms ease-out", display: "block" }}
                    />
                    <div
                        className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs shadow-md"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                    >
                        <span className="min-w-14 text-center">{Math.round(scale * 100)}%</span>
                        <button
                            type="button"
                            title="重置缩放"
                            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-full transition-colors hover:opacity-70"
                            onClick={() => setScale(1)}
                        >
                            <RotateCcw className="size-3.5" />
                        </button>
                        <button
                            type="button"
                            title="放大"
                            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-full transition-colors hover:opacity-70"
                            onClick={() => setScale((current) => Math.min(MAX_SCALE, current * 1.25))}
                        >
                            <Maximize2 className="size-3.5" />
                        </button>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
