import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Copy, Download, Eye, FolderOpen, FolderPlus, ImagePlus, LoaderCircle, PenLine, SlidersHorizontal, Sparkles, Trash2, Upload, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { App, Button, Drawer, Dropdown, Empty, Image, Input, Modal, Tag, Tooltip, Typography, type MenuProps } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration, getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { deleteStoredImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { loadWorkbenchSession, saveWorkbenchSession } from "@/services/workbench-session";
import { trackWrite } from "@/services/desktop-storage";
import { acknowledgeReferenceHandoff, getReferenceHandoffs } from "@/services/reference-handoff";
import type { ReferenceImage } from "@/types/image";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed" | "canceled";
    image?: GeneratedImage;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    cancelCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "成功" | "失败" | "取消";
    images: GeneratedImage[];
    thumbnails: string[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "imageResolution" | "size" | "count" | "background">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const SESSION_STORE_KEY = "image-workbench:current-session";
const RESULT_ACTION_BUTTON_CLASS = "min-w-[104px] flex-1 px-2 [&_.ant-btn-icon]:shrink-0";
const MAX_REFERENCE_IMAGES = 6;
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

export default function ImagePage() {
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
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [detailLog, setDetailLog] = useState<GenerationLog | null>(null);
    const [storageSettings, setStorageSettings] = useState<{ resultRoot: string; folders: Record<string, string> } | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [sessionHydrated, setSessionHydrated] = useState(false);
    const generationControllersRef = useRef(new Map<string, AbortController>());
    const lastBatchRef = useRef<{ prompt: string; config: GenerationLogConfig; references: ReferenceImage[]; durationMs: number; images: GeneratedImage[] } | null>(null);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(
        () => () => {
            generationControllersRef.current.forEach((controller) => controller.abort());
            generationControllersRef.current.clear();
        },
        [],
    );

    useEffect(() => {
        void refreshLogs();
        void window.lySpaceDesktop?.getStorageSettings().then((settings) => setStorageSettings(settings as { resultRoot: string; folders: Record<string, string> }));
    }, []);

    useEffect(() => {
        let active = true;
        void loadWorkbenchSession<{ prompt: string; references: ReferenceImage[]; results: GenerationResult[]; elapsedMs: number }>(SESSION_STORE_KEY)
            .then((session) => {
                if (!active || !session) return;
                setPrompt(session.prompt || "");
                setReferences(session.references || []);
                setResults((session.results || []).map((result) => (result.status === "pending" ? { ...result, status: "failed", error: "上次生成已中断，可重试" } : result)));
                setElapsedMs(session.elapsedMs || 0);
            })
            .catch(() => undefined)
            .finally(() => active && setSessionHydrated(true));
        return () => {
            active = false;
        };
    }, []);

    // 生成期间每秒的 elapsedMs 变化不触发保存，避免生成过程中反复把整个结果集写入 IndexedDB；
    // 每次结果/输入变化（含生成结束的最终状态）仍会保存。
    useEffect(() => {
        if (!sessionHydrated) return;
        void saveWorkbenchSession(SESSION_STORE_KEY, { prompt, references, results, elapsedMs }).catch(() => undefined);
    }, [prompt, references, results, sessionHydrated]);

    useEffect(() => {
        if (!sessionHydrated) return;
        void (async () => {
            let nextReferences = references;
            for (const handoff of await getReferenceHandoffs("image")) {
                if (nextReferences.length >= MAX_REFERENCE_IMAGES) break;
                const dataUrl = await resolveImageUrl(handoff.storageKey);
                if (!dataUrl) continue;
                nextReferences = [...nextReferences, { id: nanoid(), name: handoff.name, type: handoff.type, dataUrl, storageKey: handoff.storageKey }];
                await saveWorkbenchSession(SESSION_STORE_KEY, { prompt, references: nextReferences, results, elapsedMs }).catch(() => undefined);
                await acknowledgeReferenceHandoff(handoff.id);
            }
            if (nextReferences !== references) {
                setReferences(nextReferences);
                message.success("精修图片已加入参考图");
            }
        })();
        // 交接仅在当前会话恢复完成后消费一次。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionHydrated]);

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return;
        const remaining = MAX_REFERENCE_IMAGES - references.length;
        if (remaining <= 0) {
            message.warning(`参考图最多添加 ${MAX_REFERENCE_IMAGES} 张，请先移除部分参考图`);
            return;
        }
        if (imageFiles.length > remaining) message.warning(`参考图最多添加 ${MAX_REFERENCE_IMAGES} 张，已添加前 ${remaining} 张`);
        const nextReferences = await Promise.all(
            imageFiles.slice(0, remaining).map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        setReferences((value) => [...value, ...nextReferences]);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error("剪切板里没有可读取的图片");
                return;
            }
            const remaining = MAX_REFERENCE_IMAGES - references.length;
            if (remaining <= 0) {
                message.warning(`参考图最多添加 ${MAX_REFERENCE_IMAGES} 张，请先移除部分参考图`);
                return;
            }
            if (blobs.length > remaining) message.warning(`参考图最多添加 ${MAX_REFERENCE_IMAGES} 张，已读取前 ${remaining} 张`);
            const nextReferences = await Promise.all(
                blobs.slice(0, remaining).map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success(`已读取 ${nextReferences.length} 张参考图`);
        } catch {
            message.error("剪切板里没有可读取的图片");
        }
    };

    const cancelResult = (id: string) => {
        const controller = generationControllersRef.current.get(id);
        if (!controller || controller.signal.aborted) return;
        controller.abort();
        setResults((value) => updateResultById(value, id, { status: "canceled", error: undefined, image: undefined }));
    };

    const generate = async () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请输入生图提示词");
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return;
        }

        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;

        setElapsedMs(0);
        setRunning(true);
        const pendingResults = Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" as const }));
        // 新任务排列在最前，保留之前的生成结果不被挤掉
        setResults((prev) => [...pendingResults, ...prev]);
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);

        const tasks = pendingResults.map((item) => runGenerationSlot(item.id, snapshot));

        const result = await Promise.allSettled(tasks);
        const successImages = result.filter((item): item is PromiseFulfilledResult<GeneratedImage | null> => item.status === "fulfilled").map((item) => item.value).filter((image): image is GeneratedImage => Boolean(image));
        const successCount = successImages.length;
        const cancelCount = result.filter((item) => item.status === "fulfilled" && item.value === null).length;
        const failCount = result.filter((item) => item.status === "rejected").length;
        const failed = result.find((item): item is PromiseRejectedResult => item.status === "rejected");
        const error = failed?.reason instanceof Error ? failed.reason.message : failCount ? "生成失败" : undefined;

        try {
            const logImages = await Promise.all(
                successImages.map(async (image) => {
                    const stored = await uploadImage(image.dataUrl);
                    return { ...image, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
                }),
            );
            lastBatchRef.current = { prompt: text, config: { ...snapshot.config, count: String(generationCount) }, references: snapshot.references, durationMs: performance.now() - batchStartedAt, images: logImages };
            // 结果图转存 IndexedDB 并回写 storageKey，跨重启/跨模块切换恢复时走本地存储，不依赖 base64/http URL
            const storedImagesById = new Map(logImages.map((item) => [item.id, item]));
            setResults((value) => value.map((result) => (result.image && storedImagesById.has(result.image.id) ? { ...result, image: storedImagesById.get(result.image.id) } : result)));
            saveLog(
                buildLog({
                    prompt: text,
                    model,
                    config: { ...snapshot.config, count: String(generationCount) },
                    references: snapshot.references,
                    durationMs: performance.now() - batchStartedAt,
                    successCount,
                    failCount,
                    cancelCount,
                    status: successCount ? "成功" : failCount ? "失败" : "取消",
                    images: logImages,
                }),
            );
            if (successCount) message.success("图片已生成");
            else if (failCount) message.error(failed?.reason instanceof Error ? failed.reason.message : "生成失败");
            else message.info("已取消生成");
        } catch (error) {
            // 落库失败时用原始成功图片设置兜底，保证刚生成的图片右键详情仍可用
            if (successImages.length) {
                lastBatchRef.current = { prompt: text, config: { ...snapshot.config, count: String(generationCount) }, references: snapshot.references, durationMs: performance.now() - batchStartedAt, images: successImages };
            }
            message.error(error instanceof Error ? `生成完成但保存记录失败：${error.message}` : "生成完成但保存记录失败");
        } finally {
            setRunning(false);
        }
    };

    const downloadImage = async (image: GeneratedImage, index: number) => {
        if (window.lySpaceDesktop) {
            try {
                const blob = await (await fetch(image.dataUrl)).blob();
                const mime = blob.type.toLowerCase();
                const extension = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "png";
                const result = await window.lySpaceDesktop.saveFileDialog({ defaultPath: `image-${index + 1}.${extension}`, bytes: await blob.arrayBuffer() });
                if (!result.canceled) message.success("图片已保存");
            } catch {
                message.error("保存图片失败");
            }
            return;
        }
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        if (references.length >= MAX_REFERENCE_IMAGES) {
            message.warning(`参考图最多添加 ${MAX_REFERENCE_IMAGES} 张，请先移除部分参考图`);
            return;
        }
        try {
            const stored = await uploadImage(image.dataUrl);
            setReferences((value) => [...value, { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
            message.success("已加入参考图");
        } catch {
            message.error("加入参考图失败");
        }
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number) => {
        try {
            const stored = await uploadImage(image.dataUrl);
            addAsset({
                kind: "image",
                title: `生成结果 ${index + 1}`,
                coverUrl: stored.url,
                tags: [],
                source: "生图工作台",
                data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
                metadata: { source: "image-page", prompt },
            });
            message.success("已加入我的资产");
        } catch {
            message.error("添加到资产失败");
        }
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            if (references.length >= MAX_REFERENCE_IMAGES) {
                message.warning(`参考图最多添加 ${MAX_REFERENCE_IMAGES} 张，请先移除部分参考图`);
            } else {
                const stored = await uploadImage(payload.dataUrl);
                setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }]);
            }
        } else {
            message.warning("生图工作台只能使用文本或图片资产");
        }
        setAssetPickerOpen(false);
    };

    const deleteSelectedLogs = () => {
        const deletedLogs = logs.filter((log) => selectedLogIds.includes(log.id));
        // 只回收该记录独有引用的结果图 blob；参考图可能与当前会话或其他记录共享，不能随删除回收
        const imageKeys = deletedLogs.flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        const deletedImageIds = new Set(deletedLogs.flatMap((log) => log.images.map((image) => image.id)));
        void Promise.all([deleteStoredImages(imageKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(refreshLogs).catch(() => undefined);
        // 结果区同步移除已删除记录对应的图片，避免引用已回收的 blob 出现破图
        setResults((value) => value.filter((result) => !(result.image && deletedImageIds.has(result.image.id))));
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = (log: GenerationLog) => {
        void trackWrite(logStore.setItem(log.id, serializeLog(log))).then(refreshLogs).catch(() => undefined);
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());

    const resolveDetailLog = (image: GeneratedImage): GenerationLog | null => {
        const matched = logs.find((log) => log.images.some((item) => item.id === image.id));
        if (matched) return matched;
        const batch = lastBatchRef.current;
        if (batch && batch.images.some((item) => item.id === image.id)) {
            return buildLog({ prompt: batch.prompt, model, config: batch.config, references: batch.references, durationMs: batch.durationMs, successCount: batch.images.length, failCount: 0, cancelCount: 0, status: "成功", images: batch.images });
        }
        return null;
    };

    const openResultDetail = (image: GeneratedImage) => {
        const log = resolveDetailLog(image);
        if (log) setDetailLog(log);
        else message.info("未找到该图片的生成信息");
    };

    const allLogsSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAllLogs = () => setSelectedLogIds(allLogsSelected ? [] : logs.map((log) => log.id));

    const deleteFailedLogs = () => {
        const failedIds = logs.filter((log) => log.status === "失败").map((log) => log.id);
        if (!failedIds.length) return;
        setSelectedLogIds(failedIds);
        setDeleteConfirmOpen(true);
    };

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error("请输入生图提示词");
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return null;
        }
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: [...references] };
    };

    const runGenerationSlot = async (id: string, snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }) => {
        const itemStartedAt = performance.now();
        const controller = new AbortController();
        generationControllersRef.current.set(id, controller);
        try {
            const requestOptions = { signal: controller.signal };
            const result = snapshot.references.length ? await requestEdit(snapshot.config, snapshot.text, snapshot.references, undefined, requestOptions) : await requestGeneration(snapshot.config, snapshot.text, requestOptions);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            const meta = await readImageMeta(image.dataUrl);
            const nextImage = { id: image.id, dataUrl: image.dataUrl, durationMs: performance.now() - itemStartedAt, width: meta.width, height: meta.height, bytes: getDataUrlByteSize(image.dataUrl) };
            if (controller.signal.aborted) return null;
            setResults((value) => updateResultById(value, id, { status: "success", image: nextImage }));
            return nextImage;
        } catch (error) {
            if (controller.signal.aborted) {
                setResults((value) => updateResultById(value, id, { status: "canceled", error: undefined, image: undefined }));
                return null;
            }
            setResults((value) => updateResultById(value, id, { status: "failed", error: error instanceof Error ? error.message : "生成失败" }));
            throw error;
        } finally {
            if (generationControllersRef.current.get(id) === controller) generationControllersRef.current.delete(id);
        }
    };

    const retryResult = async (index: number) => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        const id = results[index]?.id;
        if (!id) return;
        setResults((value) => updateResultById(value, id, { status: "pending", error: undefined, image: undefined }));
        const retryStartedAt = performance.now();
        try {
            const image = await runGenerationSlot(id, snapshot);
            if (!image) return;
            const stored = await uploadImage(image.dataUrl);
            const logImage = { ...image, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
            setResults((value) => updateResultById(value, id, { image: { ...image, dataUrl: stored.url, storageKey: stored.storageKey } }));
            saveLog(
                buildLog({
                    prompt: snapshot.text,
                    model,
                    config: { ...snapshot.config, count: "1" },
                    references: snapshot.references,
                    durationMs: performance.now() - retryStartedAt,
                    successCount: 1,
                    failCount: 0,
                    cancelCount: 0,
                    status: "成功",
                    images: [logImage],
                }),
            );
            lastBatchRef.current = { prompt: snapshot.text, config: { ...snapshot.config, count: "1" }, references: snapshot.references, durationMs: performance.now() - retryStartedAt, images: [logImage] };
            message.success("重试成功");
        } catch {
            // runGenerationSlot 已经把结果状态更新为 failed
        }
    };

    const displayResults = results;

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:overflow-hidden">

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">生图工作台</h1>
                                </div>
                                <div className="flex shrink-0 gap-2 lg:hidden">
                                    <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                        参数
                                    </Button>
                                </div>
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
                                <Input.TextArea value={prompt} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setPrompt(event.target.value)} rows={7} placeholder="描述画面主体、风格、构图、光线和用途" />
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">参考图</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            剪切板
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            上传
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint relative flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${isReferenceDragActive ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current += 1;
                                        if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true);
                                    }}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                                        if (!dragDepthRef.current) setIsReferenceDragActive(false);
                                    }}
                                    onDrop={(event) => {
                                        event.preventDefault();
                                        dragDepthRef.current = 0;
                                        setIsReferenceDragActive(false);
                                        void addReferences(event.dataTransfer.files);
                                    }}
                                    onWheel={(event) => {
                                        if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                        event.preventDefault();
                                        event.currentTarget.scrollLeft += event.deltaY;
                                    }}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                            <button
                                                type="button"
                                                className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                aria-label="移除参考图"
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{isReferenceDragActive ? "松开即可添加参考图" : "暂无参考图，可将图片拖到这里"}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    调整
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
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
                            <div>
                                <h2 className="text-xl font-semibold">生成结果</h2>
                            </div>
                            <div className="flex items-center gap-2">
                                {running ? <Tag className="m-0 px-2 py-1">等待 {formatDuration(elapsedMs)}</Tag> : null}
                                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAllLogs}>
                                    {allLogsSelected ? "取消全选" : "全选"}
                                </Button>
                                <Button size="small" icon={<XCircle className="size-3.5" />} disabled={!logs.some((log) => log.status === "失败")} onClick={deleteFailedLogs}>
                                    清除失败
                                </Button>
                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={() => setDeleteConfirmOpen(true)}>
                                    删除
                                </Button>
                            </div>
                        </div>
                        {displayResults.length ? (
                            <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
                                {displayResults.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} onViewDetail={openResultDetail} />
                                    ) : result.status === "failed" ? (
                                        <FailedImageCard key={result.id} error={result.error || "生成失败"} onRetry={() => retryResult(index)} />
                                    ) : result.status === "canceled" ? (
                                        <CanceledImageCard key={result.id} onRetry={() => retryResult(index)} />
                                    ) : (
                                        <PendingImageCard key={result.id} onCancel={() => cancelResult(result.id)} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <ImagePlus className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成图片" />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title="参数" placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除选中的 {selectedLogIds.length} 条生成记录吗？
            </Modal>
            <Modal title="生成详情" open={Boolean(detailLog)} onCancel={() => setDetailLog(null)} footer={null} width={760} destroyOnHidden>
                {detailLog ? <LogDetail log={detailLog} storageSettings={storageSettings} /> : null}
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">模型</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
    onViewDetail,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    onViewDetail: (image: GeneratedImage) => void;
}) {
    return (
        <Dropdown
            trigger={["contextMenu"]}
            menu={{
                items: [
                    { key: "detail", label: "查看详情", icon: <Eye className="size-3.5" /> },
                    { type: "divider" },
                    { key: "download", label: "下载", icon: <Download className="size-3.5" /> },
                ],
                onClick: ({ key }) => {
                    if (key === "detail") onViewDetail(image);
                    else if (key === "download") onDownload(image, index);
                },
            }}
        >
            <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                <Image src={image.dataUrl} alt={`生成结果 ${index + 1}`} className="aspect-square object-cover" />
                <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                    <div className="flex min-w-0 gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                        <span>
                            {image.width}x{image.height}
                        </span>
                        <span>{formatBytes(image.bytes)}</span>
                        <span>{formatDuration(image.durationMs)}</span>
                    </div>
                    <div className="flex min-w-0 flex-wrap gap-2">
                        <Tooltip title="添加到资产">
                            <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                                添加到资产
                            </Button>
                        </Tooltip>
                        <Tooltip title="加入参考图">
                            <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                                加入参考图
                            </Button>
                        </Tooltip>
                        <Tooltip title="下载">
                            <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                                下载
                            </Button>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </Dropdown>
    );
}

