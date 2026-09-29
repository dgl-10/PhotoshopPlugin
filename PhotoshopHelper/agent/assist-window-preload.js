const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload for the AI Assist window.
 *
 * Everything the page needs comes from here, straight to the main process's agent service —
 * never over HTTP, so this window cannot be opened from a browser or a tunnel.
 */
contextBridge.exposeInMainWorld('assistBridge', {
    getState: () => ipcRenderer.invoke('agent-assist:get-state'),
    stop: () => ipcRenderer.invoke('agent-assist:stop'),
    getSetup: () => ipcRenderer.invoke('agent-assist:get-setup'),
    copyText: (text) => ipcRenderer.invoke('agent-assist:copy-text', text),
    getCliConfig: () => ipcRenderer.invoke('agent-assist:get-cli-config'),
    openCliSettings: (cli) => ipcRenderer.invoke('agent-assist:open-cli-settings', { cli }),

    // Fired when the tray menu or the plugin's line asks for a specific section, most often
    // 'connect' right after opening the window.
    onShowSection: (callback) => {
        ipcRenderer.on('assist-show-section', (event, section) => callback(section));
    }
});
