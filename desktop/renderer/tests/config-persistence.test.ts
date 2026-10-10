import { beforeEach, expect, it } from "vitest";

class MemoryStorage {
    private values = new Map<string, string>();
    get length() { return this.values.size; }
    clear() { this.values.clear(); }
    getItem(key: string) { return this.values.get(key) ?? null; }
    key(index: number) { return [...this.values.keys()][index] ?? null; }
    removeItem(key: string) { this.values.delete(key); }
    setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

const storage = new MemoryStorage();

beforeEach(() => {
    storage.clear();
    globalThis.localStorage = storage as unknown as Storage;
});

it("已安装用户缺少配置时进入恢复状态且不写入默认渠道", async () => {
    const { CONFIG_STORE_KEY, useConfigStore } = await import("@/stores/use-config-store");
    useConfigStore.getState().prepareConfigHydration("ready");
    await useConfigStore.persist.rehydrate();
    useConfigStore.getState().completeConfigHydration(true);

    expect(useConfigStore.getState().configHydrationStatus).toBe("needs-recovery");
    expect(useConfigStore.getState().config.channels).toHaveLength(0);
    expect(storage.getItem(CONFIG_STORE_KEY)).toBeNull();
});

it("首次安装完成 hydration 后才允许保存默认配置", async () => {
    const { CONFIG_STORE_KEY, useConfigStore } = await import("@/stores/use-config-store");
    useConfigStore.getState().prepareConfigHydration("first-run");
    await useConfigStore.persist.rehydrate();
    useConfigStore.getState().completeConfigHydration(true);

    expect(useConfigStore.getState().configHydrationStatus).toBe("ready");
    const persisted = JSON.parse(storage.getItem(CONFIG_STORE_KEY) || "{}");
    expect(persisted.state.config.channels).toHaveLength(1);
});

it("损坏的配置原文保持不变，不被默认配置覆盖", async () => {
    const { CONFIG_STORE_KEY, useConfigStore } = await import("@/stores/use-config-store");
    storage.setItem(CONFIG_STORE_KEY, "{broken");
    useConfigStore.getState().prepareConfigHydration("ready");
    await Promise.resolve(useConfigStore.persist.rehydrate()).catch(() => undefined);
    useConfigStore.getState().completeConfigHydration(false);

    expect(useConfigStore.getState().configHydrationStatus).toBe("needs-recovery");
    expect(storage.getItem(CONFIG_STORE_KEY)).toBe("{broken");
});

it("导入失败时不替换原配置", async () => {
    const { CONFIG_STORE_KEY } = await import("@/stores/use-config-store");
    const { importAppConfig } = await import("@/services/config-file");
    const original = JSON.stringify({ state: { config: { channels: [{ id: "keep" }] } }, version: 0 });
    storage.setItem(CONFIG_STORE_KEY, original);

    await expect(importAppConfig(new File(["{broken"], "broken.json"))).rejects.toThrow("配置文件格式不正确");
    expect(storage.getItem(CONFIG_STORE_KEY)).toBe(original);
});

it("恢复有效配置前创建带时间戳的本地备份", async () => {
    const storeModule = await import("@/stores/use-config-store");
    const { restoreAppConfig } = await import("@/services/config-file");
    const original = JSON.stringify({ state: { config: storeModule.defaultConfig, webdav: storeModule.defaultWebdavSyncConfig }, version: 0 });
    storage.setItem(storeModule.CONFIG_STORE_KEY, original);

    restoreAppConfig({ config: storeModule.defaultConfig, webdav: storeModule.defaultWebdavSyncConfig });

    expect(storeModule.useConfigStore.getState().configHydrationStatus).toBe("ready");
    expect(storeModule.useConfigStore.getState().config.channels).toHaveLength(1);
    expect([...Array(storage.length).keys()].some((index) => storage.key(index)?.startsWith(`${storeModule.CONFIG_STORE_KEY}:backup:`))).toBe(true);
});
