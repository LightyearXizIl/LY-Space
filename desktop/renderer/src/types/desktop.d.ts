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
    type AppLogLevel = "info" | "warn" | "error";
    type AppLogCategory = "system" | "network" | "operation" | "error";
    type AppLogEntry = { id: string; time: string; level: AppLogLevel; category: AppLogCategory; message: string; details?: unknown };
    type AppLogSettings = { retentionDays: 7 | 14 | 30 };
    type CanvasRecoveryCandidate = { id: string; source: string; createdAt: string; missing: number; projects: unknown[]; config?: { config?: unknown; webdav?: unknown } | null };
    type FeaturePluginStatus = "ready" | "disabled" | "update-available" | "incompatible" | "repair";
    type FeaturePluginAsset = { path: string; url: string; size: number; sha256: string };
    type FeaturePluginManifest = { schemaVersion: 1; id: "agent-core" | "skill-manager"; name: string; description: string; version: string; minAppVersion: string; protocolVersion: string; hostApiVersion?: string; permissions: string[]; dependencies: Array<{ id: "agent-core" | "skill-manager"; range: string }>; rendererEntry: string; serviceEntry?: string; assets: FeaturePluginAsset[]; runtime?: { versionRange: string; version: string; entry: string; asset: FeaturePluginAsset; format: "file" | "tar" } | null; serviceArchive?: { schemaVersion: number; format: "tar.gz"; platform: "win32"; arch: "x64"; root: string; asset: FeaturePluginAsset; tree: { path: string; sha256: string; fileCount: number; totalBytes: number } } | null };
    type InstalledFeaturePlugin = { id: "agent-core" | "skill-manager"; name: string; version: string; enabled: boolean; status: FeaturePluginStatus; installedAt: string; error: string; manifest: FeaturePluginManifest };
    type FeaturePluginState = { catalog: FeaturePluginManifest[]; plugins: InstalledFeaturePlugin[]; runtime: { source?: "system" | "manual" | "managed"; path?: string; version?: string; checkedAt?: string }; remoteAgent: { url: string; configured: boolean } | null; downloading: { id: string; received: number; total: number; stage: string } | null };
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
            fetchUrl: (url: string, mediaKind?: "image" | "video" | "audio") => Promise<{ bytes: ArrayBuffer; mimeType: string }>;
            copyImageToClipboard: (payload: { bytes: ArrayBuffer; mimeType?: string }) => Promise<{ width: number; height: number }>;
            appendAppLog: (entry: Omit<AppLogEntry, "id">) => Promise<void>;
            readAppLogs: (limit?: number) => Promise<AppLogEntry[]>;
            clearAppLogs: () => Promise<void>;
            getAppLogSettings: () => Promise<AppLogSettings>;
            setAppLogRetention: (days: 7 | 14 | 30) => Promise<AppLogSettings>;
            openAppLogDirectory: () => Promise<string>;
            saveCanvasSnapshot: (projects: unknown[]) => Promise<string>;
            ensureCanvasSnapshot: (projects: unknown[]) => Promise<string | null>;
            getCanvasRecoveryCandidates: (projects: unknown[]) => Promise<CanvasRecoveryCandidate[]>;
            recoverCanvasProjects: (current: unknown[], recovered: unknown[]) => Promise<unknown[]>;
            saveFileDialog: (payload: { title?: string; defaultPath?: string; bytes: ArrayBuffer; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; path: string }>;
            saveFilesDialog: (payload: { title?: string; files: Array<{ name: string; bytes: ArrayBuffer }>; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ canceled: boolean; paths: string[] }>;
            writeGeneratedOutput: (payload: { kind: StorageKind; extension?: string; bytes?: ArrayBuffer; text?: string }) => Promise<{ path: string; name: string }>;
            proxyRequest: (payload: { method?: string; url: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; data: string }>;
            deleteGeneratedFiles: (paths: string[]) => Promise<{ deleted: number; missing: number; failed: number; skipped: number }>;
            persistenceFlushed: (requestId: string) => Promise<{ accepted: boolean }>;
            relaunchAfterFlush: () => Promise<void>;
            onFlushPersistence: (listener: (request: { id: string; action: "install" | "quit" | "relaunch" }) => void) => () => void;
            featurePluginsList: () => Promise<FeaturePluginState>;
            refreshFeaturePlugins: () => Promise<FeaturePluginState>;
            installFeaturePlugin: (id: "agent-core" | "skill-manager", options?: { withDependencies?: boolean }) => Promise<FeaturePluginState | { needsDependencies: Array<{ id: "agent-core" | "skill-manager"; range: string }>; state: FeaturePluginState }>;
            cancelFeaturePluginDownload: () => Promise<FeaturePluginState>;
            setFeaturePluginEnabled: (id: "agent-core" | "skill-manager", enabled: boolean) => Promise<FeaturePluginState>;
            uninstallFeaturePlugin: (id: "agent-core" | "skill-manager") => Promise<FeaturePluginState>;
            getFeaturePluginSource: (id: "agent-core" | "skill-manager") => Promise<string>;
            probeCodexRuntime: () => Promise<{ candidates: Array<{ path: string; available: boolean; version: string; error: string }>; compatible: { path: string; available: boolean; version: string; error: string } | null; state: FeaturePluginState }>;
            chooseCodexRuntime: () => Promise<FeaturePluginState>;
            installManagedCodexRuntime: () => Promise<FeaturePluginState>;
            startAgent: () => Promise<{ url: string }>;
            stopAgent: () => Promise<void>;
            agentRequest: (payload: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown }) => Promise<unknown>;
            subscribeAgent: (clientId: string) => Promise<{ connected: boolean }>;
            stopAgentEvents: () => Promise<void>;
            resolveAgentTool: (clientId: string, payload: { requestId: string; result?: unknown; error?: string }) => Promise<unknown>;
            setRemoteAgentCredentials: (payload: { url: string; token: string }) => Promise<FeaturePluginState>;
            clearRemoteAgentCredentials: () => Promise<FeaturePluginState>;
            onFeaturePluginState: (listener: (state: FeaturePluginState) => void) => () => void;
            onAgentEvent: (listener: (payload: { clientId: string; event: string; data: unknown }) => void) => () => void;
        };
    }
}
