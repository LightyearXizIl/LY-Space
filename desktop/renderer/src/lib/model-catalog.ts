import type { ChannelModel, ChannelModelCapability, ModelCatalogCategory, ModelClassificationSource } from "@/stores/use-config-store";

export type FetchedChannelModel = {
    name: string;
    displayName?: string;
    description?: string;
    owner?: string;
    family: string;
    category: ModelCatalogCategory;
    capability: ChannelModelCapability;
    classificationSource: ModelClassificationSource;
    disabledReason?: string;
};

export type ModelCategoryFilter = "all" | ModelCatalogCategory;

export type ModelCatalogGroup = {
    key: string;
    category: ModelCatalogCategory;
    family: string;
    models: FetchedChannelModel[];
};

export const MODEL_CATEGORY_ORDER: ModelCatalogCategory[] = ["text", "vision", "image", "video", "audio", "unknown", "unsupported"];

export const MODEL_CATEGORY_LABELS: Record<ModelCatalogCategory, string> = {
    text: "文本生成",
    vision: "视觉理解",
    image: "图片生成",
    video: "视频生成",
    audio: "音频生成",
    unknown: "未识别",
    unsupported: "暂不支持",
};

export const MODEL_CATEGORY_FILTER_LABELS: Record<ModelCatalogCategory, string> = {
    text: "文本",
    vision: "视觉",
    image: "图片",
    video: "视频",
    audio: "音频",
    unknown: "未识别",
    unsupported: "暂不支持",
};

export const MODEL_SOURCE_LABELS: Record<ModelClassificationSource, string> = {
    upstream: "上游分类",
    preset: "内置清单",
    inferred: "名称推断",
    manual: "手动添加",
};

const UNSUPPORTED_RULES: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /(?:^|[-_.])(embedding|embeddings|embed)(?:$|[-_.])/i, reason: "LY Space 暂未接入向量模型" },
    { pattern: /(?:^|[-_.])rerank(?:er)?(?:$|[-_.])/i, reason: "LY Space 暂未接入重排模型" },
    { pattern: /(?:^|[-_.])(?:bge|gte|e5|m3e|text2vec)(?:$|[-_.])/i, reason: "LY Space 暂未接入向量模型" },
    { pattern: /(?:^|[-_.])(moderation|moderate)(?:$|[-_.])/i, reason: "LY Space 暂未接入审核模型" },
    { pattern: /(?:^|[-_.])(guard|guardrail|safety)(?:$|[-_.])/i, reason: "LY Space 暂未接入 Guard / 安全模型" },
    { pattern: /(?:^|[-_.])(asr|speech-to-text|transcription)(?:$|[-_.])/i, reason: "LY Space 暂未接入 ASR 模型" },
    { pattern: /(?:^|[-_.])(?:whisper|paraformer|sensevoice|funasr)(?:$|[-_.])/i, reason: "LY Space 暂未接入 ASR 模型" },
    { pattern: /(?:^|[-_.])(voice-clone|voice-cloning|speech-clone)(?:$|[-_.])/i, reason: "LY Space 暂未接入声音复刻模型" },
    { pattern: /(?:^|[-_.])seed-icl(?:$|[-_.])/i, reason: "LY Space 暂未接入声音复刻模型" },
    { pattern: /(?:3d|text-to-3d|image-to-3d)/i, reason: "LY Space 暂未接入 3D 模型" },
];

const FAMILY_RULES: Array<{ label: string; pattern: RegExp }> = [
    { label: "DeepSeek", pattern: /deepseek/i },
    { label: "Seedream", pattern: /seedream/i },
    { label: "Seedance", pattern: /seedance/i },
    { label: "豆包", pattern: /(?:doubao|豆包)/i },
    { label: "GPT", pattern: /(?:^|[-_.])(?:gpt|o[134])(?:$|[-_.])/i },
    { label: "Claude", pattern: /claude/i },
    { label: "Gemini", pattern: /gemini/i },
    { label: "Imagen", pattern: /imagen/i },
    { label: "Veo", pattern: /(?:^|[-_.])veo(?:$|[-_.])/i },
    { label: "Qwen", pattern: /(?:qwen|通义)/i },
    { label: "Kimi", pattern: /(?:kimi|moonshot)/i },
    { label: "GLM", pattern: /(?:^|[-_.])glm(?:$|[-_.])/i },
    { label: "Llama", pattern: /llama/i },
    { label: "Mistral", pattern: /mistral/i },
    { label: "Gemma", pattern: /gemma/i },
    { label: "FLUX", pattern: /(?:^|[-_.])flux(?:$|[-_.])/i },
    { label: "Sora", pattern: /sora/i },
    { label: "Kling", pattern: /kling/i },
    { label: "Wan", pattern: /(?:^|[-_.])wan(?:$|[-_.])/i },
    { label: "Hailuo", pattern: /hailuo/i },
];

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function flattenStrings(value: unknown): string[] {
    if (typeof value === "string") return [value.toLowerCase()];
    if (Array.isArray(value)) return value.flatMap(flattenStrings);
    const source = record(value);
    return source ? Object.entries(source).flatMap(([key, item]) => (item === true ? [key.toLowerCase()] : flattenStrings(item))) : [];
}

