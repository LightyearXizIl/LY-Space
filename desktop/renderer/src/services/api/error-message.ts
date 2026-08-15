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
    if (axios.isAxiosError(error)) return readUpstreamError(error.response?.data) || statusMessage(error.response?.status, fallback) || error.message || fallback;
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readUpstreamError(error.message) || error.message : readUpstreamError(error) || fallback;
}
