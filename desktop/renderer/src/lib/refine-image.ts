export type RefineCropRect = { x: number; y: number; width: number; height: number };
export type RefineResolution = "original" | "1k" | "2k" | "4k" | "8k" | "custom";
export type RefineFormat = "png" | "jpeg" | "webp";
export type RefineFilter = "original" | "vivid" | "cinema" | "warm" | "cool" | "vintage" | "mono" | "contrast";
export type RefineTransform = { rotation: number; flipX: boolean; flipY: boolean };
export type RefineAdjustments = { exposure: number; contrast: number; highlights: number; shadows: number; saturation: number; temperature: number; tint: number; sharpen: number; vignette: number };
export type RefineLutState = { name: string; source: string; format: "cube" | "3dl"; intensity: number };
export const defaultRefineTransform: RefineTransform = { rotation: 0, flipX: false, flipY: false };
export const defaultRefineAdjustments: RefineAdjustments = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, temperature: 0, tint: 0, sharpen: 0, vignette: 0 };

/** Validate LUTs with Three.js' official loaders before persisting their non-destructive source. */
export async function parseRefineLut(file: File): Promise<RefineLutState> {
    const source = await file.text();
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".cube") && !lower.endsWith(".3dl")) throw new Error("LUT 仅支持 .cube 或 .3dl 文件");
    try {
        if (lower.endsWith(".cube")) {
            const { LUTCubeLoader } = await import("three/addons/loaders/LUTCubeLoader.js");
            new LUTCubeLoader().parse(source);
        } else {
            const { LUT3dlLoader } = await import("three/addons/loaders/LUT3dlLoader.js");
            new LUT3dlLoader().parse(source);
        }
    } catch {
        throw new Error("LUT 文件无法解析，请确认 .cube/.3dl 内容完整");
    }
    return { name: file.name, source, format: lower.endsWith(".cube") ? "cube" : "3dl", intensity: 100 };
}

export const refineResolutionOptions: Array<{ value: RefineResolution; label: string }> = [
    { value: "original", label: "原始" },
    { value: "1k", label: "1K" },
    { value: "2k", label: "2K" },
    { value: "4k", label: "4K" },
    { value: "8k", label: "8K" },
    { value: "custom", label: "自定义" },
];

const longEdges: Record<Exclude<RefineResolution, "original" | "custom">, number> = { "1k": 1024, "2k": 2048, "4k": 3840, "8k": 7680 };

export function cropPixelSize(image: { width: number; height: number }, crop: RefineCropRect) {
    return { width: Math.max(1, Math.round(image.width * crop.width)), height: Math.max(1, Math.round(image.height * crop.height)) };
}

export function resolveRefineDimensions(image: { width: number; height: number }, crop: RefineCropRect, resolution: RefineResolution, customWidth: number, customHeight: number) {
    const source = cropPixelSize(image, crop);
    const ratio = source.width / source.height;
    if (resolution === "original") return { ...source, disabled: false, reason: "" };
    if (resolution === "custom") {
        const width = Math.max(1, Math.round(customWidth || source.width));
        const height = Math.max(1, Math.round(customHeight || Math.round(width / ratio)));
        return { width, height, disabled: width > source.width || height > source.height, reason: "自定义尺寸不能超过裁切区域原始像素" };
    }
    const longEdge = longEdges[resolution];
    const width = ratio >= 1 ? longEdge : align16(longEdge * ratio);
    const height = ratio >= 1 ? align16(longEdge / ratio) : longEdge;
    return { width, height, disabled: width > source.width || height > source.height, reason: `${resolution.toUpperCase()} 超过裁切区域原始像素，不能本地放大` };
}

