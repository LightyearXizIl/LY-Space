import { App, Button, Checkbox, Collapse, Input, Modal, Tabs, Tag } from "antd";
import { ChevronDown, ChevronRight, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
    MODEL_CATEGORY_FILTER_LABELS,
    MODEL_CATEGORY_LABELS,
    MODEL_CATEGORY_ORDER,
    MODEL_SOURCE_LABELS,
    catalogModelFromConfigured,
    catalogModelFromManual,
    expandedCatalogGroupKeys,
    filterCatalogModels,
    groupCatalogModels,
    mergeSelectedCatalogModels,
    type FetchedChannelModel,
    type ModelCategoryFilter,
} from "@/lib/model-catalog";
import { fetchChannelModels } from "@/services/api/image";
import { isArkAgentPlanBaseUrl, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";

type Props = {
    open: boolean;
    channel: ModelChannel | null;
    onConfirm: (models: ChannelModel[]) => void;
    onClose: () => void;
};

function uniqueCatalog(models: FetchedChannelModel[]) {
    return [...new Map(models.map((model) => [model.name, model])).values()];
}

// 选择渠道模型弹窗：优先使用上游元数据，并在元数据不足时明确展示名称推断结果。
export function ModelSelectModal({ open, channel, onConfirm, onClose }: Props) {
    const { message } = App.useApp();
    const [existing, setExisting] = useState<FetchedChannelModel[]>([]);
    const [fetched, setFetched] = useState<FetchedChannelModel[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState("new");
    const [category, setCategory] = useState<ModelCategoryFilter>("all");
    const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
    const [search, setSearch] = useState("");
    const [manual, setManual] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open) return;
        const configured = (channel?.models || []).map(catalogModelFromConfigured);
        setExisting(configured);
        setFetched([]);
        setSelected(new Set(configured.map((model) => model.name)));
        setActiveTab(configured.length ? "existing" : "new");
        setCategory("all");
        setExpandedKeys([]);
        setSearch("");
        setManual("");
    }, [open, channel?.id]);

    const currentList = activeTab === "new" ? fetched : existing;
    const categoryCounts = useMemo(() => Object.fromEntries(MODEL_CATEGORY_ORDER.map((key) => [key, currentList.filter((model) => model.category === key).length])), [currentList]);
    const baseGroups = useMemo(() => groupCatalogModels(filterCatalogModels(currentList, "", category)), [category, currentList]);
    const visibleList = useMemo(() => filterCatalogModels(currentList, search, category), [category, currentList, search]);
    const groups = useMemo(() => groupCatalogModels(visibleList), [visibleList]);
    const baseGroupSignature = baseGroups.map((group) => group.key).join("|");
    const searchable = Boolean(search.trim());
    const activeExpandedKeys = expandedCatalogGroupKeys(groups, search, expandedKeys);
    const selectableVisible = visibleList.filter((model) => !model.disabledReason);
    const visibleSelectedCount = selectableVisible.filter((model) => selected.has(model.name)).length;
    const allCatalog = useMemo(() => uniqueCatalog([...existing, ...fetched]), [existing, fetched]);
    const selectableNames = useMemo(() => new Set(allCatalog.filter((model) => !model.disabledReason || existing.some((item) => item.name === model.name)).map((model) => model.name)), [allCatalog, existing]);
    const totalSelectedCount = [...selected].filter((name) => selectableNames.has(name)).length;
    const manualOnly = channel?.apiFormat === "ark" && isArkAgentPlanBaseUrl(channel.baseUrl);

    useEffect(() => {
        if (!open) return;
        const defaults = baseGroups.filter((group) => group.models.some((model) => selected.has(model.name))).map((group) => group.key);
        if (!defaults.length && baseGroups[0]) defaults.push(baseGroups[0].key);
        setExpandedKeys(defaults);
        // selected 只用于首次确定默认展开组；后续勾选不应强制重新展开用户已收起的分组。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab, baseGroupSignature, category, open]);

    const toggle = (model: FetchedChannelModel, checked: boolean) => {
        if (model.disabledReason) return;
        setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(model.name);
            else next.delete(model.name);
            return next;
        });
    };

    const selectModels = (models: FetchedChannelModel[], checked: boolean) =>
        setSelected((current) => {
            const next = new Set(current);
            models.filter((model) => !model.disabledReason).forEach((model) => (checked ? next.add(model.name) : next.delete(model.name)));
            return next;
        });

    const addManual = () => {
        const name = manual.trim();
        if (!name) return;
        const existingModel = existing.find((model) => model.name === name);
        if (existingModel) {
            if (!existingModel.disabledReason) setSelected((current) => new Set(current).add(name));
            setActiveTab("existing");
        } else {
            const model = catalogModelFromManual(name);
            setFetched((current) => uniqueCatalog([model, ...current]));
            if (model.disabledReason) message.warning(model.disabledReason);
            else setSelected((current) => new Set(current).add(name));
            setActiveTab("new");
            setCategory("all");
        }
        setManual("");
    };

    const fetchModels = async () => {
        if (!channel) return;
        if (!channel.baseUrl.trim() || !channel.apiKey.trim()) {
            message.error("请先填写接口地址和 API Key");
            return;
        }
        setLoading(true);
        try {
            const models = await fetchChannelModels(channel);
            setFetched(models);
            setActiveTab("new");
            setCategory("all");
            message.success(`已拉取 ${models.length} 个模型，并完成能力分类`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "拉取模型失败");
        } finally {
            setLoading(false);
        }
    };

    const confirm = () => {
        onConfirm(mergeSelectedCatalogModels(channel?.models || [], allCatalog, selected));
        onClose();
    };

    const collapseItems = groups.map((group) => {
        const available = group.models.filter((model) => !model.disabledReason);
        const chosen = available.filter((model) => selected.has(model.name)).length;
        return {
            key: group.key,
            label: (
                <div className="flex min-w-0 items-center gap-2">
                    <Checkbox
                        disabled={!available.length}
                        checked={Boolean(available.length) && chosen === available.length}
                        indeterminate={chosen > 0 && chosen < available.length}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => selectModels(available, event.target.checked)}
                    />
                    <span className="truncate text-sm font-medium">
                        {MODEL_CATEGORY_LABELS[group.category]} · {group.family}（{group.models.length}）
                    </span>
                </div>
            ),
            children: (
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    {group.models.map((model) => {
                        const sourceLabel = model.category === "unknown" ? "待分类" : MODEL_SOURCE_LABELS[model.classificationSource];
                        return (
                            <label
                                key={model.name}
                                className={`flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 ${model.disabledReason ? "cursor-not-allowed border-stone-200 opacity-60 dark:border-stone-800" : "cursor-pointer border-stone-200 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900/50"}`}
                                title={model.disabledReason || model.description}
                            >
                                <Checkbox className="mt-0.5" disabled={Boolean(model.disabledReason)} checked={selected.has(model.name)} onChange={(event) => toggle(model, event.target.checked)} />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium" title={model.name}>
                                        {model.name}
                                    </span>
                                    {model.displayName ? (
                                        <span className="mt-0.5 block truncate text-xs text-stone-500" title={model.displayName}>
                                            {model.displayName}
                                        </span>
                                    ) : null}
                                    {model.description ? (
                                        <span className="mt-0.5 block truncate text-xs text-stone-400" title={model.description}>
                                            {model.description}
                                        </span>
                                    ) : null}
                                    {model.disabledReason ? <span className="mt-1 block text-xs text-amber-600 dark:text-amber-400">{model.disabledReason}</span> : null}
                                </span>
                                <Tag bordered={false} className="mr-0 shrink-0 text-[11px]">
                                    {sourceLabel}
                                </Tag>
                            </label>
                        );
                    })}
                </div>
            ),
        };
    });

    return (
        <Modal
            open={open}
            width={960}
            centered
            onCancel={onClose}
            title={
                <span>
                    选择渠道模型{" "}
                    <span className="ml-2 text-xs font-normal text-stone-500">
                        已选择 {totalSelectedCount} / 可选 {selectableNames.size}
                    </span>
                </span>
            }
            styles={{ body: { maxHeight: "68vh", overflowY: "auto" } }}
            footer={[
                <Button key="cancel" onClick={onClose}>
                    取消
                </Button>,
                <Button key="confirm" type="primary" onClick={confirm}>
                    确定
                </Button>,
            ]}
        >
            <div className="flex flex-wrap items-center gap-3">
                <Input className="min-w-[200px] flex-1" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 ID、显示名、说明或系列" prefix={<Search className="size-4 text-stone-400" />} allowClear />
                <Input className="min-w-[180px] flex-1" value={manual} onChange={(event) => setManual(event.target.value)} onPressEnter={addManual} placeholder="输入模型 ID" />
                <Button onClick={addManual}>增加模型</Button>
                <Button icon={<RefreshCw className="size-4" />} loading={loading} disabled={manualOnly} onClick={() => void fetchModels()}>
                    拉取模型列表
                </Button>
            </div>
            <div className="mt-2 text-xs text-stone-500">
                {manualOnly ? "Agent Plan 不提供模型列表接口。请按账号套餐可用的模型 ID 手动增加；这里不会猜测或预置模型。" : "优先使用上游返回的分类与展示信息；上游未提供时才按模型名称推断，并显示分类来源。"}
            </div>

            <Tabs
                className="mt-3"
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                    { key: "new", label: `新获取的模型 (${fetched.length})` },
                    { key: "existing", label: `已有的模型 (${existing.length})` },
                ]}
            />

            <div className="mb-3 flex flex-wrap gap-2" aria-label="模型能力筛选">
                <Button size="small" type={category === "all" ? "primary" : "default"} onClick={() => setCategory("all")}>
                    全部 {currentList.length}
                </Button>
                {MODEL_CATEGORY_ORDER.map((key) => (
                    <Button key={key} size="small" type={category === key ? "primary" : "default"} onClick={() => setCategory(key)}>
                        {MODEL_CATEGORY_FILTER_LABELS[key]} {categoryCounts[key] || 0}
                    </Button>
                ))}
            </div>

            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-stone-500">
                    当前范围已选择 {visibleSelectedCount} / 可选 {selectableVisible.length}
                </span>
                <div className="flex flex-wrap gap-2">
                    <Button size="small" icon={<ChevronDown className="size-3.5" />} disabled={!groups.length || searchable} onClick={() => setExpandedKeys(groups.map((group) => group.key))}>
                        全部展开
                    </Button>
                    <Button size="small" icon={<ChevronRight className="size-3.5" />} disabled={!groups.length || searchable} onClick={() => setExpandedKeys([])}>
                        全部收起
                    </Button>
                    <Button size="small" disabled={!selectableVisible.length} onClick={() => selectModels(selectableVisible, true)}>
                        全选当前列表
                    </Button>
                    <Button size="small" disabled={!visibleSelectedCount} onClick={() => selectModels(selectableVisible, false)}>
                        取消当前列表
                    </Button>
                </div>
            </div>

            {groups.length ? (
                <Collapse size="small" activeKey={activeExpandedKeys} onChange={(keys) => !searchable && setExpandedKeys(Array.isArray(keys) ? keys.map(String) : [String(keys)])} items={collapseItems} />
            ) : (
                <div className="py-8 text-center text-sm text-stone-500">{activeTab === "new" ? "点击「拉取模型列表」获取上游模型，或手动增加模型 ID。" : "当前条件下没有已有模型。"}</div>
            )}
        </Modal>
    );
}
