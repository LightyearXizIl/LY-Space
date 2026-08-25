import { createFeaturePluginRuntime } from "@/lib/feature-plugins/feature-plugin-runtime";

type FeaturePluginModule = {
    id: "agent-core" | "skill-manager";
    activate: (runtime: ReturnType<typeof createFeaturePluginRuntime>) => void | (() => void);
};

const cleanups = new Map<string, () => void>();
const loading = new Map<string, Promise<void>>();
const activeVersions = new Map<string, string>();

async function evaluate(source: string): Promise<FeaturePluginModule> {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
        const mod = await import(/* @vite-ignore */ url) as { default?: unknown; plugin?: unknown };
        const value = mod.default ?? mod.plugin;
        if (!value || typeof value !== "object" || typeof (value as FeaturePluginModule).activate !== "function") throw new Error("功能插件未导出 activate");
        return value as FeaturePluginModule;
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function activateFeaturePlugin(id: "agent-core" | "skill-manager") {
    if (cleanups.has(id)) return;
    const current = loading.get(id);
    if (current) return await current;
    const task = (async () => {
        if (!window.lySpaceDesktop) return;
        const module = await evaluate(await window.lySpaceDesktop.getFeaturePluginSource(id));
        if (module.id !== id) throw new Error("功能插件标识不匹配");
        const cleanup = module.activate(createFeaturePluginRuntime(id));
        cleanups.set(id, typeof cleanup === "function" ? cleanup : () => undefined);
    })();
    loading.set(id, task);
    try {
        await task;
    } finally {
        loading.delete(id);
    }
}

export function deactivateFeaturePlugin(id: string) {
    const cleanup = cleanups.get(id);
    cleanups.delete(id);
    activeVersions.delete(id);
    cleanup?.();
}

export async function syncFeaturePlugins(state: FeaturePluginState) {
    const records = state.plugins.filter((plugin) => plugin.enabled && ["ready", "update-available"].includes(plugin.status));
    records.filter((plugin) => activeVersions.get(plugin.id) && activeVersions.get(plugin.id) !== plugin.version).forEach((plugin) => deactivateFeaturePlugin(plugin.id));
    const ready = new Set(records.map((plugin) => plugin.id));
    [...cleanups.keys()].filter((id) => !ready.has(id as "agent-core" | "skill-manager")).forEach(deactivateFeaturePlugin);
    for (const record of records) {
        await activateFeaturePlugin(record.id as "agent-core" | "skill-manager");
        activeVersions.set(record.id, record.version);
    }
}
