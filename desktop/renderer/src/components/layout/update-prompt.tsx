import { useEffect, useRef } from "react";
import { App } from "antd";

// 全局自动更新提示：启动/状态变化时发现新版本或下载完成即弹窗，同一版本只提示一次
export function UpdatePrompt() {
    const { modal } = App.useApp();
    const promptedVersionRef = useRef("");

    useEffect(() => {
        if (!window.lySpaceDesktop) return;
        const handleState = (state: AppUpdateState) => {
            const version = state.version;
            if (!version || promptedVersionRef.current === version) return;
            if (state.status === "available") {
                promptedVersionRef.current = version;
                modal.confirm({
                    title: "发现新版本",
                    content: `LY Space ${version} 已发布，是否现在下载更新？`,
                    okText: "下载更新",
                    cancelText: "稍后",
                    onOk: () => void window.lySpaceDesktop?.checkAndDownloadUpdate(),
                });
            } else if (state.status === "downloaded") {
                promptedVersionRef.current = version;
                modal.confirm({
                    title: "更新已就绪",
                    content: `${version} 已下载完成，是否立即重启并安装？`,
                    okText: "重启并安装",
                    cancelText: "稍后",
                    onOk: () => void window.lySpaceDesktop?.installDownloadedUpdate(),
                });
            }
        };
        void window.lySpaceDesktop.getUpdateState().then(handleState).catch(() => undefined);
        return window.lySpaceDesktop.onUpdateStateChanged(handleState);
    }, [modal]);

    return null;
}
