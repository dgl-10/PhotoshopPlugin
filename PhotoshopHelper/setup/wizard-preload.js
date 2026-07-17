const { contextBridge, ipcRenderer } = require('electron');

/**
 * Dedicated preload for the First-Run Wizard window.
 * Kept separate from the main preload.js to avoid polluting the drag-window API.
 */
contextBridge.exposeInMainWorld('wizardBridge', {
    // Receive initialization data (paths) from the main process
    onInit: (callback) => {
        ipcRenderer.on('wizard-init', (event, data) => callback(data));
    },

    // Request Explorer/Finder to reveal the settings folder
    openSettingsFolder: (userDataPath, fileName) => {
        ipcRenderer.send('wizard-open-settings', userDataPath, fileName);
    },

    // Signal that the user has completed setup
    complete: () => {
        ipcRenderer.send('wizard-complete');
    },

    // Relaunch the application
    relaunch: () => {
        ipcRenderer.send('wizard-relaunch');
    }
});
