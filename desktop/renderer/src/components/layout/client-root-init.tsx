import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";

import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { flushLocalState, flushPendingStorageWrites } from "@/services/desktop-storage";
import { initializeAppLogging, logAppEvent } from "@/services/app-logger";
import { UpdatePrompt } from "@/components/layout/update-prompt";
import { FeaturePluginHost } from "@/components/layout/feature-plugin-host";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const handledConfigParams = useRef(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const configHydrationStatus = useConfigStore((state) => state.configHydrationStatus);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    usePromptSourceScheduler();

    useEffect(() => {
        initializeAppLogging();
    }, []);

    useEffect(() => {
        let cancelled = false;
        const hydrateConfig = async () => {
            const desktop = window.lySpaceDesktop;
            let status: StorageBootstrapStatus = "first-run";
            let reason = "";
            if (desktop) {
                try {
                    const bootstrap = await desktop.getStorageStatus();
                    status = bootstrap.status;
                    reason = bootstrap.reason;
                } catch {
                    status = "needs-recovery";
                    reason = "storage-status-unavailable";
                }
            }
            if (cancelled) return;
            const store = useConfigStore.getState();
            store.prepareConfigHydration(status);
            try {
                await useConfigStore.persist.rehydrate();
                if (!cancelled) store.completeConfigHydration(true);
            } catch {
                if (!cancelled) store.completeConfigHydration(false);
            }
            if (!cancelled && (status === "needs-recovery" || useConfigStore.getState().configHydrationStatus === "needs-recovery")) {
                openConfigDialog(false, "channels");
                message.warning(reason ? "用户设置需要恢复，请导入有效配置后再继续使用" : "未读取到有效用户设置，请导入有效配置后再继续使用");
            }
        };
        void hydrateConfig();
        return () => { cancelled = true; };
    }, [message, openConfigDialog]);

    useEffect(() => {
        const showStorageError = (event: Event) => {
            const detail = event instanceof CustomEvent ? String(event.detail || "生成结果保存到本地目录失败，请检查存储设置") : "生成结果保存到本地目录失败，请检查存储设置";
            logAppEvent({ category: "error", level: "error", message: "生成结果保存失败", details: { error: detail } });
            message.warning(detail);
        };
        window.addEventListener("lyspace:storage-error", showStorageError);
        const unsubscribe = window.lySpaceDesktop?.onFlushPersistence((request) => {
            void flushLocalState().then(flushPendingStorageWrites).then(
                () => window.lySpaceDesktop?.persistenceFlushed(request.id),
                () => {
                    message.error("本地数据保存失败，已取消退出，请检查存储后重试");
                    return window.lySpaceDesktop?.persistenceFlushed(request.id, "本地数据保存失败");
                },
            ).catch(() => message.error("退出通知失败，请稍后重试"));
        });
        return () => {
            window.removeEventListener("lyspace:storage-error", showStorageError);
            unsubscribe?.();
        };
    }, [message]);

    useEffect(() => {
        if (configHydrationStatus === "loading") return;
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const firstChannel = config.channels[0];
        updateConfig(
            "channels",
            firstChannel
                ? config.channels.map((channel, index) =>
                      index === 0
                          ? {
                                ...channel,
                                ...(baseUrl ? { baseUrl } : {}),
                                ...(apiKey ? { apiKey } : {}),
                            }
                          : channel,
                  )
                : [createModelChannel({ id: "default", name: "默认渠道", baseUrl: baseUrl || undefined, apiKey: apiKey || "" })],
        );
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        message.success("已导入本地直连配置");
    }, [config.channels, configHydrationStatus, message, updateConfig]);

    return (
        <>
            {children}
            <FeaturePluginHost />
            <UpdatePrompt />
        </>
    );
}
