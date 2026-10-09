import axios from "axios";

import { buildApiUrl, type ApiCallFormat, type ChannelBalanceQuery, type ModelChannel } from "@/stores/use-config-store";
import { readUpstreamError } from "./error-message";

export type ChannelBalance = {
    amount: number;
    currency: string;
    /** 命中的查询端点标识，便于排查（如 grsai-apikey-credits）。 */
    probe: string;
};

/** 未指定字段与端点内置字段时，按顺序尝试的常见金额字段名。 */
const AMOUNT_FIELDS = ["balance", "remaining", "available", "total_available", "credits", "credit", "quota", "amount", "hard_limit_usd", "total_granted"];

/** 一个余额查询端点定义。 */
type BalanceProbe = {
    id: string;
    label: string;
    method: "GET" | "POST";
    /** 相对 Base URL 的路径；经 buildApiUrl 会自动补 /v1。 */
    path: string;
    /** 鉴权位置：header 走 Bearer；body 写入 bodyKey；query 写入 queryKey。 */
    auth: "header" | "body" | "query";
    /** auth=body 时写入请求体的字段名。 */
    bodyKey?: string;
    /** auth=query 时写入 URL 查询参数的字段名。 */
    queryKey?: string;
    /** true 表示使用控制面地址（去掉 Base 末尾的 /v1），不自动补 /v1。 */
    controlPlane?: boolean;
    /** 优先尝试的金额字段（点路径）。 */
    fields: string[];
    /** 适用协议；不填表示所有协议都可用（作为兜底）。 */
    formats?: ApiCallFormat[];
};

/**
 * 已知中转站的余额端点。auto 模式按「本渠道协议优先 → 其余兜底」的顺序依次尝试。
 * 各站接口形态差异很大：GRS 同时提供 API Key 积分和账户积分接口；星流是 GET + Bearer；
 * one-api/new-api 系沿用 OpenAI 账单端点。新增站点只需在此追加一条。
 */
const PROBES: BalanceProbe[] = [
    { id: "grsai-account-credits", label: "GRS AI · 账户积分", method: "GET", path: "/client/common/getCredits", auth: "query", queryKey: "apikey", controlPlane: true, fields: ["data.credits", "credits", "data.balance", "balance", "data.remaining", "remaining"], formats: ["grsai"] },
    { id: "grsai-apikey-credits", label: "GRS AI · APIKey 积分", method: "POST", path: "/client/openapi/getAPIKeyCredits", auth: "body", bodyKey: "apiKey", controlPlane: true, fields: ["data.credits", "credits"], formats: ["grsai"] },
    { id: "openai-credit-grants", label: "OpenAI 账单 · 授信额度", method: "GET", path: "/dashboard/billing/credit_grants", auth: "header", fields: ["total_available", "data.total_available", "total_granted"], formats: ["openai"] },
    { id: "openai-subscription", label: "OpenAI 账单 · 订阅额度", method: "GET", path: "/dashboard/billing/subscription", auth: "header", fields: ["hard_limit_usd", "data.hard_limit_usd", "system_hard_limit_usd"], formats: ["openai"] },
    { id: "wallet", label: "钱包", method: "GET", path: "/wallet", auth: "header", fields: ["balance", "data.balance", "credits", "data.credits"], formats: ["openai"] },
    { id: "credits", label: "额度", method: "GET", path: "/credits", auth: "header", fields: [] },
];

/** auto 模式命中的端点缓存（按渠道 id），避免每次轮询都从头探测。 */
const probeCache = new Map<string, string>();

function readPath(source: unknown, path: string): unknown {
    return path
        .split(".")
        .filter(Boolean)
        .reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), source);
}

function toNumber(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value.replace(/[,\s¥$€£]/g, ""));
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/**
 * 取值优先级：用户指定 field → 端点内置字段 → 常见字段自动识别（含顶层与 data/result 嵌套）。
 * 注意 0 是合法余额，一律按「找到」返回，不能当未命中。
 */
function detectAmount(payload: unknown, field: string | undefined, probeFields: string[]): number | null {
    const order = field?.trim() ? [field.trim()] : probeFields;
    for (const path of order) {
        const value = toNumber(readPath(payload, path));
        if (value !== null) return value;
    }
    for (const scope of [payload, readPath(payload, "data"), readPath(payload, "data.data"), readPath(payload, "result")]) {
        if (!scope || typeof scope !== "object") continue;
        for (const name of AMOUNT_FIELDS) {
            const value = toNumber((scope as Record<string, unknown>)[name]);
            if (value !== null) return value;
        }
    }
    return null;
}

function detectCurrency(payload: unknown): string {
    for (const scope of [payload, readPath(payload, "data")]) {
        if (scope && typeof scope === "object") {
            const currency = (scope as Record<string, unknown>).currency;
            if (typeof currency === "string" && currency.trim()) return currency.trim().toUpperCase();
        }
    }
    return "";
}

/** 币种 → 符号；未识别时返回空串（不臆造币种，只显示数字）。 */
export function balanceCurrencySymbol(currency: string) {
    const code = currency.trim().toUpperCase();
    if (code === "USD") return "$";
    if (code === "CNY" || code === "RMB") return "¥";
    if (code === "EUR") return "€";
    return "";
}

