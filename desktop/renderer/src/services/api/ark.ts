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

type ArkProxyResponse = { status: number; headers: Record<string, string>; data: string };
type ArkRequestOptions = { signal?: AbortSignal };

function arkRequestId() {
    return globalThis.crypto?.randomUUID?.() || `ark-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function arkRequestError(response: ArkProxyResponse, fallback: string) {
    let message = fallback;
    try {
        const payload = JSON.parse(response.data) as { error?: { message?: string; code?: string | number }; message?: string; msg?: string; code?: string | number };
        message = payload.error?.message || payload.message || payload.msg || fallback;
        const code = payload.error?.code ?? payload.code;
        if (code !== undefined && code !== 0) message = `${message}（上游代码 ${code}）`;
    } catch {
        // 失败响应不一定为 JSON，仍保留 HTTP 状态与请求 ID。
    }
    const requestId = response.headers["x-request-id"] || response.headers["x-tt-logid"] || response.headers["x-volc-request-id"];
    return `${message}（HTTP ${response.status}${requestId ? `，请求 ID ${requestId}` : ""}）`;
}

function desktopBridge() {
    return window.lySpaceDesktop;
}

/** Desktop Ark calls are relayed by the Electron main process so browser CORS never gates them. */
export async function arkRequestText(config: Pick<AiConfig, "baseUrl" | "apiKey">, path: string, init: { method?: string; body?: unknown } = {}, options?: ArkRequestOptions) {
    const request = {
        kind: "ark" as const,
        method: init.method || "GET",
        url: arkApiUrl(config, path),
        headers: arkHeaders(config, init.body === undefined ? undefined : "application/json"),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    };
    const bridge = desktopBridge();
    if (bridge) {
        if (options?.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        const requestId = arkRequestId();
        const abort = () => { void bridge.cancelProxyRequest(requestId); };
        options?.signal?.addEventListener("abort", abort, { once: true });
        let response: ArkProxyResponse;
        try {
            response = await bridge.proxyRequest({ ...request, requestId });
        } finally {
            options?.signal?.removeEventListener("abort", abort);
        }
        if (response.status < 200 || response.status >= 300) throw new Error(arkRequestError(response, "方舟请求失败"));
        return response;
    }
    // 浏览器开发环境没有主进程 IPC，仍可直连，部署环境应使用桌面端以避免 CORS 限制。
    try {
        const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: options?.signal });
        const data = await response.text();
        const proxyResponse = { status: response.status, headers: Object.fromEntries(response.headers.entries()), data };
        if (!response.ok) throw new Error(arkRequestError(proxyResponse, "方舟请求失败"));
        return proxyResponse;
    } catch (error) {
        if (error instanceof TypeError) throw new Error("方舟浏览器直连失败，开发环境可能受 CORS 限制；请使用桌面端验证");
        throw error;
    }
}

export async function arkRequestJson<T>(config: Pick<AiConfig, "baseUrl" | "apiKey">, path: string, init: { method?: string; body?: unknown } = {}, options?: ArkRequestOptions): Promise<T> {
    const response = await arkRequestText(config, path, init, options);
    try {
        return JSON.parse(response.data) as T;
    } catch {
        throw new Error("方舟接口返回了无效 JSON 响应");
    }
}

/** Streams SSE chunks through IPC on desktop; complete JSON remains available when an upstream ignores stream=true. */
export async function arkStreamText(config: Pick<AiConfig, "baseUrl" | "apiKey">, path: string, body: unknown, onChunk: (text: string) => void, options?: ArkRequestOptions) {
    const bridge = desktopBridge();
    if (!bridge) return (await arkRequestText(config, path, { method: "POST", body }, options)).data;
    if (options?.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    const requestId = arkRequestId();
    let streamError = "";
    const unsubscribe = bridge.onProxyStreamEvent((event) => {
        if (event.requestId === requestId && event.type === "chunk" && event.data) onChunk(event.data);
        if (event.requestId === requestId && event.type === "error") streamError = event.error || "方舟流式请求失败";
    });
    const abort = () => { void bridge.cancelProxyStream(requestId); };
    options?.signal?.addEventListener("abort", abort, { once: true });
    try {
        const response = await bridge.proxyStreamRequest({
            kind: "ark",
            requestId,
            method: "POST",
            url: arkApiUrl(config, path),
            headers: { ...arkHeaders(config, "application/json"), Accept: "text/event-stream" },
            body: JSON.stringify(body),
        });
        if (streamError) throw new Error(streamError);
        if (response.status < 200 || response.status >= 300) throw new Error(arkRequestError(response, "方舟文本请求失败"));
        return response.data;
    } finally {
        unsubscribe();
        options?.signal?.removeEventListener("abort", abort);
    }
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
