import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

type ImageSize = { width: number; height: number };

const defaultMinZoom = 1;
const defaultMaxZoom = 4;
const zoomStep = 1.2;
const viewportPadding = 16;

/** 可选视口配置：默认值保持裁切弹窗等既有调用方的行为不变 */
export type ImageViewportOptions = {
    /** 最小缩放（相对适应窗口基准），默认 1 */
    minZoom?: number;
    /** 最大缩放（相对适应窗口基准），默认 4；需要绝对像素上限的调用方自行换算传入 */
    maxZoom?: number;
    /** 适应窗口时是否允许把小图放大铺满视口，默认 false（不放大） */
    fitUpscale?: boolean;
    /** 显示像素相对图片原始像素的比例上限（如 8 = 800%），设置后优先于 maxZoom 收紧上限 */
    maxAbsoluteScale?: number;
};

export function useImageEditorViewport(image: ImageSize | null, open: boolean, options?: ImageViewportOptions) {
    const minZoom = options?.minZoom ?? defaultMinZoom;
    const maxZoom = options?.maxZoom ?? defaultMaxZoom;
    const fitUpscale = options?.fitUpscale ?? false;
    const viewportNodeRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const panRef = useRef<{ pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
    const zoomAnchorRef = useRef<{ zoom: number; ratioX: number; ratioY: number; viewportX: number; viewportY: number } | null>(null);
    const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
    const [viewportSize, setViewportSize] = useState<ImageSize>({ width: 0, height: 0 });
    const [zoom, setZoom] = useState(minZoom);
    const [isPanning, setIsPanning] = useState(false);
    const [spacePressed, setSpacePressed] = useState(false);
    const spacePressedRef = useRef(false);
    const viewportRef = useCallback((node: HTMLDivElement | null) => {
        viewportNodeRef.current = node;
        setViewportElement(node);
    }, []);

    useEffect(() => {
        if (!open) return;
        zoomAnchorRef.current = null;
        setZoom(minZoom);
    }, [open, image?.width, image?.height]);

    useEffect(() => {
        if (!open) return;
        const releaseSpace = () => {
            spacePressedRef.current = false;
            setSpacePressed(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.code !== "Space" || event.repeat) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("input,textarea,[contenteditable='true']")) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (document.activeElement instanceof HTMLElement && document.activeElement.matches("button,a,[role='button']")) document.activeElement.blur();
            spacePressedRef.current = true;
            setSpacePressed(true);
        };
        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code !== "Space" || !spacePressedRef.current) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            releaseSpace();
        };
        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("keyup", handleKeyUp, true);
        window.addEventListener("blur", releaseSpace);
        return () => {
            window.removeEventListener("keydown", handleKeyDown, true);
            window.removeEventListener("keyup", handleKeyUp, true);
            window.removeEventListener("blur", releaseSpace);
            spacePressedRef.current = false;
        };
    }, [open]);

    useEffect(() => {
        if (!open || !viewportElement) return;
        const updateSize = () => {
            const width = viewportElement.clientWidth;
            const height = viewportElement.clientHeight;
            setViewportSize((current) => (current.width === width && current.height === height ? current : { width, height }));
        };
        updateSize();
        const observer = new ResizeObserver(updateSize);
        observer.observe(viewportElement);
        return () => observer.disconnect();
    }, [open, viewportElement]);

    const baseSize = fitImageToViewport(image, viewportSize, fitUpscale);
    // 显示像素相对图片原始像素的基准比例；maxAbsoluteScale 优先于 maxZoom 收紧上限
    const baseScale = image && baseSize.width ? baseSize.width / image.width : 0;
    const effectiveMaxZoom = options?.maxAbsoluteScale && baseScale > 0 ? Math.min(maxZoom, options.maxAbsoluteScale / baseScale) : maxZoom;
    const stageSize = { width: baseSize.width * zoom, height: baseSize.height * zoom };
    const contentSize = {
        width: Math.max(viewportSize.width, stageSize.width),
        height: Math.max(viewportSize.height, stageSize.height),
    };
    const stageOffset = {
        left: Math.max(0, Math.round((contentSize.width - stageSize.width) / 2)),
        top: Math.max(0, Math.round((contentSize.height - stageSize.height) / 2)),
    };

    useLayoutEffect(() => {
        const viewport = viewportNodeRef.current;
        const anchor = zoomAnchorRef.current;
        if (!viewport || !anchor || Math.abs(anchor.zoom - zoom) > 0.001) return;
        const nextWidth = baseSize.width * zoom;
        const nextHeight = baseSize.height * zoom;
        const nextLeft = Math.max(0, (Math.max(viewport.clientWidth, nextWidth) - nextWidth) / 2);
        const nextTop = Math.max(0, (Math.max(viewport.clientHeight, nextHeight) - nextHeight) / 2);
        viewport.scrollLeft = nextLeft + anchor.ratioX * nextWidth - anchor.viewportX;
        viewport.scrollTop = nextTop + anchor.ratioY * nextHeight - anchor.viewportY;
        zoomAnchorRef.current = null;
    }, [baseSize.height, baseSize.width, zoom]);

    const setZoomAround = useCallback(
        (nextZoom: number, clientX?: number, clientY?: number) => {
            const viewport = viewportNodeRef.current;
            const stage = stageRef.current;
            if (!viewport || !stage || !baseSize.width || !baseSize.height) return;

            const boundedZoom = clamp(nextZoom, minZoom, effectiveMaxZoom);
            if (Math.abs(boundedZoom - zoom) < 0.001) return;

            const viewportRect = viewport.getBoundingClientRect();
            const stageRect = stage.getBoundingClientRect();
            const pointerX = clientX ?? viewportRect.left + viewportRect.width / 2;
            const pointerY = clientY ?? viewportRect.top + viewportRect.height / 2;
            const ratioX = clamp((pointerX - stageRect.left) / Math.max(1, stageRect.width), 0, 1);
            const ratioY = clamp((pointerY - stageRect.top) / Math.max(1, stageRect.height), 0, 1);
            const viewportX = pointerX - viewportRect.left;
            const viewportY = pointerY - viewportRect.top;

            zoomAnchorRef.current = { zoom: boundedZoom, ratioX, ratioY, viewportX, viewportY };
            setZoom(boundedZoom);
        },
        [baseSize.height, baseSize.width, effectiveMaxZoom, zoom],
    );

    useEffect(() => {
        if (!open || !viewportElement) return;
        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setZoomAround(event.deltaY < 0 ? zoom * zoomStep : zoom / zoomStep, event.clientX, event.clientY);
        };
        viewportElement.addEventListener("wheel", handleWheel, { passive: false });
        return () => viewportElement.removeEventListener("wheel", handleWheel);
    }, [open, setZoomAround, viewportElement, zoom]);

    const startPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 1 && !(event.button === 0 && spacePressedRef.current)) return;
        event.preventDefault();
        event.stopPropagation();
        const viewport = event.currentTarget;
        panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
        viewport.setPointerCapture(event.pointerId);
        setIsPanning(true);
    }, []);
    const movePan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const pan = panRef.current;
        if (!pan || event.pointerId !== pan.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.x);
        event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.y);
    }, []);
    const stopPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const pan = panRef.current;
        if (!pan || event.pointerId !== pan.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        panRef.current = null;
        setIsPanning(false);
    }, []);
    const preventAuxClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
    }, []);

    return {
        viewportRef,
        stageRef,
        zoom,
        isPanning,
        spacePressed,
        scrollClassName: zoom > minZoom + 0.001 ? "overflow-scroll" : "overflow-hidden",
        panHandlers: {
            onPointerDownCapture: startPan,
            onPointerMoveCapture: movePan,
            onPointerUpCapture: stopPan,
            onPointerCancelCapture: stopPan,
            onAuxClick: preventAuxClick,
        },
        canZoomIn: zoom < effectiveMaxZoom,
        canZoomOut: zoom > minZoom,
        imageScale: image ? stageSize.width / image.width : 0,
        zoomIn: () => setZoomAround(zoom * zoomStep),
        zoomOut: () => setZoomAround(zoom / zoomStep),
        resetZoom: () => setZoomAround(minZoom),
        zoomTo: (nextZoom: number, clientX?: number, clientY?: number) => setZoomAround(nextZoom, clientX, clientY),
        zoomToActualPixel: () => setZoomAround(baseScale > 0 ? 1 / baseScale : minZoom),
        contentStyle: { width: contentSize.width, height: contentSize.height } satisfies CSSProperties,
        stageStyle: {
            left: stageOffset.left,
            top: stageOffset.top,
            width: stageSize.width,
            height: stageSize.height,
        } satisfies CSSProperties,
        mediaStyle: {
            width: baseSize.width,
            height: baseSize.height,
            transform: `translateZ(0) scale(${zoom})`,
            transformOrigin: "top left",
        } satisfies CSSProperties,
    };
}