export function formatBalance(balance: ChannelBalance) {
    return `${balanceCurrencySymbol(balance.currency)}${balance.amount}`;
}

/** 解析自定义路径为最终 URL：http(s) 绝对地址原样使用，其余交由 buildApiUrl 补 /v1。 */
export function resolveBalanceUrl(baseUrl: string, path: string) {
    const trimmed = path.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return buildApiUrl(baseUrl, trimmed.startsWith("/") ? trimmed : `/${trimmed}`);
}

function probeUrl(channel: ModelChannel, probe: BalanceProbe) {
    if (probe.controlPlane) {
        const base = channel.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
        if (!base) throw new Error("请先配置渠道接口地址");
        const url = `${base}${probe.path}`;
        if (probe.auth === "query") {
            const key = channel.apiKey.trim();
            if (!key) throw new Error("请先填写该渠道的 API Key");
            return `${url}?${encodeURIComponent(probe.queryKey || "apiKey")}=${encodeURIComponent(key)}`;
        }
        return url;
    }
    return resolveBalanceUrl(channel.baseUrl, probe.path);
}

/** 由「自定义」配置构造一个探测端点。 */
function customProbe(query: ChannelBalanceQuery): BalanceProbe {
    return {
        id: "custom",
        label: "自定义",
        method: query.method === "POST" ? "POST" : "GET",
        path: query.path.trim() || "/wallet",
        auth: query.authMode === "body" ? "body" : "header",
        bodyKey: query.bodyKey?.trim() || "apiKey",
        fields: [],
    };
}

function selectProbes(channel: ModelChannel, query: ChannelBalanceQuery): BalanceProbe[] {
    if (query.mode === "custom") return [customProbe(query)];
    if (query.mode === "grsai") return PROBES.filter((probe) => probe.formats?.includes("grsai"));
    if (query.mode === "wallet") return PROBES.filter((probe) => probe.id === "wallet" || probe.id === "credits");
    if (query.mode === "openai-billing") return PROBES.filter((probe) => probe.id.startsWith("openai-"));
    // auto：本渠道协议的端点优先，其余端点兜底；命中的端点提到最前。
    const preferred = PROBES.filter((probe) => probe.formats?.includes(channel.apiFormat));
    const rest = PROBES.filter((probe) => !probe.formats?.includes(channel.apiFormat));
    const ordered = [...preferred, ...rest];
    const cachedId = probeCache.get(channel.id);
    if (cachedId) {
        const index = ordered.findIndex((probe) => probe.id === cachedId);
        if (index > 0) ordered.unshift(...ordered.splice(index, 1));
    }
    return ordered;
}

async function runProbe(channel: ModelChannel, probe: BalanceProbe, query: ChannelBalanceQuery, signal?: AbortSignal): Promise<ChannelBalance> {
    const url = probeUrl(channel, probe);
    const headers: Record<string, string> = {};
    let body: Record<string, string> | undefined;
    if (probe.auth === "body") {
        body = { [probe.bodyKey || "apiKey"]: channel.apiKey.trim() };
        headers["Content-Type"] = "application/json";
    } else if (probe.auth === "header") {
        headers.Authorization = `Bearer ${channel.apiKey.trim()}`;
    }
    const response =
        probe.method === "POST"
            ? await axios.post(url, body, { headers, timeout: 15000, signal })
            : await axios.get(url, { headers, timeout: 15000, signal });
    const amount = detectAmount(response.data, query.field, probe.fields);
    if (amount === null) {
        const detail = readUpstreamError(response.data);
        throw new Error(detail || "未找到可识别的余额字段");
    }
    return { amount, currency: detectCurrency(response.data), probe: probe.id };
}

export async function fetchChannelBalance(channel: ModelChannel, query: ChannelBalanceQuery, signal?: AbortSignal): Promise<ChannelBalance> {
    if (!channel.apiKey.trim()) throw new Error("请先填写该渠道的 API Key");
    const probes = selectProbes(channel, query);
    if (!probes.length) throw new Error("该查询方式没有可用端点，请改用「自动识别」或「自定义」");
    let authFailed: string | null = null;
    const failures: string[] = [];
    for (const probe of probes) {
        try {
            const result = await runProbe(channel, probe, query, signal);
            if (query.mode === "auto") probeCache.set(channel.id, probe.id);
            return result;
        } catch (error) {
            if (axios.isCancel(error)) throw error;
            if (axios.isAxiosError(error)) {
                const status = error.response?.status;
                const message = readUpstreamError(error.response?.data) || error.message;
                if ((status === 401 || status === 403) && !authFailed) authFailed = `${probe.label}：HTTP ${status} ${message}`;
                else failures.push(`${probe.label}：${status ? `HTTP ${status} ` : ""}${message}`);
                continue;
            }
            failures.push(`${probe.label}：${error instanceof Error ? error.message : "查询失败"}`);
        }
    }
    if (authFailed) throw new Error(`余额查询失败：API Key 无效或无权限（${authFailed}）`);
    const detail = failures.length ? `；最近失败：${failures[failures.length - 1]}` : "";
    throw new Error(`未找到可用的余额接口（已尝试 ${probes.length} 个端点）${detail}。可在「查询方式」中改用自定义路径。`);
}
