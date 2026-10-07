export const GRSAI_MINIMAX_H3_REFERENCE_LIMITS = {
    images: 9,
    videos: 0,
    audios: 3,
    total: 12,
};

export const grsaiVideoResolutionOptions = [
    { value: "480p", label: "480p" },
    { value: "768p", label: "768p" },
    { value: "1080p", label: "1080p" },
] as const;

export const grsaiVideoAspectRatioOptions = [
    { value: "landscape", label: "横屏" },
    { value: "portrait", label: "竖屏" },
] as const;

export function isGrsaiMinimaxH3Model(model: string) {
    const normalized = model.trim().toLowerCase();
    return normalized === "minimax-h3" || normalized.endsWith("::minimax-h3");
}

export function grsaiVideoReferenceLimits(model = "") {
    return isGrsaiMinimaxH3Model(model) ? GRSAI_MINIMAX_H3_REFERENCE_LIMITS : { images: 0, videos: 0, audios: 0, total: 0 };
}

export function normalizeGrsaiVideoResolution(value: string) {
    const normalized = String(value || "").toLowerCase().replace(/p$/i, "");
    if (normalized === "480") return "480p";
    if (normalized === "1080") return "1080p";
    return "768p";
}

export function normalizeGrsaiVideoDuration(value: string, resolution = "") {
    const seconds = Math.floor(Number(value) || 6);
    const max = normalizeGrsaiVideoResolution(resolution) === "1080p" ? 10 : 15;
    return Math.max(1, Math.min(max, seconds));
}

export function normalizeGrsaiVideoAspectRatio(value: string) {
    if (value === "portrait") return "portrait";
    if (value === "landscape") return "landscape";
    const dimensions = value.match(/^(\d+)x(\d+)$/);
    if (dimensions) return Number(dimensions[1]) < Number(dimensions[2]) ? "portrait" : "landscape";
    const ratio = value.match(/^(\d+):(\d+)$/);
    if (ratio) return Number(ratio[1]) < Number(ratio[2]) ? "portrait" : "landscape";
    return "landscape";
}
