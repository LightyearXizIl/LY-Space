import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";

import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { useAgentStore } from "@/stores/use-agent-store";
import { flushPendingStorageWrites } from "@/services/desktop-storage";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const handledConfigParams = useRef(false);
    const handledDesktopInit = useRef(false);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const config = useConfigStore((state) => state.config);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const connectAgent = useAgentStore((state) => state.connectAgent);

    usePromptSourceScheduler();

    useEffect(() => {
        const showStorageError = (event: Event) => message.warning(event instanceof CustomEvent ? String(event.detail || "生成结果保存到本地目录失败，请检查存储设置") : "生成结果保存到本地目录失败，请检查存储设置");
        window.addEventListener("lyspace:storage-error", showStorageError);
        const unsubscribe = window.lySpaceDesktop?.onFlushPersistence(() => {
            void flushPendingStorageWrites().finally(() => void window.lySpaceDesktop?.persistenceFlushed());
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
        void window.lySpaceDesktop.getAgentConfig().then((agent) => {
            if (agent.status === "ready") {
                localStorage.setItem("canvas-agent-url", agent.url);
                localStorage.setItem("canvas-agent-token", agent.token);
                setAgentState({ url: agent.url, token: agent.token });
                connectAgent({ silent: true });
            } else {
                setAgentState({ connectError: agent.error || "内置 Canvas Agent 启动失败" });
            }
            if (!config.channels.some((channel) => channel.apiKey.trim())) openConfigDialog(false, "channels");
        }).catch(() => setAgentState({ connectError: "无法读取内置 Canvas Agent 配置" }));
    }, [config.channels, connectAgent, openConfigDialog, setAgentState]);

    return <>{children}</>;
}