/** 计算图片在视口内适应后的基准尺寸（默认不放大，fitUpscale 时允许铺满视口） */
export function fitImageToViewport(image: ImageSize | null, viewport: ImageSize, fitUpscale = false): ImageSize {
    if (!image || !viewport.width || !viewport.height) return { width: 0, height: 0 };
    const availableWidth = Math.max(1, viewport.width - viewportPadding * 2);
    const availableHeight = Math.max(1, viewport.height - viewportPadding * 2);
    const scale = Math.min(availableWidth / image.width, availableHeight / image.height, fitUpscale ? Number.POSITIVE_INFINITY : 1);
    return { width: Math.max(1, Math.floor(image.width * scale)), height: Math.max(1, Math.floor(image.height * scale)) };
}

/** 实际像素 1:1 对应的相对缩放倍率（基准适应尺寸相对图片原始像素的比例取倒数） */
export function actualPixelZoom(baseSize: ImageSize, image: ImageSize | null): number {
    if (!image || !image.width || !baseSize.width) return 1;
    return image.width / baseSize.width;
}

/** 当前显示的绝对像素比例（显示像素 / 图片原始像素），用于按实际像素显示缩放百分比 */
export function absoluteViewportScale(baseSize: ImageSize, zoom: number, image: ImageSize | null): number {
    if (!image || !image.width || !baseSize.width) return 0;
    return (baseSize.width * zoom) / image.width;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
