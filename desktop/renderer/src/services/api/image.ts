import axios from "axios";

import { buildApiUrl, AGNES_DEFAULT_MODELS, GRSAI_DEFAULT_MODELS, resolveModelRequestConfig, resolveModelScript, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { normalizePluginImages, runModelPlugin } from "./model-plugin";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { catalogModelFromPreset, catalogModelsFromRecords, type FetchedChannelModel } from "@/lib/model-catalog";
import { fetchImageBlob, imageToDataUrl, imageToFile } from "@/services/image-storage";
import { notifyStorageError, saveGeneratedBlob, saveGeneratedText } from "@/services/desktop-storage";
import type { ReferenceImage } from "@/types/image";
import { readRequestError, readUpstreamError } from "./error-message";
import { arkRequestJson, arkStreamText, buildArkImageRequest, buildArkResponsesRequest } from "./ark";

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

type ResponseInputMessage =
    | AiTextMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { role: "tool"; tool_call_id: string; content: string };

type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = AiTextMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem =
    | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
    | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string };
type ResponseApiPayload = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string };

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type GrsaiTaskResponse = ImageApiResponse & {
    id?: string;
    status?: "running" | "violation" | "succeeded" | "failed" | string;
    progress?: number;
    error?: string | { message?: string };
};
type OpenAiChatPayload = {
    choices?: Array<{ delta?: { content?: string | Array<{ text?: string }> }; message?: { content?: string | Array<{ text?: string }> } }>;
    error?: { message?: string };
    message?: string;
};
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
    thoughtSignature?: string;
    thought_signature?: string;
};
type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<Record<string, unknown> & { name?: string; displayName?: string; description?: string; supportedGenerationMethods?: string[] }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type GeminiStreamState = { buffer: string; text: string; toolCalls: ResponseToolCall[]; error?: string };
type RequestOptions = { signal?: AbortSignal };

const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 262144;
const IMAGE_MAX_PIXELS = 7680 * 7680;
const IMAGE_MAX_EDGE = 7680;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";

const GEMINI_SUPPORTED_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    return ["auto", "low", "medium", "high"].includes(value) ? value : undefined;
}

function normalizeImageResolution(value: string | undefined) {
    return value === "2k" || value === "4k" || value === "8k" ? value : "1k";
}

function resolutionEdge(value: string | undefined) {
    return ({ "1k": 1024, "2k": 2048, "4k": 3840, "8k": 7680 } as Record<string, number>)[normalizeImageResolution(value)];
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** Map "resolution + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(resolution: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    const longSide = resolution ? resolutionEdge(resolution) : DEFAULT_IMAGE_SHORT_SIDE;
    // 向上取整到 16 的倍数，避免 3:1 等大比例因向下取整后实际比例超限
    const shortSide = Math.max(IMAGE_SIZE_STEP, Math.ceil(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP);

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("图像比例必须是正数，例如 9:16");
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error("图像尺寸必须是正整数，例如 1024x1024");
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error("图像尺寸的宽高必须是 16 的倍数，请调整尺寸");
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error(`图像尺寸最长边不能超过 ${IMAGE_MAX_EDGE}px，请调整尺寸`);
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error("图像宽高比不能超过 3:1，请调整尺寸");
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error(`图像总像素需在 ${IMAGE_MIN_PIXELS} 到 ${IMAGE_MAX_PIXELS} 之间，请调整尺寸`);
}

function resolveRequestSize(resolution: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(resolution, value);
    throw new Error("图像尺寸格式不支持，请使用 auto、9:16 或 1024x1024");
}

function resolveGeminiImageConfig(config: AiConfig) {
    const value = config.size.trim();
    const dimensions = parseImageDimensions(value);
    const ratio = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
    const aspectRatio = value && value.toLowerCase() !== "auto" ? closestGeminiAspectRatio(ratio) : undefined;
    const imageSize = supportsGeminiImageSize(config.model) ? resolveGeminiImageSize(config.imageResolution, dimensions) : undefined;
    const image = { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) };
    return Object.keys(image).length ? { responseFormat: { image } } : {};
}

