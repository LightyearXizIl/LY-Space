import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, Download, FolderPlus, History, LoaderCircle, Music2, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, VideoIcon, Wand2 } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type DragEvent } from "react";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, Modal, Tag, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CameraTrigger } from "@/components/camera-trigger";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoSettingsPanel, normalizeVideoResolutionValue, normalizeVideoSizeValue, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildCameraPrompt, formatCameraSelection, normalizeCameraSelection, type CameraSelection } from "@/lib/camera";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { boolConfig, isSeedanceVideoConfig, normalizeSeedanceRatio, seedanceReferenceLabel, seedanceVideoReferenceError, seedanceVideoReferenceHint, SEEDANCE_REFERENCE_LIMITS, SEEDANCE_VIDEO_MIME_TYPES } from "@/lib/seedance-video";
import { deleteStoredMedia, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { imageToDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo, type VideoGenerationTask } from "@/services/api/video";
import { requestImageQuestion } from "@/services/api/image";
import { useAssetStore } from "@/stores/use-asset-store";
import { modelOptionLabel, resolveModelRequestConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { loadWorkbenchSession, saveWorkbenchSession } from "@/services/workbench-session";
import { trackWrite } from "@/services/desktop-storage";
import { acknowledgeReferenceHandoff, getReferenceHandoffs } from "@/services/reference-handoff";
import { hostImageOnOss } from "@/services/oss-hosting";
import { hostReferenceImage } from "@/services/image-hosting";

type GeneratedVideo = {
    id: string;
    url: string;
    storageKey: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    camera?: CameraSelection;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    videoReferences: ReferenceVideo[];
    audioReferences: ReferenceAudio[];
    durationMs: number;
    size: string;
    resolution: string;
    seconds: string;
    status: "生成中" | "成功" | "失败";
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:video_generation_logs";
const SESSION_STORE_KEY = "video-workbench:current-session";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });

// 模块级：进行中的视频任务轮询集合（跨组件共享，防止切页返回后重复轮询同一任务）
const activeVideoLogIds = new Set<string>();
// 任务完成通知：切页期间任务在后台完成后通知新挂载的组件刷新日志
const videoTaskListeners = new Set<() => void>();
function emitVideoTaskUpdate() {
    videoTaskListeners.forEach((listener) => listener());
}
function subscribeVideoTaskUpdate(listener: () => void) {
    videoTaskListeners.add(listener);
    return () => {
        videoTaskListeners.delete(listener);
    };
}

export default function VideoPage() {
    const { message } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [camera, setCamera] = useState<CameraSelection>({});
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [videoReferences, setVideoReferences] = useState<ReferenceVideo[]>([]);
    const [audioReferences, setAudioReferences] = useState<ReferenceAudio[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [optimizingPrompt, setOptimizingPrompt] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [referenceDragTarget, setReferenceDragTarget] = useState<"image" | "video" | "audio" | null>(null);
    const [sessionHydrated, setSessionHydrated] = useState(false);

    // 轮询闭包在页面卸载后仍后台继续(保存日志/通知新页面),但不再更新已卸载组件的 UI 状态
    const mountedRef = useRef(true);
    useEffect(() => () => {
        mountedRef.current = false;
    }, []);

    // 供 handoff 消费函数读取最新参考图（事件触发的消费不依赖渲染闭包）
    const referencesRef = useRef(references);
    referencesRef.current = references;

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    // 订阅模块级任务完成通知：切页期间任务在后台完成/失败后自动刷新日志与结果
    useEffect(() => subscribeVideoTaskUpdate(() => void refreshLogs()), []);

    useEffect(() => {
        let active = true;
        void loadWorkbenchSession<{ prompt: string; camera?: CameraSelection; references: ReferenceImage[]; videoReferences: ReferenceVideo[]; audioReferences: ReferenceAudio[]; results: GenerationResult[]; elapsedMs: number }>(SESSION_STORE_KEY).then((session) => {
            if (!active || !session) return;
            setPrompt(session.prompt || "");
            setCamera(normalizeCameraSelection(session.camera));
            setReferences(session.references || []);
            setVideoReferences(session.videoReferences || []);
            setAudioReferences(session.audioReferences || []);
            setResults(session.results || []);
            setElapsedMs(session.elapsedMs || 0);
        }).finally(() => active && setSessionHydrated(true));
        return () => {
            active = false;
        };
    }, []);

    // 生成期间每秒的 elapsedMs 变化不触发保存，避免每秒把整个 session(含参考图 dataUrl)写入 IndexedDB；
    // 每次结果/输入变化(含生成结束的最终状态)仍会保存，保存时闭包中的 elapsedMs 为最新渲染值。
    useEffect(() => {
        if (!sessionHydrated) return;
        void saveWorkbenchSession(SESSION_STORE_KEY, { prompt, camera, references, videoReferences, audioReferences, results, elapsedMs });
    }, [audioReferences, camera, prompt, references, results, sessionHydrated, videoReferences]);

    // 消费参考图 handoff（精修图片 / 阿里云设置添加的公网 URL），支持 url 直接加入
    const consumeReferenceHandoffs = async () => {
        const handoffs = await getReferenceHandoffs("video");
        if (!handoffs.length) return;
        let nextReferences = referencesRef.current;
        for (const handoff of handoffs) {
            if (nextReferences.length >= SEEDANCE_REFERENCE_LIMITS.images) {
                message.warning("视频创作台最多保留 9 张参考图");
                break;
            }
            if (handoff.url) {
                nextReferences = [...nextReferences, { id: nanoid(), name: handoff.name, type: handoff.type || "image/png", dataUrl: handoff.url, url: handoff.url }];
            } else {
                const dataUrl = await resolveImageUrl(handoff.storageKey);
                if (!dataUrl) continue;
                nextReferences = [...nextReferences, { id: nanoid(), name: handoff.name, type: handoff.type, dataUrl, storageKey: handoff.storageKey }];
            }
            await acknowledgeReferenceHandoff(handoff.id);
        }
        if (nextReferences !== referencesRef.current) {
            setReferences(nextReferences);
            void saveWorkbenchSession(SESSION_STORE_KEY, { prompt, camera, references: nextReferences, videoReferences, audioReferences, results, elapsedMs });
            message.success("参考图已加入");
        }
    };

    useEffect(() => {
        if (!sessionHydrated) return;
        void consumeReferenceHandoffs();
        window.addEventListener("lyspace:reference-handoff-created", consumeReferenceHandoffs);
        return () => window.removeEventListener("lyspace:reference-handoff-created", consumeReferenceHandoffs);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionHydrated]);

    const addReferences = async (files?: FileList | readonly File[] | null) => {
        const selectedFiles = Array.from(files || []);
        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/") && !SEEDANCE_VIDEO_MIME_TYPES.includes(file.type) && !isSupportedAudioFile(file));
        if (unsupported.length) message.warning("已忽略不支持的参考资产，请使用图片、mp4/mov 视频或 mp3/wav 音频");
        const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/")).slice(0, SEEDANCE_REFERENCE_LIMITS.images - references.length);
        const videoFiles = selectedFiles.filter((file) => SEEDANCE_VIDEO_MIME_TYPES.includes(file.type)).slice(0, SEEDANCE_REFERENCE_LIMITS.videos - videoReferences.length);
        const audioFiles = selectedFiles.filter((file) => isSupportedAudioFile(file)).slice(0, SEEDANCE_REFERENCE_LIMITS.audios - audioReferences.length);
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        const nextVideoReferences = await Promise.all(
            videoFiles.map(async (file) => {
                const video = await uploadMediaFile(file, "video-reference");
                return { id: nanoid(), name: file.name, type: video.mimeType, url: video.url, storageKey: video.storageKey, bytes: video.bytes, width: video.width, height: video.height, durationMs: video.durationMs };
            }),
        );
        const nextAudioReferences = filterAudioReferencesByDuration(
            audioReferences,
            await Promise.all(
                audioFiles.map(async (file) => {
                    const audio = await uploadMediaFile(file, "audio-reference");
                    return { id: nanoid(), name: file.name, type: audio.mimeType, url: audio.url, storageKey: audio.storageKey, durationMs: audio.durationMs };
                }),
            ),
            message.warning,
        );
        setReferences((value) => [...value, ...nextReferences].slice(0, SEEDANCE_REFERENCE_LIMITS.images));
        setVideoReferences((value) => [...value, ...nextVideoReferences].slice(0, SEEDANCE_REFERENCE_LIMITS.videos));
        setAudioReferences((value) => [...value, ...nextAudioReferences].slice(0, SEEDANCE_REFERENCE_LIMITS.audios));
    };

    const handleReferenceDragEnter = (event: DragEvent<HTMLDivElement>, target: "image" | "video" | "audio") => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes("Files")) setReferenceDragTarget(target);
    };

    const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setReferenceDragTarget(null);
    };

    const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setReferenceDragTarget(null);
        void addReferences(event.dataTransfer.files);
    };


    const addReferencesFromPaste = (event: ReactClipboardEvent) => {
        const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
        if (!files.length) return;
        event.preventDefault();
        void addReferences(files);
    };
    // Agnes 等渠道只接受公网 HTTPS 参考图：本地参考图自动托管（OSS 优先，免费图床兜底），失败明确报错引导
    const ensurePublicReferenceUrls = async (refs: ReferenceImage[]) => {
        const localRefs = refs.filter((item) => !/^https:\/\//i.test(item.dataUrl || item.url || ""));
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
    };

    // 优化提示词：调用所选文本模型（默认 defaultConfig.textModel = gpt-5.5）流式优化并回填
    const optimizePrompt = async () => {
        const text = prompt.trim();
        if (!text) {
            message.warning("请先输入提示词");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return;
        }
        setOptimizingPrompt(true);
        try {
            let streamed = "";
            const textConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model };
            const answer = await requestImageQuestion(
                textConfig,
                [
                    { role: "system", content: "你是专业的视频生成提示词优化专家。请优化用户给出的提示词，使其更具体、生动、可控（可补充镜头运动、主体动作、场景氛围、画面风格、时长节奏等描述），只输出优化后的提示词本身，不要解释、不要引号、不要多余内容。" },
                    { role: "user", content: text },
                ],
                (delta) => {
                    streamed += delta;
                    setPrompt(streamed);
                },
            );
            setPrompt(answer || streamed);
            message.success("提示词已优化");
        } catch (error) {
            message.error(error instanceof Error ? `提示词优化失败：${error.message}` : "提示词优化失败");
        } finally {
            setOptimizingPrompt(false);
        }
    };

    const generate = async () => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setElapsedMs(0);
        setRunning(true);
        setPreviewLog(null);
        setResults([{ id: nanoid(), status: "pending" }]);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);
        try {
            // Agnes 等渠道只接受公网 HTTPS 参考图：自动把本地参考图（blob/base64）上传 OSS 后提交
            const publicReferences = await ensurePublicReferenceUrls(snapshot.references);
            if (publicReferences.length > snapshot.references.length || publicReferences.some((item, index) => item.dataUrl !== snapshot.references[index]?.dataUrl)) {
                const hostedCount = publicReferences.filter((item, index) => item.dataUrl !== snapshot.references[index]?.dataUrl).length;
                setReferences(publicReferences);
                message.success(`已自动上传 ${hostedCount} 张本地参考图`);
            }
            const task = await createVideoGenerationTask(snapshot.config, snapshot.requestText, publicReferences, snapshot.videoReferences, snapshot.audioReferences);
            const log = buildLog({ prompt: snapshot.text, camera: snapshot.camera, model, config: snapshot.config, references: publicReferences, videoReferences: snapshot.videoReferences, audioReferences: snapshot.audioReferences, durationMs: 0, status: "生成中", task });
            await saveLog(log, false);
            void pollGenerationLog(log, snapshot.config);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "生成失败";
            setResults([{ id: nanoid(), status: "failed", error: errorMessage }]);
            await saveLog(buildLog({ prompt: snapshot.text, camera: snapshot.camera, model, config: snapshot.config, references: snapshot.references, videoReferences: snapshot.videoReferences, audioReferences: snapshot.audioReferences, durationMs: performance.now() - batchStartedAt, status: "失败", error: errorMessage }));
            message.error(errorMessage);
            setRunning(false);
        }
    };

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请输入视频提示词");
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return null;
        }
        const videoReferenceError = seedanceVideoReferenceError(videoReferences);
        if (videoReferenceError) {
            message.error(`${videoReferenceError}。${seedanceVideoReferenceHint}`);
            return null;
        }
        const selection = normalizeCameraSelection(camera);
        return { text, requestText: buildCameraPrompt(text, selection), camera: selection, config: buildVideoConfig(effectiveConfig, model), references: [...references], videoReferences: [...videoReferences], audioReferences: [...audioReferences] };
    };

    const retryResult = () => {
        void generate();
    };

    const downloadVideo = (video: GeneratedVideo) => {
        saveAs(video.url, "video.mp4");
    };

    const saveResultToAssets = (video: GeneratedVideo) => {
        addAsset({
            kind: "video",
            title: "生成视频",
            coverUrl: "",
            tags: [],
            source: "视频创作台",
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "video-page", prompt },
        });
        message.success("已加入我的资产");
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const stored = await uploadImage(payload.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }].slice(0, SEEDANCE_REFERENCE_LIMITS.images));
        } else if (payload.kind === "video") {
            setVideoReferences((value) => [...value, { id: nanoid(), name: payload.title, type: "video/mp4", url: payload.url, storageKey: payload.storageKey, width: payload.width, height: payload.height }].slice(0, SEEDANCE_REFERENCE_LIMITS.videos));
        } else if (payload.kind === "audio") {
            message.info("音频资产请在画布中使用");
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        setCamera({});
        setReferences([]);
        setVideoReferences([]);
        setAudioReferences([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        const mediaKeys = logs
            .filter((log) => selectedLogIds.includes(log.id))
            .map((log) => log.video?.storageKey)
            .filter((key): key is string => Boolean(key));
        void Promise.all([deleteStoredMedia(mediaKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(() => refreshLogs());
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = async (log: GenerationLog, resumePending = true) => {
        await trackWrite(logStore.setItem(log.id, serializeLog(log)));
        await refreshLogs(resumePending);
    };

    const refreshLogs = async (resumePending = true) => {
        const nextLogs = await readStoredLogs();
        setLogs(nextLogs);
        if (resumePending) resumePendingLogs(nextLogs);
        return nextLogs;
    };

    const resumePendingLogs = (items: GenerationLog[]) => {
        for (const log of items) {
            if (log.status === "生成中" && log.task) {
                void pollGenerationLog(log);
            } else if (log.status === "成功" && log.video) {
                // 切页期间任务已完成：results 中的 pending 卡片更新为成功结果
                setResults((prev) => (prev.some((result) => result.status === "pending") ? [{ id: log.video!.id, status: "success" as const, video: log.video }] : prev));
            } else if (log.status === "失败") {
                // 切页期间任务已失败：pending 卡片更新为失败
                setResults((prev) => (prev.some((result) => result.status === "pending") ? [{ id: log.id, status: "failed" as const, error: log.error || "生成失败" }] : prev));
            }
        }
    };

    const pollGenerationLog = async (log: GenerationLog, configOverride?: AiConfig) => {
        if (!log.task || activeVideoLogIds.has(log.id)) return;
        activeVideoLogIds.add(log.id);
        if (mountedRef.current) {
            setRunning(true);
            setStartedAt((value) => value || performance.now());
            setResults((value) => (value.length ? value : [{ id: log.id, status: "pending" }]));
        }
        const taskConfig = buildVideoConfig({ ...effectiveConfig, ...log.config }, log.task.model || log.model);
        try {
            for (let attempt = 0; attempt < 120; attempt += 1) {
                const state = await pollVideoGenerationTask(configOverride || taskConfig, log.task);
                if (state.status === "completed") {
                    const stored = await storeGeneratedVideo(state.result);
                    const nextVideo: GeneratedVideo = {
                        id: nanoid(),
                        url: stored.url,
                        storageKey: stored.storageKey,
                        durationMs: Date.now() - log.createdAt,
                        width: stored.width || 1280,
                        height: stored.height || 720,
                        bytes: stored.bytes,
                        mimeType: stored.mimeType,
                    };
                    if (mountedRef.current) setResults([{ id: nextVideo.id, status: "success", video: nextVideo }]);
                    await saveLog({ ...log, status: "成功", durationMs: nextVideo.durationMs, video: nextVideo, error: undefined });
                    message.success("视频已生成");
                    return;
                }
                if (state.status === "failed") throw new Error(state.error);
                if (attempt === 119) throw new Error("视频生成超时，请稍后重试");
                await delay(log.task.provider === "seedance" ? 5000 : log.task.provider === "agnes" ? 10000 : 2500);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "生成失败";
            if (mountedRef.current) setResults([{ id: log.id, status: "failed", error: errorMessage }]);
            await saveLog({ ...log, status: "失败", durationMs: Date.now() - log.createdAt, error: errorMessage });
            message.error(errorMessage);
        } finally {
            activeVideoLogIds.delete(log.id);
            if (mountedRef.current && !activeVideoLogIds.size) {
                setRunning(false);
                setStartedAt(0);
            }
            // 通知新挂载的组件刷新日志（切页期间任务完成/失败后返回页面可见结果）
            emitVideoTaskUpdate();
        }
    };

    const previewGenerationLog = (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setCamera(normalizeCameraSelection(log.camera));
        setReferences(log.references || []);
        setVideoReferences(log.videoReferences || []);
        setAudioReferences(log.audioReferences || []);
        if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.vquality) updateConfig("vquality", log.config.vquality);
        if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
        if (log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", log.config.videoGenerateAudio);
        if (log.config.videoWatermark) updateConfig("videoWatermark", log.config.videoWatermark);
        setResults(log.status === "生成中" ? [{ id: log.id, status: "pending" }] : log.video ? [{ id: log.video.id, status: "success", video: log.video }] : [{ id: log.id, status: "failed", error: log.error || "生成失败" }]);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel logs={logs} selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={() => setDeleteConfirmOpen(true)} onPreviewLog={previewGenerationLog} />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div className="flex items-start justify-between gap-3">
                            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">视频创作台</h1>
                            <div className="flex shrink-0 gap-2 lg:hidden">
                                <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                    记录
                                </Button>
                                <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    参数
                                </Button>
                            </div>
                        </div>

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">提示词</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={() => setPromptDialogOpen(true)}>
                                            查看提示词库
                                        </Button>
                                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => setAssetPickerOpen(true)}>
                                            查看我的资产
                                        </Button>
                                    </div>
                                </div>
                                <div>
                                    <Input.TextArea value={prompt} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setPrompt(event.target.value)} rows={7} placeholder="描述镜头运动、主体动作、场景氛围和画面风格" />
                                    <div className="mt-2 flex items-center justify-end gap-1.5">
                                        <ModelPicker
                                            config={effectiveConfig}
                                            value={effectiveConfig.textModel || effectiveConfig.model}
                                            onChange={(value) => updateConfig("textModel", value)}
                                            capability="text"
                                            className="!h-6 !min-w-[7rem] !px-2 !text-xs"
                                        />
                                        <Tooltip title="优化提示词">
                                            <Button type="text" size="small" className="!h-6 !w-6" icon={<Wand2 className="size-4" />} loading={optimizingPrompt} onClick={() => void optimizePrompt()} />
                                        </Tooltip>
                                    </div>
                                </div>
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">参考图</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            上传
                                        </Button>
                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!references.length} onClick={() => setReferences([])}>
                                            清空
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    tabIndex={0}
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors focus:outline-none ${referenceDragTarget === "image" ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onMouseEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
                                    onPaste={addReferencesFromPaste}
                                    onDragEnter={(event) => handleReferenceDragEnter(event, "image")}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    <Image.PreviewGroup>
                                        {references.map((item, index) => (
                                            <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                                <Image src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                                                <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{seedanceReferenceLabel("image", index)}</span>
                                                <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                                <button type="button" className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))} aria-label="移除参考图">
                                                    <Trash2 className="size-3.5" />
                                                </button>
                                            </div>
                                        ))}
                                    </Image.PreviewGroup>
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{referenceDragTarget === "image" ? "松开即可上传参考资产" : "暂无参考图，可拖入文件或直接粘贴，最多 9 张"}</div> : null}
                                </div>
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">参考视频</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            上传
                                        </Button>
                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!videoReferences.length} onClick={() => setVideoReferences([])}>
                                            清空
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${referenceDragTarget === "video" ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => handleReferenceDragEnter(event, "video")}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    {videoReferences.map((item, index) => (
                                        <div key={item.id} className="group relative h-20 w-32 shrink-0 overflow-hidden rounded-md border border-stone-200 bg-black dark:border-stone-800">
                                            <video src={item.url} className="size-full object-cover" muted preload="metadata" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{seedanceReferenceLabel("video", index)}</span>
                                            <ReferenceOrderButtons index={index} total={videoReferences.length} onMove={(offset) => setVideoReferences((value) => moveListItem(value, index, offset))} />
                                            <button type="button" className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => setVideoReferences((value) => value.filter((ref) => ref.id !== item.id))} aria-label="移除参考视频">
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!videoReferences.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{referenceDragTarget === "video" ? "松开即可上传参考资产" : "暂无参考视频，可拖入文件，最多 3 个"}</div> : null}
                                </div>
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">参考音频</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            上传
                                        </Button>
                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!audioReferences.length} onClick={() => setAudioReferences([])}>
                                            清空
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${referenceDragTarget === "audio" ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => handleReferenceDragEnter(event, "audio")}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    {audioReferences.map((item, index) => (
                                        <div key={item.id} className="group relative flex h-20 w-48 shrink-0 flex-col justify-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-2 dark:border-stone-800 dark:bg-stone-900">
                                            <div className="flex min-w-0 items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                                                <Music2 className="size-4 shrink-0" />
                                                <span className="shrink-0 rounded bg-stone-200 px-1 text-[10px] text-stone-700 dark:bg-stone-800 dark:text-stone-200">{seedanceReferenceLabel("audio", index)}</span>
                                                <span className="truncate">{item.name}</span>
                                            </div>
                                            <audio src={item.url} controls className="h-8 w-full" preload="metadata" />
                                            <ReferenceOrderButtons index={index} total={audioReferences.length} onMove={(offset) => setAudioReferences((value) => moveListItem(value, index, offset))} />
                                            <button type="button" className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => setAudioReferences((value) => value.filter((ref) => ref.id !== item.id))} aria-label="移除参考音频">
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!audioReferences.length ? <div className="flex min-w-full items-center justify-center text-center text-sm text-stone-500">{referenceDragTarget === "audio" ? "松开即可上传参考资产" : "暂无参考音频，可拖入文件，最多 3 个，mp3/wav"}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {normalizeResolution(effectiveConfig.vquality)}p · {videoSizeLabel(effectiveConfig.size)} · {normalizeVideoSeconds(effectiveConfig.videoSeconds)}s
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    调整
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-[minmax(0,1fr)_auto]">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} camera={camera} onCameraChange={setCamera} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running} onClick={() => void generate()}>
                                开始生成
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <h2 className="text-xl font-semibold">生成结果</h2>
                            {running ? <Tag className="m-0 px-2 py-1">等待 {formatDuration(elapsedMs)}</Tag> : null}
                        </div>
                        {results.length ? (
                            <div className="grid gap-4">
                                {results.map((result) => (result.status === "success" && result.video ? <ResultVideoCard key={result.id} video={result.video} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} /> : result.status === "failed" ? <FailedVideoCard key={result.id} error={result.error || "生成失败"} onRetry={retryResult} /> : <PendingVideoCard key={result.id} />))}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <VideoIcon className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成视频" />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title="生成记录" placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel logs={logs} selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={() => setDeleteConfirmOpen(true)} onPreviewLog={previewGenerationLog} />
            </Drawer>
            <Drawer title="参数" placement="bottom" height="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} camera={camera} onCameraChange={setCamera} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除选中的 {selectedLogIds.length} 条生成记录吗？
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog, camera, onCameraChange }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void; camera: CameraSelection; onCameraChange: (value: CameraSelection) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            <div className="min-w-0">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">模型</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </div>
            <div className="min-w-0">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">镜头</span>
                <CameraTrigger selection={camera} onSelectionChange={onCameraChange} />
            </div>
            <div className="col-span-2">
                <VideoSettingsPanel config={config} model={model} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" />
            </div>
        </>
    );
}

function ResultVideoCard({ video, onDownload, onSaveAsset }: { video: GeneratedVideo; onDownload: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo) => void }) {
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <video src={video.url} controls className="aspect-video w-full bg-black object-contain" />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {video.width}x{video.height}
                    </span>
                    <span>{formatBytes(video.bytes)}</span>
                    <span>{formatDuration(video.durationMs)}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(video)}>
                        添加到资产
                    </Button>
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(video)}>
                        下载
                    </Button>
                </div>
            </div>
        </div>
    );
}

