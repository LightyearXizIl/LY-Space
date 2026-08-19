import { AxiosError, AxiosHeaders, CanceledError } from "axios";
import { describe, expect, it } from "vitest";

import { getTextGenerationCount } from "@/lib/canvas/canvas-generation-helpers";
import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { readRequestError } from "@/services/api/error-message";
import { DEFAULT_PROMPT_SOURCES } from "@/services/api/prompt-source-presets";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function node(type: CanvasNodeType, metadata?: CanvasNodeData["metadata"]): CanvasNodeData {
    return { id: type, type, title: type, position: { x: 0, y: 0 }, width: 100, height: 80, metadata };
}

describe("上游文本数量兼容", () => {
    it("历史配置节点继续使用原图片数量作为文本数量", () => {
        expect(getTextGenerationCount(node(CanvasNodeType.Config, { count: 3 }))).toBe(3);
    });

    it("新文本数量优先于历史图片数量，并限制在 1 到 15", () => {
        expect(getTextGenerationCount(node(CanvasNodeType.Config, { count: 3, textCount: 1 }))).toBe(1);
        expect(getTextGenerationCount(node(CanvasNodeType.Config, { textCount: 20 }))).toBe(15);
    });

    it("普通文本节点没有文本数量时仍只生成一个结果", () => {
        expect(getTextGenerationCount(node(CanvasNodeType.Text, { count: 3 }))).toBe(1);
        expect(createCanvasNode(CanvasNodeType.Config, { x: 0, y: 0 }).metadata?.textCount).toBe(1);
    });
});

describe("上游网络与提示词源适配", () => {
    const fallbackStatus = (_status: number | undefined, fallback: string) => fallback;

    it("无响应的 Axios 网络错误给出可操作的网络和 CORS 提示", () => {
        const error = new AxiosError("Network Error", "ERR_NETWORK");
        expect(readRequestError(error, "生成失败", fallbackStatus)).toContain("CORS");
    });

    it("服务端错误正文和取消语义保持优先", () => {
        const error = new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, { data: { error: { message: "额度不足" } }, status: 401, statusText: "Unauthorized", headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } });
        expect(readRequestError(error, "生成失败", fallbackStatus)).toBe("额度不足");
        expect(readRequestError(new CanceledError("canceled"), "生成失败", fallbackStatus)).toBe("请求已取消");
    });

    it("Freestylefly 来源默认关闭，不产生升级后的自动下载", () => {
        expect(DEFAULT_PROMPT_SOURCES.find((source) => source.id === "freestylefly-gpt-image-2")).toMatchObject({ enabled: false, builtIn: true });
    });
});
