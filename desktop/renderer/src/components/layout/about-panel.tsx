import { Alert, Button, Progress, Tag, Timeline } from "antd";
import { Download, ExternalLink, Globe, Info, RefreshCw, User } from "lucide-react";
import { useVersionCheck } from "@/hooks/use-version-check";
import { APP_VERSION } from "@/constant/env";

const githubUrl = "https://github.com/LightyearXizIl/LY-Space";

const TECH_STACK = [
    { name: "Electron", version: "43" },
    { name: "React", version: "19.2" },
    { name: "Vite", version: "7.3" },
    { name: "TypeScript", version: "5" },
    { name: "Ant Design", version: "6.4" },
    { name: "Tailwind CSS", version: "4" },
    { name: "Zustand", version: "5.0" },
    { name: "three.js", version: "0.184" },
];

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

export function AboutPanel() {
    const { updateState, releases, checkUpdate, downloadUpdate, cancelUpdateDownload, installDownloadedUpdate } = useVersionCheck();
    const checking = updateState.status === "checking";
    const downloading = updateState.status === "downloading";
    const downloaded = updateState.status === "downloaded";
    const progress = updateState.progress;
    const latestVersion = updateState.version || APP_VERSION;

    return (
        <div className="space-y-5">
            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="flex items-center gap-3">
                    <svg width="44" height="44" viewBox="0 0 64 64" fill="currentColor" className="size-11 shrink-0 text-stone-950 dark:text-stone-100" aria-label="LY Space logo">
                        <path d="M32 8L58 54H46L32 29L18 54H6L32 8Z" />
                        <path d="M32 40L40 54H24L32 40Z" />
                    </svg>
                    <div>
                        <div className="text-lg font-semibold text-stone-950 dark:text-stone-100">LY Space</div>
                        <div className="text-xs text-stone-500 dark:text-stone-400">当前版本 {APP_VERSION}</div>
                    </div>
                </div>
                <p className="mt-3 text-sm leading-6 text-stone-600 dark:text-stone-300">在无限画布中生成、连接和重组灵感，让创作从单次生成变成连续推演。</p>
            </section>

            <section className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                        <User className="size-4" />
                        作者与维护
                    </div>
                    <div className="space-y-2 text-sm text-stone-600 dark:text-stone-300">
                        <div>作者：Light year</div>
                        <div className="flex items-center gap-1.5">微信号：XizllHZ_007</div>
                    </div>
                </div>
                <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                        <Globe className="size-4" />
                        项目主页
                    </div>
                    <button type="button" className="inline-flex items-center gap-1.5 cursor-pointer bg-transparent p-0 text-sm text-blue-600 underline-offset-2 hover:underline dark:text-blue-400" onClick={() => window.open(githubUrl, "_blank")}>
                        {githubUrl}
                        <ExternalLink className="size-3.5" />
                    </button>
                    <div className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">源码、更新与发布记录都可在 GitHub 查看。</div>
                </div>
            </section>

            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                    <Info className="size-4" />
                    技术栈
                </div>
                <div className="flex flex-wrap gap-2">
                    {TECH_STACK.map((item) => (
                        <Tag key={item.name} className="m-0">
                            {item.name} {item.version}
                        </Tag>
                    ))}
                </div>
            </section>

            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold">版本更新</div>
                    <div className="flex items-center gap-2">
                        <Button icon={<RefreshCw className="size-4" />} disabled={!updateState.supported || checking || downloading || downloaded} onClick={() => void checkUpdate()}>
                            {checking ? "检查中..." : downloading ? "正在下载..." : downloaded ? "已下载" : "检查更新"}
                        </Button>
                        {downloading ? <Button danger onClick={() => void cancelUpdateDownload()}>取消下载</Button> : null}
                    </div>
                </div>
                <div className="mb-3 grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs text-stone-500 dark:text-stone-400">当前版本</div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{APP_VERSION}</div>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="text-xs text-stone-500 dark:text-stone-400">最新版本</div>
                        <div className="mt-1 text-base font-semibold text-stone-950 dark:text-stone-100">{latestVersion}</div>
                    </div>
                </div>

                {!updateState.supported ? <Alert className="mb-3" type="info" showIcon message="本地开发模式不会连接正式更新服务。" /> : null}
                {updateState.status === "upToDate" ? <Alert className="mb-3" type="success" showIcon message="已是最新版本" /> : null}
                {updateState.status === "available" ? (
                    <Alert
                        className="mb-3"
                        type="info"
                        showIcon
                        message={`发现新版本 ${latestVersion}`}
                        description={
                            <Button size="small" type="primary" icon={<Download className="size-3.5" />} className="mt-2" onClick={() => void downloadUpdate()}>
                                下载更新
                            </Button>
                        }
                    />
                ) : null}
                {downloading ? (
                    <div className="mb-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <div className="mb-2 flex justify-between text-xs text-stone-500 dark:text-stone-400">
                            <span>正在下载 {latestVersion}</span>
                            <span>
                                {formatBytes(progress?.transferred)} / {formatBytes(progress?.total)} · {formatBytes(progress?.bytesPerSecond)}/s
                            </span>
                        </div>
                        <Progress percent={Math.round(progress?.percent || 0)} size="small" />
                    </div>
                ) : null}
                {downloaded ? (
                    <Alert
                        className="mb-3"
                        type="success"
                        showIcon
                        message={`${latestVersion} 已下载完成`}
                        description={
                            <Button size="small" className="mt-2" onClick={() => void installDownloadedUpdate()}>
                                重启并安装
                            </Button>
                        }
                    />
                ) : null}
                {updateState.status === "error" ? (
                    <Alert
                        className="mb-3"
                        type="error"
                        showIcon
                        message="更新失败"
                        description={
                            <div className="space-y-2">
                                <div>{updateState.error || "无法连接更新服务"}</div>
                                <button type="button" className="cursor-pointer bg-transparent p-0 text-xs text-stone-500 underline hover:text-stone-950 dark:hover:text-white" onClick={() => void checkUpdate()}>
                                    重试
                                </button>
                            </div>
                        }
                    />
                ) : null}

                <div className="max-h-[40vh] overflow-y-auto pr-2">
                    <Timeline
                        items={releases.slice(0, 1).map((release) => ({
                            content: (
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">{release.version}</span>
                                        <span className="text-xs text-stone-500 dark:text-stone-400">{release.date}</span>
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {release.version === latestVersion ? <Tag color="green">最新</Tag> : null}
                                            {release.version === APP_VERSION ? <Tag>当前</Tag> : null}
                                        </div>
                                    </div>
                                    <div className="mt-2 space-y-1.5">
                                        {release.items.map((item, index) => (
                                            <div key={`${release.version}-${index}`} className="flex items-start gap-2 text-sm leading-6 text-stone-700 dark:text-stone-300">
                                                <Tag color={getTagColor(item.type)} className="m-0 mt-0.5 shrink-0 whitespace-nowrap">
                                                    {item.type}
                                                </Tag>
                                                <span className="min-w-0 flex-1">{item.content}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ),
                        }))}
                    />
                </div>
            </section>
        </div>
    );
}
