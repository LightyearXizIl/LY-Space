import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, Copy, Download, Eye, FolderOpen, FolderPlus, ImagePlus, LoaderCircle, PenLine, RotateCcw, SlidersHorizontal, Sparkles, Trash2, Upload, Wand2, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent } from "react";
import { App, Button, Checkbox, Drawer, Dropdown, Empty, Image, Input, Modal, Tag, Tooltip, Typography, type MenuProps } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";

import { CameraModule } from "@/components/camera-module";
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
import { requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
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
    localPath?: string;
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

// 模块级生成任务表：切换页面（组件卸载）不中断任务，返回页面时恢复状态并同步 UI
type ActiveImageTask = {
    controller: AbortController;
    status: "pending" | "success" | "failed" | "canceled";
    image?: GeneratedImage;
    error?: string;
    startedAt: number;
};
const activeImageTasks = new Map<string, ActiveImageTask>();
const imageTaskListeners = new Set<() => void>();
function emitImageTasks() {
    imageTaskListeners.forEach((listener) => listener());
}
function subscribeImageTasks(listener: () => void) {
    imageTaskListeners.add(listener);
    return () => {
        imageTaskListeners.delete(listener);
    };
}

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
    const [optimizingPrompt, setOptimizingPrompt] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
    const [detailLog, setDetailLog] = useState<GenerationLog | null>(null);
    const [storageSettings, setStorageSettings] = useState<{ resultRoot: string; folders: Record<string, string> } | null>(null);
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

    // 注意：不再在组件卸载时 abort 生成任务——切换页面任务继续在后台运行，
    // 状态保存在模块级 activeImageTasks，返回页面时恢复。
    // 挂载时合并模块级任务表（切页返回恢复进行中/已完成任务），并订阅任务变化同步 UI
    useEffect(() => {
        const sync = () => {
            if (activeImageTasks.size) {
                const earliest = Math.min(...[...activeImageTasks.values()].map((task) => task.startedAt));
                setStartedAt(earliest);
                setElapsedMs(performance.now() - earliest);
            }
            setRunning(activeImageTasks.size > 0);
            const completedIds: string[] = [];
            activeImageTasks.forEach((task, id) => {
                if (task.status !== "pending") completedIds.push(id);
            });
            setResults((prev) => {
                let next = prev;
                activeImageTasks.forEach((task, id) => {
                    const existing = next.find((result) => result.id === id);
                    if (existing) {
                        next = next.map((result) => (result.id === id ? { ...result, status: task.status, image: task.image, error: task.error } : result));
                    } else {
                        next = [{ id, status: task.status, image: task.image, error: task.error }, ...next];
                    }
                });
                return next;
            });
            // 已完成任务被结果区消费后从任务表移除（防止无限增长；session 已兜底持久化）
            if (completedIds.length) completedIds.forEach((id) => activeImageTasks.delete(id));
        };
        sync();
        return subscribeImageTasks(sync);
    }, []);

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
                setResults((prev) => {
                    const restored = (session.results || []).map((result) => {
                        if (result.status !== "pending") return result;
                        // sync 已合并的最终状态（切页期间任务完成）优先保留
                        const existing = prev.find((item) => item.id === result.id);
                        if (existing && existing.status !== "pending") return existing;
                        // 同会话切页：任务表中有该任务则恢复其状态（进行中/已完成）
                        const task = activeImageTasks.get(result.id);
                        if (task) return { ...result, status: task.status, image: task.image, error: task.error };
                        // 真实重启/中断场景才标记为失败
                        return { ...result, status: "failed" as const, error: "上次生成已中断，可重试" };
                    });
                    const restoredIds = new Set(restored.map((item) => item.id));
                    const extra = prev.filter((item) => !restoredIds.has(item.id));
                    return [...restored, ...extra];
                });
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

    const addReferences = async (files?: FileList | readonly File[] | null) => {
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

    const addReferencesFromPaste = (event: ReactClipboardEvent) => {
        const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
        if (!files.length) return;
        event.preventDefault();
        void addReferences(files);
    };

    const cancelResult = (id: string) => {
        const task = activeImageTasks.get(id);
        const controller = task?.controller || generationControllersRef.current.get(id);
        if (!controller || controller.signal.aborted) {
            // 兜底：任务表/ref 中找不到可用控制器时仍移除卡片并提示，避免"点了没反应"
            activeImageTasks.delete(id);
            setResults((value) => value.filter((result) => result.id !== id));
            message.info("已取消生成");
            return;
        }
        controller.abort();
        activeImageTasks.delete(id);
        emitImageTasks();
        // 取消后直接移除该槽位，卡片从结果区消失（cancelCount 统计由 runGenerationSlot 返回 null 决定）
        setResults((value) => value.filter((result) => result.id !== id));
        message.info("已取消生成");
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

    const fetchImageAsBlob = async (dataUrl: string): Promise<Blob> => {
        try {
            return await (await fetch(dataUrl)).blob();
        } catch {
            if (!window.lySpaceDesktop) throw new Error("图片下载失败");
            // 浏览器 fetch 失败（远程 URL 跨域）时回退主进程下载
            const result = await window.lySpaceDesktop.fetchUrl(dataUrl);
            return new Blob([result.bytes], { type: result.mimeType || "image/png" });
        }
    };

    const extensionForBlob = (blob: Blob) => {
        const mime = blob.type.toLowerCase();
        if (mime.includes("jpeg")) return "jpg";
        if (mime.includes("webp")) return "webp";
        if (mime.includes("gif")) return "gif";
        return "png";
    };

    const downloadImage = async (image: GeneratedImage, index: number) => {
        if (window.lySpaceDesktop) {
            try {
                const blob = await fetchImageAsBlob(image.dataUrl);
                const result = await window.lySpaceDesktop.saveFileDialog({ defaultPath: `image-${index + 1}.${extensionForBlob(blob)}`, bytes: await blob.arrayBuffer() });
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

    const saveLog = (log: GenerationLog) => {
        void trackWrite(logStore.setItem(log.id, serializeLog(log))).then(refreshLogs).catch(() => undefined);
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());

    const resolveDetailLog = async (image: GeneratedImage): Promise<GenerationLog | null> => {
        const matched = logs.find((log) => log.images.some((item) => item.id === image.id));
        if (matched) return matched;
        // logs state 可能尚未加载完成（IndexedDB 异步读取），异步重读兜底并顺带刷新 state
        const stored = await readStoredLogs();
        if (stored.length) setLogs(stored);
        const matchedStored = stored.find((log) => log.images.some((item) => item.id === image.id));
        if (matchedStored) return matchedStored;
        const batch = lastBatchRef.current;
        if (batch && batch.images.some((item) => item.id === image.id)) {
            return buildLog({ prompt: batch.prompt, model, config: batch.config, references: batch.references, durationMs: batch.durationMs, successCount: batch.images.length, failCount: 0, cancelCount: 0, status: "成功", images: batch.images });
        }
        return null;
    };

    const openResultDetail = async (image: GeneratedImage) => {
        const log = await resolveDetailLog(image);
        if (log) setDetailLog(log);
        else message.info("未找到该图片的生成信息");
    };

    const restoreToWorkbench = async (image: GeneratedImage) => {
        const log = await resolveDetailLog(image);
        if (!log) {
            message.error("未找到该图片的生成信息，无法恢复");
            return;
        }
        // 将该次生成操作恢复到工作台：提示词、参考图与参数逐项还原，不自动触发生成
        setPrompt(log.prompt);
        setReferences(log.references || []);
        const { config: logConfig } = log;
        if (logConfig.imageModel) updateConfig("imageModel", logConfig.imageModel);
        if (logConfig.model) updateConfig("model", logConfig.model);
        if (logConfig.quality) updateConfig("quality", logConfig.quality);
        if (logConfig.imageResolution) updateConfig("imageResolution", logConfig.imageResolution);
        if (logConfig.size) updateConfig("size", logConfig.size);
        if (logConfig.count) updateConfig("count", logConfig.count);
        if (logConfig.background !== undefined) updateConfig("background", logConfig.background);
        message.success("已将该图片的生成操作恢复到工作台");
    };

    // 结果图片勾选与批量操作
    const successImageResults = results.filter((result) => result.status === "success" && result.image);
    const allImagesSelected = Boolean(successImageResults.length) && selectedImageIds.length === successImageResults.length;
    const toggleAllImages = () => setSelectedImageIds(allImagesSelected ? [] : successImageResults.map((result) => result.image!.id));
    const selectedImages = results.filter((result) => result.image && selectedImageIds.includes(result.image.id)).map((result) => result.image!);
    const toggleImageSelected = (imageId: string, checked: boolean) =>
        setSelectedImageIds((prev) => (checked ? [...prev, imageId] : prev.filter((id) => id !== imageId)));

    const downloadSelected = async () => {
        if (window.lySpaceDesktop) {
            try {
                const files = await Promise.all(
                    selectedImages.map(async (image, index) => {
                        const blob = await fetchImageAsBlob(image.dataUrl);
                        return { name: `image-${index + 1}.${extensionForBlob(blob)}`, bytes: await blob.arrayBuffer() };
                    }),
                );
                // 只弹一次保存对话框，全部图片写入所选目录
                const result = await window.lySpaceDesktop.saveFilesDialog({ files });
                if (!result.canceled) message.success(`已保存 ${result.paths.length} 张图片`);
            } catch {
                message.error("保存图片失败");
            }
        } else {
            for (let i = 0; i < selectedImages.length; i += 1) saveAs(selectedImages[i].dataUrl, `image-${i + 1}.png`);
        }
        setSelectedImageIds([]);
    };
    const addSelectedToAssets = async () => {
        for (let i = 0; i < selectedImages.length; i += 1) await saveResultToAssets(selectedImages[i], i);
        setSelectedImageIds([]);
    };
    const deleteSelectedImages = async () => {
        // 只删除勾选的图片：所在记录中移除被删图片（记录无剩余图片时删除记录），不波及其他图片
        const selectedIds = new Set(selectedImageIds);
        const relatedLogs = logs.filter((log) => log.images.some((image) => selectedIds.has(image.id)));
        const selectedImagesInLogs = relatedLogs.flatMap((log) => log.images).filter((image) => selectedIds.has(image.id));
        // 只回收被删图片的 blob 与本地文件，同记录的其它图片保留
        const imageKeys = selectedImagesInLogs.map((image) => image.storageKey).filter((key): key is string => Boolean(key));
        const localPaths = [...new Set(selectedImagesInLogs.map((image) => image.localPath).filter((path): path is string => Boolean(path)))];
        const missingPathCount = selectedImagesInLogs.filter((image) => !image.localPath).length;
        void Promise.all([
            deleteStoredImages(imageKeys),
            ...relatedLogs.map(async (log) => {
                const remaining = log.images.filter((image) => !selectedIds.has(image.id));
                if (remaining.length) {
                    await logStore.setItem(log.id, serializeLog({ ...log, images: remaining, thumbnails: remaining.map((image) => image.dataUrl).filter(Boolean) }));
                } else {
                    await logStore.removeItem(log.id);
                }
            }),
        ]).then(refreshLogs).catch(() => undefined);
        if (localPaths.length && window.lySpaceDesktop) {
            try {
                const { deleted, missing, failed, skipped } = await window.lySpaceDesktop.deleteGeneratedFiles(localPaths);
                if (failed) {
                    message.warning(`有 ${failed} 个本地文件删除失败（可能被占用或权限不足），已删除 ${deleted} 个`);
                } else if (skipped) {
                    message.warning(`${skipped} 个文件路径不在存储目录内已跳过（可能存储目录已变更）`);
                } else if (deleted > 0) {
                    message.success(`已删除 ${deleted} 张图片，本地文件已同步删除`);
                } else if (missing === localPaths.length) {
                    message.info("本地文件不存在，已忽略");
                }
            } catch {
                message.warning("本地文件删除失败");
            }
        }
        // 有生成记录但缺少本地路径（旧版本生成/落盘失败）的图片如实提示，便于区分定位
        if (missingPathCount) message.info(`${missingPathCount} 张图片有生成记录但缺少本地路径（旧版本生成），已跳过本地删除`);
        // 同步清理任务表中对应的已完成任务，避免被挂载 sync 重新合并复活
        activeImageTasks.forEach((task, id) => {
            if (task.status !== "pending" && task.image && selectedIds.has(task.image.id)) activeImageTasks.delete(id);
        });
        setResults((value) => value.filter((result) => !(result.image && selectedIds.has(result.image.id))));
        setSelectedImageIds([]);
    };

    const clearFailedResults = () => {
        const failedCards = results.filter((result) => result.status === "failed");
        const failedIds = logs.filter((log) => log.status === "失败").map((log) => log.id);
        if (!failedCards.length && !failedIds.length) {
            message.info("没有需要清除的失败项");
            return;
        }
        if (failedCards.length) {
            setResults((value) => value.filter((result) => result.status !== "failed"));
            // 同步清理任务表中已完成的失败任务，避免被挂载 sync 重新合并复活
            activeImageTasks.forEach((task, id) => {
                if (task.status === "failed") activeImageTasks.delete(id);
            });
            emitImageTasks();
        }
        // 失败记录不含结果图 blob，直接删除记录即可；同步刷新日志列表
        if (failedIds.length) {
            void Promise.all(failedIds.map((id) => logStore.removeItem(id))).then(refreshLogs).catch(() => undefined);
        }
        message.success("已清除失败的生成项");
    };

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
            // 使用所选文本模型（默认 defaultConfig.textModel = gpt-5.5）；requestImageQuestion 内部优先取 config.model
            const textConfig = { ...effectiveConfig, model: effectiveConfig.textModel || effectiveConfig.model };
            const answer = await requestImageQuestion(
                textConfig,
                [
                    { role: "system", content: "你是专业的生图提示词优化专家。请优化用户给出的提示词，使其更具体、生动、可控（可补充主体、风格、构图、光线、氛围、画质等描述），只输出优化后的提示词本身，不要解释、不要引号、不要多余内容。" },
                    { role: "user", content: text },
                ],
                (delta) => {
                    // onDelta 为增量回调，按序累加并流式回填提示词
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
        activeImageTasks.set(id, { controller, status: "pending", startedAt: itemStartedAt });
        emitImageTasks();
        try {
            const requestOptions = { signal: controller.signal };
            const result = snapshot.references.length ? await requestEdit(snapshot.config, snapshot.text, snapshot.references, undefined, requestOptions) : await requestGeneration(snapshot.config, snapshot.text, requestOptions);
            const image = result[0];
            if (!image) throw new Error("接口没有返回图片");
            const meta = await readImageMeta(image.dataUrl);
            const nextImage: GeneratedImage = { id: image.id, dataUrl: image.dataUrl, durationMs: performance.now() - itemStartedAt, width: meta.width, height: meta.height, bytes: getDataUrlByteSize(image.dataUrl), localPath: image.localPath };
            if (controller.signal.aborted) return null;
            setResults((value) => updateResultById(value, id, { status: "success", image: nextImage }));
            // 完成状态保留在任务表，切页返回时由挂载合并消费（消费后移除）
            activeImageTasks.set(id, { controller, status: "success", image: nextImage, startedAt: itemStartedAt });
            emitImageTasks();
            return nextImage;
        } catch (error) {
            if (controller.signal.aborted) {
                setResults((value) => updateResultById(value, id, { status: "canceled", error: undefined, image: undefined }));
                activeImageTasks.delete(id);
                emitImageTasks();
                return null;
            }
            setResults((value) => updateResultById(value, id, { status: "failed", error: error instanceof Error ? error.message : "生成失败" }));
            activeImageTasks.set(id, { controller, status: "failed", error: error instanceof Error ? error.message : "生成失败", startedAt: itemStartedAt });
            emitImageTasks();
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
        let retriedImage: GeneratedImage | null = null;
        try {
            const image = await runGenerationSlot(id, snapshot);
            if (!image) return;
            retriedImage = image;
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
            // 落库失败时用重试成功图片设置兜底，保证右键详情仍可用（runGenerationSlot 已更新卡片状态）
            if (retriedImage) {
                lastBatchRef.current = { prompt: snapshot.text, config: { ...snapshot.config, count: "1" }, references: snapshot.references, durationMs: performance.now() - retryStartedAt, images: [retriedImage] };
            }
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
                                <div>
                                    <Input.TextArea value={prompt} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setPrompt(event.target.value)} rows={7} placeholder="描述画面主体、风格、构图、光线和用途" />
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

                            <div>
                                <CameraModule value={prompt} onChange={setPrompt} />
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
                                    className={`hover-scrollbar hover-scrollbar-hint relative flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors focus:outline-none ${isReferenceDragActive ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onMouseEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
                                    onPaste={addReferencesFromPaste}
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
                                    <Image.PreviewGroup>
                                        {references.map((item, index) => (
                                            <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                                <Image src={item.dataUrl} alt={item.name} className="size-full object-cover" />
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
                                    </Image.PreviewGroup>
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{isReferenceDragActive ? "松开即可添加参考图" : "暂无参考图，可将图片拖到这里或直接粘贴"}</div> : null}
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
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={() => void generate()}>
                                {running ? "追加生成" : "开始生成"}
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <h2 className="text-xl font-semibold">生成结果</h2>
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                                {running ? <Tag className="m-0 px-2 py-1">等待 {formatDuration(elapsedMs)}</Tag> : null}
                                <Button size="small" icon={<Download className="size-3.5" />} disabled={!selectedImageIds.length} onClick={() => void downloadSelected()}>
                                    下载选中
                                </Button>
                                <Button size="small" icon={<FolderPlus className="size-3.5" />} disabled={!selectedImageIds.length} onClick={() => void addSelectedToAssets()}>
                                    添加资产
                                </Button>
                                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!successImageResults.length} onClick={toggleAllImages}>
                                    {allImagesSelected ? "取消全选" : "全选"}
                                </Button>
                                <Button size="small" icon={<XCircle className="size-3.5" />} onClick={clearFailedResults}>
                                    清除失败
                                </Button>
                                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedImageIds.length} onClick={deleteSelectedImages}>
                                    {selectedImageIds.length ? `删除选中 (${selectedImageIds.length})` : "删除"}
                                </Button>
                            </div>
                        </div>
                        {displayResults.length ? (
                            <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
                                {displayResults.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard
                                            key={result.id}
                                            image={result.image}
                                            index={index}
                                            selected={selectedImageIds.includes(result.image.id)}
                                            onToggleSelect={(checked) => toggleImageSelected(result.image!.id, checked)}
                                            onEdit={addResultToReferences}
                                            onDownload={downloadImage}
                                            onSaveAsset={saveResultToAssets}
                                            onViewDetail={openResultDetail}
                                            onReEdit={restoreToWorkbench}
                                        />
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
    selected,
    onToggleSelect,
    onEdit,
    onDownload,
    onSaveAsset,
    onViewDetail,
    onReEdit,
}: {
    image: GeneratedImage;
    index: number;
    selected: boolean;
    onToggleSelect: (checked: boolean) => void;
    onEdit: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
    onViewDetail: (image: GeneratedImage) => void;
    onReEdit: (image: GeneratedImage) => void;
}) {
    return (
        <Dropdown
            trigger={["contextMenu"]}
            menu={{
                items: [
                    { key: "detail", label: "查看详情", icon: <Eye className="size-3.5" /> },
                    { key: "re-edit", label: "重新编辑", icon: <RotateCcw className="size-3.5" /> },
                    { type: "divider" },
                    { key: "download", label: "下载", icon: <Download className="size-3.5" /> },
                ],
                onClick: ({ key }) => {
                    if (key === "detail") onViewDetail(image);
                    else if (key === "re-edit") onReEdit(image);
                    else if (key === "download") onDownload(image, index);
                },
            }}
        >
            <div className="relative overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                <Checkbox
                    className="absolute left-2 top-2 z-10"
                    checked={selected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => onToggleSelect(event.target.checked)}
                />
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
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm dark:!bg-stone-700/90 dark:!text-stone-100 dark:!shadow-none" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm dark:!bg-stone-700/90 dark:!text-stone-100 dark:!shadow-none" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
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
