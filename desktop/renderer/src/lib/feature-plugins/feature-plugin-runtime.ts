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
        clientId: () => string;
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
    host: {
        executeTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
    };
    openPluginCenter: () => void;
};

type Listener = () => void;
const panels = new Map<string, FeaturePanel>();
const listeners = new Set<Listener>();
let openedGroup: "agent" | null = null;
let revision = 0;
let canvasBridge: { snapshot: () => unknown; applyOps: (ops: unknown[]) => void } | null = null;
const sharedAgentClientId = `ly-space-${crypto.randomUUID()}`;
const agentListeners = new Set<(event: string, data: unknown) => void>();
let removeDesktopAgentEvents: (() => void) | null = null;
let agentEventsConnected = false;
let canvasSyncTimer: number | null = null;

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
            clientId: () => sharedAgentClientId,
            start: async () => {
                if (!window.lySpaceDesktop) throw new Error("Agent 仅在 LY Space 桌面版可用");
                return await window.lySpaceDesktop.startAgent();
            },
            stop: async () => void (await window.lySpaceDesktop?.stopAgent()),
            subscribe: async (_clientId, listener) => {
                if (!window.lySpaceDesktop) throw new Error("Agent 仅在 LY Space 桌面版可用");
                agentListeners.add(listener);
                try {
                    if (!removeDesktopAgentEvents) removeDesktopAgentEvents = window.lySpaceDesktop.onAgentEvent((payload) => {
                        if (payload.clientId === sharedAgentClientId) agentListeners.forEach((item) => item(payload.event, payload.data));
                    });
                    if (!agentEventsConnected) {
                        await window.lySpaceDesktop.subscribeAgent(sharedAgentClientId);
                        agentEventsConnected = true;
                        void syncFeatureCanvasState();
                    }
                } catch (error) {
                    agentListeners.delete(listener);
                    throw error;
                }
                return () => {
                    agentListeners.delete(listener);
                    if (!agentListeners.size) {
                        removeDesktopAgentEvents?.();
                        removeDesktopAgentEvents = null;
                        agentEventsConnected = false;
                        void window.lySpaceDesktop?.stopAgentEvents();
                    }
                };
            },
            resolveTool: async (_clientId, payload) => {
                if (!window.lySpaceDesktop) throw new Error("Agent 仅在 LY Space 桌面版可用");
                await window.lySpaceDesktop.resolveAgentTool(sharedAgentClientId, payload);
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
            sync: async (_clientId) => {
                if (!canvasBridge) throw new Error("请先打开一个画布项目，再使用画布操作");
                if (!window.lySpaceDesktop) throw new Error("Agent 仅在 LY Space 桌面版可用");
                await window.lySpaceDesktop.agentRequest({ method: "POST", path: `/canvas/activate?clientId=${encodeURIComponent(sharedAgentClientId)}`, body: {} });
                await window.lySpaceDesktop.agentRequest({ method: "POST", path: `/canvas/state?clientId=${encodeURIComponent(sharedAgentClientId)}`, body: canvasBridge.snapshot() });
            },
            applyOps: (ops) => canvasBridge?.applyOps(ops),
            available: () => Boolean(canvasBridge),
        },
        host: {
            executeTool: async (name, input) => await executeHostTool(name, input),
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
    if (bridge && agentEventsConnected) void syncFeatureCanvasState();
}

/** 画布变更合并为 300ms 同步，只有已有 Agent 订阅时才发送，避免后台隐式启动服务。 */
export function notifyFeatureCanvasChanged() {
    if (!canvasBridge || !agentEventsConnected || !window.lySpaceDesktop) return;
    if (canvasSyncTimer !== null) window.clearTimeout(canvasSyncTimer);
    canvasSyncTimer = window.setTimeout(() => {
        canvasSyncTimer = null;
        void syncFeatureCanvasState();
    }, 300);
}

