import { hostImageOnOss, loadOssHostingConfig, type OssHostingConfig } from "@/services/oss-hosting";
import type { ReferenceImage } from "@/types/image";

/** 上传前统一处理：非 PNG/JPEG 转码、限制最长边 1024px、JPEG 压缩，避免格式不支持与体积过大 */
async function normalizeImageForUpload(input: Blob): Promise<Blob> {
    try {
        const bitmap = await createImageBitmap(input);
        const maxSide = 1024;
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法处理图片");
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        // PNG（可能含透明）保持 PNG，其余统一转 JPEG（白底合成避免透明变黑）
        const keepPng = input.type === "image/png";
        const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("图片编码失败"))), keepPng ? "image/png" : "image/jpeg", keepPng ? undefined : 0.85),
        );
        return blob;
    } catch {
        return input;
    }
}

async function readReferenceBlob(item: ReferenceImage): Promise<Blob> {
    const url = item.dataUrl || item.url || "";
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("无法读取本地参考图片");
        return response.blob();
    } catch (error) {
        // 公网图片被 CORS 拦截时回退主进程下载
        if (window.lySpaceDesktop) {
            const fetched = await window.lySpaceDesktop.fetchUrl(url);
            return new Blob([fetched.bytes], { type: fetched.mimeType || "image/png" });
        }
        throw error;
    }
}

/** 把本地参考图转为公网 HTTPS URL：仅使用用户明确配置的 OSS，绝不静默上传到匿名公开图床。 */
export async function hostReferenceImage(item: ReferenceImage): Promise<ReferenceImage> {
    const ossConfig: OssHostingConfig = await loadOssHostingConfig();
    if (!ossConfig.signatureEndpoint || !ossConfig.publicBaseUrl) throw new Error("本地参考图需要公网 HTTPS 地址，请先在设置中配置阿里云 OSS，或改用已公开的图片 URL");
    const blob = await readReferenceBlob(item);
    const normalized = await normalizeImageForUpload(blob);
    const url = await hostImageOnOss(normalized, item.name, ossConfig);
    return { ...item, url, dataUrl: url };
}
