import type { CSSProperties } from "react";
import { Alert, Modal, Progress, Tag, Timeline } from "antd";
import { useVersionCheck } from "@/hooks/use-version-check";
import { APP_VERSION } from "@/constant/env";

const releasePageUrl = "https://github.com/LightyearXizIl/LY-Space/releases/latest";

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

type VersionReleaseModalProps = { className?: string; style?: CSSProperties };

export function VersionReleaseModal({ className, style }: VersionReleaseModalProps) {
    const { open, setOpen, updateState, releases, hasNewVersion, checkAndDownloadUpdate, installDownloadedUpdate } = useVersionCheck();
    const checking = updateState.status === "checking";
    const downloading = updateState.status === "downloading";
    const downloaded = updateState.status === "downloaded";
    const progress = updateState.progress;
    const latestVersion = updateState.version || APP_VERSION;

    return (
        <>
            <button type="button" className={className || "shrink-0 cursor-pointer text-xs font-medium text-stone-500 transition hover:text-stone-950 dark:text-stone-400 dark:hover:text-white"} style={style} onClick={() => setOpen(true)} title="查看版本更新">
                <span className="relative inline-flex">
                    {APP_VERSION}
                    {hasNewVersion ? <span className="absolute -right-1.5 -top-1 size-1.5 rounded-full bg-green-500" /> : null}
                </span>
            </button>
            <Modal title="版本更新" open={open} width={680} centered footer={null} onCancel={() => setOpen(false)}>
                <div className="mb-5 grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs text-stone-500 dark:text-stone-400">当前版本</div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{APP_VERSION}</div>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="flex items-center justify-between gap-3">
                            <div className="text-xs text-stone-500 dark:text-stone-400">最新版本</div>
                            <button type="button" className="cursor-pointer bg-transparent p-0 text-[11px] font-normal text-stone-400 underline-offset-2 transition hover:text-stone-700 hover:underline disabled:cursor-not-allowed disabled:no-underline dark:text-stone-500 dark:hover:text-stone-300" disabled={!updateState.supported || checking || downloading || downloaded} onClick={() => void checkAndDownloadUpdate()}>
                                {checking ? "检查中..." : downloading ? "下载中..." : downloaded ? "已下载" : "检查更新"}
                            </button>
                        </div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{latestVersion}</div>
                    </div>
                </div>

                {!updateState.supported ? <Alert className="mb-4" type="info" showIcon message="本地开发模式不会连接正式更新服务。" /> : null}
                {updateState.status === "upToDate" ? <Alert className="mb-4" type="success" showIcon message="已是最新版本" /> : null}
                {updateState.status === "available" ? <Alert className="mb-4" type="info" showIcon message={`发现 ${latestVersion}，点击“检查更新”即可开始下载。`} /> : null}
                {downloading ? <div className="mb-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800"><div className="mb-2 flex justify-between text-xs text-stone-500 dark:text-stone-400"><span>正在下载 {latestVersion}</span><span>{formatBytes(progress?.transferred)} / {formatBytes(progress?.total)} · {formatBytes(progress?.bytesPerSecond)}/s</span></div><Progress percent={Math.round(progress?.percent || 0)} size="small" /></div> : null}
                {downloaded ? <Alert className="mb-4" type="success" showIcon message={`${latestVersion} 已下载完成`} description={<button type="button" className="mt-2 cursor-pointer rounded-md bg-stone-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-950" onClick={() => void installDownloadedUpdate()}>重启并安装</button>} /> : null}
                {updateState.status === "error" ? <Alert className="mb-4" type="error" showIcon message="更新失败" description={<div className="space-y-2"><div>{updateState.error || "无法连接更新服务"}</div><div className="flex gap-3"><button type="button" className="cursor-pointer bg-transparent p-0 text-xs text-stone-500 underline hover:text-stone-950 dark:hover:text-white" onClick={() => void checkAndDownloadUpdate()}>重试</button><a className="text-xs text-stone-500 underline hover:text-stone-950 dark:hover:text-white" href={releasePageUrl} target="_blank" rel="noreferrer">前往发布页下载</a></div></div>} /> : null}

                <div className="max-h-[46vh] overflow-y-auto pr-2">
                    <Timeline items={releases.map((release) => ({ content: <div><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{release.version}</span><span className="text-xs text-stone-500 dark:text-stone-400">{release.date}</span><div className="flex min-w-0 items-center gap-1.5">{release.version === latestVersion ? <Tag color="green">最新</Tag> : null}{release.version === APP_VERSION ? <Tag>当前</Tag> : null}</div></div><div className="mt-2 space-y-1.5">{release.items.map((item, index) => <div key={`${release.version}-${index}`} className="flex items-start gap-2 text-sm leading-6 text-stone-700 dark:text-stone-300"><Tag color={getTagColor(item.type)} className="m-0 mt-0.5 shrink-0 whitespace-nowrap">{item.type}</Tag><span className="min-w-0 flex-1">{item.content}</span></div>)}</div></div> }))} />
                </div>
            </Modal>
        </>
    );
}
