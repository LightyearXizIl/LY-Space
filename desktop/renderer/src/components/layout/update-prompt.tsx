import { useEffect, useRef, useState } from "react";
import { Button, Modal, Progress, Tag } from "antd";

import { parseChangelog, type ReleaseInfo } from "@/lib/release";

function getTagColor(type: string) {
    if (type === "新增") return "green";
    if (type === "修复") return "red";
    if (type === "调整") return "blue";
    if (type === "优化") return "cyan";
    if (type === "文档") return "purple";
    return "default";
}

function formatBytes(value?: number) {
    if (!value) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

// 启动自动检查发现新版本时弹窗提醒（正中心，含更新日志，可直接下载）；关于页手动检查（triggeredBy=manual）不弹窗
export function UpdatePrompt() {
    const [state, setState] = useState<AppUpdateState | null>(null);
    const [release, setRelease] = useState<ReleaseInfo | null>(null);
    const promptedVersionRef = useRef("");

    useEffect(() => {
        if (!window.lySpaceDesktop) return;
        const handleState = (next: AppUpdateState) => {
            setState(next);
            if (next.status === "available") {
                // 解析更新日志（主进程提供的 GitHub Release 说明，即本版本 CHANGELOG 段落）
                const parsed = next.releaseNotes ? parseChangelog(next.releaseNotes) : [];
                const latest = parsed[0];
                if (latest && latest.version !== promptedVersionRef.current) {
                    promptedVersionRef.current = latest.version;
                    setRelease(latest);
                } else if (latest) {
                    setRelease(latest);
                }
            }
        };
        void window.lySpaceDesktop.getUpdateState().then(handleState).catch(() => undefined);
        return window.lySpaceDesktop.onUpdateStateChanged(handleState);
    }, []);

    const visible = Boolean(state && state.status === "available" && state.triggeredBy === "auto" && release);
    const downloading = state?.status === "downloading";
    const downloaded = state?.status === "downloaded";
    const progress = state?.progress;

    return (
        <Modal
            title="发现新版本"
            open={visible || (downloading && Boolean(release)) || (downloaded && Boolean(release))}
            footer={null}
            onCancel={() => setRelease(null)}
            centered
            width={520}
        >
            {release ? (
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-lg font-semibold">LY Space {release.version}</span>
                        {release.date ? <span className="text-xs text-stone-500">{release.date}</span> : null}
                        <Tag color="green">最新</Tag>
                    </div>
                    <div className="max-h-[36vh] space-y-1.5 overflow-y-auto pr-2">
                        {release.items.map((item, index) => (
                            <div key={index} className="flex items-start gap-2 text-sm leading-6">
                                <Tag color={getTagColor(item.type)} className="m-0 mt-0.5 shrink-0 whitespace-nowrap">
                                    {item.type}
                                </Tag>
                                <span className="min-w-0 flex-1">{item.content}</span>
                            </div>
                        ))}
                    </div>
                    {downloading ? (
                        <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
                            <div className="mb-2 flex justify-between text-xs text-stone-500">
                                <span>正在下载 {state?.version}</span>
                                <span>
                                    {formatBytes(progress?.transferred)} / {formatBytes(progress?.total)} · {formatBytes(progress?.bytesPerSecond)}/s
                                </span>
                            </div>
                            <Progress percent={Math.round(progress?.percent || 0)} size="small" />
                        </div>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        {downloaded ? (
                            <Button type="primary" onClick={() => void window.lySpaceDesktop?.installDownloadedUpdate()}>
                                重启并安装
                            </Button>
                        ) : (
                            <>
                                <Button onClick={() => setRelease(null)}>稍后</Button>
                                <Button type="primary" loading={downloading} disabled={downloading} onClick={() => void window.lySpaceDesktop?.downloadUpdate()}>
                                    下载更新
                                </Button>
                            </>
                        )}
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}
