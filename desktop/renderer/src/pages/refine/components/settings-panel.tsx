import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { App, Button, Input, Segmented, Slider } from "antd";
import { Crop, FlipHorizontal, FlipVertical, RotateCcw, RotateCw, Undo2 } from "lucide-react";

import { defaultRefineAdjustments, parseRefineLut, refineAdjustmentLabels, refineFilterLabels, refineResolutionOptions, type RefineAdjustments, type RefineFilter, type RefineFormat, type RefineResolution, type RefineSourceImage } from "@/lib/refine-image";
import type { RefineEditState } from "@/lib/refine-history";

type Dimensions = { width: number; height: number; disabled: boolean; reason: string };

type SettingsPanelProps = {
    source: RefineSourceImage | null;
    edits: RefineEditState;
    onCommitEdits: (next: RefineEditState) => void;
    onPreviewEdits: (next: RefineEditState) => void;
    ratioPreset: string;
    onRatioPreset: (preset: string) => void;
    onOpenCrop: () => void;
    cropSize: { width: number; height: number } | null;
    resolution: RefineResolution;
    onResolution: (value: RefineResolution) => void;
    customWidth: number;
    customHeight: number;
    onCustomWidth: (value: string) => void;
    onCustomHeight: (value: string) => void;
    format: RefineFormat;
    onFormat: (value: RefineFormat) => void;
    quality: number;
    onQuality: (value: number) => void;
    dimensions: Dimensions | null;
    busy: boolean;
    onRunAi: (mode: "repair" | "upscale", prompt: string) => void;
};

const tabs = [
    { key: "crop", label: "裁切与变换" },
    { key: "adjust", label: "滤镜与调色" },
    { key: "ai", label: "AI 工具" },
    { key: "export", label: "导出设置" },
] as const;

type TabKey = (typeof tabs)[number]["key"];

const ratioPresets = [
    { label: "自由", value: "free" },
    { label: "原图", value: "original" },
    { label: "1:1", value: "1:1" },
    { label: "4:3", value: "4:3" },
    { label: "3:4", value: "3:4" },
    { label: "16:9", value: "16:9" },
    { label: "9:16", value: "9:16" },
];

/**
 * 右侧设置面板：裁切与变换 / 滤镜与调色 / AI 工具 / 导出设置 四个页签。
 * 滑杆拖动期间经 onPreviewEdits 即时预览，松手经 onCommitEdits 只产生一条历史记录。
 */
