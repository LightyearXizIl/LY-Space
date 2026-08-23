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
    await applyAdjustments(context, canvas.width, canvas.height, edits?.filter || "original", edits?.adjustments || defaultRefineAdjustments, edits?.lut || null);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片导出失败，请降低分辨率后重试"))), mimeType(format), format === "png" ? undefined : quality));
}

async function applyAdjustments(context: CanvasRenderingContext2D, width: number, height: number, filter: RefineFilter, input: RefineAdjustments, lut: RefineLutState | null) {
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
    if (values.sharpen) applySharpen(context, width, height, values.sharpen);
    if (lut?.intensity) await applyLut(context, width, height, lut);
    if (values.vignette) {
        const gradient = context.createRadialGradient(width / 2, height / 2, Math.min(width, height) * .2, width / 2, height / 2, Math.hypot(width, height) / 2);
        gradient.addColorStop(.55, "rgba(0,0,0,0)"); gradient.addColorStop(1, `rgba(0,0,0,${Math.min(.8, values.vignette / 100)})`);
        context.fillStyle = gradient; context.fillRect(0, 0, width, height);
    }
}

function applySharpen(context: CanvasRenderingContext2D, width: number, height: number, amount: number) {
    const current = context.getImageData(0, 0, width, height);
    const source = new Uint8ClampedArray(current.data);
    const strength = Math.min(1, Math.abs(amount) / 100) * Math.sign(amount);
    for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
            const index = (y * width + x) * 4;
            const left = index - 4;
            const right = index + 4;
            const top = index - width * 4;
            const bottom = index + width * 4;
            for (let channel = 0; channel < 3; channel += 1) {
                const blur = (source[left + channel] + source[right + channel] + source[top + channel] + source[bottom + channel]) / 4;
                current.data[index + channel] = clampByte(source[index + channel] + (source[index + channel] - blur) * strength * 2);
            }
        }
    }
    context.putImageData(current, 0, 0);
}

async function applyLut(context: CanvasRenderingContext2D, width: number, height: number, lut: RefineLutState) {
    const parsed = lut.format === "cube"
        ? new (await import("three/addons/loaders/LUTCubeLoader.js")).LUTCubeLoader().parse(lut.source)
        : new (await import("three/addons/loaders/LUT3dlLoader.js")).LUT3dlLoader().parse(lut.source);
    const size = parsed.size;
    const table = parsed.texture3D.image.data as Uint8Array | Float32Array;
    const cube = parsed as { domainMin?: { x: number; y: number; z: number }; domainMax?: { x: number; y: number; z: number } };
    const domainMin = cube.domainMin || { x: 0, y: 0, z: 0 };
    const domainMax = cube.domainMax || { x: 1, y: 1, z: 1 };
    const data = context.getImageData(0, 0, width, height);
    const intensity = Math.max(0, Math.min(1, lut.intensity / 100));
    for (let index = 0; index < data.data.length; index += 4) {
        const r = (data.data[index] / 255 - domainMin.x) / Math.max(domainMax.x - domainMin.x, Number.EPSILON);
        const g = (data.data[index + 1] / 255 - domainMin.y) / Math.max(domainMax.y - domainMin.y, Number.EPSILON);
        const b = (data.data[index + 2] / 255 - domainMin.z) / Math.max(domainMax.z - domainMin.z, Number.EPSILON);
        const mapped = sampleLut(table, size, r, g, b);
        data.data[index] = clampByte(data.data[index] * (1 - intensity) + mapped[0] * intensity);
        data.data[index + 1] = clampByte(data.data[index + 1] * (1 - intensity) + mapped[1] * intensity);
        data.data[index + 2] = clampByte(data.data[index + 2] * (1 - intensity) + mapped[2] * intensity);
    }
    context.putImageData(data, 0, 0);
}

function sampleLut(table: Uint8Array | Float32Array, size: number, red: number, green: number, blue: number): [number, number, number] {
    const r = Math.max(0, Math.min(size - 1, red * (size - 1)));
    const g = Math.max(0, Math.min(size - 1, green * (size - 1)));
    const b = Math.max(0, Math.min(size - 1, blue * (size - 1)));
    const r0 = Math.floor(r); const r1 = Math.min(size - 1, r0 + 1); const rt = r - r0;
    const g0 = Math.floor(g); const g1 = Math.min(size - 1, g0 + 1); const gt = g - g0;
    const b0 = Math.floor(b); const b1 = Math.min(size - 1, b0 + 1); const bt = b - b0;
    const point = (ri: number, gi: number, bi: number, channel: number) => table[((bi * size * size + gi * size + ri) * 4) + channel] * (table instanceof Uint8Array ? 1 : 255);
    const interpolate = (channel: number) => {
        const c00 = point(r0, g0, b0, channel) * (1 - rt) + point(r1, g0, b0, channel) * rt;
        const c10 = point(r0, g1, b0, channel) * (1 - rt) + point(r1, g1, b0, channel) * rt;
        const c01 = point(r0, g0, b1, channel) * (1 - rt) + point(r1, g0, b1, channel) * rt;
        const c11 = point(r0, g1, b1, channel) * (1 - rt) + point(r1, g1, b1, channel) * rt;
        return (c00 * (1 - gt) + c10 * gt) * (1 - bt) + (c01 * (1 - gt) + c11 * gt) * bt;
    };
    return [interpolate(0), interpolate(1), interpolate(2)];
}

function clampByte(value: number) {
    return Math.max(0, Math.min(255, value));
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
