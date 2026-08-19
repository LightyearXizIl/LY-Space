import { App, Button, Empty, Input, Popconfirm, Select, Tag } from "antd";
import { Copy, Download, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { saveAs } from "file-saver";

import { logAppEvent } from "@/services/app-logger";

const categoryLabels: Record<AppLogCategory, string> = {
    system: "系统",
    network: "网络/API",
    operation: "操作",
    error: "错误",
};

const levelLabels: Record<AppLogLevel, string> = {
    info: "信息",
    warn: "警告",
    error: "错误",
};

function formatLogEntry(entry: AppLogEntry) {
    return JSON.stringify(entry);
}

function formatTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function AppLogsPanel() {
    const { message } = App.useApp();
    const [logs, setLogs] = useState<AppLogEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [level, setLevel] = useState<AppLogLevel | "all">("all");
    const [category, setCategory] = useState<AppLogCategory | "all">("all");
    const [keyword, setKeyword] = useState("");

    const refresh = async () => {
        if (!window.lySpaceDesktop) return;
        setLoading(true);
        try {
            setLogs(await window.lySpaceDesktop.readAppLogs(1000));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取日志失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void refresh();
    }, []);

    const visibleLogs = useMemo(() => {
        const normalizedKeyword = keyword.trim().toLocaleLowerCase();
        return logs.filter((entry) => {
            if (level !== "all" && entry.level !== level) return false;
            if (category !== "all" && entry.category !== category) return false;
            return !normalizedKeyword || formatLogEntry(entry).toLocaleLowerCase().includes(normalizedKeyword);
        });
    }, [category, keyword, level, logs]);

    const copyLogs = async () => {
        if (!visibleLogs.length) return;
        try {
            await navigator.clipboard.writeText(visibleLogs.map(formatLogEntry).join("\n"));
            message.success("已复制当前日志");
        } catch {
            message.error("复制日志失败");
        }
    };

    const exportLogs = () => {
        if (!visibleLogs.length) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        saveAs(new Blob([visibleLogs.map(formatLogEntry).join("\n") + "\n"], { type: "application/x-ndjson;charset=utf-8" }), `LY-Space-logs-${stamp}.jsonl`);
        logAppEvent({ category: "operation", message: "导出运行日志", details: { count: visibleLogs.length } });
    };

    const clearLogs = async () => {
        if (!window.lySpaceDesktop) return;
        try {
            await window.lySpaceDesktop.clearAppLogs();
            setLogs([]);
            message.success("日志已清空");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "清空日志失败");
        }
    };

    const openLogDirectory = async () => {
        if (!window.lySpaceDesktop) return;
        try {
            const result = await window.lySpaceDesktop.openAppLogDirectory();
            if (result) throw new Error(result);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "打开日志目录失败");
        }
    };

    if (!window.lySpaceDesktop) return <Empty description="运行日志仅在桌面版中可用" />;

    return (
        <div className="space-y-4">
            <div className="text-xs text-stone-500">记录系统运行、网络/API 状态、错误和关键操作。不会写入 API Key、密码、令牌、鉴权头或请求内容。</div>
            <div className="flex flex-wrap items-center gap-2">
                <Select value={category} className="w-28" onChange={(value) => setCategory(value as AppLogCategory | "all")} options={[{ value: "all", label: "全部分类" }, ...Object.entries(categoryLabels).map(([value, label]) => ({ value, label }))]} />
                <Select value={level} className="w-24" onChange={(value) => setLevel(value as AppLogLevel | "all")} options={[{ value: "all", label: "全部级别" }, ...Object.entries(levelLabels).map(([value, label]) => ({ value, label }))]} />
                <Input value={keyword} className="min-w-52 flex-1" allowClear placeholder="筛选日志内容" onChange={(event) => setKeyword(event.target.value)} />
                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>刷新</Button>
                <Button icon={<Copy className="size-4" />} disabled={!visibleLogs.length} onClick={() => void copyLogs()}>复制</Button>
                <Button icon={<Download className="size-4" />} disabled={!visibleLogs.length} onClick={exportLogs}>导出</Button>
                <Button icon={<FolderOpen className="size-4" />} onClick={() => void openLogDirectory()}>打开目录</Button>
                <Popconfirm title="确定清空全部运行日志吗？" description="此操作无法恢复。" okText="清空" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void clearLogs()}>
                    <Button danger icon={<Trash2 className="size-4" />}>清空</Button>
                </Popconfirm>
            </div>
            <div className="text-xs text-stone-500">显示 {visibleLogs.length} / {logs.length} 条，最近记录在前。</div>
            <div className="max-h-[420px] space-y-2 overflow-y-auto rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {!visibleLogs.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={logs.length ? "没有符合筛选条件的日志" : "暂无日志"} /> : visibleLogs.map((entry) => (
                    <div key={entry.id} className="rounded-md bg-stone-50 px-3 py-2 dark:bg-stone-900/60">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="text-stone-500">{formatTime(entry.time)}</span>
                            <Tag color={entry.level === "error" ? "error" : entry.level === "warn" ? "warning" : "blue"}>{levelLabels[entry.level]}</Tag>
                            <Tag>{categoryLabels[entry.category]}</Tag>
                            <span className="font-medium text-stone-800 dark:text-stone-100">{entry.message}</span>
                        </div>
                        {entry.details && Object.keys(entry.details as object).length ? <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-stone-500">{JSON.stringify(entry.details, null, 2)}</pre> : null}
                    </div>
                ))}
            </div>
        </div>
    );
}
