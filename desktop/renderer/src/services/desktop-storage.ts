const pendingWrites = new Set<Promise<unknown>>();

export function isDesktopStorageAvailable() {
    return Boolean(window.lySpaceDesktop);
}

export async function saveGeneratedBlob(kind: Exclude<StorageKind, "text">, blob: Blob) {
    if (!window.lySpaceDesktop) return;
    const extension = extensionForBlob(blob, kind);
    const write = window.lySpaceDesktop.writeGeneratedOutput({ kind, extension, bytes: await blob.arrayBuffer() });
    trackWrite(write);
    try {
        await write;
    } catch (error) {
        notifyStorageError(error);
    }
}

export async function saveGeneratedText(text: string) {
    if (!window.lySpaceDesktop) return;
    const write = window.lySpaceDesktop.writeGeneratedOutput({ kind: "text", extension: "txt", text });
    trackWrite(write);
    try {
        await write;
    } catch (error) {
        notifyStorageError(error);
    }
}

export async function flushPendingStorageWrites() {
    await Promise.allSettled([...pendingWrites]);
}

export function trackWrite<T>(write: Promise<T>) {
    pendingWrites.add(write);
    void write.then(() => pendingWrites.delete(write), () => pendingWrites.delete(write));
    return write;
}

function extensionForBlob(blob: Blob, kind: Exclude<StorageKind, "text">) {
    const type = blob.type.toLowerCase();
    if (type.includes("png")) return "png";
    if (type.includes("jpeg")) return "jpg";
    if (type.includes("webp")) return "webp";
    if (type.includes("gif")) return "gif";
    if (type.includes("mp4")) return "mp4";
    if (type.includes("webm")) return "webm";
    if (type.includes("wav")) return "wav";
    if (type.includes("ogg")) return "ogg";
    if (type.includes("aac")) return "aac";
    return kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3";
}

export function notifyStorageError(error: unknown) {
    window.dispatchEvent(new CustomEvent("lyspace:storage-error", { detail: error instanceof Error ? error.message : "生成结果保存到本地目录失败" }));
}
