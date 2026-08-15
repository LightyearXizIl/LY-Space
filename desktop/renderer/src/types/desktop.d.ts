export {};

declare global {
    type AppUpdateStatus = "idle" | "checking" | "available" | "downloading" | "paused" | "downloaded" | "installing" | "upToDate" | "error";
    type AppUpdateState = {
        status: AppUpdateStatus;
        version: string;
        releaseDate: string;
        releaseNotes: string;
        progress: { percent: number; bytesPerSecond: number; transferred: number; total: number } | null;
        error: string;
        supported: boolean;
        /** 检查更新的来源：启动自动检查为 "auto"（弹窗提醒），关于页手动检查为 "manual"（不弹窗） */
        triggeredBy: "auto" | "manual" | "";
    };
    type StorageKind = "image" | "video" | "audio" | "text";
    type StorageSettings = { resultRoot: string; cacheRoot: string; defaultResultRoot: string; defaultCacheRoot: string; pendingCacheRoot?: string; lastError?: string; folders: Record<StorageKind, string> };
    interface Window {
        lySpaceDesktop?: {
            getUpdateState: () => Promise<AppUpdateState>;
            checkUpdate: () => Promise<AppUpdateState>;
            downloadUpdate: () => Promise<AppUpdateState>;
            pauseUpdateDownload: () => Promise<AppUpdateState>;
            installDownloadedUpdate: () => Promise<void>;
            setNativeTheme: (source: "dark" | "light") => Promise<void>;
            onUpdateStateChanged: (listener: (state: AppUpdateState) => void) => () => void;
            getStorageSettings: () => Promise<StorageSettings>;
            chooseStorageDirectory: (kind: "result" | "cache") => Promise<string>;
            updateResultDirectory: (directory: string) => Promise<StorageSettings>;
            stageCacheDirectory: (directory: string) => Promise<StorageSettings>;
            resetStorageDirectory: (kind: "result" | "cache") => Promise<StorageSettings>;
            openStorageDirectory: (directory: string) => Promise<string>;
            fetchUrl: (url: string) => Promise<{ bytes: ArrayBuffer; mimeType: string }>;
            saveFileDialog: (payload: { title?: string; defaultPath?: string; bytes: ArrayBuffer; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; path: string }>;
            saveFilesDialog: (payload: { title?: string; files: Array<{ name: string; bytes: ArrayBuffer }>; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; paths: string[] }>;
            writeGeneratedOutput: (payload: { kind: StorageKind; extension?: string; bytes?: ArrayBuffer; text?: string }) => Promise<{ path: string; name: string }>;
            uploadFreeHost: (payload: { name?: string; mimeType?: string; bytes: ArrayBuffer }) => Promise<{ url: string }>;
            proxyRequest: (payload: { method?: string; url: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; data: string }>;
            deleteGeneratedFiles: (paths: string[]) => Promise<{ deleted: number; missing: number; failed: number; skipped: number }>;
            persistenceFlushed: (requestId: string) => Promise<{ accepted: boolean }>;
            relaunchAfterFlush: () => Promise<void>;
            onFlushPersistence: (listener: (request: { id: string; action: "install" | "quit" }) => void) => () => void;
        };
    }
}
