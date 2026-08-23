import axios from "axios";
import { nanoid } from "nanoid";

import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { saveGeneratedBlob } from "@/services/desktop-storage";
import { hostReferenceImage } from "@/services/image-hosting";
import { imageToDataUrl, imageToFile } from "@/services/image-storage";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import { readRequestError, readUpstreamError } from "./error-message";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; video_id?: string; task_id?: string; status?: string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; metadata?: { url?: string; video_url?: string; duration?: number; width?: number; height?: number } | null; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "completed" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
    url?: string;
    result_url?: string;
    video_url?: string;
};
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "agnes" | "plugin"; model: string; videoId?: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    const delayMs = task.provider === "seedance" ? 5000 : task.provider === "agnes" ? 10000 : 2500;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === 119) throw new Error(`${task.provider === "seedance" ? "Seedance " : task.provider === "agnes" ? "Agnes " : ""}视频生成超时，请稍后重试`);
        await delay(delayMs, options?.signal);
    }
    throw new Error("视频生成超时，请稍后重试");
}

// Agnes 只接受公网 HTTPS 参考图：本地图自动托管（OSS/免费图床），托管失败时明确报错引导
async function ensurePublicReferenceUrlsForRequest(refs: ReferenceImage[]): Promise<ReferenceImage[]> {
    const localRefs = refs.filter((item) => !/^https:\/\//i.test(item.url || item.dataUrl || ""));
    if (!localRefs.length) return refs;
    const hosted = await Promise.all(
        localRefs.map(async (item) => {
            try {
                return await hostReferenceImage(item);
            } catch (error) {
                throw new Error(error instanceof Error ? `${error.message}；Agnes 生成需参考图为公网可访问地址` : "参考图片无法托管，请改用公网 HTTPS 图片 URL");
            }
        }),
    );
    const hostedById = new Map(hosted.map((item) => [item.id, item]));
    return refs.map((item) => hostedById.get(item.id) || item);
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (isSeedanceVideoConfig(requestConfig)) {
        return createSeedanceTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    }
    if (requestConfig.apiFormat === "agnes") {
        // Agnes 只接受公网 HTTPS 参考图：本地图片自动托管（OSS 优先，未配置时免费图床兜底），覆盖页面/画布/重试所有路径
        const publicReferences = await ensurePublicReferenceUrlsForRequest(references);
        return createAgnesVideoTask(requestConfig, selectedModel, prompt, publicReferences, videoReferences, audioReferences, options);
    }
    if (videoReferences.length || audioReferences.length) {
        throw new Error("当前视频接口不支持参考视频或参考音频，请切换到 Seedance 2.0 / 火山 Agent Plan 模型，或移除参考资产");
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        if (!result) return { status: "failed", error: "插件视频任务已失效，请重新生成" };
        pluginVideoResults.delete(task.id);
        return { status: "completed", result };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "seedance") return pollSeedanceTask(requestConfig, task, options);
    if (task.provider === "agnes") return pollAgnesVideoTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

// Agnes 请求：axios 优先；网络层失败（CORS/连接等，无 response）时自动回退主进程代理重试
async function agnesRequest<T>(config: AiConfig, url: string, options: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<T> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
        const response = await axios.request<T>({
            method: options.method,
            url,
            headers: options.headers,
            data: options.body ? JSON.parse(options.body) : undefined,
            signal: options.signal,
        });
        return response.data;
    } catch (error) {
        if (axios.isAxiosError(error) && !error.response && window.lySpaceDesktop && !options.signal?.aborted) {
            const proxied = await window.lySpaceDesktop.proxyRequest({ method: options.method, url, headers: options.headers, body: options.body });
            let data: unknown = proxied.data;
            try {
                data = JSON.parse(proxied.data);
            } catch {
                // 保留原始文本
            }
            if (proxied.status >= 400) {
                // 构造兼容的 AxiosError，让 readAxiosError 正常提取错误信息
                const fakeResponse = { data, status: proxied.status, statusText: "", headers: {}, config: {} } as never;
                throw new axios.AxiosError("请求失败", String(proxied.status), undefined, undefined, fakeResponse);
            }
            return data as T;
        }
        throw error;
    }
}

function agnesFrames(seconds: string, frameRate = 24) {
    const fps = Math.max(1, Math.min(60, Number(frameRate) || 24));
    const desired = Math.max(1, Math.min(18, Number(seconds) || 6)) * fps;
    return Math.max(9, Math.min(441, Math.round((Math.min(desired, 441) - 1) / 8) * 8 + 1));
}

function agnesPublicImageUrl(image: ReferenceImage) {
    const url = image.url || image.dataUrl;
    if (!/^https:\/\//i.test(url)) throw new Error("Agnes 视频只接受公网 HTTPS 参考图片 URL。本地图片、Blob 和 Base64 无法直接发送；请先添加公网图片 URL。");
    return url;
}

async function createAgnesVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (videoReferences.length || audioReferences.length) throw new Error("Agnes Video 当前不支持参考视频或参考音频，请移除这些参考资产后生成。");
    const urls = references.map(agnesPublicImageUrl);
    const frameRate = Math.max(1, Math.min(60, Number(config.videoFrameRate) || 24));
    const numFrames = agnesFrames(config.videoSeconds, frameRate);
    // size 为 auto 时不发送 width/height（文档参数可选，由服务端按默认规格处理）
    const size = normalizeVideoSize(config.size);
    const [width, height] = size && size !== "auto" ? size.split("x").map(Number) : [undefined, undefined];
    const hasSize = Boolean(size && size !== "auto" && width && height && width > 0 && height > 0);
    const seed = (config.videoSeed || "").trim();
    const seedNumber = Number(seed);
    const negativePrompt = (config.videoNegativePrompt || "").trim();
    const steps = (config.videoNumInferenceSteps || "").trim();
    const stepsNumber = Number(steps);
    try {
        const url = aiApiUrl(config, "/videos");
        const body = JSON.stringify({
            model: modelOptionName(model),
            prompt,
            ...(hasSize ? { width, height } : {}),
            num_frames: numFrames,
            frame_rate: frameRate,
            ...(seed && Number.isInteger(seedNumber) ? { seed: seedNumber } : {}),
            ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
            ...(steps && Number.isInteger(stepsNumber) && stepsNumber > 0 ? { num_inference_steps: stepsNumber } : {}),
            ...(urls.length === 1 ? { image: urls[0] } : urls.length > 1 ? { mode: "keyframes", extra_body: { image: urls, mode: "keyframes" } } : {}),
        });
        const data = await agnesRequest<ApiEnvelope<VideoResponse>>(config, url, { method: "POST", headers: aiHeaders(config, "application/json"), body, signal: options?.signal });
        const created = unwrapEnvelope(data, "Agnes 接口没有返回视频任务");
        // 文档推荐用 video_id 查询结果；旧接口可能只返回 id，回退兼容
        const videoId = created.video_id || created.id;
        if (!videoId) throw new Error("Agnes 接口没有返回 video_id");
        return { id: videoId, videoId, provider: "agnes", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "Agnes 视频任务创建失败"));
    }
}

