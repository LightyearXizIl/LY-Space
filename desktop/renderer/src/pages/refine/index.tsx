import { App, Button } from "antd";
import { ClipboardPaste, Download, FolderOpen, Redo2, Send, Undo2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";
import { useNavigate } from "react-router-dom";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { cropPixelSize, refineExtension, refineMimeType, renderRefinedImage, resolveRefineDimensions, validateRefineSource, defaultRefineTransform, defaultRefineAdjustments, type RefineCropRect, type RefineFormat, type RefineResolution, type RefineSourceImage } from "@/lib/refine-image";
import { refineCommit, refineRedo, refineUndo, type RefineEditHistory, type RefineEditState } from "@/lib/refine-history";
import { enqueueReferenceHandoff } from "@/services/reference-handoff";
import { registerLocalStateFlusher } from "@/services/desktop-storage";
import { uploadImage } from "@/services/image-storage";
import { requestEdit } from "@/services/api/image";
import { selectableImageModelsByFeature, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { loadWorkbenchSession, saveWorkbenchSession } from "@/services/workbench-session";
import { SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import type { ReferenceImage } from "@/types/image";
import { RefinePreviewStage } from "@/pages/refine/components/preview-stage";
import { RefineSettingsPanel } from "@/pages/refine/components/settings-panel";

type EditStateBundle = RefineEditHistory & { edits: RefineEditState };
type RefineSession = { source: RefineSourceImage | null; crop: RefineCropRect; ratioPreset: string; resolution: RefineResolution; customWidth: number; customHeight: number; format: RefineFormat; quality: number; edits?: RefineEditState; history?: RefineEditState[]; historyIndex?: number; future?: RefineEditState[] };

const SESSION_KEY = "refine-workbench:current-session";
const fullCrop: RefineCropRect = { x: 0, y: 0, width: 1, height: 1 };
const freshEdits: RefineEditState = { transform: defaultRefineTransform, filter: "original", adjustments: { ...defaultRefineAdjustments }, lut: null };
const freshBundle: EditStateBundle = { edits: freshEdits, history: [], historyIndex: -1, future: [] };

export default function RefinePage() {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const inputRef = useRef<HTMLInputElement>(null);
    const [source, setSource] = useState<RefineSourceImage | null>(null);
    const [crop, setCrop] = useState<RefineCropRect>(fullCrop);
    const [ratioPreset, setRatioPreset] = useState("free");
    const [resolution, setResolution] = useState<RefineResolution>("original");
    const [customWidth, setCustomWidth] = useState(1024);
    const [customHeight, setCustomHeight] = useState(1024);
    const [format, setFormat] = useState<RefineFormat>("png");
    const [quality, setQuality] = useState(92);
    const [hydrated, setHydrated] = useState(false);
    const [cropOpen, setCropOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [previewUrl, setPreviewUrl] = useState("");
    const [editsBundle, setEditsBundle] = useState<EditStateBundle>(freshBundle);
    const sessionSnapshotRef = useRef<RefineSession | null>(null);
    const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previewFrameRef = useRef<number | null>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const edits = editsBundle.edits;

    useEffect(() => {
        let active = true;
        void loadWorkbenchSession<RefineSession>(SESSION_KEY).then((session) => {
            if (!active || !session) return;
            setSource(session.source || null);
            setCrop(session.crop || fullCrop);
            setRatioPreset(session.ratioPreset || "free");
            setResolution(session.resolution || "original");
            setCustomWidth(session.customWidth || 1024);
            setCustomHeight(session.customHeight || 1024);
            setFormat(session.format || "png");
            setQuality(session.quality || 92);
            if (session.edits || session.history) {
                setEditsBundle({
                    edits: session.edits || freshEdits,
                    history: session.history || [],
                    historyIndex: typeof session.historyIndex === "number" ? session.historyIndex : -1,
                    future: session.future || [],
                });
            }
        }).finally(() => active && setHydrated(true));
        return () => {
            active = false;
        };
    }, []);

    // 渲染期同步最新会话快照(供防抖落盘与卸载落盘读取最新值)；缩放/平移/对比位置等视图状态不写入会话
    sessionSnapshotRef.current = { source, crop, ratioPreset, resolution, customWidth, customHeight, format, quality, edits, history: editsBundle.history, historyIndex: editsBundle.historyIndex, future: editsBundle.future } satisfies RefineSession;

    // 会话保存:trailing 防抖 500ms(拖动调色等高频编辑时避免每秒数十次全量写库,会话含大图 dataUrl)
    useEffect(() => {
        if (!hydrated) return;
        if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = setTimeout(() => {
            sessionSaveTimerRef.current = null;
            if (sessionSnapshotRef.current) void saveWorkbenchSession(SESSION_KEY, sessionSnapshotRef.current);
        }, 500);
        return () => {
            if (sessionSaveTimerRef.current) {
                clearTimeout(sessionSaveTimerRef.current);
                sessionSaveTimerRef.current = null;
            }
        };
    }, [crop, customHeight, customWidth, editsBundle, format, hydrated, quality, ratioPreset, resolution, source]);

    // 卸载/切换时立即落盘防抖窗口内未保存的编辑
    useEffect(() => () => {
        if (sessionSaveTimerRef.current) {
            clearTimeout(sessionSaveTimerRef.current);
            sessionSaveTimerRef.current = null;
            if (sessionSnapshotRef.current) void saveWorkbenchSession(SESSION_KEY, sessionSnapshotRef.current);
        }
    }, []);

    useEffect(() => registerLocalStateFlusher(() => {
        if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
        return sessionSnapshotRef.current ? saveWorkbenchSession(SESSION_KEY, sessionSnapshotRef.current) : undefined;
    }), []);

    // 预览重绘 rAF 合并:拖动调色滑杆等高频 edits 变化时每帧最多一次全量 canvas 重绘
    useEffect(() => {
        if (!source) {
            setPreviewUrl("");
            return;
        }
        let active = true;
        let url = "";
        if (previewFrameRef.current) cancelAnimationFrame(previewFrameRef.current);
        previewFrameRef.current = requestAnimationFrame(() => {
            previewFrameRef.current = null;
            if (!active) return;
            void renderRefinedImage(source.dataUrl, source, crop, cropPixelSize(source, crop), "png", .92, edits).then((blob) => {
                if (!active) return;
                url = URL.createObjectURL(blob);
                setPreviewUrl(url);
            }).catch(() => active && setPreviewUrl(source.dataUrl));
        });
        return () => {
            active = false;
            if (url) URL.revokeObjectURL(url);
        };
    }, [crop, edits, source]);

    // 卸载时取消挂起的预览帧
    useEffect(() => () => {
        if (previewFrameRef.current) cancelAnimationFrame(previewFrameRef.current);
    }, []);

    const dimensions = source ? resolveRefineDimensions(source, crop, resolution, customWidth, customHeight) : null;
    const cropSize = source ? cropPixelSize(source, crop) : null;

    const replaceSource = async (input: File | Blob | string, name = "reference.png") => {
        const invalid = validateRefineSource(input);
        if (invalid) return message.warning(invalid);
        try {
            const stored = await uploadImage(input);
            const next: RefineSourceImage = { id: nanoid(), name, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes };
            const apply = () => {
                setSource(next);
                setCrop(fullCrop);
                setRatioPreset("free");
                setResolution("original");
                setCustomWidth(next.width);
                setCustomHeight(next.height);
                setEditsBundle({ edits: { ...freshEdits, adjustments: { ...defaultRefineAdjustments } }, history: [], historyIndex: -1, future: [] });
            };
            if (source) modal.confirm({ title: "替换当前图片？", content: "当前精修草稿将被替换。", okText: "替换", cancelText: "取消", onOk: apply });
            else apply();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片读取失败");
        }
    };

    const addFiles = (files?: FileList | null) => {
        const file = Array.from(files || []).find((item) => item.type.startsWith("image/"));
        if (!file) return message.warning("请选择图片文件");
        void replaceSource(file, file.name);
    };

    const addClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const item = items.find((entry) => entry.types.some((type) => type.startsWith("image/")));
            const type = item?.types.find((value) => value.startsWith("image/"));
            if (!item || !type) throw new Error("剪贴板中没有图片");
            await replaceSource(await item.getType(type), "clipboard.png");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "无法读取剪贴板图片");
        }
    };

    // 页面级 Ctrl+V 粘贴图片（输入控件内粘贴不拦截）
    const replaceSourceRef = useRef(replaceSource);
    replaceSourceRef.current = replaceSource;
    useEffect(() => {
        const handlePaste = (event: ClipboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("input,textarea,[contenteditable='true']")) return;
            const item = Array.from(event.clipboardData?.items || []).find((entry) => entry.type.startsWith("image/"));
            if (!item) return;
            const file = item.getAsFile();
            if (!file) return;
            event.preventDefault();
            void replaceSourceRef.current(file, "clipboard.png");
        };
        window.addEventListener("paste", handlePaste);
        return () => window.removeEventListener("paste", handlePaste);
    }, []);

    const updateCustomWidth = (value: string) => {
        if (!source) return;
        const width = Math.max(1, Math.floor(Number(value) || 1));
        const ratio = cropPixelSize(source, crop).width / cropPixelSize(source, crop).height;
        setCustomWidth(width);
        setCustomHeight(Math.max(1, Math.round(width / ratio)));
    };

    const updateCustomHeight = (value: string) => {
        if (!source) return;
        const height = Math.max(1, Math.floor(Number(value) || 1));
        const ratio = cropPixelSize(source, crop).width / cropPixelSize(source, crop).height;
        setCustomHeight(height);
        setCustomWidth(Math.max(1, Math.round(height * ratio)));
    };

    const buildOutput = async () => {
        if (!source || !dimensions) throw new Error("请先载入图片");
        if (dimensions.disabled) throw new Error(dimensions.reason);
        return { blob: await renderRefinedImage(source.dataUrl, source, crop, dimensions, format, quality / 100, edits), dimensions };
    };

    // 提交编辑（进历史并截断 redo 分支）；拖动中的预览走 previewEdits 不产生历史
    const commitEdits = (next: RefineEditState) => setEditsBundle((state) => ({ edits: next, ...refineCommit(state, state.edits, next) }));
    const previewEdits = (next: RefineEditState) => setEditsBundle((state) => ({ ...state, edits: next }));
    const undoEdits = () => setEditsBundle((state) => {
        const result = refineUndo(state, state.edits);
        return result ? { ...state, ...result } : state;
    });
    const redoEdits = () => setEditsBundle((state) => {
        const result = refineRedo(state);
        return result ? { ...state, ...result } : state;
    });

    const exportImage = async () => {
        setBusy(true);
        try {
            const { blob, dimensions: output } = await buildOutput();
            saveAs(blob, `refined-${new Date().toISOString().replace(/[:.]/g, "-")}-${output.width}x${output.height}.${refineExtension(format)}`);
            message.success("图片已导出");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片导出失败");
        } finally {
            setBusy(false);
        }
    };

    const sendTo = async (target: "image" | "video") => {
        setBusy(true);
        try {
            if (target === "video") {
                const session = await loadWorkbenchSession<{ references?: ReferenceImage[] }>("video-workbench:current-session");
                if ((session?.references || []).length >= SEEDANCE_REFERENCE_LIMITS.images) throw new Error("视频创作台最多保留 9 张参考图");
            }
            const { blob, dimensions: output } = await buildOutput();
            const stored = await uploadImage(blob);
            await enqueueReferenceHandoff({ target, storageKey: stored.storageKey, name: `refined-${output.width}x${output.height}.${refineExtension(format)}`, type: refineMimeType(format), width: output.width, height: output.height });
            message.success(target === "image" ? "已发送到生图工作台" : "已发送到视频创作台");
            navigate(target === "image" ? "/image" : "/video");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "发送失败");
        } finally {
            setBusy(false);
        }
    };

    const runAiTool = async (aiMode: "repair" | "upscale", aiPrompt: string) => {
        if (!source) return;
        const models = selectableImageModelsByFeature(config, aiMode === "upscale" ? "generative-upscale" : "image-edit");
        if (!models.length) return message.error(aiMode === "upscale" ? "没有声明支持生成式高清的图片模型，请在渠道设置中启用能力" : "没有声明支持全图修复的图片模型，请在渠道设置中启用能力");
        setBusy(true);
        try {
            const work = await renderRefinedImage(source.dataUrl, source, crop, cropPixelSize(source, crop), "png", .92, edits);
            const workImage = await uploadImage(work);
            const selected = models.includes(effectiveConfig.model) ? effectiveConfig.model : models[0];
            const output = await requestEdit({ ...effectiveConfig, model: selected, imageModel: selected, count: "1", imageResolution: aiMode === "upscale" ? "2k" : effectiveConfig.imageResolution }, aiMode === "upscale" ? `请将图片生成式高清放大并保留构图。${aiPrompt}` : `请进行全图修复：去瑕疵、降噪、清晰化。${aiPrompt}`, [{ id: nanoid(), name: "refine-work.png", type: workImage.mimeType, dataUrl: workImage.url, storageKey: workImage.storageKey }]);
            const result = output[0];
            if (!result) throw new Error("AI 没有返回图片");
            await replaceSource(result.dataUrl, `ai-refined-${Date.now()}.png`);
            message.success("AI 精修完成；结果已作为新版本保存");
        } catch (error) { message.error(error instanceof Error ? error.message : "AI 精修失败"); } finally { setBusy(false); }
    };

    const insertAsset = (asset: InsertAssetPayload) => {
        if (asset.kind !== "image") return message.warning("精修工作台只能载入图片资产");
        void replaceSource(asset.dataUrl, asset.title);
        setAssetPickerOpen(false);
    };

    const outputDisabled = !source || Boolean(dimensions?.disabled);

    return (
        <main className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-950 dark:bg-stone-950 dark:text-stone-100">
            <input ref={inputRef} className="hidden" type="file" accept="image/*" onChange={(event: ChangeEvent<HTMLInputElement>) => addFiles(event.target.files)} />
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 px-5 py-3 dark:border-stone-800">
                <div>
                    <h1 className="text-xl font-semibold">精修工作台</h1>
                    <p className="mt-0.5 text-sm text-stone-500">裁切、调整与调色，并发送为创作参考图。</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button icon={<Upload className="size-4" />} onClick={() => inputRef.current?.click()}>上传</Button>
                    <Button icon={<ClipboardPaste className="size-4" />} onClick={() => void addClipboard()}>剪贴板</Button>
                    <Button icon={<FolderOpen className="size-4" />} onClick={() => setAssetPickerOpen(true)}>我的资产</Button>
                </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 lg:flex-row lg:overflow-hidden">
                <RefinePreviewStage source={source} previewUrl={previewUrl} crop={crop} transform={edits.transform} onPickFile={() => inputRef.current?.click()} onFiles={addFiles} />
                <aside className="w-full shrink-0 lg:h-full lg:min-h-0 lg:w-[400px]">
                    <RefineSettingsPanel
                        source={source}
                        edits={edits}
                        onCommitEdits={commitEdits}
                        onPreviewEdits={previewEdits}
                        ratioPreset={ratioPreset}
                        onRatioPreset={setRatioPreset}
                        onOpenCrop={() => setCropOpen(true)}
                        cropSize={cropSize}
                        resolution={resolution}
                        onResolution={setResolution}
                        customWidth={customWidth}
                        customHeight={customHeight}
                        onCustomWidth={updateCustomWidth}
                        onCustomHeight={updateCustomHeight}
                        format={format}
                        onFormat={setFormat}
                        quality={quality}
                        onQuality={setQuality}
                        dimensions={dimensions}
                        busy={busy}
                        onRunAi={(mode, prompt) => void runAiTool(mode, prompt)}
                    />
                </aside>
            </div>
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 px-5 py-2.5 dark:border-stone-800">
                <div className="flex items-center gap-1">
                    <Button size="small" type="text" icon={<Undo2 className="size-4" />} aria-label="撤销" title="撤销" disabled={editsBundle.historyIndex < 0} onClick={undoEdits} />
                    <Button size="small" type="text" icon={<Redo2 className="size-4" />} aria-label="重做" title="重做" disabled={!editsBundle.future.length} onClick={redoEdits} />
                    <span className="ml-2 hidden text-xs text-stone-400 md:inline dark:text-stone-500">滚轮缩放 · 拖动平移 · 空格抓手 · Ctrl+V 粘贴图片</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button loading={busy} disabled={outputDisabled} icon={<Send className="size-4" />} onClick={() => void sendTo("image")}>发送到生图</Button>
                    <Button loading={busy} disabled={outputDisabled} icon={<Send className="size-4" />} onClick={() => void sendTo("video")}>发送到视频</Button>
                    <Button type="primary" loading={busy} disabled={outputDisabled} icon={<Download className="size-4" />} onClick={() => void exportImage()}>导出图片</Button>
                </div>
            </footer>
            {source ? <CanvasNodeCropDialog dataUrl={source.dataUrl} open={cropOpen} initialCrop={crop} initialRatioPreset={ratioPreset} onClose={() => setCropOpen(false)} onConfirm={(next: CanvasImageCropRect, preset?: string) => { setCrop(next); if (preset) setRatioPreset(preset); setCropOpen(false); }} /> : null}
            <AssetPickerModal open={assetPickerOpen} onClose={() => setAssetPickerOpen(false)} onInsert={insertAsset} />
        </main>
    );
}
