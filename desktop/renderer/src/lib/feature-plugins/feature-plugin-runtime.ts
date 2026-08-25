export type FeaturePanel = {
    id: string;
    pluginId: "agent-core" | "skill-manager";
    group: "agent";
    title: string;
    order?: number;
    mount: (container: HTMLElement) => void | (() => void);
};

export type FeaturePluginRuntime = {
    pluginId: "agent-core" | "skill-manager";
    registerPanel: (panel: Omit<FeaturePanel, "pluginId">) => () => void;
    agent: {
        start: () => Promise<{ url: string }>;
        stop: () => Promise<void>;
        subscribe: (clientId: string, listener: (event: string, data: unknown) => void) => Promise<() => void>;
        resolveTool: (clientId: string, payload: { requestId: string; result?: unknown; error?: string }) => Promise<void>;
        request: <T = unknown>(payload: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown }) => Promise<T>;
        setRemoteCredentials: (payload: { url: string; token: string }) => Promise<FeaturePluginState>;
        clearRemoteCredentials: () => Promise<FeaturePluginState>;
    };
    canvas: {
        sync: (clientId: string) => Promise<void>;
        applyOps: (ops: unknown[]) => void;
        available: () => boolean;
    };
    openPluginCenter: () => void;
};

type Listener = () => void;
const panels = new Map<string, FeaturePanel>();
const listeners = new Set<Listener>();
let openedGroup: "agent" | null = null;
let revision = 0;
let canvasBridge: { snapshot: () => unknown; applyOps: (ops: unknown[]) => void } | null = null;

function notify() {
    revision += 1;
    listeners.forEach((listener) => listener());
}

export function createFeaturePluginRuntime(pluginId: "agent-core" | "skill-manager"): FeaturePluginRuntime {
    return {
        pluginId,
        registerPanel: (input) => {
            const panel: FeaturePanel = { ...input, pluginId };
            if (!panel.id || !panel.title || typeof panel.mount !== "function") throw new Error("功能插件面板定义无效");
            panels.set(panel.id, panel);
            notify();
            return () => {
                if (panels.get(panel.id) === panel) {
                    panels.delete(panel.id);
                    notify();
                }
            };
        },
        agent: {
            start: async () => {
                if (!window.lySpaceDesktop) throw new Error("Agent 仅在 LY Space 桌面版可用");
                return await window.lySpaceDesktop.startAgent();
            },
            stop: async () => void (await window.lySpaceDesktop?.stopAgent()),
            subscribe: async (clientId, listener) => {
                if (!window.lySpaceDesktop) throw new Error("Agent 仅在 LY Space 桌面版可用");
                const unsubscribe = window.lySpaceDesktop.onAgentEvent((payload) => {
                    if (payload.clientId === clientId) listener(payload.event, payload.data);
                });
                try {
                    await window.lySpaceDesktop.subscribeAgent(clientId);
                } catch (error) {
                    unsubscribe();
                    throw error;
                }
                return () => {
                    unsubscribe();
                    void window.lySpaceDesktop?.stopAgentEvents();
                };
            },
            resolveTool: async (clientId, payload) => {
                if (!window.lySpaceDesktop) throw new Error("Agent 仅在 LY Space 桌面版可用");
                await window.lySpaceDesktop.resolveAgentTool(clientId, payload);
            },
            request: async (payload) => {
                if (!window.lySpaceDesktop) throw new Error("Agent 仅在 LY Space 桌面版可用");
                return await window.lySpaceDesktop.agentRequest(payload) as never;
            },
            setRemoteCredentials: async (payload) => {
                if (!window.lySpaceDesktop) throw new Error("Agent 仅在 LY Space 桌面版可用");
                return await window.lySpaceDesktop.setRemoteAgentCredentials(payload);
            },
            clearRemoteCredentials: async () => {
                if (!window.lySpaceDesktop) throw new Error("Agent 仅在 LY Space 桌面版可用");
                return await window.lySpaceDesktop.clearRemoteAgentCredentials();
            },
        },
        canvas: {
            sync: async (clientId) => {
                if (!canvasBridge) throw new Error("请先打开一个画布项目，再使用画布操作");
                if (!window.lySpaceDesktop) throw new Error("Agent 仅在 LY Space 桌面版可用");
                await window.lySpaceDesktop.agentRequest({ method: "POST", path: `/canvas/activate?clientId=${encodeURIComponent(clientId)}`, body: {} });
                await window.lySpaceDesktop.agentRequest({ method: "POST", path: `/canvas/state?clientId=${encodeURIComponent(clientId)}`, body: canvasBridge.snapshot() });
            },
            applyOps: (ops) => canvasBridge?.applyOps(ops),
            available: () => Boolean(canvasBridge),
        },
        openPluginCenter: () => {
            window.dispatchEvent(new CustomEvent("lyspace:open-plugin-center"));
        },
    };
}

export function getFeaturePanels(group?: "agent") {
    return [...panels.values()].filter((panel) => !group || panel.group === group).sort((left, right) => (left.order || 0) - (right.order || 0));
}

export function subscribeFeaturePanels(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function openFeaturePanel(group: "agent" = "agent") {
    openedGroup = group;
    notify();
}

export function closeFeaturePanel() {
    openedGroup = null;
    notify();
}

export function getOpenedFeaturePanelGroup() {
    return openedGroup;
}

export function getFeaturePluginRevision() {
    return revision;
}

export function setFeatureCanvasBridge(bridge: { snapshot: () => unknown; applyOps: (ops: unknown[]) => void } | null) {
    canvasBridge = bridge;
}
