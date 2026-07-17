const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('electron', {
    // Start native drag operation (uses files stored in main process)
    startDrag: () => {
        ipcRenderer.send('start-drag');
    },

    // Notify main process that drag is complete
    dragComplete: () => {
        ipcRenderer.send('drag-complete');
    },

    // Listen for images info from main process
    onSetImages: (callback) => {
        ipcRenderer.on('set-images', (event, data) => {
            callback(data);
        });
    }
});
