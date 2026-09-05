import { afterEach, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => new Map<string, Map<string, unknown>>());
vi.mock("localforage", () => ({ default: { createInstance: ({ storeName }: { storeName: string }) => {
    const data = stores.get(storeName) || new Map<string, unknown>();
    stores.set(storeName, data);
    return {
        getItem: async (key: string) => data.get(key),
        setItem: async (key: string, value: unknown) => { data.set(key, value); return value; },
        removeItem: async (key: string) => { data.delete(key); },
        iterate: async (callback: (value: unknown, key: string) => void) => { for (const [key, value] of data) callback(value, key); },
    };
} } }));
vi.mock("@/services/desktop-storage", () => ({ trackWrite: (promise: Promise<unknown>) => promise }));
vi.mock("@/services/file-storage", () => ({ resolveMediaUrl: vi.fn() }));
import { cleanupUnusedImages } from "@/services/image-storage";
import { loadWorkbenchSession, saveWorkbenchSession } from "@/services/workbench-session";

afterEach(() => { stores.forEach((data) => data.clear()); vi.restoreAllMocks(); });

it("清理无引用图片时保护两个工作台会话及视频记录中的参考图", async () => {
    const images = stores.get("image_files")!;
    for (const key of ["image:session", "image:video", "image:generated", "image:unused"]) images.set(key, new Blob(["image"]));
    await saveWorkbenchSession("video-workbench:current-session", { references: [{ storageKey: "image:session", dataUrl: "blob:expired" }] });
    stores.get("video_generation_logs")!.set("logs", [{ references: [{ storageKey: "image:video" }] }]);
    stores.get("image_generation_logs")!.set("logs", [{ storageKey: "image:generated" }]);
    await cleanupUnusedImages({});
    expect([...images.keys()]).toEqual(["image:session", "image:video", "image:generated"]);
});

it("重新载入工作台时用持久化图片恢复预览，替换已失效的 Blob 地址", async () => {
    stores.get("image_files")!.set("image:reload", new Blob(["image"], { type: "image/png" }));
    await saveWorkbenchSession("video-workbench:current-session", { references: [{ storageKey: "image:reload", dataUrl: "blob:expired" }] });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:restored");
    const session = await loadWorkbenchSession<{ references: { dataUrl: string; storageKey: string }[] }>("video-workbench:current-session");
    expect(session?.references[0]).toEqual({ storageKey: "image:reload", dataUrl: "blob:restored" });
});
