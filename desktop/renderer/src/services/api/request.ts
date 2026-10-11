export type ApiParams = Record<string, string | string[] | number | number[] | undefined>;

export const IMAGE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Compose a timeout with a caller signal while preserving caller cancellation. */
export function withRequestTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => controller.abort(new DOMException("请求超时", "TimeoutError")), timeoutMs);
    return { signal: controller.signal, dispose: () => { window.clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
}

export function compactApiParams(params: ApiParams) {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "" && value !== undefined && (!Array.isArray(value) || value.length > 0))) as ApiParams;
}

export function serializeApiParams(params?: ApiParams) {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => queryParams.append(key, String(item)));
        else queryParams.set(key, String(value));
    }
    return queryParams;
}