function PendingVideoCard() {
    return (
        <div className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>生成中</span>
            </div>
        </div>
    );
}

function FailedVideoCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">生成失败</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger onClick={onRetry}>
                    重试
                </Button>
            </div>
        </div>
    );
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">生成记录</h2>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    新建
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? "取消" : "全选"}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    删除
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard key={log.id} log={log} selected={selectedLogIds.includes(log.id)} active={activeLogId === log.id} onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))} onClick={() => onPreviewLog(log)} />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">暂无生成记录</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    return (
        <button type="button" className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`} onClick={onClick}>
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
                <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.size}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.resolution}p</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.seconds}s</Tag>
                        {log.camera && formatCameraSelection(log.camera) !== "自动" ? <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">镜头：{formatCameraSelection(log.camera)}</Tag> : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={log.status === "成功" ? "blue" : log.status === "生成中" ? "processing" : "red"}>
                        {log.status}
                    </Tag>
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                        {formatDuration(log.durationMs)}
                    </Tag>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const logs: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            logs.push(value);
        });
        return (await Promise.all(logs.map(normalizeLog))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const video = log.video?.storageKey ? { ...log.video, url: await resolveMediaUrl(log.video.storageKey, log.video.url) } : log.video;
    const videoReferences = await Promise.all(
        (log.videoReferences || []).map(async (item) => ({
            ...item,
            url: item.storageKey ? await resolveMediaUrl(item.storageKey, item.url) : item.url,
        })),
    );
    const audioReferences = await Promise.all(
        (log.audioReferences || []).map(async (item) => ({
            ...item,
            url: item.storageKey ? await resolveMediaUrl(item.storageKey, item.url) : item.url,
        })),
    );
    const references = await Promise.all(
        (log.references || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || "",
        camera: normalizeCameraSelection(log.camera),
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.videoModel || "",
        config,
        references,
        videoReferences,
        audioReferences,
        durationMs: log.durationMs || 0,
        size: log.size || config.size || "",
        resolution: normalizeResolution(log.resolution || config.vquality || ""),
        seconds: log.seconds || config.videoSeconds || "",
        status: log.status || "成功",
        task: log.task,
        video,
        error: log.error,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        videoReferences: log.videoReferences.map((item) => (item.storageKey ? { ...item, url: "" } : item)),
        audioReferences: log.audioReferences.map((item) => (item.storageKey ? { ...item, url: "" } : item)),
        video: log.video?.storageKey ? { ...log.video, url: "" } : log.video,
    };
}

function isSupportedAudioFile(file: File) {
    return file.type === "audio/mpeg" || file.type === "audio/mp3" || file.type === "audio/wav" || file.type === "audio/x-wav" || /\.(mp3|wav)$/i.test(file.name);
}

function filterAudioReferencesByDuration(existing: ReferenceAudio[], next: ReferenceAudio[], warn: (content: string) => void) {
    let total = existing.reduce((sum, item) => sum + (item.durationMs || 0), 0);
    const accepted: ReferenceAudio[] = [];
    let skipped = false;
    for (const item of next) {
        if (item.durationMs && (item.durationMs < 2000 || item.durationMs > 15000)) {
            skipped = true;
            continue;
        }
        if (item.durationMs && total + item.durationMs > 15000) {
            skipped = true;
            continue;
        }
        total += item.durationMs || 0;
        accepted.push(item);
    }
    if (skipped) warn("已忽略不符合时长要求的参考音频：单个 2-15 秒，总时长不超过 15 秒");
    return accepted;
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        videoModel: log.config?.videoModel || log.model || "",
        size: log.config?.size || log.size || "",
        vquality: normalizeResolution(log.config?.vquality || log.resolution || ""),
        videoSeconds: log.config?.videoSeconds || log.seconds || "",
        videoGenerateAudio: log.config?.videoGenerateAudio || "true",
        videoWatermark: log.config?.videoWatermark || "false",
    };
}

function buildLog({ prompt, camera, model, config, references, videoReferences, audioReferences, durationMs, status, task, video, error }: { prompt: string; camera: CameraSelection; model: string; config: AiConfig; references: ReferenceImage[]; videoReferences: ReferenceVideo[]; audioReferences: ReferenceAudio[]; durationMs: number; status: GenerationLog["status"]; task?: VideoGenerationTask; video?: GeneratedVideo; error?: string }): GenerationLog {
    const logConfig = {
        model: config.model,
        videoModel: config.videoModel,
        size: config.size,
        vquality: normalizeResolution(config.vquality),
        videoSeconds: config.videoSeconds,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        camera: normalizeCameraSelection(camera),
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config: logConfig,
        references,
        videoReferences,
        audioReferences,
        durationMs,
        size: logConfig.size,
        resolution: logConfig.vquality,
        seconds: logConfig.videoSeconds,
        status,
        task,
        video,
        error,
    };
}

function buildVideoConfig(config: AiConfig, model: string): AiConfig {
    const seedance = isSeedanceVideoConfig({ ...config, model });
    const agnes = resolveModelRequestConfig({ ...config, model }, model).apiFormat === "agnes";
    return {
        ...config,
        model,
        videoModel: model,
        size: seedance ? normalizeSeedanceRatio(config.size) : normalizeVideoSize(config.size),
        videoSeconds: normalizeVideoSeconds(config.videoSeconds, agnes),
        vquality: normalizeResolution(config.vquality),
        videoGenerateAudio: String(boolConfig(config.videoGenerateAudio, true)),
        videoWatermark: String(boolConfig(config.videoWatermark, false)),
        videoFrameRate: normalizeVideoFrameRate(config.videoFrameRate),
        videoSeed: normalizeVideoSeed(config.videoSeed),
        videoNumInferenceSteps: normalizeVideoInferenceSteps(config.videoNumInferenceSteps),
    };
}

function normalizeVideoSeconds(value: string, agnes = false) {
    if (String(value).trim() === "-1") return "-1";
    const seconds = Math.floor(Number(value) || 6);
    // Agnes 文档最大 18 秒；其他渠道保持原有 20 秒上限
    return String(Math.max(1, Math.min(agnes ? 18 : 20, seconds)));
}

function normalizeVideoFrameRate(value: string) {
    const rate = Math.floor(Number(value) || 24);
    return String(Math.max(1, Math.min(60, rate)));
}

function normalizeVideoSeed(value: string) {
    const seed = Number((value || "").trim());
    return Number.isInteger(seed) ? String(seed) : "";
}

function normalizeVideoInferenceSteps(value: string) {
    const steps = Number((value || "").trim());
    return Number.isInteger(steps) && steps > 0 ? String(steps) : "";
}

function normalizeVideoSize(value: string) {
    return normalizeVideoSizeValue(value);
}

function normalizeResolution(value: string) {
    return normalizeVideoResolutionValue(value);
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
