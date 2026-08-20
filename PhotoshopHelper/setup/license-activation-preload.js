const { contextBridge, ipcRenderer } = require('electron');

/**
 * Dedicated preload for the License Activation window.
 */
contextBridge.exposeInMainWorld('activationBridge', {
    // Receive initialization data from the main process
    onInit: (callback) => {
        ipcRenderer.on('activation-init', (event, data) => callback(data));
    },

    // Request verification of a license key
    verifyLicense: (licenseKey) => {
        return ipcRenderer.invoke('activation-verify', licenseKey);
    },

    // Signal that the user wants to close the dialog
    close: () => {
        ipcRenderer.send('activation-close');
    },

    // Open the Gumroad purchase URL in the external browser
    buyLicense: () => {
        ipcRenderer.send('activation-buy');
    },

    // Signal that the lockout countdown has ended and close can be unlocked
    unlockClose: () => {
        ipcRenderer.send('activation-unlock-close');
    }
});