function closestGeminiAspectRatio(value: string) {
    const ratio = parseImageRatio(value);
    const target = ratio.width / ratio.height;
    return GEMINI_SUPPORTED_RATIOS.reduce((best, item) => {
        const current = parseRatioValue(item);
        const bestRatio = parseRatioValue(best);
        return Math.abs(current.width / current.height - target) < Math.abs(bestRatio.width / bestRatio.height - target) ? item : best;
    });
}

function resolveGeminiImageSize(resolution: string, dimensions: { width: number; height: number } | null) {
    const normalizedResolution = normalizeImageResolution(resolution);
    if (normalizedResolution === "8k") throw new Error("当前 Gemini 图片模型最高支持 4K，请选择 4K 或更低分辨率");
    // 显式像素尺寸优先于分辨率档位，避免默认 1K 覆盖用户的显式尺寸
    if (dimensions) {
        const edge = Math.max(dimensions.width, dimensions.height);
        if (edge <= 768) return "512";
        if (edge <= 1536) return "1K";
        if (edge <= 3072) return "2K";
        return "4K";
    }
    return ({ "1k": "1K", "2k": "2K", "4k": "4K" } as Record<string, string>)[normalizedResolution];
}

function supportsGeminiImageSize(model: string) {
    const value = model.toLowerCase();
    return value.includes("gemini-3") || value.includes("3.1") || value.includes("3-pro");
}

function resolveImageDataUrl(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse) {
    const upstreamError = readUpstreamError(payload.error);
    if (upstreamError) throw new Error(upstreamError);
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new Error(readUpstreamError(payload) || "请求失败");
    }
    // 支持 data / images / results 三种返回字段（兼容不同 API）
    const imageList = payload.data
        || (payload as Record<string, unknown>).images as Array<Record<string, unknown>> | undefined
        || (payload as Record<string, unknown>).results as Array<Record<string, unknown>> | undefined
        || [];
    const images =
        imageList
            .map(resolveImageDataUrl)
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl }));

    if (images.length === 0) {
        // 尝试检查是否有返回了但格式不被识别的数据
        const rawKeys = Object.keys(payload).filter((k) => k !== "code" && k !== "msg" && k !== "error");
        throw new Error(rawKeys.length > 0
            ? `接口返回了未知格式的数据（字段：${rawKeys.join("、")}），请检查模型或接口兼容性`
            : "接口没有返回图片，请检查提示词是否触发安全审核或模型是否支持该操作");
    }

    return images;
}

function grsaiImageSize(resolution: string) {
    return normalizeImageResolution(resolution).toUpperCase();
}

function grsaiAspectRatio(config: AiConfig) {
    const value = config.size.trim();
    if (!value || value.toLowerCase() === "auto") return "auto";
    const dimensions = parseImageDimensions(value);
    return dimensions ? closestGeminiAspectRatio(`${dimensions.width}:${dimensions.height}`) : closestGeminiAspectRatio(value);
}

export function grsaiRequestBody(config: AiConfig, prompt: string, images: string[]) {
    const model = config.model.trim();
    const lowerModel = model.toLowerCase();
    const isGptImage = lowerModel === "gpt-image-2" || lowerModel === "gpt-image-2-vip";
    const isVip = lowerModel === "gpt-image-2-vip";
    const requestSize = resolveRequestSize(config.imageResolution, config.size);
    const aspectRatio = isVip
        ? requestSize || "auto"
        : isGptImage
            ? (config.size.trim().includes(":") ? config.size.trim() : requestSize || "auto")
            : grsaiAspectRatio(config);
    return {
        model,
        prompt: withSystemPrompt(config, prompt),
        images,
        aspectRatio,
        ...(isGptImage ? {} : { imageSize: grsaiImageSize(config.imageResolution) }),
        replyType: "json",
    };
}

export function normalizeGrsaiReference(value: string) {
    const reference = value.trim();
    if (/^https?:\/\//i.test(reference)) return reference;
    const dataUrl = reference.match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i);
    const base64 = (dataUrl?.[1] || reference).replace(/\s+/g, "");
    if (!base64 || !/^[a-z0-9+/]+={0,2}$/i.test(base64)) throw new Error("GRS AI 参考图格式无效，请重新添加图片");
    return base64;
}