export function RefineSettingsPanel(props: SettingsPanelProps) {
    const { source, edits, onCommitEdits, onPreviewEdits } = props;
    const [activeTab, setActiveTab] = useState<TabKey>("crop");
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

    const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
        const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "Home" ? -Infinity : event.key === "End" ? Infinity : 0;
        if (delta === 0) return;
        event.preventDefault();
        const next = Math.min(tabs.length - 1, Math.max(0, index + delta));
        setActiveTab(tabs[next].key);
        tabRefs.current[next]?.focus();
    };

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
            <div role="tablist" aria-label="精修设置" className="flex border-b border-stone-200 dark:border-stone-800" onKeyDown={(event) => {
                const index = tabs.findIndex((tab) => tab.key === activeTab);
                handleTabKeyDown(event, index);
            }}>
                {tabs.map((tab, index) => (
                    <button
                        key={tab.key}
                        ref={(node) => { tabRefs.current[index] = node; }}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab.key}
                        tabIndex={activeTab === tab.key ? 0 : -1}
                        className={`flex-1 cursor-pointer border-b-2 bg-transparent px-2 py-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 ${activeTab === tab.key ? "border-stone-900 font-medium text-stone-950 dark:border-stone-100 dark:text-stone-50" : "border-transparent text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200"}`}
                        onClick={() => setActiveTab(tab.key)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {activeTab === "crop" ? <CropTab {...props} /> : null}
                {activeTab === "adjust" ? <AdjustTab source={source} edits={edits} onCommitEdits={onCommitEdits} onPreviewEdits={onPreviewEdits} /> : null}
                {activeTab === "ai" ? <AiTab busy={props.busy} hasSource={Boolean(source)} onRunAi={props.onRunAi} /> : null}
                {activeTab === "export" ? <ExportTab {...props} /> : null}
            </div>
        </div>
    );
}

function CropTab({ source, edits, onCommitEdits, onPreviewEdits, ratioPreset, onRatioPreset, onOpenCrop, cropSize }: SettingsPanelProps) {
    return (
        <div className="space-y-5">
            <section>
                <h3 className="mb-2 text-sm font-medium">比例</h3>
                <Segmented block size="small" value={ratioPreset} options={ratioPresets} onChange={(value: string | number) => onRatioPreset(String(value))} />
                <Button className="mt-3" block icon={<Crop className="size-4" />} disabled={!source} onClick={onOpenCrop}>自定义裁切</Button>
                <p className="mt-2 text-xs text-stone-500">{cropSize ? `裁切区域 ${cropSize.width} × ${cropSize.height}` : "载入图片后可裁切"}</p>
            </section>
            <section>
                <h3 className="mb-2 text-sm font-medium">旋转与翻转</h3>
                <div className="grid grid-cols-4 gap-1">
                    <Button size="small" icon={<RotateCcw className="size-4" />} disabled={!source} aria-label="逆时针旋转 90 度" title="逆时针旋转 90 度" onClick={() => onCommitEdits({ ...edits, transform: { ...edits.transform, rotation: edits.transform.rotation - 90 } })} />
                    <Button size="small" icon={<RotateCw className="size-4" />} disabled={!source} aria-label="顺时针旋转 90 度" title="顺时针旋转 90 度" onClick={() => onCommitEdits({ ...edits, transform: { ...edits.transform, rotation: edits.transform.rotation + 90 } })} />
                    <Button size="small" icon={<FlipHorizontal className="size-4" />} disabled={!source} onClick={() => onCommitEdits({ ...edits, transform: { ...edits.transform, flipX: !edits.transform.flipX } })}>水平</Button>
                    <Button size="small" icon={<FlipVertical className="size-4" />} disabled={!source} onClick={() => onCommitEdits({ ...edits, transform: { ...edits.transform, flipY: !edits.transform.flipY } })}>垂直</Button>
                </div>
                <div className="mt-3">
                    <div className="mb-1 flex justify-between text-xs"><span>精细旋转</span><span>{edits.transform.rotation}°</span></div>
                    <Slider min={-45} max={45} step={1} value={edits.transform.rotation} disabled={!source} onChange={(value) => onPreviewEdits({ ...edits, transform: { ...edits.transform, rotation: Number(value) } })} onChangeComplete={(value) => onCommitEdits({ ...edits, transform: { ...edits.transform, rotation: Number(value) } })} />
                </div>
            </section>
        </div>
    );
}

function AdjustTab({ source, edits, onCommitEdits, onPreviewEdits }: { source: RefineSourceImage | null; edits: RefineEditState; onCommitEdits: (next: RefineEditState) => void; onPreviewEdits: (next: RefineEditState) => void }) {
    const { message } = App.useApp();
    const lutInputRef = useRef<HTMLInputElement>(null);
    const importLut = async (file?: File) => {
        if (!file) return;
        try {
            onCommitEdits({ ...edits, lut: await parseRefineLut(file) });
            message.success("LUT 已导入");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "LUT 导入失败");
        }
    };
    const resetAdjustment = (key: keyof RefineAdjustments) => onCommitEdits({ ...edits, adjustments: { ...edits.adjustments, [key]: defaultRefineAdjustments[key] } });
    const hasCustomAdjustments = (Object.keys(defaultRefineAdjustments) as Array<keyof RefineAdjustments>).some((key) => edits.adjustments[key] !== defaultRefineAdjustments[key]);

    return (
        <div className="space-y-5">
            <input ref={lutInputRef} className="hidden" type="file" accept=".cube,.3dl" onChange={(event: ChangeEvent<HTMLInputElement>) => void importLut(event.target.files?.[0])} />
            <section>
                <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-medium">滤镜</h3>
                    <Button size="small" type="text" icon={<Undo2 className="size-3.5" />} disabled={!source || edits.filter === "original"} onClick={() => onCommitEdits({ ...edits, filter: "original" })}>还原滤镜</Button>
                </div>
                <div className="grid grid-cols-4 gap-1">
                    {(Object.keys(refineFilterLabels) as RefineFilter[]).map((key) => (
                        <Button key={key} size="small" type={edits.filter === key ? "primary" : "default"} disabled={!source} onClick={() => onCommitEdits({ ...edits, filter: key })}>{refineFilterLabels[key]}</Button>
                    ))}
                </div>
            </section>
            <section>
                <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-medium">基础调色</h3>
                    <Button size="small" type="text" icon={<RotateCcw className="size-3.5" />} disabled={!source || !hasCustomAdjustments} onClick={() => onCommitEdits({ ...edits, adjustments: { ...defaultRefineAdjustments } })}>重置</Button>
                </div>
                <div className="grid grid-cols-2 gap-x-4">
                    {(Object.keys(refineAdjustmentLabels) as Array<keyof RefineAdjustments>).map((key) => (
                        <div key={key} className="mb-1">
                            <div className="flex items-center justify-between text-xs">
                                <span>{refineAdjustmentLabels[key]}</span>
                                <span className="flex items-center gap-1 tabular-nums">
                                    {edits.adjustments[key] !== defaultRefineAdjustments[key] ? (
                                        <button type="button" title={`重置${refineAdjustmentLabels[key]}`} aria-label={`重置${refineAdjustmentLabels[key]}`} className="cursor-pointer text-stone-400 transition-colors hover:text-stone-700 dark:hover:text-stone-200" onClick={() => resetAdjustment(key)}>
                                            <RotateCcw className="size-3" />
                                        </button>
                                    ) : null}
                                    {edits.adjustments[key]}
                                </span>
                            </div>
                            <Slider min={-100} max={100} value={edits.adjustments[key]} disabled={!source} onChange={(value) => onPreviewEdits({ ...edits, adjustments: { ...edits.adjustments, [key]: Number(value) } })} onChangeComplete={(value) => onCommitEdits({ ...edits, adjustments: { ...edits.adjustments, [key]: Number(value) } })} />
                        </div>
                    ))}
                </div>
            </section>
            <section>
                <h3 className="mb-2 text-sm font-medium">LUT</h3>
                <div className="flex gap-2">
                    <Button size="small" disabled={!source} onClick={() => lutInputRef.current?.click()}>导入 .cube/.3dl</Button>
                    {edits.lut ? <Button size="small" danger disabled={!source} onClick={() => onCommitEdits({ ...edits, lut: null })}>移除 {edits.lut.name}</Button> : null}
                </div>
                {edits.lut ? (
                    <div className="mt-2">
                        <div className="mb-1 flex justify-between text-xs"><span>强度</span><span>{edits.lut.intensity}</span></div>
                        <Slider min={0} max={100} value={edits.lut.intensity} disabled={!source} onChange={(value) => onPreviewEdits({ ...edits, lut: { ...edits.lut!, intensity: Number(value) } })} onChangeComplete={(value) => onCommitEdits({ ...edits, lut: { ...edits.lut!, intensity: Number(value) } })} />
                    </div>
                ) : null}
            </section>
        </div>
    );
}

