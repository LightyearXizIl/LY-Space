import { useEffect, useSyncExternalStore, type CSSProperties } from "react";
import { Button, Tabs } from "antd";
import { Bot, X } from "lucide-react";

import { closeFeaturePanel, getFeaturePanels, getFeaturePluginRevision, getOpenedFeaturePanelGroup, openFeaturePanel, subscribeFeaturePanels, type FeaturePanel } from "@/lib/feature-plugins/feature-plugin-runtime";
import { syncFeaturePlugins } from "@/lib/feature-plugins/feature-plugin-loader";

function FeaturePluginMount({ panel }: { panel: FeaturePanel }) {
    useEffect(() => {
        const container = document.getElementById(`feature-plugin-panel-${panel.id}`);
        if (!container) return;
        return panel.mount(container) || undefined;
    }, [panel]);
    return <div id={`feature-plugin-panel-${panel.id}`} className="min-h-0 flex-1 overflow-auto" />;
}

export function FeaturePluginHost() {
    useSyncExternalStore(subscribeFeaturePanels, getFeaturePluginRevision, getFeaturePluginRevision);
    const panels = getFeaturePanels();
    const open = getOpenedFeaturePanelGroup();
    useEffect(() => {
        if (!window.lySpaceDesktop) return;
        const apply = (state: FeaturePluginState) => void syncFeaturePlugins(state).catch((error) => console.error("功能插件加载失败", error));
        void window.lySpaceDesktop.featurePluginsList().then(apply).catch(() => undefined);
        return window.lySpaceDesktop.onFeaturePluginState(apply);
    }, []);
    if (open !== "agent" || panels.length === 0) return null;
    const items = panels.map((panel) => ({ key: panel.id, label: panel.title, children: <FeaturePluginMount key={panel.id} panel={panel} /> }));
    return (
        <aside className="fixed inset-y-0 right-0 z-[80] flex w-[min(440px,100vw)] flex-col border-l border-stone-200 bg-background shadow-2xl dark:border-stone-800" aria-label="Agent 面板">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-stone-200 px-3 dark:border-stone-800">
                <div className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4" /> Agent</div>
                <Button type="text" size="small" icon={<X className="size-4" />} onClick={closeFeaturePanel} aria-label="关闭 Agent 面板" />
            </div>
            <Tabs className="flex min-h-0 flex-1 flex-col px-3 [&_.ant-tabs-content-holder]:min-h-0 [&_.ant-tabs-content-holder]:flex-1 [&_.ant-tabs-content]:h-full" items={items} />
        </aside>
    );
}

export function FeatureAgentTrigger({ className = "", style }: { className?: string; style?: CSSProperties }) {
    useSyncExternalStore(subscribeFeaturePanels, getFeaturePluginRevision, getFeaturePluginRevision);
    if (!getFeaturePanels().some((panel) => panel.group === "agent")) return null;
    return <button type="button" className={className} style={style} onClick={() => openFeaturePanel("agent")} aria-label="打开 Agent" title="Agent"><Bot className="size-4" /></button>;
}