export async function grsaiReferenceValue(image: ReferenceImage) {
    const remoteUrl = image.url || image.dataUrl;
    if (!image.storageKey && /^https?:\/\//i.test(remoteUrl)) return remoteUrl;
    return normalizeGrsaiReference(await imageToDataUrl(image));
}

async function requestGrsaiImageOnce(config: AiConfig, prompt: string, images: string[], options?: RequestOptions) {
    try {
        let payload = (await axios.post<GrsaiTaskResponse>(aiApiUrl(config, "/api/generate"), grsaiRequestBody(config, prompt, images), {
            headers: aiHeaders(config, "application/json"),
            signal: options?.signal,
        })).data;
        for (let attempt = 0; payload.status === "running" && payload.id && attempt < 150; attempt += 1) {
            await delay(2000, options?.signal);
            payload = (await axios.get<GrsaiTaskResponse>(aiApiUrl(config, "/api/result"), {
                headers: aiHeaders(config),
                params: { id: payload.id },
                signal: options?.signal,
            })).data;
        }
        if (payload.status === "running") throw new Error("GRS AI 图片生成超时，请稍后在生成记录中重试");
        if (payload.status === "failed" || payload.status === "violation") throw new Error(readApiErrorMessage(payload.error) || payload.msg || (payload.status === "violation" ? "提示词未通过安全审核" : "GRS AI 图片生成失败"));
        return parseImagePayload(payload);
    } catch (error) {
        throw new Error(readAxiosError(error, "GRS AI 图片生成失败"));
    }
}

async function requestGrsaiImages(config: AiConfig, prompt: string, images: string[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGrsaiImageOnce(config, prompt, images, options));
    return persistGeneratedImages((await Promise.all(requests)).flat());
}

async function persistGeneratedImages<T extends { dataUrl: string }>(images: T[]): Promise<Array<T & { localPath?: string }>> {
    const persisted = await Promise.all(
        images.map(async (image): Promise<T & { localPath?: string }> => {
            try {
                // 浏览器 fetch 失败（远程 URL 跨域）时回退主进程下载，保证落盘成功
                const saved = await saveGeneratedBlob("image", await fetchImageBlob(image.dataUrl));
                // 记录本地落盘路径，删除结果图时同步删除本地文件
                return saved ? { ...image, localPath: saved.path } : image;
            } catch (error) {
                // 结果仍会被工作台缓存；本地目录写入失败（含远程 URL 拉取失败）通过全局提示告知用户。
                notifyStorageError(error);
                return image;
            }
        }),
    );
    return persisted;
}

async function persistGeneratedText(text: string) {
    await saveGeneratedText(text);
    return text;
}

function readApiErrorMessage(value: unknown): string {
    return readUpstreamError(value);
}

function readAxiosError(error: unknown, fallback: string) {
    return readRequestError(error, fallback, readStatusError);
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    if (status === 404) return "接口地址不存在（404），请检查 Base URL 和模型选择";
    if (status === 502) return "网关错误（502），接口服务暂时不可用，请稍后重试";
    if (status === 503) return "服务繁忙（503），请稍后重试";
    return status ? `请求失败（HTTP ${status}），请检查 Base URL 和 API Key 是否正确` : fallback;
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function geminiBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: Pick<AiConfig, "baseUrl" | "model">, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    if (!action) return `${baseUrl}/models`;
    return `${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`;
}

function geminiHeaders(config: Pick<AiConfig, "apiKey">) {
    return {
        "x-goog-api-key": config.apiKey,
        "Content-Type": "application/json",
    };
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [message];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function parseToolResponse(payload: ResponseApiPayload): ToolResponseResult {
    const output = payload.output || [];
    const content =
        payload.output_text ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    const toolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: item.call_id || item.id || "",
            type: "function" as const,
            function: { name: item.name || "", arguments: item.arguments || "{}" },
        }))
        .filter((item) => item.id && item.function.name);
    return { content, toolCalls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readUpstreamError(payload) || "请求失败");
    if (payload.error?.message) throw new Error(readUpstreamError(payload.error) || payload.error.message);
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(`Gemini 拒绝了本次请求：${payload.promptFeedback.blockReason}`);
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    const message = text ? readUpstreamError(text) || readStatusError(response.status, fallback) : readStatusError(response.status, fallback);
    const requestId = response.headers.get("x-request-id") || response.headers.get("x-tt-logid") || response.headers.get("x-volc-request-id");
    return requestId ? `${message}（请求 ID ${requestId}）` : message;
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
        event = JSON.parse(data) as Record<string, unknown>;
    } catch {
        // 非 JSON 的 data: 行（如代理的 ping/注释）直接忽略，避免中断整个流
        return;
    }
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        // 回调传增量文本，与 SDK 的“流式增量回调”约定一致（GRS 分支同样传增量）
        onDelta?.(event.delta);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta?.(event.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeResponseStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    if (config.apiFormat === "ark") {
        const state: ResponseStreamState = { buffer: "", text: "" };
        let rawText = "";
        let receivedChunks = false;
        const complete = await arkStreamText(config, "/responses", { ...body, stream: true }, (chunk) => {
            receivedChunks = true;
            rawText += chunk;
            consumeResponseStreamText(state, chunk, onDelta);
        }, options);
        if (!receivedChunks) {
            rawText = complete;
            consumeResponseStreamText(state, complete, onDelta, true);
        } else {
            consumeResponseStreamText(state, "", onDelta, true);
        }
        if (state.error) throw new Error(state.error);
        if (!state.payload && !state.text && rawText.trim()) {
            try {
                const payload = JSON.parse(rawText) as ResponseApiPayload;
                validateResponsePayload(payload);
                return parseToolResponse(payload);
            } catch {
                // 非 SSE/JSON 时与其他渠道保持相同的空响应回退。
            }
        }
        if (!state.payload) return { content: state.text, toolCalls: [] };
        validateResponsePayload(state.payload);
        const result = parseToolResponse(state.payload);
        return { ...result, content: state.text || result.content };
    }
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    if (!response.body) {
        const payload = (await response.json()) as ResponseApiPayload;
        validateResponsePayload(payload);
        return parseToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "" };
    let rawText = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        rawText += chunk;
        consumeResponseStreamText(state, chunk, onDelta);
        if (state.error) throw new Error(state.error);
    }
    const tail = decoder.decode();
    rawText += tail;
    consumeResponseStreamText(state, tail, onDelta, true);
    if (state.error) throw new Error(state.error);
    if (!state.payload && !state.text && rawText.trim()) {
        // 部分代理忽略 stream 参数直接返回 JSON：回退解析，避免静默丢失内容
        try {
            const payload = JSON.parse(rawText) as ResponseApiPayload;
            validateResponsePayload(payload);
            return parseToolResponse(payload);
        } catch {
            // 既非 SSE 事件也非 JSON 时保持原行为，由调用方兜底提示
        }
    }
    if (!state.payload) return { content: state.text, toolCalls: [] };
    validateResponsePayload(state.payload);
    const result = parseToolResponse(state.payload);
    return { ...result, content: state.text || result.content };
}

