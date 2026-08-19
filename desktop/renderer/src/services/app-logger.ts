export type AppLogLevel = "info" | "warn" | "error";
export type AppLogCategory = "system" | "network" | "operation" | "error";
export type AppLogInput = {
    level?: AppLogLevel;
    category: AppLogCategory;
    message: string;
    details?: Record<string, unknown>;
};

let initialized = false;

export function logAppEvent(input: AppLogInput) {
    const entry = {
        time: new Date().toISOString(),
        level: input.level || "info",
        category: input.category,
        message: input.message.slice(0, 500),
        details: redactLogValue(input.details),
    };
    void window.lySpaceDesktop?.appendAppLog(entry);
}

export function initializeAppLogging() {
    if (initialized) return;
    initialized = true;
    logAppEvent({ category: "system", message: "渲染进程已启动", details: { route: window.location.pathname } });

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = describeRequest(input, init);
        if (!request) return nativeFetch(input, init);
        const startedAt = performance.now();
        try {
            const response = await nativeFetch(input, init);
            logAppEvent({
                category: "network",
                level: response.ok ? "info" : "warn",
                message: response.ok ? "网络请求完成" : "网络请求返回异常状态",
                details: { ...request, status: response.status, durationMs: Math.round(performance.now() - startedAt) },
            });
            return response;
        } catch (error) {
            logAppEvent({
                category: "network",
                level: "error",
                message: "网络请求失败",
                details: { ...request, durationMs: Math.round(performance.now() - startedAt), error: errorMessage(error) },
            });
            throw error;
        }
    };

    window.addEventListener("error", (event) => {
        logAppEvent({ category: "error", level: "error", message: "渲染进程未捕获错误", details: { message: event.message, source: sanitizeUrl(event.filename), line: event.lineno, column: event.colno } });
    });
    window.addEventListener("unhandledrejection", (event) => {
        logAppEvent({ category: "error", level: "error", message: "未处理的 Promise 拒绝", details: { error: errorMessage(event.reason) } });
    });
}

function describeRequest(input: RequestInfo | URL, init?: RequestInit) {
    const rawUrl = input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input);
    const url = sanitizeUrl(rawUrl);
    if (!url) return null;
    return { method: init?.method || (input instanceof Request ? input.method : "GET"), url };
}

function sanitizeUrl(value: string) {
    try {
        const url = new URL(value, window.location.href);
        if (!/^https?:$/.test(url.protocol)) return "";
        return `${url.origin}${url.pathname}`;
    } catch {
        return "";
    }
}

function redactLogValue(value: unknown, depth = 0): unknown {
    if (depth > 4 || value == null) return value;
    if (typeof value === "string") {
        const truncated = value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
        return truncated
            .replace(/(Bearer\\s+)[^\\s,;]+/gi, "$1[已脱敏]")
            .replace(/((?:api[_.-]?key|authorization|password|secret|token)\\s*[:=]\\s*)[^\\s,;]+/gi, "$1[已脱敏]");
    }
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactLogValue(item, depth + 1));
    if (typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, /api.?key|authorization|password|secret|token/i.test(key) ? "[已脱敏]" : redactLogValue(item, depth + 1)]),
    );
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error || "未知错误");
}
