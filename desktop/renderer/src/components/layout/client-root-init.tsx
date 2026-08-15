import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";

import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { flushPendingStorageWrites } from "@/services/desktop-storage";
import { UpdatePrompt } from "@/components/layout/update-prompt";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const handledConfigParams = useRef(false);
    const handledDesktopInit = useRef(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    usePromptSourceScheduler();

    useEffect(() => {
        const showStorageError = (event: Event) => message.warning(event instanceof CustomEvent ? String(event.detail || "生成结果保存到本地目录失败，请检查存储设置") : "生成结果保存到本地目录失败，请检查存储设置");
        window.addEventListener("lyspace:storage-error", showStorageError);
        const unsubscribe = window.lySpaceDesktop?.onFlushPersistence((request) => {
            void flushPendingStorageWrites().finally(() => void window.lySpaceDesktop?.persistenceFlushed(request.id));
        });
        return () => {
            window.removeEventListener("lyspace:storage-error", showStorageError);
            unsubscribe?.();
        };
    }, [message]);

    useEffect(() => {
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
        openConfigDialog(false);
        message.success("已导入本地直连配置");
    }, [config.channels, message, openConfigDialog, updateConfig]);

    useEffect(() => {
        if (handledDesktopInit.current || !window.lySpaceDesktop) return;
        handledDesktopInit.current = true;
        if (!config.channels.some((channel) => channel.apiKey.trim())) openConfigDialog(false, "channels");
    }, [config.channels, openConfigDialog]);

    return (
        <>
            {children}
            <UpdatePrompt />
        </>
    );
}