function chatText(content: string | Array<{ text?: string }> | undefined) {
    if (typeof content === "string") return content;
    return (content || []).map((item) => item.text || "").join("");
}

function consumeGrsaiChatBlock(block: string, onDelta: (text: string) => void) {
    const line = block.split(/\r?\n/).find((item) => item.startsWith("data:"));
    if (!line) return "";
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return "";
    try {
        const payload = JSON.parse(data) as OpenAiChatPayload;
        if (payload.error?.message || payload.message) throw new Error(payload.error?.message || payload.message);
        const delta = chatText(payload.choices?.[0]?.delta?.content);
        if (delta) onDelta(delta);
        return delta;
    } catch (error) {
        if (error instanceof SyntaxError) return "";
        throw error;
    }
}

async function requestGrsaiChat(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const body = { model: config.model, stream: true, messages: withSystemMessage(config, messages) };
    const response = await fetch(aiApiUrl(config, "/chat/completions"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "GRS AI 文本请求失败"));
    if (!response.body) {
        const payload = (await response.json()) as OpenAiChatPayload;
        if (payload.error?.message || payload.message) throw new Error(payload.error?.message || payload.message);
        const text = chatText(payload.choices?.[0]?.message?.content) || "没有返回内容";
        onDelta(text);
        return text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let rawText = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        rawText += chunk;
        buffer += chunk;
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || "";
        for (const block of blocks) text += consumeGrsaiChatBlock(block, onDelta);
    }
    const tail = decoder.decode();
    rawText += tail;
    buffer += tail;
    if (buffer.trim()) text += consumeGrsaiChatBlock(buffer, onDelta);
    if (!text && rawText.trim()) {
        // 部分代理忽略 stream 参数直接返回 JSON：回退解析，避免静默丢失内容
        try {
            const payload = JSON.parse(rawText) as OpenAiChatPayload;
            if (payload.error?.message || payload.message) throw new Error(payload.error?.message || payload.message);
            const answer = chatText(payload.choices?.[0]?.message?.content);
            if (answer) {
                onDelta(answer);
                return answer;
            }
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    }
    return text || "没有返回内容";
}

function toGeminiBody(config: AiConfig, messages: ResponseInputMessage[], extra?: Record<string, unknown>) {
    const systemText = [
        config.systemPrompt.trim(),
        ...messages.flatMap((message) => (!("type" in message) && message.role === "system" ? [geminiTextContent(message.content)] : [])),
    ]
        .filter(Boolean)
        .join("\n\n");
    const contents = toGeminiContents(messages.filter((message) => ("type" in message ? true : message.role !== "system")));
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

function toGeminiContents(messages: ResponseInputMessage[]): GeminiContent[] {
    const callNameById = new Map<string, string>();
    return messages.flatMap((message): GeminiContent[] => {
        if ("type" in message) {
            callNameById.set(message.call_id, message.name);
            return [{ role: "model", parts: [{ functionCall: { id: message.call_id, name: message.name, args: jsonObject(message.arguments) }, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }] }];
        }
        if (message.role === "tool") {
            const name = callNameById.get(message.tool_call_id) || "tool_result";
            return [{ role: "user", parts: [{ functionResponse: { id: message.tool_call_id, name, response: { result: jsonValue(message.content) } } }] }];
        }
        return [{ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }];
    });
}

function toGeminiParts(content: ResponseMessageContent): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: ResponseMessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function jsonObject(value: string): Record<string, unknown> {
    const parsed = jsonValue(value);
    return isRecord(parsed) ? parsed : {};
}

function jsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toGeminiToolOptions(tools: ResponseFunctionTool[], toolChoice: ToolChoice) {
    if (!tools.length) return {};
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const functionCallingConfig =
        typeof toolChoice === "object"
            ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] }
            : { mode: toolChoice === "required" ? "ANY" : "AUTO" };
    return {
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig },
    };
}