function metadataValues(raw?: Record<string, unknown>) {
    if (!raw) return [];
    return [
        raw.category,
        raw.type,
        raw.capability,
        raw.capabilities,
        raw.modalities,
        raw.input,
        raw.input_modalities,
        raw.inputModalities,
        raw.output,
        raw.output_modalities,
        raw.outputModalities,
        raw.supportedGenerationMethods,
        raw.supported_generation_methods,
        raw.supported_methods,
        raw.methods,
    ].flatMap(flattenStrings);
}

function declaredValues(raw?: Record<string, unknown>) {
    if (!raw) return [];
    return [raw.category, raw.type, raw.capability, raw.capabilities, raw.supportedGenerationMethods, raw.supported_generation_methods, raw.supported_methods, raw.methods].flatMap(flattenStrings);
}

function includesAny(values: string[], patterns: RegExp[]) {
    return values.some((value) => patterns.some((pattern) => pattern.test(value)));
}

function unsupportedReason(name: string, metadata: string[]) {
    const normalized = `${name} ${metadata.join(" ")}`;
    return UNSUPPORTED_RULES.find((rule) => rule.pattern.test(normalized))?.reason;
}

function explicitCategory(raw?: Record<string, unknown>): ModelCatalogCategory | undefined {
    const values = metadataValues(raw);
    const declared = declaredValues(raw);
    if (includesAny(values, [/(?:^|[-_. ])(?:embedding|embeddings|embed|embedcontent)(?:$|[-_. ])/i, /rerank/i, /moderation/i, /guard/i, /speech-to-text/i, /transcription/i, /voice-clon/i, /(?:^|[-_. ])3d(?:$|[-_. ])/i])) return "unsupported";

    const modalities = record(raw?.modalities);
    const outputs = flattenStrings(raw?.output_modalities ?? raw?.outputModalities ?? raw?.output ?? modalities?.output ?? modalities?.outputs);
    const inputs = flattenStrings(raw?.input_modalities ?? raw?.inputModalities ?? raw?.input ?? modalities?.input ?? modalities?.inputs);
    if (includesAny(outputs, [/video/i])) return "video";
    if (includesAny(outputs, [/(?:^|[-_. ])image(?:$|[-_. ])/i])) return "image";
    if (includesAny(outputs, [/audio/i, /speech/i, /music/i])) return "audio";
    if (includesAny(inputs, [/(?:^|[-_. ])image(?:$|[-_. ])/i, /vision/i]) && includesAny(outputs, [/text/i])) return "vision";

    if (includesAny(declared, [/^(?:video|video-generation|text-to-video)$/i])) return "video";
    if (includesAny(declared, [/^(?:image|image-generation|text-to-image)$/i])) return "image";
    if (includesAny(declared, [/^(?:audio|audio-generation|speech|text-to-speech|tts|music)$/i])) return "audio";
    if (includesAny(declared, [/^(?:vision|image-understanding|multimodal)$/i])) return "vision";
    if (includesAny(declared, [/^(?:text|chat|text-generation|response|responses)$/i])) return "text";
    if (includesAny(values, [/video[-_ ]?(generation|gen)/i, /text[-_ ]?to[-_ ]?video/i])) return "video";
    if (includesAny(values, [/image[-_ ]?(generation|gen)/i, /text[-_ ]?to[-_ ]?image/i, /images\/generations/i])) return "image";
    if (includesAny(values, [/audio[-_ ]?(generation|gen)/i, /text[-_ ]?to[-_ ]?speech/i, /speech[-_ ]?synthesis/i, /(?:^|[-_. ])tts(?:$|[-_. ])/i, /music[-_ ]?(generation|gen)/i])) return "audio";
    if (includesAny(values, [/vision/i, /image[-_ ]?understanding/i, /multimodal/i])) return "vision";
    if (includesAny(values, [/text[-_ ]?(generation|gen)/i, /chat/i, /responses?/i, /generatecontent/i])) return "text";
    return undefined;
}

