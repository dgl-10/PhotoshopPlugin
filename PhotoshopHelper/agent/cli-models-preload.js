const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload for the CLI Model Config window (Window B).
 *
 * Exposes cliModelsBridge to the renderer via contextBridge.
 * The CLI name the window was opened for is injected as a URL hash
 * so no extra IPC round-trip is needed to identify it.
 */
contextBridge.exposeInMainWorld('cliModelsBridge', {
    /**
     * Load stored tier settings + cached model list for a CLI.
     * @param {string} cli
     */
    getState: (cli) => ipcRenderer.invoke('cli-models:get-state', { cli }),

    /**
     * Enable or disable a specific CLI.
     * @param {string}  cli
     * @param {boolean} value
     */
    setEnabled: (cli, value) => ipcRenderer.invoke('cli-models:set-enabled', { cli, value }),

    /**
     * Set the native image generation flag for a specific CLI.
     * @param {string}  cli
     * @param {boolean} value
     */
    setNativeImageGen: (cli, value) => ipcRenderer.invoke('cli-models:set-native-image-gen', { cli, value }),

    /**
     * Save all settings at once (enabled, nativeImageGen, tiers).
     * @param {string} cli
     * @param {{ enabled?: boolean, nativeImageGen?: boolean, tiers?: object }} data
     */
    save: (cli, data) => ipcRenderer.invoke('cli-models:save', { cli, ...data }),

    /**
     * Save all three tiers at once.
     * @param {string} cli
     * @param {{ light, medium, high }} tiers  Each tier: { model, effort }.
     */
    saveTiers: (cli, tiers) => ipcRenderer.invoke('cli-models:save-tiers', { cli, tiers }),

    /**
     * Run the model-list prompt for this CLI and return the refreshed data.
     * The main process handles retries and caching.
     * @param {string} cli
     */
    refreshModels: (cli) => ipcRenderer.invoke('cli-models:refresh-models', { cli })
});