async function pollAgnesVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        // 文档：结果查询为 GET /agnesapi（不带 /v1）；baseUrl 可能带 /v1 尾缀，先归一化
        const base = config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
        const url = `${base}/agnesapi`;
        const query = `video_id=${encodeURIComponent(task.videoId || task.id)}&model_name=${encodeURIComponent(modelOptionName(task.model))}`;
        const payload = await agnesRequest<ApiEnvelope<VideoResponse>>(config, `${url}?${query}`, { method: "GET", headers: aiHeaders(config), signal: options?.signal });
        const state = unwrapEnvelope(payload, "Agnes 接口没有返回视频任务");
        const resultUrl = videoResultUrl(state) || state.metadata?.url || state.metadata?.video_url;
        if (resultUrl) return { status: "completed", result: await videoResultFromUrl(resultUrl, options) };
        if (["failed", "cancelled", "error"].includes((state.status || "").toLowerCase())) return { status: "failed", error: readApiErrorMessage(state.error) || "Agnes 视频生成失败" };
        return { status: "pending" };
    } catch (error) {
        // 限流（429 / rate limit）时视为暂时不可查询，返回 pending 由轮询层稍后重试，不中断生成
        if (axios.isAxiosError(error) && (error.response?.status === 429 || /rate limit/i.test(`${error.response?.data?.message || ""} ${error.message}`))) {
            return { status: "pending" };
        }
        throw new Error(readAxiosError(error, "Agnes 视频任务查询失败"));
    }
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error("模型调用脚本没有返回视频");
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) {
        const stored = await uploadMediaFile(result.blob, "video");
        await saveGeneratedBlob("video", result.blob);
        return stored;
    }
    if (result.url) {
        try {
            let blob: Blob;
            try {
                const response = await fetch(result.url);
                if (!response.ok) throw new Error(`视频下载失败：HTTP ${response.status}`);
                blob = await response.blob();
            } catch {
                if (!window.lySpaceDesktop) throw new Error("视频跨域下载失败，且桌面下载服务不可用");
                const fetched = await window.lySpaceDesktop.fetchUrl(result.url, "video");
                blob = new Blob([fetched.bytes], { type: fetched.mimeType || result.mimeType || "video/mp4" });
            }
            const stored = await uploadMediaFile(blob, "video");
            await saveGeneratedBlob("video", blob);
            return stored;
        } catch {
            // 服务端视频仍可播放；本地下载失败时不伪造已缓存状态。
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error("视频接口没有返回可播放的视频");
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(imageToFile));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务创建失败"));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error) || "视频生成失败" };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "视频任务查询失败"));
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error("请输入视频提示词，或连接参考图片/视频/音频");
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error("Seedance 接口没有返回任务 ID");
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务创建失败"));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(state);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (state.status === "succeeded" || state.status === "completed") return { status: "failed", error: "Seedance 任务成功但没有返回视频 URL" };
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: readApiErrorMessage(state.error) || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}` };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, "Seedance 任务查询失败"));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error("Seedance 参考视频单个时长需要在 2-15 秒之间");
        total += video.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考视频总时长不能超过 15 秒");
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error("Seedance 参考音频单个时长需要在 2-15 秒之间");
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考音频总时长不能超过 15 秒");
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    return dataUrl;
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("参考视频必须是公网 URL、资产 ID，或本地已保存的视频");
    return blobToDataUrl(blob);
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("参考音频必须是公网 URL、资产 ID，或本地已保存的音频");
    return blobToDataUrl(blob);
}

async function videoResultFromUrl(url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini" || config.apiFormat === "grsai") throw new Error("当前渠道暂不支持视频生成，请使用 OpenAI 格式渠道或为模型配置调用脚本");
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, "接口没有返回视频任务");
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, "Seedance 接口没有返回任务");
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || "请求失败");
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse | SeedanceTask) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
}

function readApiErrorMessage(value: unknown): string {
    return readUpstreamError(value);
}

function readAxiosError(error: unknown, fallback: string) {
    return readRequestError(error, fallback, statusMessage);
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || "视频下载失败");
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取本地资产失败"));
        reader.readAsDataURL(blob);
    });
}
