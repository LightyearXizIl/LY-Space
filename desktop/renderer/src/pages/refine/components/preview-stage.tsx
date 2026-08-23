import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";
import { ClipboardPaste, Columns2, ImageDown, ImagePlus, Maximize2, ZoomIn, ZoomOut } from "lucide-react";

import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";
import { cropPixelSize, renderRefinedImage, type RefineCropRect, type RefineSourceImage, type RefineTransform } from "@/lib/refine-image";
import { formatBytes } from "@/lib/image-utils";

type PreviewStageProps = {
    source: RefineSourceImage | null;
    previewUrl: string;
    crop: RefineCropRect;
    transform: RefineTransform;
    onPickFile: () => void;
    onFiles: (files: FileList | null) => void;
};

/**
 * 精修预览工作区：滚轮围绕指针缩放（按图片实际像素显示比例，上限 800%）、按钮缩放、适应窗口、
 * 实际像素 1:1、左键拖动平移、中键平移与空格临时抓手；「原图」临时查看未应用滤镜/调色/LUT 的图像，
 * 「对比」提供可拖动分割线（键盘可调）的原图/效果图分屏。视图状态不写入会话草稿。
 */
export function RefinePreviewStage({ source, previewUrl, crop, transform, onPickFile, onFiles }: PreviewStageProps) {
    const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
    const [dragActive, setDragActive] = useState(false);
    const [showOriginal, setShowOriginal] = useState(false);
    const [compare, setCompare] = useState(false);
    const [compareRatio, setCompareRatio] = useState(0.5);
    const [originalUrl, setOriginalUrl] = useState("");
    const mediaRef = useRef<HTMLDivElement>(null);
    const viewport = useImageEditorViewport(imageSize, Boolean(source), { fitUpscale: true, maxAbsoluteScale: 8 });

    // 需要原图时按「相同裁切与几何变换、不应用滤镜/调色/LUT」渲染一版；关闭时释放
    const needOriginal = Boolean(source) && (showOriginal || compare);
    useEffect(() => {
        if (!needOriginal || !source) {
            setOriginalUrl("");
            return;
        }
        let active = true;
        let url = "";
        void renderRefinedImage(source.dataUrl, source, crop, cropPixelSize(source, crop), "png", .92, { transform }).then((blob) => {
            if (!active) return;
            url = URL.createObjectURL(blob);
            setOriginalUrl(url);
        }).catch(() => active && setOriginalUrl(""));
        return () => {
            active = false;
            if (url) URL.revokeObjectURL(url);
        };
    }, [crop, needOriginal, source, transform]);

    const handleImageLoad = (event: SyntheticEvent<HTMLImageElement>) => {
        const image = event.currentTarget;
        setImageSize((current) => (current?.width === image.naturalWidth && current?.height === image.naturalHeight ? current : { width: image.naturalWidth, height: image.naturalHeight }));
    };

    // Escape 关闭原图/对比临时视图（预览区聚焦时）
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Escape" || (!showOriginal && !compare)) return;
        event.preventDefault();
        setShowOriginal(false);
        setCompare(false);
    };

    const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragActive(true);
    };
    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragActive(false);
        onFiles(event.dataTransfer.files);
    };

    // 拖动对比分割线：按指针在图片内的水平比例更新（键盘经 role=slider 的方向键调节）
    const startCompareDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const stage = mediaRef.current?.parentElement;
        if (!stage) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const update = (clientX: number) => {
            const rect = stage.getBoundingClientRect();
            setCompareRatio(Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))));
        };
        update(event.clientX);
        const move = (moveEvent: PointerEvent) => update(moveEvent.clientX);
        const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
    };
    const nudgeCompare = (direction: number) => setCompareRatio((current) => Math.min(1, Math.max(0, current + direction * 0.02)));

    const displayUrl = showOriginal && originalUrl ? originalUrl : previewUrl;
    const absoluteScale = viewport.imageScale;

    return (
        <div
            className={`relative flex min-h-[420px] flex-1 items-center justify-center overflow-hidden rounded-lg border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-stone-400 lg:min-h-0 ${dragActive ? "border-stone-900 bg-stone-100 dark:border-stone-100 dark:bg-stone-900" : "border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-900"}`}
            onDragOver={handleDragOver}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            aria-label="精修预览区"
        >
            {source ? (
                <>
                    <div ref={viewport.viewportRef} {...viewport.panHandlers} className={`size-full ${viewport.scrollClassName} ${viewport.isPanning ? "cursor-grabbing" : viewport.spacePressed ? "cursor-grab" : ""}`}>
                        <div className="relative" style={viewport.contentStyle}>
                            <div style={viewport.stageStyle} className="absolute select-none">
                                <div ref={mediaRef} className="relative overflow-hidden" style={viewport.mediaStyle}>
                                    {compare && originalUrl ? (
                                        <>
                                            <img src={originalUrl} alt="原图" draggable={false} className="pointer-events-none absolute inset-0 size-full object-contain" />
                                            <img src={previewUrl} alt="效果图" draggable={false} className="pointer-events-none absolute inset-0 size-full object-contain" style={{ clipPath: `inset(0 0 0 ${compareRatio * 100}%)` }} />
                                        </>
                                    ) : (
                                        <img src={displayUrl} alt={source.name} draggable={false} onLoad={handleImageLoad} className="pointer-events-none block size-full object-contain" />
                                    )}
                                </div>
                                {compare && originalUrl ? (
                                    <>
                                        <div className="pointer-events-none absolute inset-y-0 w-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,.35)]" style={{ left: `${compareRatio * 100}%` }} />
                                        <div
                                            role="slider"
                                            tabIndex={0}
                                            aria-label="对比分割线位置"
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                            aria-valuenow={Math.round(compareRatio * 100)}
                                            className="absolute top-1/2 z-10 flex size-6 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-stone-300 bg-white text-stone-700 shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-200"
                                            style={{ left: `${compareRatio * 100}%` }}
                                            onPointerDown={startCompareDrag}
                                            onKeyDown={(event) => {
                                                if (event.key === "ArrowLeft") {
                                                    event.preventDefault();
                                                    nudgeCompare(-1);
                                                } else if (event.key === "ArrowRight") {
                                                    event.preventDefault();
                                                    nudgeCompare(1);
                                                }
                                            }}
                                        >
                                            <Columns2 className="size-3.5" />
                                        </div>
                                    </>
                                ) : null}
                                {(compare || showOriginal) && originalUrl ? (
                                    <span className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-black/55 px-1.5 py-0.5 text-xs text-white">{compare ? "左：原图 / 右：效果图" : "原图"}</span>
                                ) : null}
                            </div>
                        </div>
                    </div>
                    <div className="pointer-events-none absolute left-3 top-3 flex gap-2 text-xs">
                        <span className="rounded bg-black/55 px-2 py-0.5 text-white">{source.width} × {source.height}</span>
                        <span className="rounded bg-black/55 px-2 py-0.5 text-white">{formatBytes(source.bytes)}</span>
                    </div>
                    <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-stone-200 bg-white/95 px-2 py-1 text-xs text-stone-700 shadow-md dark:border-stone-700 dark:bg-stone-900/95 dark:text-stone-200">
                        <StageButton title="缩小" disabled={!viewport.canZoomOut} onClick={viewport.zoomOut} ariaLabel="缩小预览"><ZoomOut className="size-3.5" /></StageButton>
                        <span className="min-w-12 text-center tabular-nums">{absoluteScale > 0 ? `${Math.round(absoluteScale * 100)}%` : "--"}</span>
                        <StageButton title="放大" disabled={!viewport.canZoomIn} onClick={viewport.zoomIn} ariaLabel="放大预览"><ZoomIn className="size-3.5" /></StageButton>
                        <StageButton title="适应窗口" disabled={!source} onClick={viewport.resetZoom}><Maximize2 className="mr-1 size-3.5" />适应</StageButton>
                        <StageButton title="按图片实际像素 1:1 显示" disabled={!source} onClick={viewport.zoomToActualPixel}>1:1</StageButton>
                        <span className="mx-1 h-4 w-px bg-stone-200 dark:bg-stone-700" />
                        <StageButton title="临时查看未应用滤镜/调色/LUT 的原图" active={showOriginal} disabled={!source} onClick={() => { setShowOriginal((current) => !current); setCompare(false); }}><ImageDown className="mr-1 size-3.5" />原图</StageButton>
                        <StageButton title="原图与效果图分屏对比" active={compare} disabled={!source} onClick={() => { setCompare((current) => !current); setShowOriginal(false); }}><Columns2 className="mr-1 size-3.5" />对比</StageButton>
                    </div>
                </>
            ) : (
                <button type="button" className="flex cursor-pointer flex-col items-center gap-3 rounded-lg p-8 text-stone-500 transition-colors hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200" onClick={onPickFile}>
                    <ImagePlus className="size-10" />
                    <span className="text-base">拖入图片或点击上传</span>
                    <span className="text-xs">支持 JPG / PNG / WebP · 最大 50MB</span>
                    <span className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-stone-200 px-3 py-1 text-xs dark:border-stone-700"><ClipboardPaste className="size-3.5" />或按 Ctrl+V 粘贴图片</span>
                </button>
            )}
        </div>
    );
}

function StageButton({ title, ariaLabel, active, disabled, onClick, children }: { title: string; ariaLabel?: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            title={title}
            aria-label={ariaLabel}
            aria-pressed={active}
            disabled={disabled}
            className={`inline-flex h-6 cursor-pointer items-center rounded-full px-2 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-stone-800 ${active ? "bg-stone-900 text-white hover:bg-stone-900 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-100" : ""}`}
            onClick={onClick}
        >
            {children}
        </button>
    );
}