function PendingImageCard({ onCancel }: { onCancel: () => void }) {
    return (
        <Dropdown menu={{ items: [{ key: "cancel", danger: true, label: "取消生成", onClick: onCancel }] }} trigger={["contextMenu"]}>
            <div className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
                <div
                    className="absolute inset-0 opacity-60"
                    style={{
                        backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                        backgroundSize: "16px 16px",
                    }}
                />
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                    <LoaderCircle className="size-6 animate-spin" />
                    <span>生成中</span>
                </div>
            </div>
        </Dropdown>
    );
}

function CanceledImageCard({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-stone-600 dark:text-stone-300">已取消</div>
                <div className="text-xs text-stone-500 dark:text-stone-400">此图片的生成请求已停止</div>
            </div>
            <div className="flex justify-end border-t border-stone-200 p-3 dark:border-stone-800">
                <Button size="small" onClick={onRetry}>
                    重试
                </Button>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
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

function updateResultById(results: GenerationResult[], id: string, next: Partial<GenerationResult>) {
    return results.map((item) => (item.id === id ? { ...item, ...next } : item));
}

function LogDetail({ log, storageSettings }: { log: GenerationLog; storageSettings: { resultRoot: string; folders: Record<string, string> } | null }) {
    const savedFolder = storageSettings?.folders?.image || storageSettings?.resultRoot || "";
    const images = log.images.filter((image) => image.dataUrl);
    return (
        <div className="space-y-4">
            <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-stone-500 dark:text-stone-400">提示词</span>
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void navigator.clipboard.writeText(log.prompt)}>
                        复制
                    </Button>
                </div>
                <div className="whitespace-pre-wrap rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm dark:border-stone-800 dark:bg-stone-900">{log.prompt}</div>
            </div>
            {log.references?.length ? (
                <div>
                    <div className="mb-1 text-sm font-medium text-stone-500 dark:text-stone-400">参考图（{log.references.length} 张）</div>
                    <Image.PreviewGroup>
                        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                            {log.references.map((ref, index) => (
                                <Image key={ref.id || index} src={ref.dataUrl} alt={`reference-${index + 1}`} className="aspect-square w-full rounded-lg border border-stone-200 object-cover dark:border-stone-800" />
                            ))}
                        </div>
                    </Image.PreviewGroup>
                </div>
            ) : (
                <div>
                    <div className="mb-1 text-sm font-medium text-stone-500 dark:text-stone-400">参考图</div>
                    <div className="rounded-lg border border-dashed border-stone-300 p-3 text-center text-sm text-stone-500 dark:border-stone-700">暂无参考图（仅提示词生成）</div>
                </div>
            )}
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
                <LogDetailInfo label="模型" value={log.model} />
                <LogDetailInfo label="尺寸" value={log.size} />
                <LogDetailInfo label="质量" value={log.quality} />
                <LogDetailInfo label="分辨率" value={log.config?.imageResolution || "自动"} />
                <LogDetailInfo label="张数" value={`${log.imageCount} 张`} />
                <LogDetailInfo label="时间" value={log.time} />
                <LogDetailInfo label="耗时" value={formatDuration(log.durationMs)} />
                <LogDetailInfo
                    label="结果"
                    value={[log.successCount ? `成功 ${log.successCount}` : "", log.failCount ? `失败 ${log.failCount}` : "", log.cancelCount ? `取消 ${log.cancelCount}` : ""].filter(Boolean).join(" / ") || "—"}
                />
            </div>
            {images.length ? (
                <div>
                    <div className="mb-2 text-sm font-medium text-stone-500 dark:text-stone-400">生成结果（{images.length} 张）</div>
                    <Image.PreviewGroup>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {images.map((image, index) => (
                                <Image key={image.id || index} src={image.dataUrl} alt={`result-${index + 1}`} className="aspect-square w-full rounded-lg border border-stone-200 object-cover dark:border-stone-800" />
                            ))}
                        </div>
                    </Image.PreviewGroup>
                </div>
            ) : null}
            {savedFolder ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm dark:border-stone-800 dark:bg-stone-900">
                    <div className="min-w-0">
                        <div className="text-stone-500 dark:text-stone-400">已保存到文件夹</div>
                        <div className="truncate font-medium">{savedFolder}</div>
                    </div>
                    <Button size="small" icon={<FolderOpen className="size-3.5" />} onClick={() => void window.lySpaceDesktop?.openStorageDirectory(savedFolder)}>
                        打开文件夹
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

function LogDetailInfo({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 dark:border-stone-800 dark:bg-stone-900">
            <div className="text-xs text-stone-500 dark:text-stone-400">{label}</div>
            <div className="mt-0.5 truncate font-medium" title={value}>
                {value}
            </div>
        </div>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        cancelCount: log.cancelCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "成功",
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
        thumbnails: [],
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        imageResolution: log.config?.imageResolution || "1k",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
        background: log.config?.background || "",
    };
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

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    cancelCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    cancelCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        imageResolution: config.imageResolution,
        size: config.size,
        count: config.count,
        background: config.background,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        cancelCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}
