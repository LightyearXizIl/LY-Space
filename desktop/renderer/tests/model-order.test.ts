import { describe, expect, it } from "vitest";

import { grsaiSupportedImageResolutions, highestSupportedImageResolution, normalizeImageQuality, normalizeModelGroupOrder, normalizeModelOrder } from "@/stores/use-config-store";

describe("模型排序与图片偏好规范化", () => {
    it("规范化分组顺序时去重、清理失效渠道并追加新渠道", () => {
        expect(normalizeModelGroupOrder(["b", "missing", "b"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
    });

    it("模型顺序和分组顺序分别规范化，互不影响", () => {
        expect(normalizeModelOrder(["b", "b", "missing"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
        expect(normalizeModelGroupOrder(["channel-2"], ["channel-1", "channel-2"])).toEqual(["channel-2", "channel-1"]);
    });

    it("旧图片质量 auto 迁移到 medium，未知值也回退到 medium", () => {
        expect(normalizeImageQuality("auto")).toBe("medium");
        expect(normalizeImageQuality("max")).toBe("max");
        expect(normalizeImageQuality("invalid")).toBe("medium");
    });

    it("GRS AI GPT Image 2 支持 2K/4K，受限模型保留各自上限", () => {
        expect(grsaiSupportedImageResolutions("gpt-image-2")).toEqual(["1k", "2k", "4k"]);
        expect(grsaiSupportedImageResolutions("gpt-image-2.5")).toEqual(["1k"]);
        expect(grsaiSupportedImageResolutions("gpt-image-2.5-sunburst")).toEqual(["1k", "2k", "4k"]);
        expect(grsaiSupportedImageResolutions("gpt-image-2.5-flare")).toEqual(["1k", "2k", "4k"]);
        expect(highestSupportedImageResolution(["1k", "2k", "4k"])).toBe("4k");
    });
});
