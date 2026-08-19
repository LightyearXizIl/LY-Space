import type { CameraSelection } from "@/lib/camera";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    localPath?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

export type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "imageResolution" | "size" | "count" | "background">;

export type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    camera?: CameraSelection;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    cancelCount: number;
    pendingCount?: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "生成中" | "成功" | "失败" | "取消";
    images: GeneratedImage[];
    thumbnails: string[];
};

type GenerationSlotStatus = "pending" | "success" | "failed" | "canceled";

export type TransientGenerationBatch = {
    id: string;
    createdAt: number;
    startedAt: number;
    time: string;
    prompt: string;
    camera: CameraSelection;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    imageCount: number;
    slots: Map<string, GenerationSlotStatus>;
    images: Map<string, GeneratedImage>;
};

export function createTransientGenerationBatch({ id, slotIds, prompt, camera, model, config, references, startedAt = performance.now(), createdAt = Date.now(), time = new Date(createdAt).toLocaleString("zh-CN", { hour12: false }) }: {
    id: string;
    slotIds: string[];
    prompt: string;
    camera: CameraSelection;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    startedAt?: number;
    createdAt?: number;
    time?: string;
}): TransientGenerationBatch {
    return { id, createdAt, startedAt, time, prompt, camera, model, config, references, imageCount: slotIds.length, slots: new Map(slotIds.map((slotId) => [slotId, "pending"])), images: new Map() };
}

export function updateTransientGenerationSlot(batch: TransientGenerationBatch, slotId: string, status: GenerationSlotStatus, image?: GeneratedImage) {
    batch.slots.set(slotId, status);
    if (image) batch.images.set(image.id, image);
}

export function replaceTransientGenerationImages(batch: TransientGenerationBatch, images: GeneratedImage[]) {
    images.forEach((image) => batch.images.set(image.id, image));
}

export function findTransientGenerationLog(batches: Iterable<TransientGenerationBatch>, imageId: string, now = performance.now()): GenerationLog | null {
    for (const batch of batches) {
        if (batch.images.has(imageId)) return buildTransientGenerationLog(batch, now);
    }
    return null;
}

export function buildTransientGenerationLog(batch: TransientGenerationBatch, now = performance.now()): GenerationLog {
    const counts = { success: 0, failed: 0, canceled: 0, pending: 0 };
    batch.slots.forEach((status) => {
        if (status === "success") counts.success += 1;
        else if (status === "failed") counts.failed += 1;
        else if (status === "canceled") counts.canceled += 1;
        else counts.pending += 1;
    });
    const images = [...batch.images.values()];
    return {
        id: batch.id,
        createdAt: batch.createdAt,
        title: batch.prompt.slice(0, 12) || "未命名",
        prompt: batch.prompt,
        camera: batch.camera,
        time: batch.time,
        model: batch.model,
        config: batch.config,
        references: batch.references,
        durationMs: Math.max(0, now - batch.startedAt),
        successCount: counts.success,
        failCount: counts.failed,
        cancelCount: counts.canceled,
        pendingCount: counts.pending || undefined,
        imageCount: batch.imageCount,
        size: batch.config.size,
        quality: batch.config.quality,
        status: counts.pending ? "生成中" : counts.success ? "成功" : counts.failed ? "失败" : "取消",
        images,
        thumbnails: images.map((image) => image.dataUrl).filter(Boolean),
    };
}