async function requestGeminiStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(`${geminiApiUrl(config, "streamGenerateContent")}?alt=sse`, {
        method: "POST",
        headers: geminiHeaders(config),
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, "请求失败"));
    if (!response.body) {
        const payload = (await response.json()) as GeminiPayload;
        return parseGeminiToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
    let rawText = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        rawText += chunk;
        consumeGeminiStreamText(state, chunk, onDelta);
        if (state.error) throw new Error(state.error);
    }
    const tail = decoder.decode();
    rawText += tail;
    consumeGeminiStreamText(state, tail, onDelta, true);
    if (state.error) throw new Error(state.error);
    if (!state.text && !state.toolCalls.length && rawText.trim()) {
        // 部分代理忽略 alt=sse 直接返回 JSON：回退解析，避免静默丢失内容
        try {
            return parseGeminiToolResponse(JSON.parse(rawText) as GeminiPayload);
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    }
    return { content: state.text, toolCalls: state.toolCalls };
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeGeminiStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function consumeGeminiStreamBlock(block: string, state: GeminiStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    let payload: GeminiPayload;
    try {
        payload = JSON.parse(data) as GeminiPayload;
    } catch {
        // 非 JSON 的 data: 行直接忽略，避免中断整个流
        return;
    }
    const result = parseGeminiToolResponse(payload);
    if (result.content) {
        state.text += result.content;
        // 回调传增量文本，与 SDK 的“流式增量回调”约定一致
        onDelta?.(result.content);
    }
    state.toolCalls.push(...result.toolCalls);
}

function parseGeminiToolResponse(payload: GeminiPayload): ToolResponseResult {
    validateGeminiPayload(payload);
    const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
    const content = parts.map((part) => part.text || "").join("");
    const toolCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name))
        .map((call) => {
            const part = parts.find((item) => item.functionCall === call);
            const thoughtSignature = part?.thoughtSignature || part?.thought_signature;
            return {
                id: call.id || nanoid(),
                type: "function" as const,
                function: { name: call.name || "", arguments: JSON.stringify(call.args || {}) },
                ...(thoughtSignature ? { thoughtSignature } : {}),
            };
        });
    return { content, toolCalls };
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGeminiImagesOnce(config, prompt, references, options));
    return persistGeneratedImages((await Promise.all(requests)).flat());
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const image of references) {
        parts.push(toGeminiImagePart(await imageToDataUrl(image)));
    }
    const response = await axios.post<GeminiPayload>(
        geminiApiUrl(config, "generateContent"),
        {
            ...toGeminiBody(config, [{ role: "user", content: prompt }], { generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...resolveGeminiImageConfig(config) } }),
            contents: [{ role: "user", parts }],
        },
        { headers: geminiHeaders(config), signal: options?.signal },
    );
    return parseGeminiImagePayload(response.data);
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return part.fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new Error("Gemini 接口没有返回图片");
    return images;
}

