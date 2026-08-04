// 图片降采样缩略图:避免画布节点/资产封面直接解码原图(1k~8k 大图全尺寸解码吃显存)。
// 生成后的缩略图以 object URL 缓存(模块级 LRU),同源复用;失败回退调用方使用原图。
export const THUMBNAIL_MAX_SIDE = 1024;
const THUMBNAIL_MAX_ENTRIES = 200;
// 缩略图生成并发上限:画布恢复大量图片节点时避免同时解码多个原图吃满 CPU
const MAX_CONCURRENT_THUMBNAILS = 3;
let activeThumbnailTasks = 0;
const thumbnailQueue: Array<() => void> = [];

function runThumbnailTask(task: () => Promise<string | null>): Promise<string | null> {
    return new Promise((resolve) => {
        const start = () => {
            activeThumbnailTasks += 1;
            void task()
                .finally(() => {
                    activeThumbnailTasks -= 1;
                    const next = thumbnailQueue.shift();
                    if (next) next();
                })
                .then(resolve);
        };
        if (activeThumbnailTasks < MAX_CONCURRENT_THUMBNAILS) start();
        else thumbnailQueue.push(start);
    });
}

type ThumbnailEntry = { url: string };
const thumbnailCache = new Map<string, ThumbnailEntry>();
const pendingThumbnails = new Map<string, Promise<string | null>>();

function touchCache(key: string) {
    const entry = thumbnailCache.get(key);
    if (!entry) return;
    // LRU:重新插入到末尾表示最近使用
    thumbnailCache.delete(key);
    thumbnailCache.set(key, entry);
}

function setCache(key: string, url: string) {
    thumbnailCache.set(key, { url });
    // 超限时淘汰最久未使用的条目并释放其 object URL
    while (thumbnailCache.size > THUMBNAIL_MAX_ENTRIES) {
        const oldestKey = thumbnailCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        const oldest = thumbnailCache.get(oldestKey);
        thumbnailCache.delete(oldestKey);
        if (oldest) URL.revokeObjectURL(oldest.url);
    }
}

/**
 * 获取 source(blob:/data: URL)的降采样缩略图 object URL。
 * 返回 null 表示生成失败(调用方应回退原图)。
 */
export function getThumbnailUrl(source: string, maxSide = THUMBNAIL_MAX_SIDE): Promise<string | null> {
    const cached = thumbnailCache.get(source);
    if (cached) {
        touchCache(source);
        return Promise.resolve(cached.url);
    }
    const inflight = pendingThumbnails.get(source);
    if (inflight) return inflight;

    const task = runThumbnailTask(() => createThumbnail(source, maxSide)).catch(() => null);
    pendingThumbnails.set(source, task);
    void task.finally(() => pendingThumbnails.delete(source));
    void task.then((url) => {
        if (url) setCache(source, url);
    });
    return task;
}

/** 清除指定来源的缩略图缓存(图片内容变化后调用,避免旧图复用) */
export function clearThumbnailCache(source: string) {
    const entry = thumbnailCache.get(source);
    if (entry) {
        thumbnailCache.delete(source);
        URL.revokeObjectURL(entry.url);
    }
    pendingThumbnails.delete(source);
}

async function createThumbnail(source: string, maxSide: number): Promise<string | null> {
    try {
        const blob = await (await fetch(source)).blob();
        const bitmap = await createImageBitmap(blob);
        try {
            const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            ctx.drawImage(bitmap, 0, 0, width, height);
            const output = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
            return output ? URL.createObjectURL(output) : null;
        } finally {
            bitmap.close();
        }
    } catch {
        return null;
    }
}
