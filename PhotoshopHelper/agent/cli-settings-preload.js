const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload for the CLI Settings window (Window A).
 *
 * Exposes cliSettingsBridge to the renderer via contextBridge.
 * All calls go straight to the main process over IPC — no HTTP involved.
 */
contextBridge.exposeInMainWorld('cliSettingsBridge', {
    /** Load install status + stored settings for all 4 CLIs. */
    getState: () => ipcRenderer.invoke('cli-settings:get-state'),

    /**
     * Enable or disable a specific CLI.
     * @param {string}  cli
     * @param {boolean} value
     */
    setEnabled: (cli, value) => ipcRenderer.invoke('cli-settings:set-enabled', { cli, value }),

    /**
     * Set the native image generation flag for a specific CLI.
     * @param {string}  cli
     * @param {boolean} value
     */
    setNativeImageGen: (cli, value) => ipcRenderer.invoke('cli-settings:set-native-image-gen', { cli, value }),

    /**
     * Ask the main process to open the Model Config window for a specific CLI.
     * @param {string} cli
     */
    openModelConfig: (cli) => ipcRenderer.invoke('cli-settings:open-model-config', { cli })
});