function agnesImageSize(config: AiConfig) {
    const resolution = normalizeImageResolution(config.imageResolution);
    if (resolution === "8k") throw new Error("Agnes Image 2.1 官方最高支持 4K，请选择 4K 或更低分辨率");
    const size = config.size.trim();
    // auto：不传 size，由接口按提示词自动决定宽高比（不再回退 1:1 正方形）
    if (!size || size.toLowerCase() === "auto") return undefined;
    return resolveRequestSize(resolution, size);
}

/** 目标是否为 Agnes 端点：apiFormat 为 agnes，或 baseUrl 指向 Agnes 主机（兼容以 openai 格式配置的 Agnes 渠道）。 */
function isAgnesTarget(requestConfig: AiConfig) {
    if (requestConfig.apiFormat === "agnes") return true;
    try {
        return new URL(requestConfig.baseUrl).hostname.includes("agnes");
    } catch {
        return false;
    }
}

async function requestAgnesImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const images = await Promise.all(references.map(imageToDataUrl));
    const size = agnesImageSize(config);
    const makeRequest = async () => {
        const response = await axios.post<ImageApiResponse>(aiApiUrl(config, "/images/generations"), {
            model: config.model,
            prompt: withSystemPrompt(config, prompt),
            ...(size ? { size } : {}),
            return_base64: true,
            ...(images.length ? { image: images } : {}),
        }, { headers: aiHeaders(config, "application/json"), signal: options?.signal });
        return parseImagePayload(response.data);
    };
    return persistGeneratedImages((await Promise.all(Array.from({ length: count }, makeRequest))).flat());
}