function AiTab({ busy, hasSource, onRunAi }: { busy: boolean; hasSource: boolean; onRunAi: (mode: "repair" | "upscale", prompt: string) => void }) {
    const [aiMode, setAiMode] = useState<"repair" | "upscale">("repair");
    const [aiPrompt, setAiPrompt] = useState("");
    return (
        <div className="space-y-4">
            <Segmented block value={aiMode} options={[{ label: "全图修复", value: "repair" }, { label: "生成式高清", value: "upscale" }]} onChange={(value: string | number) => setAiMode(value as "repair" | "upscale")} />
            <Input value={aiPrompt} placeholder={aiMode === "upscale" ? "可补充高清要求" : "可补充修复要求"} onChange={(event) => setAiPrompt(event.target.value)} />
            <Button block type="primary" loading={busy} disabled={!hasSource} onClick={() => onRunAi(aiMode, aiPrompt)}>{aiMode === "upscale" ? "生成式高清（2x）" : "执行全图修复"}</Button>
            <p className="text-xs text-stone-500">AI 操作生成新版本，原图与本地编辑参数会保留。</p>
        </div>
    );
}

function ExportTab({ source, resolution, onResolution, customWidth, customHeight, onCustomWidth, onCustomHeight, format, onFormat, quality, onQuality, dimensions }: SettingsPanelProps) {
    return (
        <div className="space-y-5">
            <section>
                <h3 className="mb-2 text-sm font-medium">导出分辨率</h3>
                <Segmented block size="small" disabled={!source} value={resolution} options={refineResolutionOptions} onChange={(value: string | number) => onResolution(value as RefineResolution)} />
                {resolution === "custom" ? (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                        <Input value={customWidth} inputMode="numeric" prefix="宽" disabled={!source} onChange={(event: ChangeEvent<HTMLInputElement>) => onCustomWidth(event.target.value)} />
                        <Input value={customHeight} inputMode="numeric" prefix="高" disabled={!source} onChange={(event: ChangeEvent<HTMLInputElement>) => onCustomHeight(event.target.value)} />
                    </div>
                ) : null}
                <p className={`mt-2 text-xs ${dimensions?.disabled ? "text-red-500" : "text-stone-500"}`}>{dimensions ? `${dimensions.width} × ${dimensions.height}${dimensions.disabled ? ` · ${dimensions.reason}` : ""}` : ""}</p>
            </section>
            <section>
                <h3 className="mb-2 text-sm font-medium">文件格式</h3>
                <Segmented block size="small" value={format} options={[{ label: "PNG", value: "png" }, { label: "JPEG", value: "jpeg" }, { label: "WebP", value: "webp" }]} onChange={(value: string | number) => onFormat(value as RefineFormat)} />
                {format !== "png" ? (
                    <div className="mt-3">
                        <div className="mb-1 flex justify-between text-xs text-stone-500"><span>质量</span><span>{quality}</span></div>
                        <Slider min={1} max={100} value={quality} onChange={(value) => onQuality(Number(value))} />
                    </div>
                ) : null}
            </section>
        </div>
    );
}
