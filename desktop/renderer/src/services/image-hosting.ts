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

/**
 * 免费图床上传（uguu.se 优先，tmpfiles.org、catbox.moe 兜底，均匿名免配置）。返回公网 HTTPS 图片 URL。
 * 每层图床先浏览器直传（支持 CORS 时），失败自动回退主进程代理（无跨域限制）。
 * 上传前统一转 PNG/JPEG；依赖第三方服务：图片会公开到公网；全部失败时抛错提示配置 OSS 或使用公网 URL。
 */
export async function uploadImageToFreeHost(input: Blob, name: string): Promise<string> {
    const blob = await normalizeImageForUpload(input);
    const uploadName = name || "reference.png";
    const directUguu = async (): Promise<string> => {
        const form = new FormData();
        form.append("files[]", blob, uploadName);
        const response = await fetch("https://uguu.se/upload.php", { method: "POST", body: form });
        const payload = await response.json().catch(() => null);
        const url = typeof payload?.files?.[0]?.url === "string" ? payload.files[0].url : "";
        if (!response.ok || !/^https:\/\//i.test(url)) throw new Error(`免费图床上传失败（HTTP ${response.status}）`);
        return url;
    };
    const directTmpfiles = async (): Promise<string> => {
        const form = new FormData();
        form.append("file", blob, uploadName);
        const response = await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: form });
        const payload = await response.json().catch(() => null);
        const url = typeof payload?.data?.url === "string" ? payload.data.url : "";
        if (!response.ok || !/^https:\/\//i.test(url)) throw new Error(`免费图床上传失败（HTTP ${response.status}）`);
        return url.replace("/tmpfiles.org/", "/tmpfiles.org/dl/");
    };
    const directCatbox = async (): Promise<string> => {
        const form = new FormData();
        form.append("reqtype", "fileupload");
        form.append("fileToUpload", blob, uploadName);
        const response = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form });
        const text = (await response.text()).trim();
        if (!response.ok || !/^https:\/\//i.test(text)) {
            throw new Error(`免费图床上传失败${text && text.length < 200 ? `：${text}` : `（HTTP ${response.status}）`}`);
        }
        return text;
    };
    try {
        return await directUguu();
    } catch (error) {
        try {
            return await directTmpfiles();
        } catch {
            try {
                return await directCatbox();
            } catch {
                // 浏览器直传被 CORS/网络拦截时回退主进程代理（无跨域限制，内部同样多图床兜底）
                if (!window.lySpaceDesktop) throw error;
                try {
                    const result = await window.lySpaceDesktop.uploadFreeHost({ name: uploadName, mimeType: blob.type || "image/png", bytes: await blob.arrayBuffer() });
                    return result.url;
                } catch {
                    throw new Error("免费图床上传失败（图床不可达，可能网络受限），请配置阿里云 OSS 或改用公网 HTTPS 图片 URL");
                }
            }
        }
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

/**
 * 把本地参考图转为公网 HTTPS URL：优先阿里云 OSS（已配置时），未配置时自动改用免费图床。
 */
export async function hostReferenceImage(item: ReferenceImage): Promise<ReferenceImage> {
    const ossConfig: OssHostingConfig = await loadOssHostingConfig();
    const blob = await readReferenceBlob(item);
    const normalized = await normalizeImageForUpload(blob);
    const url = ossConfig.signatureEndpoint && ossConfig.publicBaseUrl ? await hostImageOnOss(normalized, item.name, ossConfig) : await uploadImageToFreeHost(normalized, item.name);
    return { ...item, url, dataUrl: url };
}
