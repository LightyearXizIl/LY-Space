const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lySpaceDesktop", {
    getAgentConfig: () => ipcRenderer.invoke("lyspace:agent-config"),
    getUpdateState: () => ipcRenderer.invoke("lyspace:update-state"),
    checkAndDownloadUpdate: () => ipcRenderer.invoke("lyspace:check-and-download-update"),
    installDownloadedUpdate: () => ipcRenderer.invoke("lyspace:install-downloaded-update"),
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
    writeGeneratedOutput: (payload) => ipcRenderer.invoke("lyspace:write-generated-output", payload),
    persistenceFlushed: () => ipcRenderer.invoke("lyspace:persistence-flushed"),
    relaunchAfterFlush: () => ipcRenderer.invoke("lyspace:relaunch-after-flush"),
    onFlushPersistence: (listener) => {
        const handler = () => listener();
        ipcRenderer.on("lyspace:flush-persistence", handler);
        return () => ipcRenderer.removeListener("lyspace:flush-persistence", handler);
    },
});
