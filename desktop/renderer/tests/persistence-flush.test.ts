import { expect, it } from "vitest";
import { flushLocalState, flushPendingStorageWrites, registerLocalStateFlusher, trackWrite } from "@/services/desktop-storage";

it("同步或异步保存失败不再伪装为成功", async () => {
    const unregister = registerLocalStateFlusher(() => { throw new Error("disk full"); });
    try { await expect(flushLocalState()).rejects.toThrow("保存失败"); }
    finally { unregister(); }
    const unregisterAsync = registerLocalStateFlusher(async () => { throw new Error("disk full"); });
    try { await expect(flushLocalState()).rejects.toThrow("保存失败"); }
    finally { unregisterAsync(); }
});

it("等待本地写入失败时阻止退出", async () => {
    let reject!: (error: Error) => void;
    trackWrite(new Promise((_, fail) => { reject = fail; }));
    const result = flushPendingStorageWrites();
    reject(new Error("write failed"));
    await expect(result).rejects.toThrow("保存失败");
});

it("等待保存期间新增的写入也完成后才返回", async () => {
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    trackWrite(new Promise<void>((resolve) => { resolveFirst = resolve; }));
    let finished = false;
    const result = flushPendingStorageWrites().then(() => { finished = true; });
    trackWrite(new Promise<void>((resolve) => { resolveSecond = resolve; }));
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    resolveSecond();
    await result;
    expect(finished).toBe(true);
});
