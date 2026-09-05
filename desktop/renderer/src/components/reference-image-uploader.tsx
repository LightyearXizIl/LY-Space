import { Alert, App, Button, Image, Input, Tooltip } from "antd";
import { Check, ChevronLeft, ChevronRight, ClipboardPaste, Copy, ImagePlus, LoaderCircle, RotateCcw, Trash2, UploadCloud, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type Dispatch, type DragEvent, type SetStateAction } from "react";

import { ReferenceHostingConfigurationError, loadRecentReferenceUploads, REFERENCE_IMAGE_MIME_TYPES, saveRecentReferenceUpload, uploadReferenceImage, validateReferenceImageFile, type UploadedReferenceAsset } from "@/services/media-hosting";
import type { ReferenceImage } from "@/types/image";
import { uploadImage } from "@/services/image-storage";

export type ReferenceUploadItem = {
    id: string;
    file: File;
    localPreviewUrl: string;
    fileName: string;
    status: "pending" | "uploading" | "error";
    progress?: number;
    error?: string;
};

type Props = {
    references: ReferenceImage[];
    setReferences: Dispatch<SetStateAction<ReferenceImage[]>>;
    limit: number;
    onOpenSettings: () => void;
    requiresPublicUrl?: boolean;
};

const ACCEPT = REFERENCE_IMAGE_MIME_TYPES.join(",");
const MAX_CONCURRENT_UPLOADS = 3;

function isPublicHttpsImageUrl(value: string) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname !== "localhost" && !/^127(?:\.\d{1,3}){3}$/.test(url.hostname) && url.hostname !== "::1";
    } catch {
        return false;
    }
}

function uploadErrorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : "上传失败，请稍后重试";
    if (/failed to fetch|networkerror|网络请求失败/i.test(message)) return "网络连接失败，请稍后重试";
    return message.replace(/^Cloudflare R2 上传失败：/, "");
}

function moveItem<T>(items: T[], index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= items.length) return items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