function inferredCategory(name: string): ModelCatalogCategory {
    const unsupported = unsupportedReason(name, []);
    if (unsupported) return "unsupported";
    if (/(?:seedance|video|sora|(?:^|[-_.])veo(?:$|[-_.])|kling|(?:^|[-_.])wan(?:$|[-_.])|hailuo)/i.test(name)) return "video";
    if (/(?:^|[-_.])(?:audio|tts|text-to-speech|speech-synthesis|speech|voice|music|sound)(?:$|[-_.])/i.test(name)) return "audio";
    if (/(?:seedream|gpt-image|(?:^|[-_.])image(?:$|[-_.])|dall-e|dalle|imagen|(?:^|[-_.])flux(?:$|[-_.])|sdxl|stable-diffusion|midjourney)/i.test(name)) return "image";
    if (/(?:vision|multimodal|(?:^|[-_.])vl(?:$|[-_.]))/i.test(name)) return "vision";
    if (/(?:deepseek|doubao|(?:^|[-_.])(?:gpt|o[134])(?:$|[-_.])|claude|gemini|qwen|kimi|moonshot|(?:^|[-_.])glm(?:$|[-_.])|llama|mistral|gemma|agnes)/i.test(name)) return "text";
    return "unknown";
}

function capabilityForCategory(category: ModelCatalogCategory): ChannelModelCapability {
    if (category === "vision" || category === "text") return "text";
    if (category === "image" || category === "video" || category === "audio") return category;
    return "unknown";
}

function modelFamily(name: string, displayName?: string, owner?: string, upstreamFamily?: string) {
    if (upstreamFamily) return upstreamFamily;
    const searchable = `${name} ${displayName || ""}`;
    const matched = FAMILY_RULES.find((rule) => rule.pattern.test(searchable));
    if (matched) return matched.label;
    if (owner && !/^(?:openai|organization-owner|unknown)$/i.test(owner)) return owner;
    const prefix = name.split(/[-_.:/]/).filter(Boolean)[0];
    return prefix && prefix.length <= 24 ? prefix : "其他";
}

