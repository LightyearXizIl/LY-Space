export const AGNES_VIDEO_25_MODEL = "agnes-video-2.5";
export const AGNES_VIDEO_25_FLASH_MODEL = "agnes-video-2.5-flash";

export const AGNES_VIDEO_25_ASPECT_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const AGNES_VIDEO_25_RESOLUTIONS = ["720P", "960P", "2K"] as const;

function plainModelName(value: string) {
    const separator = value.lastIndexOf("::");
    return (separator >= 0 ? value.slice(separator + 2) : value).trim().toLowerCase();
}

export function isAgnesVideo25Model(model: string) {
    return plainModelName(model) === AGNES_VIDEO_25_MODEL;
}

export function isAgnesVideo25FlashModel(model: string) {
    return plainModelName(model) === AGNES_VIDEO_25_FLASH_MODEL;
}

export function isAgnesVideo25Family(model: string) {
    return isAgnesVideo25Model(model) || isAgnesVideo25FlashModel(model);
}

export function normalizeAgnesVideo25Seconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(4, Math.min(12, seconds)));
}

export function normalizeAgnesVideo25Resolution(value: string, flash = false) {
    if (flash) return "720P";
    const normalized = String(value || "").trim().toUpperCase();
    if (normalized === "960" || normalized === "960P") return "960P";
    if (normalized === "2K" || normalized === "2KP") return "2K";
    return "720P";
}

export function normalizeAgnesVideo25AspectRatio(value: string) {
    const input = String(value || "").trim();
    if ((AGNES_VIDEO_25_ASPECT_RATIOS as readonly string[]).includes(input)) return input;
    const match = input.match(/^(\d+)x(\d+)$/);
    if (!match) return "16:9";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return "16:9";
    const ratio = width / height;
    return AGNES_VIDEO_25_ASPECT_RATIOS.reduce((best, candidate) => {
        const [bestWidth, bestHeight] = best.split(":").map(Number);
        const [widthValue, heightValue] = candidate.split(":").map(Number);
        return Math.abs(widthValue / heightValue - ratio) < Math.abs(bestWidth / bestHeight - ratio) ? candidate : best;
    }, "16:9");
}