export async function renderRefinedImage(sourceUrl: string, image: { width: number; height: number }, crop: RefineCropRect, output: { width: number; height: number }, format: RefineFormat, quality = 0.92, edits?: { transform?: RefineTransform; filter?: RefineFilter; adjustments?: RefineAdjustments; lut?: RefineLutState | null }) {
    const source = await loadImage(sourceUrl);
    const canvas = document.createElement("canvas");
    canvas.width = output.width;
    canvas.height = output.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持图片导出");
    if (format === "jpeg") {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    const sx = Math.max(0, Math.floor(crop.x * image.width));
    const sy = Math.max(0, Math.floor(crop.y * image.height));
    const sw = Math.max(1, Math.ceil(crop.width * image.width));
    const sh = Math.max(1, Math.ceil(crop.height * image.height));
    const transform = edits?.transform || defaultRefineTransform;
    context.save();
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate((transform.rotation * Math.PI) / 180);
    context.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
    context.drawImage(source, sx, sy, sw, sh, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
    context.restore();
    applyAdjustments(context, canvas.width, canvas.height, edits?.filter || "original", edits?.adjustments || defaultRefineAdjustments);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片导出失败，请降低分辨率后重试"))), mimeType(format), format === "png" ? undefined : quality));
}

function applyAdjustments(context: CanvasRenderingContext2D, width: number, height: number, filter: RefineFilter, input: RefineAdjustments) {
    const presets: Record<RefineFilter, Partial<RefineAdjustments>> = {
        original: {}, vivid: { saturation: 25, contrast: 10 }, cinema: { contrast: 18, saturation: -8, temperature: -6 }, warm: { temperature: 24, saturation: 8 }, cool: { temperature: -24, saturation: -4 }, vintage: { temperature: 18, saturation: -18, contrast: -8, vignette: 15 }, mono: { saturation: -100, contrast: 10 }, contrast: { contrast: 30 },
    };
    const preset = presets[filter];
    const values = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value + (preset[key as keyof RefineAdjustments] || 0)])) as RefineAdjustments;
    const pixels = context.getImageData(0, 0, width, height);
    const exposure = 2 ** (values.exposure / 100);
    const contrast = 1 + values.contrast / 100;
    const saturation = 1 + values.saturation / 100;
    for (let i = 0; i < pixels.data.length; i += 4) {
        let r = pixels.data[i] * exposure; let g = pixels.data[i + 1] * exposure; let b = pixels.data[i + 2] * exposure;
        const lum = (r + g + b) / 3;
        const shadow = Math.max(0, 1 - lum / 128) * values.shadows * 1.2;
        const highlight = Math.max(0, lum / 255 - .5) * values.highlights * 1.2;
        r = (r - 128) * contrast + 128 + shadow - highlight + values.temperature * .6 + values.tint * .25;
        g = (g - 128) * contrast + 128 + shadow - highlight - values.tint * .35;
        b = (b - 128) * contrast + 128 + shadow - highlight - values.temperature * .6;
        const gray = (r + g + b) / 3; r = gray + (r - gray) * saturation; g = gray + (g - gray) * saturation; b = gray + (b - gray) * saturation;
        pixels.data[i] = Math.max(0, Math.min(255, r)); pixels.data[i + 1] = Math.max(0, Math.min(255, g)); pixels.data[i + 2] = Math.max(0, Math.min(255, b));
    }
    context.putImageData(pixels, 0, 0);
    if (values.vignette) {
        const gradient = context.createRadialGradient(width / 2, height / 2, Math.min(width, height) * .2, width / 2, height / 2, Math.hypot(width, height) / 2);
        gradient.addColorStop(.55, "rgba(0,0,0,0)"); gradient.addColorStop(1, `rgba(0,0,0,${Math.min(.8, values.vignette / 100)})`);
        context.fillStyle = gradient; context.fillRect(0, 0, width, height);
    }
}

export function refineExtension(format: RefineFormat) {
    return format === "jpeg" ? "jpg" : format;
}

export function refineMimeType(format: RefineFormat) {
    return mimeType(format);
}

function align16(value: number) {
    return Math.max(16, Math.round(value / 16) * 16);
}

function mimeType(format: RefineFormat) {
    return format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
}

function loadImage(url: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("图片解码失败"));
        image.src = url;
    });
}
