const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lySpaceDesktop", {
    getUpdateState: () => ipcRenderer.invoke("lyspace:update-state"),
    checkUpdate: () => ipcRenderer.invoke("lyspace:check-update"),
    downloadUpdate: () => ipcRenderer.invoke("lyspace:download-update"),
    pauseUpdateDownload: () => ipcRenderer.invoke("lyspace:pause-update-download"),
    installDownloadedUpdate: () => ipcRenderer.invoke("lyspace:install-downloaded-update"),
    setNativeTheme: (source) => ipcRenderer.invoke("lyspace:set-native-theme", source),
    onUpdateStateChanged: (listener) => {
        const handler = (_event, state) => listener(state);
        ipcRenderer.on("lyspace:update-state-changed", handler);
        return () => ipcRenderer.removeListener("lyspace:update-state-changed", handler);
    },
    getStorageSettings: () => ipcRenderer.invoke("lyspace:storage-settings"),
    chooseStorageDirectory: (kind) => ipcRenderer.invoke("lyspace:choose-storage-directory", kind),
    updateResultDirectory: (directory) => ipcRenderer.invoke("lyspace:update-result-directory", directory),
    stageCacheDirectory: (directory) => ipcRenderer.invoke("lyspace:stage-cache-directory", directory),
    resetStorageDirectory: (kind) => ipcRenderer.invoke("lyspace:reset-storage-directory", kind),
    openStorageDirectory: (directory) => ipcRenderer.invoke("lyspace:open-storage-directory", directory),
    fetchUrl: (url, mediaKind) => ipcRenderer.invoke("lyspace:fetch-url", url, mediaKind),
    copyImageToClipboard: (payload) => ipcRenderer.invoke("lyspace:copy-image-to-clipboard", payload),
    appendAppLog: (entry) => ipcRenderer.invoke("lyspace:append-app-log", entry),
    readAppLogs: (limit) => ipcRenderer.invoke("lyspace:read-app-logs", limit),
    clearAppLogs: () => ipcRenderer.invoke("lyspace:clear-app-logs"),
    getAppLogSettings: () => ipcRenderer.invoke("lyspace:app-log-settings"),
    setAppLogRetention: (days) => ipcRenderer.invoke("lyspace:set-app-log-retention", days),
    openAppLogDirectory: () => ipcRenderer.invoke("lyspace:open-app-log-directory"),
    saveCanvasSnapshot: (projects) => ipcRenderer.invoke("lyspace:canvas-snapshot", projects),
    ensureCanvasSnapshot: (projects) => ipcRenderer.invoke("lyspace:ensure-canvas-snapshot", projects),
    scanCanvasRecovery: (projects) => ipcRenderer.invoke("lyspace:canvas-recovery-scan", projects),
    applyCanvasRecovery: (current, request) => ipcRenderer.invoke("lyspace:canvas-recovery-apply", current, request),
    onCanvasRecoveryProgress: (listener) => {
        const handler = (_event, progress) => listener(progress);
        ipcRenderer.on("lyspace:canvas-recovery-progress", handler);
        return () => ipcRenderer.removeListener("lyspace:canvas-recovery-progress", handler);
    },
    saveFileDialog: (payload) => ipcRenderer.invoke("lyspace:save-file-dialog", payload),
    saveFilesDialog: (payload) => ipcRenderer.invoke("lyspace:save-files-dialog", payload),
    writeGeneratedOutput: (payload) => ipcRenderer.invoke("lyspace:write-generated-output", payload),
    proxyRequest: (payload) => ipcRenderer.invoke("lyspace:proxy-request", payload),
    cancelProxyRequest: (requestId) => ipcRenderer.invoke("lyspace:proxy-request-cancel", requestId),
    proxyStreamRequest: (payload) => ipcRenderer.invoke("lyspace:proxy-stream-request", payload),
    cancelProxyStream: (requestId) => ipcRenderer.invoke("lyspace:proxy-stream-cancel", requestId),
    onProxyStreamEvent: (listener) => {
        const handler = (_event, payload) => listener(payload);
        ipcRenderer.on("lyspace:proxy-stream-event", handler);
        return () => ipcRenderer.removeListener("lyspace:proxy-stream-event", handler);
    },
    deleteGeneratedFiles: (paths) => ipcRenderer.invoke("lyspace:delete-generated-files", paths),
    persistenceFlushed: (requestId, error) => ipcRenderer.invoke("lyspace:persistence-flushed", requestId, error),
    relaunchAfterFlush: () => ipcRenderer.invoke("lyspace:relaunch-after-flush"),
    onFlushPersistence: (listener) => {
        const handler = (_event, request) => listener(request);
        ipcRenderer.on("lyspace:flush-persistence", handler);
        return () => ipcRenderer.removeListener("lyspace:flush-persistence", handler);
    },
    featurePluginsList: () => ipcRenderer.invoke("lyspace:feature-plugins-list"),
    refreshFeaturePlugins: () => ipcRenderer.invoke("lyspace:feature-plugins-refresh"),
    installFeaturePlugin: (id, options) => ipcRenderer.invoke("lyspace:feature-plugins-install", id, options),
    cancelFeaturePluginDownload: () => ipcRenderer.invoke("lyspace:feature-plugins-cancel-download"),
    setFeaturePluginEnabled: (id, enabled) => ipcRenderer.invoke("lyspace:feature-plugins-set-enabled", id, enabled),
    uninstallFeaturePlugin: (id) => ipcRenderer.invoke("lyspace:feature-plugins-uninstall", id),
    getFeaturePluginSource: (id) => ipcRenderer.invoke("lyspace:feature-plugins-source", id),
    probeCodexRuntime: () => ipcRenderer.invoke("lyspace:feature-runtime-probe"),
    chooseCodexRuntime: () => ipcRenderer.invoke("lyspace:feature-runtime-choose"),
    installManagedCodexRuntime: () => ipcRenderer.invoke("lyspace:feature-runtime-install"),
    startAgent: () => ipcRenderer.invoke("lyspace:agent-start"),
    stopAgent: () => ipcRenderer.invoke("lyspace:agent-stop"),
    agentRequest: (payload) => ipcRenderer.invoke("lyspace:agent-request", payload),
    subscribeAgent: (clientId) => ipcRenderer.invoke("lyspace:agent-subscribe", clientId),
    stopAgentEvents: () => ipcRenderer.invoke("lyspace:agent-stop-events"),
    resolveAgentTool: (clientId, payload) => ipcRenderer.invoke("lyspace:agent-tool-result", clientId, payload),
    setRemoteAgentCredentials: (payload) => ipcRenderer.invoke("lyspace:agent-remote-credentials", payload),
    clearRemoteAgentCredentials: () => ipcRenderer.invoke("lyspace:agent-clear-remote-credentials"),
    onFeaturePluginState: (listener) => {
        const handler = (_event, state) => listener(state);
        ipcRenderer.on("lyspace:feature-plugin-state", handler);
        return () => ipcRenderer.removeListener("lyspace:feature-plugin-state", handler);
    },
    onAgentEvent: (listener) => {
        const handler = (_event, payload) => listener(payload);
        ipcRenderer.on("lyspace:agent-event", handler);
        return () => ipcRenderer.removeListener("lyspace:agent-event", handler);
    },
});
