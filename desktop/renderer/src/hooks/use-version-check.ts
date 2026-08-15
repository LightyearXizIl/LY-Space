import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { APP_VERSION } from "@/constant/env";
import { normalizeReleaseVersion, parseChangelog, sortReleases, type ReleaseInfo } from "@/lib/release";

const releaseChangelogUrl = (version: string) => `https://raw.githubusercontent.com/LightyearXizIl/LY-Space/${version.startsWith("v") ? version : `v${version}`}/CHANGELOG.md`;

function readLocalReleases(): ReleaseInfo[] {
    return sortReleases(__APP_RELEASES__ || []);
}

function initialUpdateState(): AppUpdateState {
    return { status: "idle", version: APP_VERSION, releaseDate: "", releaseNotes: "", progress: null, error: "", supported: Boolean(window.lySpaceDesktop), triggeredBy: "" };
}

export function useVersionCheck() {
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const [open, setOpen] = useState(false);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [updateState, setUpdateState] = useState<AppUpdateState>(initialUpdateState);
    const hasNewVersion = ["available", "downloading", "paused", "downloaded", "installing"].includes(updateState.status);

    useEffect(() => {
        if (!window.lySpaceDesktop) return;
        void window.lySpaceDesktop.getUpdateState().then(setUpdateState).catch(() => undefined);
        return window.lySpaceDesktop.onUpdateStateChanged(setUpdateState);
    }, []);

    useEffect(() => {
        const version = updateState.version;
        if (!version || !/^v?\d+\.\d+\.\d+$/.test(version)) return;
        // 本地 __APP_RELEASES__ 已有该版本日志则无需拉取（含更新完成后的当前版本场景）
        if (localReleases.some((release) => release.version === normalizeReleaseVersion(version))) return;
        let active = true;
        void fetch(releaseChangelogUrl(version))
            .then((response) => (response.ok ? response.text() : Promise.reject(new Error("更新日志读取失败"))))
            .then((content) => {
                if (active) setReleases(sortReleases(parseChangelog(content)));
            })
            .catch(() => {
                if (!active) return;
                // 远程 CHANGELOG 拉取失败时，回退用主进程提供的 Release 说明（GitHub Release body，即本版本 CHANGELOG 段落）
                const notes = updateState.releaseNotes ? parseChangelog(updateState.releaseNotes) : [];
                setReleases(notes.length ? sortReleases(notes) : localReleases);
            });
        return () => {
            active = false;
        };
    }, [localReleases, updateState.releaseNotes, updateState.version]);

    const checkUpdate = useCallback(async () => {
        if (!window.lySpaceDesktop) return;
        try {
            setUpdateState(await window.lySpaceDesktop.checkUpdate());
        } catch {
            message.error("检查更新失败，请稍后重试");
        }
    }, [message]);

    const downloadUpdate = useCallback(async () => {
        if (!window.lySpaceDesktop) return;
        try {
            setUpdateState(await window.lySpaceDesktop.downloadUpdate());
        } catch {
            message.error("下载更新失败，请稍后重试");
        }
    }, [message]);

    const installDownloadedUpdate = useCallback(async () => {
        if (!window.lySpaceDesktop) return;
        try {
            await window.lySpaceDesktop.installDownloadedUpdate();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "无法启动安装程序，请重试");
        }
    }, [message]);

    const pauseUpdateDownload = useCallback(async () => {
        if (!window.lySpaceDesktop) return;
        try {
            setUpdateState(await window.lySpaceDesktop.pauseUpdateDownload());
        } catch {
            // 暂停失败可忽略，状态会通过事件流更新
        }
    }, []);

    return { open, setOpen, updateState, releases, hasNewVersion, checkUpdate, downloadUpdate, pauseUpdateDownload, installDownloadedUpdate };
}
