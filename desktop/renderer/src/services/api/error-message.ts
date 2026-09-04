import axios from "axios";

export function readUpstreamError(value: unknown): string {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return readUpstreamError(parsed) || value;
        } catch {
            return value;
        }
    }
    if (typeof value !== "object") return String(value);
    const payload = value as { error?: unknown; message?: unknown; msg?: unknown; detail?: unknown; data?: unknown };
    return readUpstreamError(payload.error) || readUpstreamError(payload.message) || readUpstreamError(payload.msg) || readUpstreamError(payload.detail) || readUpstreamError(payload.data) || JSON.stringify(value);
}

export function readRequestError(error: unknown, fallback: string, statusMessage: (status: number | undefined, fallback: string) => string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return "网络请求未到达服务端：请检查网络、DNS、TLS 证书和 Base URL；浏览器直连跨域接口时，还需确认服务端已允许 CORS。";
        const message = readUpstreamError(error.response?.data) || statusMessage(error.response?.status, fallback) || error.message || fallback;
        const code = upstreamCode(error.response?.data);
        const requestId = responseHeader(error.response?.headers, "x-request-id") || responseHeader(error.response?.headers, "x-tt-logid") || responseHeader(error.response?.headers, "x-volc-request-id");
        const details = [code ? `上游错误码 ${code}` : "", requestId ? `请求 ID ${requestId}` : ""].filter(Boolean);
        return details.length ? `${message}（${details.join("；")}）` : message;
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readUpstreamError(error.message) || error.message : readUpstreamError(error) || fallback;
}

function upstreamCode(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const record = value as { code?: unknown; error?: { code?: unknown } };
    const code = record.error?.code ?? record.code;
    return typeof code === "string" || typeof code === "number" ? String(code) : "";
}

function responseHeader(headers: unknown, name: string): string {
    if (!headers) return "";
    if (typeof (headers as { get?: unknown }).get === "function") {
        const value = (headers as { get: (key: string) => unknown }).get(name);
        return typeof value === "string" ? value : "";
    }
    const value = (headers as Record<string, unknown>)[name] || (headers as Record<string, unknown>)[name.toLowerCase()];
    return typeof value === "string" ? value : "";
}
