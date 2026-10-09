import { useEffect, useMemo, useState } from "react";
import { Wallet } from "lucide-react";
import { Tooltip } from "antd";

import { fetchChannelBalance, formatBalance, type ChannelBalance } from "@/services/api/balance";
import { canvasThemes } from "@/lib/canvas-theme";
import { resolveModelChannel, useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

const MIN_INTERVAL_MS = 10_000;

/**
 * 画布顶栏的中转站余额徽标：按当前模型所属渠道的余额查询配置定时轮询，点击可手动刷新。
 * 未配置或未启用余额查询时不渲染，保持顶栏极简。
 */
export function ChannelBalanceBadge() {
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const config = useConfigStore((state) => state.config);
    const channel = useMemo(() => resolveModelChannel(config, config.model), [config]);
    const query = channel.balanceQuery;
    const enabled = Boolean(query?.enabled);

    const [balance, setBalance] = useState<ChannelBalance | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [updatedAt, setUpdatedAt] = useState(0);
    const [tick, setTick] = useState(0);

    const intervalMs = Math.max(MIN_INTERVAL_MS, (query?.intervalSec || 60) * 1000);
    // 用渠道关键字段拼依赖，避免 config 对象每次变更都重建轮询。
    const depKey = [channel.id, channel.baseUrl, channel.apiKey, query?.mode, query?.method, query?.authMode, query?.bodyKey, query?.path, query?.field].join("|");

    useEffect(() => {
        if (!enabled || !query) {
            setBalance(null);
            setError("");
            setLoading(false);
            return;
        }
        let cancelled = false;
        const controller = new AbortController();
        const load = async () => {
            setLoading(true);
            try {
                const next = await fetchChannelBalance(channel, query, controller.signal);
                if (cancelled) return;
                setBalance(next);
                setError("");
                setUpdatedAt(Date.now());
            } catch (loadError) {
                if (cancelled) return;
                setError(loadError instanceof Error ? loadError.message : "余额查询失败");
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void load();
        const timer = window.setInterval(() => void load(), intervalMs);
        return () => {
            cancelled = true;
            controller.abort();
            window.clearInterval(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, depKey, intervalMs, tick]);

    if (!enabled) return null;

    const text = balance ? formatBalance(balance) : "—";
    const tooltip = (
        <div className="space-y-0.5">
            <div>{channel.name} 余额</div>
            {balance ? <div>{formatBalance(balance)}</div> : null}
            {updatedAt ? <div>更新于 {new Date(updatedAt).toLocaleTimeString()}</div> : null}
            {error ? <div className="max-w-64 whitespace-pre-wrap">{error}</div> : null}
            <div className="opacity-60">点击刷新</div>
        </div>
    );

    return (
        <Tooltip title={tooltip}>
            <button
                type="button"
                onClick={() => setTick((value) => value + 1)}
                aria-label={`刷新${channel.name}余额`}
                className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs transition hover:bg-black/5 dark:hover:bg-white/10"
                style={{ color: theme.node.text }}
            >
                <Wallet className="size-4" />
                <span className={loading ? "opacity-60" : ""}>{text}</span>
            </button>
        </Tooltip>
    );
}
