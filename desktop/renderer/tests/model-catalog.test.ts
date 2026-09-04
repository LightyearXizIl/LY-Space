import { describe, expect, it } from "vitest";

import { catalogModelFromManual, catalogModelFromPreset, catalogModelsFromRecords, expandedCatalogGroupKeys, filterCatalogModels, groupCatalogModels, mergeSelectedCatalogModels } from "@/lib/model-catalog";
import { sanitizeConfig } from "@/services/config-file";
import { AGNES_DEFAULT_MODELS, GRSAI_DEFAULT_MODELS, defaultConfig, normalizeChannelModels, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";

describe("上游模型分类", () => {
    it("上游明确分类优先于名称推断，并保留显示信息", () => {
        const [model] = catalogModelsFromRecords([{ id: "example-chat", display_name: "绘图旗舰", description: "上游说明", category: "image-generation", owned_by: "Example" }]);
        expect(model).toMatchObject({ name: "example-chat", displayName: "绘图旗舰", description: "上游说明", category: "image", capability: "image", classificationSource: "upstream", owner: "Example" });
    });

    it("解析 OpenAI 基础对象、兼容平台非标准字段和 Gemini 元数据", () => {
        const models = catalogModelsFromRecords([
            { id: "deepseek-v3", object: "model", owned_by: "deepseek" },
            { id: "vendor-motion", capabilities: ["video-generation"] },
            { name: "models/gemini-3-pro", displayName: "Gemini 3 Pro", description: "通用生成模型", supportedGenerationMethods: ["generateContent"] },
        ]);
        expect(models.find((model) => model.name === "deepseek-v3")).toMatchObject({ category: "text", family: "DeepSeek", classificationSource: "inferred" });
        expect(models.find((model) => model.name === "vendor-motion")).toMatchObject({ category: "video", capability: "video", classificationSource: "upstream" });
        expect(models.find((model) => model.name === "gemini-3-pro")).toMatchObject({ displayName: "Gemini 3 Pro", category: "text", family: "Gemini", classificationSource: "upstream" });
    });

    it("视觉理解映射到文本能力，未识别不再默认为文本", () => {
        const models = catalogModelsFromRecords([{ id: "qwen2.5-vl-72b" }, { id: "upstream-vision", modalities: { input: ["text", "image"], output: ["text"] } }, { id: "vendor-model-2026" }]);
        expect(models.find((model) => model.name.includes("qwen"))).toMatchObject({ category: "vision", capability: "text" });
        expect(models.find((model) => model.name === "upstream-vision")).toMatchObject({ category: "vision", capability: "text", classificationSource: "upstream" });
        expect(models.find((model) => model.name.startsWith("vendor"))).toMatchObject({ category: "unknown", capability: "unknown" });
    });

    it("暂不支持类型具有最高优先级并给出禁选原因", () => {
        const [model] = catalogModelsFromRecords([{ id: "qwen-text-embedding-v4", category: "text-generation" }]);
        expect(model).toMatchObject({ category: "unsupported", capability: "unknown" });
        expect(model.disabledReason).toContain("向量");
        expect(catalogModelsFromRecords([{ id: "bge-m3" }])[0].category).toBe("unsupported");
        expect(catalogModelsFromRecords([{ id: "whisper-1" }])[0].disabledReason).toContain("ASR");
    });

    it("GRS AI 与 Agnes AI 内置清单使用内置来源", () => {
        expect(catalogModelFromPreset(GRSAI_DEFAULT_MODELS[0])).toMatchObject({ classificationSource: "preset", category: "image" });
        expect(catalogModelFromPreset(AGNES_DEFAULT_MODELS[0])).toMatchObject({ classificationSource: "preset", category: "text" });
    });
});

describe("模型筛选、系列分组与选择", () => {
    const models = catalogModelsFromRecords([{ id: "deepseek-v3" }, { id: "deepseek-r1" }, { id: "seedream-4.0" }, { id: "qwen-embedding-v4" }]);

    it("按能力和搜索条件筛选，再按能力与系列稳定分组", () => {
        expect(filterCatalogModels(models, "deep", "text").map((model) => model.name)).toEqual(["deepseek-r1", "deepseek-v3"]);
        const groups = groupCatalogModels(models);
        expect(groups.map((group) => `${group.category}:${group.family}:${group.models.length}`)).toEqual(["text:DeepSeek:2", "image:Seedream:1", "unsupported:Qwen:1"]);
    });

    it("搜索时展开所有命中分组，清空后恢复用户展开状态", () => {
        const groups = groupCatalogModels(models);
        expect(expandedCatalogGroupKeys(groups, "seed", [groups[0].key])).toEqual(groups.map((group) => group.key));
        expect(expandedCatalogGroupKeys(groups, "", [groups[0].key])).toEqual([groups[0].key]);
    });

    it("手动模型同样分类，无法识别时保留为待分类", () => {
        expect(catalogModelFromManual("seedance-2.0")).toMatchObject({ category: "video", capability: "video", classificationSource: "manual" });
        expect(catalogModelFromManual("private-endpoint-001")).toMatchObject({ category: "unknown", capability: "unknown", classificationSource: "manual" });
    });

    it("重复拉取只刷新展示信息，保留用户能力、脚本和图片特性", () => {
        const existing = [{ name: "vendor-model", capability: "image" as const, script: "return []", imageFeatures: ["image-edit" as const], displayName: "旧名称" }];
        const fetched = catalogModelsFromRecords([{ id: "vendor-model", displayName: "上游新名称", description: "上游新说明", category: "text-generation" }]);
        expect(mergeSelectedCatalogModels(existing, fetched, ["vendor-model"])[0]).toMatchObject({
            capability: "image",
            script: "return []",
            imageFeatures: ["image-edit"],
            displayName: "上游新名称",
            description: "上游新说明",
            category: "image",
            classificationSource: "manual",
        });
    });

    it("暂不支持模型不能作为新选择写入渠道", () => {
        const unsupported = models.find((model) => model.category === "unsupported")!;
        expect(mergeSelectedCatalogModels([], [unsupported], [unsupported.name])).toEqual([]);
    });
});

describe("模型分类配置兼容", () => {
    it("旧模型自动推导，unknown 不进入生成模型选择器", () => {
        const channel = { id: "custom", name: "自定义", baseUrl: "https://example.com", apiKey: "key", apiFormat: "openai" as const, models: normalizeChannelModels(["private-endpoint-001"]) };
        const config = { ...defaultConfig, channels: [channel], models: ["custom::private-endpoint-001"] } as AiConfig;
        expect(channel.models[0]).toMatchObject({ capability: "unknown", category: "unknown", classificationSource: "inferred" });
        expect(selectableModelsByCapability(config)).toEqual([]);
        expect(selectableModelsByCapability(config, "text")).toEqual([]);
    });

    it("导入时保留分类元数据和 unknown，仍不导入调用脚本", () => {
        const { config, skippedScripts } = sanitizeConfig({
            channels: [
                {
                    id: "custom",
                    name: "兼容渠道",
                    baseUrl: "https://example.com",
                    apiKey: "key",
                    apiFormat: "openai",
                    models: [{ name: "private-model", capability: "unknown", displayName: "私有模型", description: "说明", family: "Private", category: "unknown", classificationSource: "manual", script: "return 1" }],
                },
            ],
        });
        expect(config.channels[0].models[0]).toEqual({ name: "private-model", capability: "unknown", displayName: "私有模型", description: "说明", family: "Private", category: "unknown", classificationSource: "manual" });
        expect(skippedScripts).toBe(1);
    });

    it("导入缺少展示字段的旧配置时自动补充推导信息", () => {
        const { config } = sanitizeConfig({
            channels: [{ id: "legacy", name: "旧渠道", baseUrl: "https://example.com", apiKey: "key", apiFormat: "openai", models: [{ name: "deepseek-v3", capability: "text" }] }],
        });
        expect(config.channels[0].models[0]).toMatchObject({ capability: "text", category: "text", family: "DeepSeek", classificationSource: "inferred" });
    });
});