/** Seedream uses the Ark image endpoint for both text-to-image and reference-image editing. */
async function requestArkImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const images = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const size = resolveRequestSize(config.imageResolution, config.size);
    try {
        const payload = await arkRequestJson<ImageApiResponse>(config, "/images/generations", {
            method: "POST",
            body: buildArkImageRequest(config, withSystemPrompt(config, prompt), count, size, images),
        }, options);
        return persistGeneratedImages(parseImagePayload(payload));
    } catch (error) {
        throw new Error(readAxiosError(error, "方舟图片生成失败"));
    }
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script) {
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(config.imageResolution, config.size);
        const background = normalizeBackground(config.background);
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, prompt),
                images: [],
                params: { size: requestSize, quality, resolution: normalizeImageResolution(config.imageResolution), count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return persistGeneratedImages(normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl })));
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    if (requestConfig.apiFormat === "grsai") {
        return await requestGrsaiImages(requestConfig, prompt, [], n, options);
    }
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, prompt, [], n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    if (requestConfig.apiFormat === "ark") return requestArkImages(requestConfig, prompt, [], n, options);
    if (isAgnesTarget(requestConfig)) return requestAgnesImages(requestConfig, prompt, [], n, options);
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(config.imageResolution, config.size);
    const background = normalizeBackground(config.background);
    try {
        const response = await axios.post<ImageApiResponse>(
            aiApiUrl(requestConfig, "/images/generations"),
            {
                model: requestConfig.model,
                prompt: withSystemPrompt(requestConfig, prompt),
                n,
                ...(quality ? { quality } : {}),
                ...(requestSize ? { size: requestSize } : {}),
                ...(background ? { background } : {}),
                response_format: "b64_json",
                output_format: IMAGE_OUTPUT_FORMAT,
            },
            {
                headers: aiHeaders(requestConfig, "application/json"),
                signal: options?.signal,
            },
        );
        return persistGeneratedImages(parseImagePayload(response.data));
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script) {
        if (mask) throw new Error("当前模型脚本不支持蒙版编辑，请移除蒙版后使用参考图编辑");
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(config.imageResolution, config.size);
        const background = normalizeBackground(config.background);
        const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, requestPrompt),
                images: refs,
                params: { size: requestSize, quality, resolution: normalizeImageResolution(config.imageResolution), count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return persistGeneratedImages(normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl })));
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    if (requestConfig.apiFormat === "grsai") {
        if (mask) throw new Error("GRS AI 当前接口不支持蒙版编辑，请移除蒙版后使用参考图编辑");
        const refs = await Promise.all(references.map(grsaiReferenceValue));
        return await requestGrsaiImages(requestConfig, requestPrompt, refs, n, options);
    }
    if (requestConfig.apiFormat === "gemini") {
        if (mask) throw new Error("Gemini 调用格式暂不支持蒙版编辑");
        try {
            return await requestGeminiImages(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    if (isAgnesTarget(requestConfig)) {
        if (mask) throw new Error("Agnes 图片接口不支持蒙版参数；请使用全图修复或生成式高清");
        return requestAgnesImages(requestConfig, requestPrompt, references, n, options);
    }

    if (requestConfig.apiFormat === "ark") {
        if (mask) throw new Error("火山方舟 Seedream 暂未提供蒙版接口；请移除蒙版后使用参考图编辑，或切换支持蒙版的渠道");
        return requestArkImages(requestConfig, requestPrompt, references, n, options);
    }

    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(config.imageResolution, config.size);
    const background = normalizeBackground(config.background);
    const formData = new FormData();
    formData.set("model", requestConfig.model);
    formData.set("prompt", withSystemPrompt(requestConfig, requestPrompt));
    formData.set("n", String(n));
    formData.set("response_format", "b64_json");
    formData.set("output_format", IMAGE_OUTPUT_FORMAT);
    if (quality) {
        formData.set("quality", quality);
    }
    if (requestSize) {
        formData.set("size", requestSize);
    }
    if (background) {
        formData.set("background", background);
    }
    const files = await Promise.all(references.map(imageToFile));
    files.forEach((file) => formData.append("image", file));
    if (mask) formData.set("mask", dataUrlToFile(mask));

    try {
        const response = await axios.post<ImageApiResponse>(aiApiUrl(requestConfig, "/images/edits"), formData, { headers: aiHeaders(requestConfig), signal: options?.signal });
        return persistGeneratedImages(parseImagePayload(response.data));
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    const script = resolveModelScript(config, config.model || config.textModel);
    if (script) {
        try {
            const answer = await runModelPlugin<string>({
                capability: "text",
                script,
                config: requestConfig,
                messages: withSystemMessage(requestConfig, messages),
                signal: options?.signal,
                onDelta,
            });
            const text = String(answer ?? "").trim() || "没有返回内容";
            if (text === "没有返回内容") onDelta(text);
            return persistGeneratedText(text);
        } catch (error) {
            throw new Error(readAxiosError(error, "请求失败"));
        }
    }
    try {
        if (requestConfig.apiFormat === "grsai") {
            const answer = await requestGrsaiChat(requestConfig, messages, onDelta, options);
            return persistGeneratedText(answer || "没有返回内容");
        }
        if (requestConfig.apiFormat === "gemini") {
            const answer = (await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages), onDelta, options)).content || "没有返回内容";
            if (answer === "没有返回内容") onDelta(answer);
            return persistGeneratedText(answer);
        }
        if (requestConfig.apiFormat === "agnes") {
            const response = await axios.post<OpenAiChatPayload>(aiApiUrl(requestConfig, "/chat/completions"), {
                model: requestConfig.model,
                messages: withSystemMessage(requestConfig, messages),
                stream: false,
                ...(requestConfig.reasoningEffort === "auto" ? {} : { chat_template_kwargs: { enable_thinking: true } }),
            }, { headers: aiHeaders(requestConfig, "application/json"), signal: options?.signal });
            const answer = chatText(response.data.choices?.[0]?.message?.content) || "没有返回内容";
            onDelta(answer);
            return persistGeneratedText(answer);
        }
        if (requestConfig.apiFormat === "ark") {
            const answer = (await requestStreamingResponse(requestConfig, buildArkResponsesRequest(
                requestConfig,
                toResponseInput(withSystemMessage(requestConfig, messages)),
            ), onDelta, options)).content || "没有返回内容";
            if (answer === "没有返回内容") onDelta(answer);
            return persistGeneratedText(answer);
        }
        const answer = (await requestStreamingResponse(requestConfig, {
            model: requestConfig.model,
            input: toResponseInput(withSystemMessage(requestConfig, messages)),
            ...(requestConfig.reasoningEffort === "auto" ? {} : { reasoning: { effort: requestConfig.reasoningEffort } }),
        }, onDelta, options)).content || "没有返回内容";
        if (answer === "没有返回内容") onDelta(answer);
        return persistGeneratedText(answer);
    } catch (error) {
        throw new Error(readAxiosError(error, "请求失败"));
    }
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat">): Promise<FetchedChannelModel[]> {
    try {
        if (config.apiFormat === "grsai") return GRSAI_DEFAULT_MODELS.map(catalogModelFromPreset);
        if (config.apiFormat === "gemini") {
            const response = await axios.get<GeminiPayload>(geminiApiUrl({ ...defaultGeminiConfig, ...config }), { headers: geminiHeaders({ ...defaultGeminiConfig, ...config }) });
            validateGeminiPayload(response.data);
            return catalogModelsFromRecords(response.data.models || []);
        }
        if (config.apiFormat === "ark" && /\/api\/plan\/v3(?:\/|$)/i.test(config.baseUrl)) {
            throw new Error("Agent Plan 不提供模型列表接口，请按套餐可用模型手动增加模型 ID");
        }
        if (config.apiFormat === "ark") {
            const payload = await arkRequestJson<{ data?: Array<Record<string, unknown>>; error?: { message?: string } }>(config, "/models");
            return catalogModelsFromRecords(payload.data || []);
        }
        const response = await axios.get<{ data?: Array<Record<string, unknown>>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
        });
        const models = catalogModelsFromRecords(response.data.data || []);
        return models.length || config.apiFormat !== "agnes" ? models : AGNES_DEFAULT_MODELS.map(catalogModelFromPreset);
    } catch (error) {
        if (config.apiFormat === "agnes") return AGNES_DEFAULT_MODELS.map(catalogModelFromPreset);
        throw new Error(readAxiosError(error, "读取模型失败"));
    }
}

export async function fetchChannelModels(channel: ModelChannel) {
    return fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat });
}

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
