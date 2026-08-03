import { hostImageOnOss, loadOssHostingConfig, type OssHostingConfig } from "@/services/oss-hosting";
import type { ReferenceImage } from "@/types/image";

/**
 * 免费图床上传（catbox.moe，匿名免配置）。返回公网 HTTPS 图片 URL。
 * 优先浏览器直传（catbox 支持 CORS 时），失败（CORS/网络拦截）自动回退主进程代理上传（无浏览器跨域限制）。
 * 依赖第三方服务：图片会公开到公网，国内网络可能不稳定；失败时抛错由调用方提示。
 */
export async function uploadImageToFreeHost(input: Blob, name: string): Promise<string> {
    const direct = async (): Promise<string> => {
        const form = new FormData();
        form.append("reqtype", "fileupload");
        form.append("fileToUpload", input, name || "reference.png");
        const response = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form });
        const text = (await response.text()).trim();
        if (!response.ok || !/^https:\/\//i.test(text)) {
            throw new Error(`免费图床上传失败${text && text.length < 200 ? `：${text}` : `（HTTP ${response.status}）`}`);
        }
        return text;
    };
    try {
        return await direct();
    } catch (error) {
        // 浏览器直传被 CORS/网络拦截时回退主进程代理（无跨域限制）
        if (!window.lySpaceDesktop) throw error;
        try {
            const result = await window.lySpaceDesktop.uploadFreeHost({ name: name || "reference.png", mimeType: input.type || "application/octet-stream", bytes: await input.arrayBuffer() });
            return result.url;
        } catch {
            throw error;
        }
    }
}

async function readReferenceBlob(item: ReferenceImage): Promise<Blob> {
    const url = item.dataUrl || item.url || "";
    const response = await fetch(url);
    if (!response.ok) throw new Error("无法读取本地参考图片");
    return response.blob();
}

/**
 * 把本地参考图转为公网 HTTPS URL：优先阿里云 OSS（已配置时），未配置时自动改用免费图床。
 */
export async function hostReferenceImage(item: ReferenceImage): Promise<ReferenceImage> {
    const ossConfig: OssHostingConfig = await loadOssHostingConfig();
    const blob = await readReferenceBlob(item);
    const url = ossConfig.signatureEndpoint && ossConfig.publicBaseUrl ? await hostImageOnOss(blob, item.name, ossConfig) : await uploadImageToFreeHost(blob, item.name);
    return { ...item, url, dataUrl: url };
}
