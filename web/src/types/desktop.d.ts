export {};

declare global {
    type StorageKind = "image" | "video" | "audio" | "text";
    type StorageSettings = { resultRoot: string; cacheRoot: string; defaultResultRoot: string; defaultCacheRoot: string; pendingCacheRoot?: string; lastError?: string; folders: Record<StorageKind, string> };
    interface Window {
        lySpaceDesktop?: {
            getAgentConfig: () => Promise<{ url: string; token: string; status: "ready" | "error"; error?: string }>;
            getStorageSettings: () => Promise<StorageSettings>;
            chooseStorageDirectory: (kind: "result" | "cache") => Promise<string>;
            updateResultDirectory: (directory: string) => Promise<StorageSettings>;
            stageCacheDirectory: (directory: string) => Promise<StorageSettings>;
            resetStorageDirectory: (kind: "result" | "cache") => Promise<StorageSettings>;
            openStorageDirectory: (directory: string) => Promise<string>;
            writeGeneratedOutput: (payload: { kind: StorageKind; extension?: string; bytes?: ArrayBuffer; text?: string }) => Promise<{ path: string; name: string }>;
            persistenceFlushed: () => Promise<void>;
            relaunchAfterFlush: () => Promise<void>;
            onFlushPersistence: (listener: () => void) => () => void;
        };
    }
}
