import axios from "axios";

import { readUpstreamError } from "./error-message";

type CreditsResponse = {
    code?: number | string;
    data?: { credits?: number } | null;
    msg?: string;
    message?: string;
};

function controlPlaneUrl(baseUrl: string, path: string) {
    const normalized = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
    if (!normalized) throw new Error("请先配置 GRS AI 接口地址");
    return `${normalized}${path}`;
}

async function requestCredits(baseUrl: string, path: string, body: Record<string, string>) {
    try {
        const response = await axios.post<CreditsResponse>(controlPlaneUrl(baseUrl, path), body, { headers: { "Content-Type": "application/json" } });
        const payload = response.data;
        if (String(payload.code) !== "0") throw new Error(payload.msg || payload.message || "GRS AI 积分查询失败");
        const credits = payload.data?.credits;
        if (typeof credits !== "number" || !Number.isFinite(credits)) throw new Error("GRS AI 返回的积分余额格式不正确");
        return credits;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const message = readUpstreamError(error.response?.data) || error.message;
            throw new Error(`GRS AI 积分查询失败：${message}`);
        }
        throw error instanceof Error ? error : new Error("GRS AI 积分查询失败");
    }
}

export function fetchGrsaiApiKeyCredits(baseUrl: string, apiKey: string) {
    if (!apiKey.trim()) throw new Error("请先配置 API Key");
    return requestCredits(baseUrl, "/client/openapi/getAPIKeyCredits", { apiKey: apiKey.trim() });
}

export function fetchGrsaiAccountCredits(baseUrl: string, token: string) {
    if (!token.trim()) throw new Error("请先填写 GRS AI 账户 Token");
    return requestCredits(baseUrl, "/client/openapi/getCredits", { token: token.trim() });
}
