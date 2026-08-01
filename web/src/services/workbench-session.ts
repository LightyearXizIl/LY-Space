import localforage from "localforage";

import { resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl } from "@/services/image-storage";
import { trackWrite } from "@/services/desktop-storage";

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "workbench_sessions" });

export async function loadWorkbenchSession<T>(key: string): Promise<T | null> {
    const value = await store.getItem<T>(key);
    return value ? await hydrateStoredUrls(value) as T : null;
}

export async function saveWorkbenchSession(key: string, value: unknown) {
    await trackWrite(store.setItem(key, value));
}

export async function clearWorkbenchSession(key: string) {
    await trackWrite(store.removeItem(key));
}

async function hydrateStoredUrls(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(hydrateStoredUrls));
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const next = Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, item]) => [key, await hydrateStoredUrls(item)])));
    const storageKey = typeof record.storageKey === "string" ? record.storageKey : "";
    if (!storageKey) return next;
    const url = storageKey.startsWith("image:") ? await resolveImageUrl(storageKey, String(record.dataUrl || record.url || record.content || "")) : await resolveMediaUrl(storageKey, String(record.url || record.content || ""));
    if ("dataUrl" in record) next.dataUrl = url;
    if ("url" in record) next.url = url;
    if ("content" in record) next.content = url;
    return next;
}
