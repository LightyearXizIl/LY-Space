import { hostImageOnOss, loadOssHostingConfig, type OssHostingConfig } from "@/services/oss-hosting";
import type { ReferenceImage } from "@/types/image";

/**
 * 免费图床上传（tmpfiles.org 优先，catbox.moe 兜底，均匿名免配置）。返回公网 HTTPS 图片 URL。
 * 每层图床先浏览器直传（支持 CORS 时），失败自动回退主进程代理（无跨域限制）。
 * 依赖第三方服务：图片会公开到公网；全部失败时抛错提示配置 OSS 或使用公网 URL。
 */
export async function uploadImageToFreeHost(input: Blob, name: string): Promise<string> {
    const directTmpfiles = async (): Promise<string> => {
        const form = new FormData();
        form.append("file", input, name || "reference.png");
        const response = await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: form });
        const payload = await response.json().catch(() => null);
        const url = typeof payload?.data?.url === "string" ? payload.data.url : "";
        if (!response.ok || !/^https:\/\//i.test(url)) throw new Error(`免费图床上传失败（HTTP ${response.status}）`);
        return url.replace("/tmpfiles.org/", "/tmpfiles.org/dl/");
    };
    const directCatbox = async (): Promise<string> => {
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
        return await directTmpfiles();
    } catch (error) {
        try {
            return await directCatbox();
        } catch {
            // 浏览器直传被 CORS/网络拦截时回退主进程代理（无跨域限制，内部同样多图床兜底）
            if (!window.lySpaceDesktop) throw error;
            try {
                const result = await window.lySpaceDesktop.uploadFreeHost({ name: name || "reference.png", mimeType: input.type || "application/octet-stream", bytes: await input.arrayBuffer() });
                return result.url;
            } catch {
                throw new Error("免费图床上传失败（图床不可达，可能网络受限），请配置阿里云 OSS 或改用公网 HTTPS 图片 URL");
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
    const url = ossConfig.signatureEndpoint && ossConfig.publicBaseUrl ? await hostImageOnOss(blob, item.name, ossConfig) : await uploadImageToFreeHost(blob, item.name);
    return { ...item, url, dataUrl: url };
}
