import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Popconfirm, Progress, Switch, Tabs, Tag } from "antd";
import { Bot, Download, FolderCog, Puzzle, RefreshCw, ShieldCheck, Trash2, Wrench } from "lucide-react";

const statusText: Record<FeaturePluginStatus, string> = {
    downloading: "下载中",
    ready: "可用",
    "runtime-required": "需要 Codex 运行时",
    disabled: "已停用",
    "update-available": "有新版本",
    incompatible: "当前应用不兼容",
    repair: "需要修复",
    error: "安装失败",
};

function sizeText(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 1) return "未知大小";
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

export function FeaturePluginCenter({ openNodePlugins }: { openNodePlugins?: () => void }) {
    const { message, modal } = App.useApp();
    const [state, setState] = useState<FeaturePluginState | null>(null);
    const [busy, setBusy] = useState("");
    const records = useMemo(() => new Map((state?.plugins || []).map((plugin) => [plugin.id, plugin])), [state?.plugins]);
    const downloading = state?.downloading || null;

    const load = useCallback(async (refresh = false) => {
        if (!window.lySpaceDesktop) return;
        try {
            setState(refresh ? await window.lySpaceDesktop.refreshFeaturePlugins() : await window.lySpaceDesktop.featurePluginsList());
        } catch (error) {
            message.error(`读取功能插件失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }, [message]);

    useEffect(() => {
        void load();
        return window.lySpaceDesktop?.onFeaturePluginState(setState);
    }, [load]);

    const run = async (id: string, action: () => Promise<FeaturePluginState | { needsDependencies: Array<{ id: string; range: string }>; state: FeaturePluginState } | void>) => {
        setBusy(id);
        try {
            const result = await action();
            if (result && "needsDependencies" in result) {
                const names = result.needsDependencies.map((dependency) => state?.catalog.find((item) => item.id === dependency.id)?.name || dependency.id).join("、");
                modal.confirm({
                    title: "需要先安装依赖",
                    content: `“${id}” 依赖 ${names}。确认后只会下载安装这些官方功能插件；Codex 运行时仍需单独确认下载。`,
                    okText: "安装依赖并继续",
                    cancelText: "取消",
                    onOk: async () => {
                        setBusy(id);
                        try {
                            setState(await window.lySpaceDesktop!.installFeaturePlugin(id as "agent-core" | "skill-manager", { withDependencies: true }) as FeaturePluginState);
                            message.success("插件已安装");
                        } finally {
                            setBusy("");
                        }
                    },
                });
            } else if (result) {
                setState(result as FeaturePluginState);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy("");
        }
    };

    if (!window.lySpaceDesktop) return <Alert type="info" showIcon message="功能插件仅在 LY Space 桌面版中可用。" />;
    return (
        <Tabs
            items={[
                {
                    key: "feature",
                    label: "功能插件",
                    children: (
                        <div className="space-y-3">
                            <Alert type="info" showIcon icon={<ShieldCheck className="size-4" />} message="功能插件只能从 LY Space 官方清单安装。不会自动下载插件、更新或 Codex 运行时。" />
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500">
                                <span>Agent Core 与 Skill 管理独立下载；卸载保留对话、凭据和 Skills 数据。</span>
                                <Button size="small" icon={<RefreshCw className="size-4" />} loading={busy === "refresh"} onClick={() => run("refresh", async () => await window.lySpaceDesktop!.refreshFeaturePlugins())}>刷新清单</Button>
                            </div>
                            {downloading ? <Progress percent={downloading.total ? Math.min(100, Math.round(downloading.received / downloading.total * 100)) : 0} status="active" format={() => `${downloading.id} · ${sizeText(downloading.received)} / ${sizeText(downloading.total)}`} /> : null}
                            {!state ? <div className="py-8 text-center text-sm text-stone-500">正在读取已安装插件…</div> : state.catalog.length === 0 ? <div className="py-8 text-center text-sm text-stone-500">尚未获取官方功能插件清单。请检查网络后刷新。</div> : state.catalog.map((manifest) => {
                                const record = records.get(manifest.id);
                                const runtime = manifest.runtime;
                                const pluginSize = manifest.assets.reduce((sum, asset) => sum + asset.size, 0);
                                const requiresRuntime = manifest.id === "agent-core" && record?.status === "runtime-required";
                                return (
                                    <section key={manifest.id} className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div className="flex min-w-0 gap-3">
                                                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-700 dark:bg-stone-900 dark:text-stone-200">{manifest.id === "agent-core" ? <Bot className="size-5" /> : <Puzzle className="size-5" />}</span>
                                                <div className="min-w-0">
                                                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold"><span>{manifest.name}</span><Tag>v{record?.version || manifest.version}</Tag>{record ? <Tag color={record.status === "ready" ? "success" : record.status === "error" ? "error" : "warning"}>{statusText[record.status]}</Tag> : null}</div>
                                                    <p className="mt-1 text-xs leading-5 text-stone-500">{manifest.description}</p>
                                                    <div className="mt-2 text-xs text-stone-500">插件 {sizeText(pluginSize)}{runtime ? ` · Codex 运行时 ${sizeText(runtime.asset.size)}` : ""}</div>
                                                </div>
                                            </div>
                                            <div className="flex shrink-0 items-center gap-2">
                                                {record ? <Switch size="small" checked={record.enabled} disabled={busy === manifest.id || Boolean(state.downloading)} onChange={(enabled) => run(manifest.id, async () => await window.lySpaceDesktop!.setFeaturePluginEnabled(manifest.id, enabled))} /> : null}
                                                {!record ? <Button type="primary" size="small" icon={<Download className="size-4" />} loading={busy === manifest.id} disabled={Boolean(downloading)} onClick={() => run(manifest.id, async () => await window.lySpaceDesktop!.installFeaturePlugin(manifest.id))}>安装</Button> : null}
                                                {record?.status === "update-available" || record?.status === "repair" ? <Button size="small" icon={<Wrench className="size-4" />} loading={busy === manifest.id} onClick={() => run(manifest.id, async () => await window.lySpaceDesktop!.installFeaturePlugin(manifest.id, { withDependencies: true }))}>{record.status === "repair" ? "修复" : "更新"}</Button> : null}
                                                {record ? <Popconfirm title={`卸载 ${manifest.name}？`} description="会移除插件程序和受管运行时，保留对话、凭据和 Skills 数据。" okText="卸载" cancelText="取消" onConfirm={() => run(manifest.id, async () => await window.lySpaceDesktop!.uninstallFeaturePlugin(manifest.id))}><Button size="small" danger icon={<Trash2 className="size-4" />} /></Popconfirm> : null}
                                            </div>
                                        </div>
                                        {requiresRuntime && runtime ? <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100"><FolderCog className="size-4" /><span>未发现兼容的 Codex。可复用已有安装，也可单独下载受管运行时。</span><Button size="small" onClick={() => run("runtime-probe", async () => (await window.lySpaceDesktop!.probeCodexRuntime()).state)}>重新检测</Button><Button size="small" onClick={() => run("runtime-choose", async () => await window.lySpaceDesktop!.chooseCodexRuntime())}>选择已有 Codex</Button><Button size="small" type="primary" loading={busy === "runtime-install"} onClick={() => run("runtime-install", async () => await window.lySpaceDesktop!.installManagedCodexRuntime())}>下载运行时</Button></div> : null}
                                        {record?.error ? <div className="mt-2 text-xs text-red-500">{record.error}</div> : null}
                                        {manifest.permissions.length ? <div className="mt-3 text-xs text-stone-500">权限：{manifest.permissions.join("、")}</div> : null}
                                    </section>
                                );
                            })}
                            {downloading ? <Button size="small" onClick={() => run("cancel-download", async () => await window.lySpaceDesktop!.cancelFeaturePluginDownload())}>取消下载</Button> : null}
                        </div>
                    ),
                },
                {
                    key: "canvas",
                    label: "节点插件",
                    children: <div className="space-y-3 rounded-xl border border-stone-200 p-4 text-sm dark:border-stone-800"><div className="font-medium">画布节点插件</div><p className="text-xs leading-5 text-stone-500">现有节点插件保持独立：官方节点插件可一键安装，第三方插件仍可按 URL 安装，并会在画布页面内执行。</p><Button icon={<Puzzle className="size-4" />} onClick={openNodePlugins}>打开节点插件管理</Button></div>,
                },
            ]}
        />
    );
}
