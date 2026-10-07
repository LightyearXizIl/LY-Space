import { Fragment, useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Cpu, GripVertical } from "lucide-react";

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { decodeChannelModel, modelOptionLabel, modelOptionName, modelOptionsForConfig, normalizeModelOrder, selectableModelsByCapability, useConfigStore, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
    sortable?: boolean;
};

type ModelPickerGroup = {
    key: string;
    label: string;
    models: string[];
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder = "选择模型", onMissingConfig, sortable = false }: ModelPickerProps) {
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const [draggingModel, setDraggingModel] = useState<{ groupKey: string; model: string } | null>(null);
    const reorderModels = useConfigStore((state) => state.reorderModels);
    const options = useMemo(() => Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model)))), [capability, config, value]);
    const groups = useMemo(() => groupModelOptions(config, options), [config, options]);
    const current = value || "";

    const commitGroupOrder = (groupKey: string, nextGroupModels: string[]) => {
        const allModels = modelOptionsForConfig(config);
        const visibleModels = new Set(options);
        const nextVisibleOrder = groups.flatMap((group) => group.key === groupKey ? nextGroupModels : group.models);
        const hiddenModels = allModels.filter((model) => !visibleModels.has(model));
        reorderModels(normalizeModelOrder([...nextVisibleOrder, ...hiddenModels], allModels));
    };

    const moveModel = (groupKey: string, model: string, direction: -1 | 1) => {
        const group = groups.find((item) => item.key === groupKey);
        if (!group) return;
        const index = group.models.indexOf(model);
        const targetIndex = index + direction;
        if (index < 0 || targetIndex < 0 || targetIndex >= group.models.length) return;
        const next = [...group.models];
        [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
        commitGroupOrder(groupKey, next);
    };

    const dropModel = (groupKey: string, targetModel: string) => {
        if (!draggingModel || draggingModel.groupKey !== groupKey || draggingModel.model === targetModel) return;
        const group = groups.find((item) => item.key === groupKey);
        if (!group) return;
        const next = [...group.models];
        const sourceIndex = next.indexOf(draggingModel.model);
        const targetIndex = next.indexOf(targetModel);
        if (sourceIndex < 0 || targetIndex < 0) return;
        next.splice(sourceIndex, 1);
        next.splice(targetIndex, 0, draggingModel.model);
        commitGroupOrder(groupKey, next);
        setDraggingModel(null);
    };

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return (
        <Select
            open={open}
            value={current}
            onOpenChange={(nextOpen) => {
                if (nextOpen && !options.length && config.channelMode === "local") onMissingConfig?.();
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
            }}
            onValueChange={onChange}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={current ? modelOptionLabel(config, current) : placeholder}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{current ? modelOptionLabel(config, current) : placeholder}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {groups.length ? (
                    <>
                        {sortable ? <div className="px-2 pb-1 pt-1 text-[11px] text-muted-foreground">按渠道分组 · 拖动或使用箭头调整组内顺序</div> : null}
                        {groups.map((group, groupIndex) => (
                            <Fragment key={group.key}>
                                {groupIndex ? <SelectSeparator /> : null}
                                <SelectGroup>
                                    <SelectLabel className="flex items-center justify-between px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                                        <span>{group.label}</span>
                                        <span className="font-normal opacity-70">{group.models.length}</span>
                                    </SelectLabel>
                                    {group.models.map((model, modelIndex) => (
                                        <SelectItem
                                            key={model}
                                            value={model}
                                            textValue={modelOptionLabel(config, model)}
                                            draggable={sortable}
                                            className={cn("group", sortable && draggingModel?.model === model && "opacity-50")}
                                            onDragStart={(event) => {
                                                if (!sortable) return;
                                                setDraggingModel({ groupKey: group.key, model });
                                                event.dataTransfer.effectAllowed = "move";
                                                event.dataTransfer.setData("text/plain", model);
                                            }}
                                            onDragOver={(event) => {
                                            if (sortable && draggingModel?.groupKey === group.key) {
                                                    event.preventDefault();
                                                    event.dataTransfer.dropEffect = "move";
                                                }
                                            }}
                                            onDrop={(event) => {
                                                event.preventDefault();
                                            if (sortable) dropModel(group.key, model);
                                            }}
                                            onDragEnd={() => sortable && setDraggingModel(null)}
                                        >
                                            <ModelLabel config={config} model={model} />
                                            {sortable ? (
                                                <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                                    <GripVertical className="mr-0.5 size-3.5 cursor-grab text-muted-foreground" aria-hidden="true" />
                                                    <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30" disabled={modelIndex === 0} aria-label={`将 ${modelOptionLabel(config, model)} 上移`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => { event.stopPropagation(); moveModel(group.key, model, -1); }}>
                                                        <ChevronUp className="size-3.5" />
                                                    </button>
                                                    <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-30" disabled={modelIndex === group.models.length - 1} aria-label={`将 ${modelOptionLabel(config, model)} 下移`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => { event.stopPropagation(); moveModel(group.key, model, 1); }}>
                                                        <ChevronDown className="size-3.5" />
                                                    </button>
                                                </span>
                                            ) : null}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                            </Fragment>
                        ))}
                    </>
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {emptyModelLabel(config, capability)}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function groupModelOptions(config: AiConfig, options: string[]): ModelPickerGroup[] {
    const groups = new Map<string, ModelPickerGroup>();
    options.forEach((model) => {
        const decoded = decodeChannelModel(model);
        const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : undefined;
        const key = channel?.id || "other";
        const group = groups.get(key) || { key, label: channel?.name || "其他模型", models: [] };
        group.models.push(model);
        groups.set(key, group);
    });
    const channelOrder = new Map(config.channels.map((channel, index) => [channel.id, index]));
    return [...groups.values()].sort((a, b) => (channelOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (channelOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER));
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability === "image" ? "生图" : capability === "video" ? "视频" : capability === "text" ? "文本" : capability === "audio" ? "音频" : "";
    if (capability && config.models.length) return `请先在渠道里为${label}指定模型`;
    return config.models.length ? `暂无匹配的${label}模型` : "请先到配置里添加渠道和模型";
}

function ModelLabel({ config, model }: { config: AiConfig; model: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="truncate">{modelOptionLabel(config, model)}</span>
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}
