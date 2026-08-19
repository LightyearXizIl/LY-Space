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
    fetchUrl: (url) => ipcRenderer.invoke("lyspace:fetch-url", url),
    copyImageToClipboard: (payload) => ipcRenderer.invoke("lyspace:copy-image-to-clipboard", payload),
    appendAppLog: (entry) => ipcRenderer.invoke("lyspace:append-app-log", entry),
    readAppLogs: (limit) => ipcRenderer.invoke("lyspace:read-app-logs", limit),
    clearAppLogs: () => ipcRenderer.invoke("lyspace:clear-app-logs"),
    openAppLogDirectory: () => ipcRenderer.invoke("lyspace:open-app-log-directory"),
    saveFileDialog: (payload) => ipcRenderer.invoke("lyspace:save-file-dialog", payload),
    saveFilesDialog: (payload) => ipcRenderer.invoke("lyspace:save-files-dialog", payload),
    writeGeneratedOutput: (payload) => ipcRenderer.invoke("lyspace:write-generated-output", payload),
    uploadFreeHost: (payload) => ipcRenderer.invoke("lyspace:upload-free-host", payload),
    proxyRequest: (payload) => ipcRenderer.invoke("lyspace:proxy-request", payload),
    deleteGeneratedFiles: (paths) => ipcRenderer.invoke("lyspace:delete-generated-files", paths),
    persistenceFlushed: (requestId) => ipcRenderer.invoke("lyspace:persistence-flushed", requestId),
    relaunchAfterFlush: () => ipcRenderer.invoke("lyspace:relaunch-after-flush"),
    onFlushPersistence: (listener) => {
        const handler = (_event, request) => listener(request);
        ipcRenderer.on("lyspace:flush-persistence", handler);
        return () => ipcRenderer.removeListener("lyspace:flush-persistence", handler);
    },
});
