import { FolderPlus, Search } from "lucide-react";
import { type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Empty, Input, Spin, Tag } from "antd";
import { useVirtualizer } from "@tanstack/react-virtual";

import { PromptCard } from "@/components/prompts/prompt-card";
import { usePromptList } from "@/components/prompts/use-prompt-list";
import { PromptDetailDialog } from "./components/prompt-detail-dialog";
import { useCopyText } from "@/hooks/use-copy-text";
import { cn } from "@/lib/utils";
import { useAssetStore } from "@/stores/use-asset-store";
import { ALL_PROMPTS_OPTION, type Prompt } from "@/services/api/prompts";

export default function PromptsPage() {
    const { message } = App.useApp();
    const [titleKeyword, setTitleKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [selectedCategory, setSelectedCategory] = useState(ALL_PROMPTS_OPTION);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const addAsset = useAssetStore((state) => state.addAsset);
    const copyText = useCopyText();
    const { query, items: promptItems, tags: promptTags, categories: promptCategoryOptions, total: totalPrompts } = usePromptList({ keyword: titleKeyword, tags: selectedTags, category: selectedCategory });

    useEffect(() => {
        if (query.isError) message.error(query.error instanceof Error ? query.error.message : "获取提示词失败");
    }, [message, query.error, query.isError]);

    const toggleTag = (tag: string) => {
        if (tag === ALL_PROMPTS_OPTION) return setSelectedTags([]);
        setSelectedTags((items) => (items.includes(tag) ? items.filter((item) => item !== tag) : [...items, tag]));
    };

    // 稳定回调:配合 PromptCard 的 memo(滚动加载更多/筛选时未变化的卡片不重渲染)
    const savePromptAsset = useCallback((item: Prompt) => {
        addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category, data: { content: item.prompt }, metadata: { source: "prompt-library", promptId: item.id, githubUrl: item.githubUrl } });
        message.success("已加入我的资产");
    }, [addAsset, message]);

    const handleCopyPrompt = useCallback((item: Prompt) => {
        copyText(item.prompt, "提示词已复制");
    }, [copyText]);

    const renderAssetAction = useCallback((item: Prompt) => <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => savePromptAsset(item)}>加入资产</Button>, [savePromptAsset]);

    // 虚拟滚动:只渲染视口附近的行(DOM 数量恒定,无限滚动不再累积卡片)
    const scrollRef = useRef<HTMLDivElement>(null);
    const [columnCount, setColumnCount] = useState(getColumnCount);
    useEffect(() => {
        const handleResize = () => setColumnCount(getColumnCount());
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, []);

    const promptRows = useMemo(() => {
        const rows: Prompt[][] = [];
        for (let i = 0; i < promptItems.length; i += columnCount) rows.push(promptItems.slice(i, i + columnCount));
        return rows;
    }, [columnCount, promptItems]);

    const rowVirtualizer = useVirtualizer({
        count: promptRows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 320,
        overscan: 4,
        getItemKey: (index) => promptRows[index]?.[0]?.id ?? index,
    });

    const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        if (query.hasNextPage && !query.isFetchingNextPage && target.scrollTop + target.clientHeight >= target.scrollHeight - 160) void query.fetchNextPage();
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-4 py-6 [background-size:16px_16px] sm:px-6 lg:py-8 dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)]" onScroll={handleListScroll}>
                <div className="mx-auto max-w-7xl">
                    <div className="text-center">
                        <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">提示词中心</h1>
                        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">当前共 {totalPrompts} 条提示词</p>
                    </div>
                    <div className="mt-5 grid items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-6">
                        <aside className="thin-scrollbar max-h-72 overflow-y-auto border-b border-stone-200 pb-5 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-6rem)] lg:border-b-0 lg:border-r lg:pb-8 lg:pr-5 dark:border-stone-800">
                            <PromptFilter label="分类" options={promptCategoryOptions} selected={selectedCategory} onChange={setSelectedCategory} />
                            <div className="mt-6">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">标签</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {promptTags.map((tag) => {
                                        const active = tag === ALL_PROMPTS_OPTION ? selectedTags.length === 0 : selectedTags.includes(tag);
                                        return <Tag.CheckableTag key={tag} checked={active} className={cn("prompt-filter-tag", active && "is-active")} onChange={() => toggleTag(tag)}>{tag}</Tag.CheckableTag>;
                                    })}
                                </div>
                            </div>
                        </aside>
                        <section className="min-w-0">
                            <Input size="large" prefix={<Search className="size-4 text-stone-400" />} value={titleKeyword} placeholder="搜索标题、内容或标签" onChange={(event) => setTitleKeyword(event.target.value)} />
                            {query.isLoading ? <div className="flex h-60 items-center justify-center"><Spin /></div> : null}
                            {!query.isLoading ? (
                                <div className="mt-5">
                                    {promptRows.length === 0 ? (
                                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到匹配的提示词" className="py-16" />
                                    ) : (
                                        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                                            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                                                const row = promptRows[virtualRow.index];
                                                return (
                                                    <div
                                                        key={virtualRow.key}
                                                        data-index={virtualRow.index}
                                                        ref={rowVirtualizer.measureElement}
                                                        className="absolute left-0 top-0 w-full"
                                                        style={{ transform: `translateY(${virtualRow.start}px)` }}
                                                    >
                                                        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                                                            {row.map((item) => (
                                                                <PromptCard key={`${item.sourceId}:${item.id}`} item={item} onOpen={setSelectedPrompt} onCopy={handleCopyPrompt} extraAction={renderAssetAction} />
                                                            ))}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            ) : null}
                            <div className="mt-6 text-center text-xs text-stone-500 dark:text-stone-400">{query.isFetchingNextPage ? "加载中..." : query.hasNextPage ? "继续向下滚动加载更多" : promptItems.length > 0 ? "已经到底了" : null}</div>
                        </section>
                    </div>
                </div>
            </main>

            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} onCopy={(prompt) => copyText(prompt, "提示词已复制")} onSaveAsset={savePromptAsset} />
        </div>
    );
}

function getColumnCount() {
    const width = typeof window === "undefined" ? 3 : window.innerWidth;
    if (width >= 1280) return 3;
    if (width >= 640) return 2;
    return 1;
}

function PromptFilter({ label, options, selected, onChange }: { label: string; options: string[]; selected: string; onChange: (value: string) => void }) {
    return <div><div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">{label}</div><div className="flex flex-wrap gap-1.5">{options.map((option) => <Tag.CheckableTag key={option} checked={selected === option} className={cn("prompt-filter-tag", selected === option && "is-active")} onChange={() => onChange(option)}>{option}</Tag.CheckableTag>)}</div></div>;
}
