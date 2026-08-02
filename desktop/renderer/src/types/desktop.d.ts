export {};

declare global {
    type AppUpdateStatus = "idle" | "checking" | "available" | "downloading" | "downloaded" | "upToDate" | "error";
    type AppUpdateState = {
        status: AppUpdateStatus;
        version: string;
        releaseDate: string;
        releaseNotes: string;
        progress: { percent: number; bytesPerSecond: number; transferred: number; total: number } | null;
        error: string;
        supported: boolean;
    };
    type StorageKind = "image" | "video" | "audio" | "text";
    type StorageSettings = { resultRoot: string; cacheRoot: string; defaultResultRoot: string; defaultCacheRoot: string; pendingCacheRoot?: string; lastError?: string; folders: Record<StorageKind, string> };
    interface Window {
        lySpaceDesktop?: {
            getUpdateState: () => Promise<AppUpdateState>;
            checkAndDownloadUpdate: () => Promise<AppUpdateState>;
            cancelUpdateDownload: () => Promise<AppUpdateState>;
            installDownloadedUpdate: () => Promise<void>;
            onUpdateStateChanged: (listener: (state: AppUpdateState) => void) => () => void;
            getStorageSettings: () => Promise<StorageSettings>;
            chooseStorageDirectory: (kind: "result" | "cache") => Promise<string>;
            updateResultDirectory: (directory: string) => Promise<StorageSettings>;
            stageCacheDirectory: (directory: string) => Promise<StorageSettings>;
            resetStorageDirectory: (kind: "result" | "cache") => Promise<StorageSettings>;
            openStorageDirectory: (directory: string) => Promise<string>;
            fetchUrl: (url: string) => Promise<{ bytes: ArrayBuffer; mimeType: string }>;
            saveFileDialog: (payload: { title?: string; defaultPath?: string; bytes: ArrayBuffer; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; path: string }>;
            writeGeneratedOutput: (payload: { kind: StorageKind; extension?: string; bytes?: ArrayBuffer; text?: string }) => Promise<{ path: string; name: string }>;
            persistenceFlushed: () => Promise<void>;
            relaunchAfterFlush: () => Promise<void>;
            onFlushPersistence: (listener: () => void) => () => void;
        };
    }
}