export function ReferenceImageUploader({ references, setReferences, limit, onOpenSettings, requiresPublicUrl = false }: Props) {
    const { message } = App.useApp();
    const inputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const mountedRef = useRef(true);
    const referencesRef = useRef(references);
    const uploadsRef = useRef(new Map<string, ReferenceUploadItem>());
    const queueRef = useRef<string[]>([]);
    const activeUploadsRef = useRef(0);
    const removedRef = useRef(new Set<string>());
    const requiresPublicUrlRef = useRef(requiresPublicUrl);
    requiresPublicUrlRef.current = requiresPublicUrl;
    const [uploads, setUploads] = useState<ReferenceUploadItem[]>([]);
    const [dragging, setDragging] = useState(false);
    const [manualUrl, setManualUrl] = useState("");
    const [configurationError, setConfigurationError] = useState(false);
    const [recent, setRecent] = useState<UploadedReferenceAsset[]>([]);

    referencesRef.current = references;

    useEffect(() => {
        mountedRef.current = true;
        void loadRecentReferenceUploads().then(setRecent).catch(() => undefined);
        return () => {
            mountedRef.current = false;
            uploadsRef.current.forEach((item) => URL.revokeObjectURL(item.localPreviewUrl));
        };
    }, []);

    useEffect(() => setConfigurationError(false), [requiresPublicUrl]);

    const syncUploads = () => {
        if (mountedRef.current) setUploads(Array.from(uploadsRef.current.values()));
    };

    const removeUpload = (id: string) => {
        const item = uploadsRef.current.get(id);
        if (!item) return;
        removedRef.current.add(id);
        queueRef.current = queueRef.current.filter((queuedId) => queuedId !== id);
        uploadsRef.current.delete(id);
        URL.revokeObjectURL(item.localPreviewUrl);
        syncUploads();
    };

    const uploadOne = async (id: string) => {
        const item = uploadsRef.current.get(id);
        if (!item || removedRef.current.has(id)) return;
        uploadsRef.current.set(id, { ...item, status: "uploading", error: undefined });
        syncUploads();
        try {
            // 支持文件/Base64 的接口直接使用本地持久化图片，仅公网 URL 接口需要托管。
            if (!requiresPublicUrlRef.current) {
                const stored = await uploadImage(item.file);
                if (!mountedRef.current || removedRef.current.has(id)) return;
                setReferences((current) => current.length >= limit ? current : [...current, {
                    id: nanoid(), name: item.fileName, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey,
                }]);
                removeUpload(id);
                return;
            }
            const uploaded = await uploadReferenceImage(item.file);
            if (!mountedRef.current || removedRef.current.has(id)) return;
            setReferences((current) => {
                if (current.length >= limit || current.some((reference) => reference.url === uploaded.url || reference.dataUrl === uploaded.url)) return current;
                return [...current, { id: nanoid(), name: item.fileName, type: item.file.type, dataUrl: uploaded.url, url: uploaded.url }];
            });
            try {
                const nextRecent = await saveRecentReferenceUpload({ ...uploaded, fileName: item.fileName, type: item.file.type });
                if (mountedRef.current) setRecent(nextRecent);
            } catch {
                // 上传成功不因本地历史写入失败而回滚。
            }
            removeUpload(id);
        } catch (error) {
            if (!mountedRef.current || removedRef.current.has(id)) return;
            if (error instanceof ReferenceHostingConfigurationError && requiresPublicUrlRef.current) setConfigurationError(true);
            const current = uploadsRef.current.get(id);
            if (current) uploadsRef.current.set(id, { ...current, status: "error", error: uploadErrorMessage(error) });
            syncUploads();
        }
    };

    const pumpQueue = () => {
        while (mountedRef.current && activeUploadsRef.current < MAX_CONCURRENT_UPLOADS && queueRef.current.length) {
            const id = queueRef.current.shift();
            if (!id || removedRef.current.has(id)) continue;
            activeUploadsRef.current += 1;
            void uploadOne(id).finally(() => {
                activeUploadsRef.current -= 1;
                pumpQueue();
            });
        }
    };

    const enqueueFiles = (files?: FileList | readonly File[] | null) => {
        const selected = Array.from(files || []);
        if (!selected.length) return;
        setConfigurationError(false);
        const remaining = limit - referencesRef.current.length - uploadsRef.current.size;
        if (remaining <= 0) {
            message.warning(`参考图最多添加 ${limit} 张，请先移除部分参考图`);
            return;
        }
        const known = new Set([...uploadsRef.current.values()].map((item) => `${item.file.name}:${item.file.size}:${item.file.lastModified}`));
        const accepted: File[] = [];
        for (const file of selected) {
            try {
                validateReferenceImageFile(file);
                const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
                if (known.has(fingerprint)) {
                    message.warning(`“${file.name}”已经在上传列表中`);
                    continue;
                }
                known.add(fingerprint);
                accepted.push(file);
            } catch (error) {
                message.warning(`${file.name}：${uploadErrorMessage(error)}`);
            }
        }
        const nextFiles = accepted.slice(0, remaining);
        if (accepted.length > remaining) message.warning(`参考图最多添加 ${limit} 张，已加入前 ${remaining} 张`);
        nextFiles.forEach((file) => {
            const item: ReferenceUploadItem = { id: nanoid(), file, localPreviewUrl: URL.createObjectURL(file), fileName: file.name, status: "pending" };
            uploadsRef.current.set(item.id, item);
            queueRef.current.push(item.id);
        });
        syncUploads();
        pumpQueue();
    };

    const retryUpload = (id: string) => {
        const item = uploadsRef.current.get(id);
        if (!item || item.status !== "error") return;
        removedRef.current.delete(id);
        setConfigurationError(false);
        uploadsRef.current.set(id, { ...item, status: "pending", error: undefined });
        queueRef.current.push(id);
        syncUploads();
        pumpQueue();
    };

    const addManualUrl = () => {
        const url = manualUrl.trim();
        if (!isPublicHttpsImageUrl(url)) {
            message.error("请输入可公开访问的 HTTPS 图片 URL");
            return;
        }
        if (references.some((reference) => reference.url === url || reference.dataUrl === url)) {
            message.warning("该图片已经添加");
            return;
        }
        if (references.length >= limit) {
            message.warning(`参考图最多添加 ${limit} 张，请先移除部分参考图`);
            return;
        }
        const name = new URL(url).pathname.split("/").pop() || "公网参考图";
        setReferences((current) => [...current, { id: nanoid(), name, type: "image/*", dataUrl: url, url }]);
        setManualUrl("");
    };

    const addRecent = (asset: UploadedReferenceAsset) => {
        if (references.length >= limit) {
            message.warning(`参考图最多添加 ${limit} 张，请先移除部分参考图`);
            return;
        }
        if (references.some((reference) => reference.url === asset.url || reference.dataUrl === asset.url)) {
            message.warning("该图片已经添加");
            return;
        }
        setReferences((current) => [...current, { id: nanoid(), name: asset.fileName, type: asset.type, dataUrl: asset.url, url: asset.url }]);
    };

    const copyUrl = async (url: string) => {
        try {
            await navigator.clipboard.writeText(url);
            message.success("图片链接已复制");
        } catch {
            message.error("复制链接失败");
        }
    };

    const pasteImages = (event: ReactClipboardEvent<HTMLButtonElement>) => {
        const files = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
        if (!files.length) return;
        event.preventDefault();
        enqueueFiles(files);
    };

    return (
        <section className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-base font-semibold">参考图</span>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!references.length && !uploads.length} onClick={() => {
                    uploads.forEach((item) => removeUpload(item.id));
                    setReferences([]);
                }}>
                    清空
                </Button>
            </div>
            <input ref={inputRef} type="file" accept={ACCEPT} multiple className="hidden" onChange={(event: ChangeEvent<HTMLInputElement>) => {
                enqueueFiles(event.target.files);
                event.target.value = "";
            }} />
            <button
                type="button"
                className={`flex min-h-36 w-full flex-col items-center justify-center rounded-lg border border-dashed px-4 text-center transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 dark:focus-visible:outline-stone-100 ${dragging ? "border-stone-900 bg-stone-100 dark:border-stone-100 dark:bg-stone-900" : "border-stone-300 text-stone-600 hover:border-stone-500 hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-500 dark:hover:bg-stone-900"}`}
                onClick={() => inputRef.current?.click()}
                onPaste={pasteImages}
                onDragEnter={(event: DragEvent<HTMLButtonElement>) => {
                    event.preventDefault();
                    dragDepthRef.current += 1;
                    if (event.dataTransfer.types.includes("Files")) setDragging(true);
                }}
                onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                }}
                onDragLeave={(event) => {
                    event.preventDefault();
                    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                    if (!dragDepthRef.current) setDragging(false);
                }}
                onDrop={(event) => {
                    event.preventDefault();
                    dragDepthRef.current = 0;
                    setDragging(false);
                    enqueueFiles(event.dataTransfer.files);
                }}
            >
                <ImagePlus className="mb-2 size-7" aria-hidden="true" />
                <span className="font-medium">{dragging ? "松开即可添加参考图" : "拖入图片，或点击选择文件"}</span>
                <span className="mt-1 text-xs text-stone-500 dark:text-stone-400"><ClipboardPaste className="mr-1 inline size-3" aria-hidden="true" />PNG / JPG / JPEG / WEBP · 支持 Ctrl+V 粘贴 · 最大 100MB</span>
            </button>

            <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">{requiresPublicUrl ? "当前视频接口需要公网图片链接，本地图片将上传至已配置的素材托管。" : "本地图片直接添加为参考图，无需配置 OSS。"}</p>
            {requiresPublicUrl && configurationError ? <Alert className="mt-3" type="warning" showIcon message="尚未配置参考素材托管" description="当前视频接口只接受公网图片链接。请配置 Cloudflare R2 + Worker，或在下方直接添加已有的公网图片链接。" action={<Button size="small" onClick={onOpenSettings}>前往配置</Button>} /> : null}

            {references.length || uploads.length ? (
                <div className="mt-3">
                    <div className="mb-2 flex items-center justify-between text-sm">
                        <span className="font-medium">已添加参考图</span>
                        <span className="text-stone-500 dark:text-stone-400">{references.length} / {limit}</span>
                    </div>
                    <Image.PreviewGroup>
                        <div className="flex flex-wrap gap-2">
                            {references.map((item, index) => (
                                <div key={item.id} className="group relative w-24 overflow-hidden rounded-md border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900">
                                    <Image src={item.dataUrl} alt={item.name} className="size-24 object-cover" />
                                    <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{String(index + 1).padStart(2, "0")} <Check className="inline size-3" aria-label="已添加" /></span>
                                    <div className="absolute inset-x-1 bottom-1 flex justify-between gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                        <Tooltip title="前移"><button type="button" aria-label="前移参考图" disabled={index === 0} className="flex size-6 items-center justify-center rounded bg-black/60 text-white disabled:opacity-40" onClick={() => setReferences((current) => moveItem(current, index, -1))}><ChevronLeft className="size-3.5" /></button></Tooltip>
                                        {isPublicHttpsImageUrl(item.url || item.dataUrl) ? <Tooltip title="复制链接"><button type="button" aria-label="复制图片链接" className="flex size-6 items-center justify-center rounded bg-black/60 text-white" onClick={() => void copyUrl(item.url || item.dataUrl)}><Copy className="size-3.5" /></button></Tooltip> : null}
                                        <Tooltip title="后移"><button type="button" aria-label="后移参考图" disabled={index === references.length - 1} className="flex size-6 items-center justify-center rounded bg-black/60 text-white disabled:opacity-40" onClick={() => setReferences((current) => moveItem(current, index, 1))}><ChevronRight className="size-3.5" /></button></Tooltip>
                                        <Tooltip title="移除"><button type="button" aria-label="移除参考图" className="flex size-6 items-center justify-center rounded bg-black/60 text-white" onClick={() => setReferences((current) => current.filter((reference) => reference.id !== item.id))}><Trash2 className="size-3.5" /></button></Tooltip>
                                    </div>
                                    <div className="truncate px-1.5 py-1 text-[10px] text-stone-600 dark:text-stone-300">{item.name}</div>
                                </div>
                            ))}
                            {uploads.map((item) => (
                                <div key={item.id} className="relative w-24 overflow-hidden rounded-md border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900">
                                    <img src={item.localPreviewUrl} alt={item.fileName} className="size-24 object-cover" />
                                    <div className="absolute inset-0 flex items-center justify-center bg-black/45 text-center text-xs text-white">
                                        {item.status === "error" ? <span className="px-1">添加失败</span> : <LoaderCircle className="size-5 animate-spin" aria-label="添加中" />}
                                    </div>
                                    {item.status === "error" ? <div className="absolute inset-x-1 bottom-1 flex justify-center gap-1"><button type="button" aria-label="重试上传" className="flex size-6 items-center justify-center rounded bg-black/60 text-white" onClick={() => retryUpload(item.id)}><RotateCcw className="size-3.5" /></button><button type="button" aria-label="删除上传项" className="flex size-6 items-center justify-center rounded bg-black/60 text-white" onClick={() => removeUpload(item.id)}><X className="size-3.5" /></button></div> : null}
                                    <div className="truncate px-1.5 py-1 text-[10px] text-stone-600 dark:text-stone-300">{item.status === "error" ? item.error : item.status === "pending" ? "等待添加" : "添加中…"}</div>
                                </div>
                            ))}
                        </div>
                    </Image.PreviewGroup>
                </div>
            ) : null}

            {recent.length ? <div className="mt-4"><div className="mb-2 text-sm font-medium">最近上传</div><div className="flex gap-2 overflow-x-auto pb-1">{recent.slice(0, 8).map((asset) => <button key={asset.id} type="button" className="group relative size-14 shrink-0 overflow-hidden rounded border border-stone-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stone-900 dark:border-stone-800 dark:focus-visible:outline-stone-100" onClick={() => addRecent(asset)} aria-label={`添加最近上传的 ${asset.fileName}`}><img src={asset.url} alt="" className="size-full object-cover" /><UploadCloud className="absolute inset-0 m-auto hidden size-4 text-white drop-shadow group-hover:block" /></button>)}</div></div> : null}

            <div className="mt-5 border-t border-stone-200 pt-4 dark:border-stone-800">
                <div className="mb-2 text-sm font-medium">或添加公网图片</div>
                <div className="flex gap-2"><Input value={manualUrl} onChange={(event) => setManualUrl(event.target.value)} onPressEnter={addManualUrl} placeholder="https://example.com/image.png" aria-label="公网图片 URL" /><Button onClick={addManualUrl}>添加</Button></div>
            </div>
        </section>
    );
}
