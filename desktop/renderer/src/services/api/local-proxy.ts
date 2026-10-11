import { normalizeLocalProxyUrl } from "@/stores/use-config-store";

export async function testLocalProxy(proxyUrl: string) {
    const base = normalizeLocalProxyUrl(proxyUrl);
    if (!base) throw new Error("请先填写本地代理地址");
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${base}/`, { cache: "no-store", signal: controller.signal });
        const data = response.ok ? (await response.json().catch(() => null) as { proxy?: string } | null) : null;
        if (!data?.proxy) throw new Error("本地代理不可用，请确认代理进程正在运行");
        return data.proxy;
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error("本地代理连接超时");
        throw error instanceof Error ? error : new Error("本地代理不可用，请确认代理进程正在运行");
    } finally {
        window.clearTimeout(timer);
    }
}
