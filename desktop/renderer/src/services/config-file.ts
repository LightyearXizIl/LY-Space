import { saveAs } from "file-saver";

import { useConfigStore, defaultConfig, defaultWebdavSyncConfig, type AiConfig, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: { sources: PromptSource[]; schedule: PromptSourceSchedule };
};

const apiFormats = new Set<ApiCallFormat>(["openai", "gemini", "ark", "grsai", "agnes"]);
const capabilities = new Set<ModelCapability>(["image", "video", "text", "audio"]);
const imageResolutions = new Set<AiConfig["imageResolution"]>(["1k", "2k", "4k", "8k"]);
const reasoningEfforts = new Set<AiConfig["reasoningEffort"]>(["auto", "low", "medium", "high", "xhigh"]);

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, fallback = "") {
    return typeof value === "string" ? value : fallback;
}

function sanitizeModel(value: unknown): { model: ChannelModel; skippedScript: boolean } | null {
    const source = record(value);
    if (!source || !text(source.name).trim() || !capabilities.has(source.capability as ModelCapability)) return null;
    const imageFeatures = Array.isArray(source.imageFeatures) ? source.imageFeatures.filter((item): item is NonNullable<ChannelModel["imageFeatures"]>[number] => item === "image-edit" || item === "mask-edit" || item === "generative-upscale" || item === "dedicated-super-resolution") : undefined;
    return { model: { name: text(source.name).trim(), capability: source.capability as ModelCapability, ...(imageFeatures?.length ? { imageFeatures } : {}) }, skippedScript: Boolean(text(source.script).trim()) };
}

function sanitizeChannel(value: unknown): { channel: ModelChannel; skippedScripts: number } | null {
    const source = record(value);
    if (!source || !apiFormats.has(source.apiFormat as ApiCallFormat) || !Array.isArray(source.models)) return null;
    const models = source.models.map(sanitizeModel).filter((item): item is NonNullable<ReturnType<typeof sanitizeModel>> => Boolean(item));
    if (!models.length) return null;
    return {
        channel: { id: text(source.id).trim() || crypto.randomUUID(), name: text(source.name).trim() || "导入渠道", baseUrl: text(source.baseUrl).trim(), apiKey: text(source.apiKey), apiFormat: source.apiFormat as ApiCallFormat, models: models.map((item) => item.model), enabled: source.enabled !== false },
        skippedScripts: models.filter((item) => item.skippedScript).length,
    };
}

function sanitizeConfig(value: unknown) {
    const source = record(value);
    if (!source || !Array.isArray(source.channels)) throw new Error("配置缺少有效渠道");
    const channels = source.channels.map(sanitizeChannel).filter((item): item is NonNullable<ReturnType<typeof sanitizeChannel>> => Boolean(item));
    if (!channels.length) throw new Error("配置中没有有效模型");
    const merged = { ...defaultConfig, ...source, channels: channels.map((item) => item.channel) } as AiConfig;
    merged.apiFormat = apiFormats.has(source.apiFormat as ApiCallFormat) ? source.apiFormat as ApiCallFormat : defaultConfig.apiFormat;
    merged.channelMode = source.channelMode === "remote" ? "remote" : "local";
    merged.models = Array.isArray(source.models) ? source.models.filter((item): item is string => typeof item === "string") : [];
    merged.imageResolution = imageResolutions.has(source.imageResolution as AiConfig["imageResolution"]) ? source.imageResolution as AiConfig["imageResolution"] : defaultConfig.imageResolution;
    merged.reasoningEffort = reasoningEfforts.has(source.reasoningEffort as AiConfig["reasoningEffort"]) ? source.reasoningEffort as AiConfig["reasoningEffort"] : defaultConfig.reasoningEffort;
    return { config: merged, skippedScripts: channels.reduce((sum, item) => sum + item.skippedScripts, 0) };
}

function sanitizeWebdav(value: unknown): WebdavSyncConfig {
    const source = record(value);
    if (!source) throw new Error("配置缺少 WebDAV 设置");
    return { ...defaultWebdavSyncConfig, url: text(source.url).trim(), username: text(source.username), password: text(source.password), directory: text(source.directory).trim() || defaultWebdavSyncConfig.directory, lastSyncedAt: "" };
}

export function exportAppConfig() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config, webdav, promptSources: { sources, schedule } };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error("配置文件格式不正确");
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.promptSources) throw new Error("配置文件格式不正确");
    const { config, skippedScripts } = sanitizeConfig(data.config);
    const webdav = sanitizeWebdav(data.webdav);
    const currentPromptSources = usePromptSourceStore.getState();
    const sources = Array.isArray(data.promptSources.sources) ? data.promptSources.sources : currentPromptSources.sources;
    const intervalMinutes = Number(data.promptSources.schedule?.intervalMinutes);
    const schedule = { ...currentPromptSources.schedule, intervalMinutes: Number.isFinite(intervalMinutes) && intervalMinutes >= 0 ? intervalMinutes : currentPromptSources.schedule.intervalMinutes };
    useConfigStore.setState({ config, webdav });
    usePromptSourceStore.setState({ sources, schedule });
    return { skippedScripts };
}
