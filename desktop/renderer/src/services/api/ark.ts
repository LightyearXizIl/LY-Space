import { buildApiUrl, type AiConfig } from "@/stores/use-config-store";

/** Shared Ark endpoint builder. buildApiUrl accepts both root URLs and pasted full Ark endpoints. */
export function arkApiUrl(config: Pick<AiConfig, "baseUrl">, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

export function arkHeaders(config: Pick<AiConfig, "apiKey">, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

/** Seedream accepts one image as a string and multi-image editing as an array. */
export function buildArkImageRequest(config: Pick<AiConfig, "model" | "imageWatermark">, prompt: string, count: number, size?: string, images: string[] = []) {
    const normalizedCount = Math.max(1, Math.floor(count) || 1);
    return {
        model: config.model,
        prompt,
        ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}),
        ...(size ? { size } : {}),
        response_format: "b64_json",
        stream: false,
        watermark: config.imageWatermark !== "false",
        ...(normalizedCount === 1
            ? { sequential_image_generation: "disabled" }
            : { sequential_image_generation: "auto", max_images: normalizedCount }),
    };
}

export function buildArkResponsesRequest(config: Pick<AiConfig, "model" | "arkThinkingMode">, input: unknown, tools?: unknown, toolChoice?: unknown) {
    return {
        model: config.model,
        input,
        thinking: { type: config.arkThinkingMode },
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
    };
}

export function buildArkSeedanceTaskRequest(config: Pick<AiConfig, "model" | "videoGenerateAudio" | "videoWatermark" | "videoSeed">, content: Array<Record<string, unknown>>, ratio: string, resolution: string, duration: number) {
    const seed = normalizeArkSeed(config.videoSeed);
    return {
        model: config.model,
        content,
        ratio,
        resolution,
        duration,
        generate_audio: config.videoGenerateAudio !== "false",
        watermark: config.videoWatermark === "true",
        ...(seed === undefined ? {} : { seed }),
    };
}

/** Seedance accepts -1 or an unsigned 32-bit integer. Invalid user input is omitted instead of coerced. */
export function normalizeArkSeed(value: string | undefined) {
    const raw = (value || "").trim();
    if (!raw) return undefined;
    const seed = Number(raw);
    return Number.isInteger(seed) && seed >= -1 && seed <= 4294967295 ? seed : undefined;
}