export function classifyModel(input: { name: string; displayName?: string; description?: string; owner?: string; family?: string; raw?: Record<string, unknown>; source?: "upstream" | "preset" | "manual" }): FetchedChannelModel {
    const name = input.name.replace(/^models\//, "").trim();
    const metadata = metadataValues(input.raw);
    const blocked = unsupportedReason(name, metadata);
    const explicit = explicitCategory(input.raw);
    const inferred = blocked ? "unsupported" : explicit || inferredCategory(name);
    const category = blocked ? "unsupported" : inferred;
    const classificationSource: ModelClassificationSource = input.source === "preset" ? "preset" : input.source === "manual" ? "manual" : explicit ? "upstream" : "inferred";
    return {
        name,
        ...(input.displayName && input.displayName !== name ? { displayName: input.displayName } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
        family: modelFamily(name, input.displayName, input.owner, input.family),
        category,
        capability: capabilityForCategory(category),
        classificationSource,
        ...(category === "unsupported" ? { disabledReason: blocked || "该模型类型尚未接入 LY Space" } : {}),
    };
}

export function catalogModelsFromRecords(records: unknown[]): FetchedChannelModel[] {
    const result = new Map<string, FetchedChannelModel>();
    for (const value of records) {
        const raw = record(value);
        if (!raw) continue;
        const rawName = stringValue(raw.id) || stringValue(raw.name);
        if (!rawName) continue;
        const name = rawName.replace(/^models\//, "");
        const displayName = stringValue(raw.displayName) || stringValue(raw.display_name);
        const description = stringValue(raw.description);
        const owner = stringValue(raw.owned_by) || stringValue(raw.owner) || stringValue(raw.provider) || stringValue(raw.organization);
        const family = stringValue(raw.family) || stringValue(raw.model_family) || stringValue(raw.modelFamily);
        if (!result.has(name)) result.set(name, classifyModel({ name, displayName, description, owner, family, raw, source: "upstream" }));
    }
    return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function catalogModelFromPreset(model: ChannelModel): FetchedChannelModel {
    const category: ModelCatalogCategory = model.category || (model.capability === "unknown" ? "unknown" : model.capability);
    const inferred = classifyModel({ name: model.name, displayName: model.displayName, description: model.description, source: "preset" });
    return { ...inferred, category, capability: model.capability, classificationSource: "preset", family: model.family || inferred.family };
}

export function catalogModelFromManual(name: string) {
    return classifyModel({ name, source: "manual" });
}

export function catalogModelFromConfigured(model: ChannelModel): FetchedChannelModel {
    const inferred = classifyModel({ name: model.name, displayName: model.displayName, description: model.description });
    const category = model.category || (model.capability === "unknown" ? inferred.category : model.capability === "text" && inferred.category === "vision" ? "vision" : model.capability);
    return {
        ...inferred,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        ...(model.description ? { description: model.description } : {}),
        family: model.family || inferred.family,
        category,
        capability: model.capability,
        classificationSource: model.classificationSource || inferred.classificationSource,
        ...(category === "unsupported" ? { disabledReason: inferred.disabledReason || "该模型类型尚未接入 LY Space" } : { disabledReason: undefined }),
    };
}

export function filterCatalogModels(models: FetchedChannelModel[], search: string, category: ModelCategoryFilter) {
    const keyword = search.trim().toLowerCase();
    return models.filter((model) => {
        if (category !== "all" && model.category !== category) return false;
        if (!keyword) return true;
        return [model.name, model.displayName, model.description, model.family, model.owner].some((value) => value?.toLowerCase().includes(keyword));
    });
}

export function groupCatalogModels(models: FetchedChannelModel[]): ModelCatalogGroup[] {
    const groups = new Map<string, ModelCatalogGroup>();
    for (const model of models) {
        const key = `${model.category}:${model.family}`;
        const group = groups.get(key) || { key, category: model.category, family: model.family, models: [] };
        group.models.push(model);
        groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => {
        const categoryOrder = MODEL_CATEGORY_ORDER.indexOf(a.category) - MODEL_CATEGORY_ORDER.indexOf(b.category);
        return categoryOrder || a.family.localeCompare(b.family);
    });
}

export function expandedCatalogGroupKeys(groups: ModelCatalogGroup[], search: string, savedKeys: string[]) {
    return search.trim() ? groups.map((group) => group.key) : savedKeys;
}

export function mergeSelectedCatalogModels(existing: ChannelModel[], catalog: FetchedChannelModel[], selectedNames: Iterable<string>): ChannelModel[] {
    const selected = new Set(selectedNames);
    const existingByName = new Map(existing.map((model) => [model.name, model]));
    const catalogByName = new Map(catalog.map((model) => [model.name, model]));
    const orderedNames = [...existing.map((model) => model.name), ...catalog.map((model) => model.name)].filter((name, index, names) => names.indexOf(name) === index && selected.has(name));
    return orderedNames.flatMap((name) => {
        const fetched = catalogByName.get(name);
        const current = existingByName.get(name);
        if (!fetched && current) return [current];
        if (!fetched) return [];
        if (fetched.category === "unsupported") return current ? [current] : [];
        const refreshed: ChannelModel = {
            name,
            capability: fetched.capability,
            ...(fetched.displayName ? { displayName: fetched.displayName } : {}),
            ...(fetched.description ? { description: fetched.description } : {}),
            family: fetched.family,
            category: fetched.category,
            classificationSource: fetched.classificationSource,
        };
        if (!current) return [refreshed];
        const preserveManualCategory = current.classificationSource === "manual" || current.capability !== fetched.capability;
        return [
            {
                ...refreshed,
                capability: current.capability,
                ...(preserveManualCategory
                    ? {
                          category: current.category || (current.capability === "unknown" ? "unknown" : current.capability),
                          classificationSource: "manual" as const,
                      }
                    : {}),
                ...(current.script ? { script: current.script } : {}),
                ...(current.imageFeatures?.length ? { imageFeatures: current.imageFeatures } : {}),
            },
        ];
    });
}