async function syncFeatureCanvasState() {
    if (!canvasBridge || !agentEventsConnected || !window.lySpaceDesktop) return;
    try {
        await window.lySpaceDesktop.agentRequest({ method: "POST", path: `/canvas/activate?clientId=${encodeURIComponent(sharedAgentClientId)}`, body: {} });
        await window.lySpaceDesktop.agentRequest({ method: "POST", path: `/canvas/state?clientId=${encodeURIComponent(sharedAgentClientId)}`, body: canvasBridge.snapshot() });
    } catch {
        // 服务重启或路由切换时由下一次订阅/画布变更重新激活，不把瞬态错误写入画布状态。
    }
}

async function executeHostTool(name: string, input: Record<string, unknown>) {
    if (name === "site_navigate") {
        const target = String(input.path || "");
        if (!/^\/(?:[A-Za-z0-9_/-]*)$/.test(target)) throw new Error("Agent 路由地址无效");
        window.history.pushState({}, "", target);
        window.dispatchEvent(new PopStateEvent("popstate"));
        return { ok: true, path: target };
    }
    if (name === "canvas_list_projects") {
        const keyword = String(input.keyword || "").trim().toLowerCase();
        const page = Math.max(1, Number(input.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 20));
        const projects = useCanvasStore.getState().projects.filter((project) => !keyword || project.title.toLowerCase().includes(keyword));
        return { items: projects.slice((page - 1) * pageSize, page * pageSize).map(({ id, title, createdAt, updatedAt, nodes, connections }) => ({ id, title, createdAt, updatedAt, nodeCount: nodes.length, connectionCount: connections.length })), total: projects.length, page, pageSize };
    }
    if (["canvas_get_state", "canvas_export_snapshot"].includes(name)) {
        if (!canvasBridge) throw new Error("请先打开一个画布项目，再使用画布工具");
        return canvasBridge.snapshot();
    }
    if (name === "canvas_get_selection") {
        if (!canvasBridge) throw new Error("请先打开一个画布项目，再使用画布工具");
        const snapshot = canvasBridge.snapshot() as { selectedNodeIds?: string[] };
        return { selectedNodeIds: snapshot.selectedNodeIds || [] };
    }
    if (name === "prompts_search") return await fetchPrompts({ keyword: String(input.keyword || ""), category: String(input.category || "全部"), tag: Array.isArray(input.tags) ? input.tags.map(String) : [], page: Number(input.page) || 1, pageSize: Number(input.pageSize) || 20 });
    if (name === "assets_list") {
        const kind = String(input.kind || "all");
        const keyword = String(input.keyword || "").trim().toLowerCase();
        const page = Math.max(1, Number(input.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 20));
        const assets = useAssetStore.getState().assets.filter((asset) => (kind === "all" || asset.kind === kind) && (!keyword || `${asset.title} ${asset.tags.join(" ")}`.toLowerCase().includes(keyword)));
        return { items: assets.slice((page - 1) * pageSize, page * pageSize).map(({ data: _data, ...asset }) => asset), total: assets.length, page, pageSize };
    }
    if (name === "assets_add") {
        const kind = String(input.kind || "");
        const title = String(input.title || "").trim();
        if (!title || !["text", "image"].includes(kind)) throw new Error("素材类型或标题无效");
        const common = { title, coverUrl: "", tags: Array.isArray(input.tags) ? input.tags.map(String) : [], source: String(input.source || ""), note: String(input.note || "") };
        if (kind === "text") return { id: useAssetStore.getState().addAsset({ ...common, kind: "text", data: { content: String(input.content || "") } }) };
        const imageUrl = String(input.imageUrl || "");
        if (!imageUrl) throw new Error("图片素材需要 imageUrl");
        const image = await uploadImage(imageUrl);
        return { id: useAssetStore.getState().addAsset({ ...common, kind: "image", coverUrl: image.url, data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType } }) };
    }
    throw new Error(`当前桌面宿主尚未实现工具「${name}」`);
}
import { fetchPrompts } from "@/services/api/prompts";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
