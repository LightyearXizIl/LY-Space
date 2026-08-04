import { App, Button, Input, Modal, Segmented, Slider, Tag } from "antd";
import { ClipboardPaste, Crop, Download, FolderOpen, ImagePlus, RotateCcw, RotateCw, Send, Undo2, Redo2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";
import { useNavigate } from "react-router-dom";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { cropPixelSize, defaultRefineAdjustments, defaultRefineTransform, parseRefineLut, refineExtension, refineMimeType, refineResolutionOptions, renderRefinedImage, resolveRefineDimensions, type RefineAdjustments, type RefineCropRect, type RefineFilter, type RefineFormat, type RefineLutState, type RefineResolution, type RefineTransform } from "@/lib/refine-image";
import { formatBytes, readImageMeta } from "@/lib/image-utils";
import { enqueueReferenceHandoff } from "@/services/reference-handoff";
import { uploadImage } from "@/services/image-storage";
import { requestEdit } from "@/services/api/image";
import { selectableImageModelsByFeature, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { loadWorkbenchSession, saveWorkbenchSession } from "@/services/workbench-session";
import { SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import type { ReferenceImage } from "@/types/image";

type RefineSource = ReferenceImage & { width: number; height: number; bytes: number };
type EditState = { transform: RefineTransform; filter: RefineFilter; adjustments: RefineAdjustments; lut: RefineLutState | null };
type RefineSession = { source: RefineSource | null; crop: RefineCropRect; ratioPreset: string; resolution: RefineResolution; customWidth: number; customHeight: number; format: RefineFormat; quality: number; edits?: EditState; history?: EditState[]; historyIndex?: number };

const SESSION_KEY = "refine-workbench:current-session";
const fullCrop: RefineCropRect = { x: 0, y: 0, width: 1, height: 1 };

export default function RefinePage() {
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const inputRef = useRef<HTMLInputElement>(null);
    const [source, setSource] = useState<RefineSource | null>(null);
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
    const [dragActive, setDragActive] = useState(false);
    const [busy, setBusy] = useState(false);
    const [previewUrl, setPreviewUrl] = useState("");
    const [edits, setEdits] = useState<EditState>({ transform: defaultRefineTransform, filter: "original", adjustments: defaultRefineAdjustments, lut: null });
    const [history, setHistory] = useState<EditState[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const lutInputRef = useRef<HTMLInputElement>(null);
    const sessionSnapshotRef = useRef<RefineSession | null>(null);
    const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previewFrameRef = useRef<number | null>(null);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const [aiMode, setAiMode] = useState<"repair" | "upscale">("repair");
    const [aiPrompt, setAiPrompt] = useState("");

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
            if (session.edits) setEdits(session.edits);
            if (session.history) setHistory(session.history);
            if (typeof session.historyIndex === "number") setHistoryIndex(session.historyIndex);
        }).finally(() => active && setHydrated(true));
        return () => {
            active = false;
        };
    }, []);

    // 渲染期同步最新会话快照(供防抖落盘与卸载落盘读取最新值)
    sessionSnapshotRef.current = { source, crop, ratioPreset, resolution, customWidth, customHeight, format, quality, edits, history, historyIndex } satisfies RefineSession;

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
    }, [crop, customHeight, customWidth, edits, format, history, historyIndex, hydrated, quality, ratioPreset, resolution, source]);

    // 卸载/切换时立即落盘防抖窗口内未保存的编辑
    useEffect(() => () => {
        if (sessionSaveTimerRef.current) {
            clearTimeout(sessionSaveTimerRef.current);
            sessionSaveTimerRef.current = null;
            if (sessionSnapshotRef.current) void saveWorkbenchSession(SESSION_KEY, sessionSnapshotRef.current);
        }
    }, []);

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
        try {
            const stored = await uploadImage(input);
            const next: RefineSource = { id: nanoid(), name, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes };
            const apply = () => {
                setSource(next);
                setCrop(fullCrop);
                setRatioPreset("free");
                setResolution("original");
                setCustomWidth(next.width);
                setCustomHeight(next.height); setEdits({ transform: defaultRefineTransform, filter: "original", adjustments: defaultRefineAdjustments, lut: null }); setHistory([]); setHistoryIndex(-1);
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

    const commitEdits = (next: EditState) => { const nextHistory = [...history.slice(0, historyIndex + 1), edits]; setHistory(nextHistory); setHistoryIndex(nextHistory.length - 1); setEdits(next); };
    const updateAdjustmentPreview = (key: keyof RefineAdjustments, value: number) => setEdits({ ...edits, adjustments: { ...edits.adjustments, [key]: value } });
    const undo = () => { if (historyIndex < 0) return; const previous = history[historyIndex]; setEdits(previous); setHistoryIndex(historyIndex - 1); };
    const importLut = async (file?: File) => { if (!file) return; try { commitEdits({ ...edits, lut: await parseRefineLut(file) }); message.success("LUT 已导入"); } catch (error) { message.error(error instanceof Error ? error.message : "LUT 导入失败"); } };

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

    const runAiTool = async () => {
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

    return (
        <main className="h-full overflow-y-auto bg-stone-50 p-5 text-stone-950 dark:bg-stone-950 dark:text-stone-100">
            <input ref={inputRef} className="hidden" type="file" accept="image/*" onChange={(event: ChangeEvent<HTMLInputElement>) => addFiles(event.target.files)} />
            <input ref={lutInputRef} className="hidden" type="file" accept=".cube,.3dl" onChange={(event: ChangeEvent<HTMLInputElement>) => void importLut(event.target.files?.[0])} />
            <div className="mx-auto flex min-h-full max-w-7xl flex-col gap-5">
                <header className="flex flex-wrap items-center justify-between gap-3">
                    <div><h1 className="text-2xl font-semibold">精修工作台</h1><p className="mt-1 text-sm text-stone-500">裁切、调整导出尺寸，并发送为创作参考图。</p></div>
                    <div className="flex flex-wrap gap-2"><Button icon={<Upload className="size-4" />} onClick={() => inputRef.current?.click()}>上传</Button><Button icon={<ClipboardPaste className="size-4" />} onClick={() => void addClipboard()}>剪贴板</Button><Button icon={<FolderOpen className="size-4" />} onClick={() => setAssetPickerOpen(true)}>我的资产</Button></div>
                </header>
                <div className="grid min-h-[620px] gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
                    <section onDragOver={(event) => { event.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={(event: DragEvent<HTMLElement>) => { event.preventDefault(); setDragActive(false); addFiles(event.dataTransfer.files); }} className={`relative flex min-h-[520px] items-center justify-center overflow-hidden rounded-lg border ${dragActive ? "border-sky-500 bg-sky-50 dark:bg-sky-950/30" : "border-stone-200 bg-card dark:border-stone-800"}`}>
                        {source ? <img src={previewUrl || source.dataUrl} alt={source.name} className="max-h-[72vh] max-w-full object-contain" /> : <button type="button" className="flex flex-col items-center gap-3 text-stone-500" onClick={() => inputRef.current?.click()}><ImagePlus className="size-10" /><span>拖入图片或点击上传</span></button>}
                        {source ? <div className="absolute left-4 top-4 flex gap-2"><Tag>{source.width} × {source.height}</Tag><Tag>{formatBytes(source.bytes)}</Tag></div> : null}
                    </section>
                    <aside className="space-y-5 rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800">
                        <section><div className="mb-2 flex items-center justify-between"><h2 className="font-medium">裁切与变换</h2><Button size="small" icon={<Crop className="size-4" />} disabled={!source} onClick={() => setCropOpen(true)}>自定义裁切</Button></div><div className="flex gap-1"><Button size="small" icon={<Undo2 />} onClick={undo} disabled={historyIndex < 0} /><Button size="small" icon={<RotateCcw />} onClick={() => commitEdits({ ...edits, transform: { ...edits.transform, rotation: edits.transform.rotation - 90 } })} /><Button size="small" icon={<RotateCw />} onClick={() => commitEdits({ ...edits, transform: { ...edits.transform, rotation: edits.transform.rotation + 90 } })} /><Button size="small" onClick={() => commitEdits({ ...edits, transform: { ...edits.transform, flipX: !edits.transform.flipX } })}>水平翻转</Button><Button size="small" onClick={() => commitEdits({ ...edits, transform: { ...edits.transform, flipY: !edits.transform.flipY } })}>垂直翻转</Button></div><Slider min={-45} max={45} value={edits.transform.rotation} onChange={(value) => setEdits({ ...edits, transform: { ...edits.transform, rotation: Number(value) } })} onChangeComplete={(value) => commitEdits({ ...edits, transform: { ...edits.transform, rotation: Number(value) } })} /><div className="text-xs text-stone-500">{cropSize ? `裁切区域 ${cropSize.width} × ${cropSize.height}` : "载入图片后可裁切"}</div></section>
                        <section><h2 className="mb-2 font-medium">滤镜与调色</h2><div className="grid grid-cols-4 gap-1">{(["original", "vivid", "cinema", "warm", "cool", "vintage", "mono", "contrast"] as RefineFilter[]).map((key) => <Button key={key} size="small" type={edits.filter === key ? "primary" : "default"} onClick={() => commitEdits({ ...edits, filter: key })}>{{ original: "原图", vivid: "鲜艳", cinema: "电影", warm: "暖色", cool: "冷色", vintage: "复古", mono: "黑白", contrast: "高对比" }[key]}</Button>)}</div>{(["exposure", "contrast", "highlights", "shadows", "saturation", "temperature", "tint", "sharpen", "vignette"] as Array<keyof RefineAdjustments>).map((key) => <div key={key} className="mt-2"><div className="flex justify-between text-xs"><span>{{ exposure: "曝光", contrast: "对比度", highlights: "高光", shadows: "阴影", saturation: "饱和度", temperature: "色温", tint: "色调", sharpen: "锐化", vignette: "暗角" }[key]}</span><span>{edits.adjustments[key]}</span></div><Slider min={-100} max={100} value={edits.adjustments[key]} onChange={(value) => updateAdjustmentPreview(key, Number(value))} onChangeComplete={(value) => commitEdits({ ...edits, adjustments: { ...edits.adjustments, [key]: Number(value) } })} /></div>)}</section>
                        <section><h2 className="mb-2 font-medium">LUT</h2><div className="flex gap-2"><Button size="small" onClick={() => lutInputRef.current?.click()}>导入 .cube/.3dl</Button>{edits.lut ? <Button size="small" danger onClick={() => commitEdits({ ...edits, lut: null })}>移除 {edits.lut.name}</Button> : null}</div>{edits.lut ? <Slider min={0} max={100} value={edits.lut.intensity} onChange={(value) => setEdits({ ...edits, lut: { ...edits.lut!, intensity: Number(value) } })} onChangeComplete={(value) => commitEdits({ ...edits, lut: { ...edits.lut!, intensity: Number(value) } })} /> : null}</section>
                        <section><h2 className="mb-2 font-medium">AI 工具</h2><Segmented block value={aiMode} options={[{ label: "全图修复", value: "repair" }, { label: "生成式高清", value: "upscale" }]} onChange={(value) => setAiMode(value as "repair" | "upscale")} /><Input className="mt-2" value={aiPrompt} placeholder={aiMode === "upscale" ? "可补充高清要求" : "可补充修复要求"} onChange={(event) => setAiPrompt(event.target.value)} /><Button className="mt-2" block loading={busy} disabled={!source} onClick={() => void runAiTool()}>{aiMode === "upscale" ? "生成式高清（2x）" : "执行全图修复"}</Button><p className="mt-1 text-xs text-stone-500">AI 操作生成新版本，原图与本地编辑参数会保留。</p></section>
                        <section><h2 className="mb-2 font-medium">导出分辨率</h2><Segmented block size="small" disabled={!source} value={resolution} options={refineResolutionOptions} onChange={(value: string | number) => setResolution(value as RefineResolution)} />{resolution === "custom" ? <div className="mt-3 grid grid-cols-2 gap-2"><Input value={customWidth} inputMode="numeric" prefix="宽" onChange={(event: ChangeEvent<HTMLInputElement>) => updateCustomWidth(event.target.value)} /><Input value={customHeight} inputMode="numeric" prefix="高" onChange={(event: ChangeEvent<HTMLInputElement>) => updateCustomHeight(event.target.value)} /></div> : null}<p className={`mt-2 text-xs ${dimensions?.disabled ? "text-red-500" : "text-stone-500"}`}>{dimensions ? `${dimensions.width} × ${dimensions.height}${dimensions.disabled ? ` · ${dimensions.reason}` : ""}` : ""}</p></section>
                        <section><h2 className="mb-2 font-medium">文件格式</h2><Segmented block size="small" value={format} options={[{ label: "PNG", value: "png" }, { label: "JPEG", value: "jpeg" }, { label: "WebP", value: "webp" }]} onChange={(value: string | number) => setFormat(value as RefineFormat)} />{format !== "png" ? <div className="mt-3"><div className="mb-1 flex justify-between text-xs text-stone-500"><span>质量</span><span>{quality}</span></div><Slider min={1} max={100} value={quality} onChange={setQuality} /></div> : null}</section>
                        <div className="space-y-2 border-t border-stone-200 pt-4 dark:border-stone-800"><Button block type="primary" loading={busy} disabled={!source || Boolean(dimensions?.disabled)} icon={<Download className="size-4" />} onClick={() => void exportImage()}>导出图片</Button><div className="grid grid-cols-2 gap-2"><Button loading={busy} disabled={!source || Boolean(dimensions?.disabled)} icon={<Send className="size-4" />} onClick={() => void sendTo("image")}>发送到生图</Button><Button loading={busy} disabled={!source || Boolean(dimensions?.disabled)} icon={<Send className="size-4" />} onClick={() => void sendTo("video")}>发送到视频</Button></div></div>
                    </aside>
                </div>
            </div>
            {source ? <CanvasNodeCropDialog dataUrl={source.dataUrl} open={cropOpen} initialCrop={crop} initialRatioPreset={ratioPreset} onClose={() => setCropOpen(false)} onConfirm={(next: CanvasImageCropRect) => { setCrop(next); setCropOpen(false); }} /> : null}
            <AssetPickerModal open={assetPickerOpen} onClose={() => setAssetPickerOpen(false)} onInsert={insertAsset} />
        </main>
    );
}
