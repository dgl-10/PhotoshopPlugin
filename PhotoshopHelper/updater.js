const { app, dialog, shell } = require('electron');
const packageJson = require('./package.json');

let autoUpdater = null;
let updaterLogger = console;
let updateCheckInterval = null;
const CHECK_INTERVAL = 12 * 60 * 60 * 1000;
const TRANSIENT_STATUS_DURATION = 5000;
let updateStatus = {
    state: 'idle', // 'idle', 'checking', 'no-update', 'available', 'downloading', 'ready', 'cancelled', 'error'
    version: null,
    error: null,
    lastChecked: null // Date object of the last update check
};


function getUpdateStatus() {
    return updateStatus;
}

function getUpdateAlert(clientPluginVersion = null) {
    let photoshopPlugin = null;
    let photoshopHelper = null;

    // Check 1: Plugin version mismatch
    const requiredPluginVersion = packageJson['ps-plugin-version'];
    if (clientPluginVersion && clientPluginVersion !== requiredPluginVersion) {
        if (process.platform === 'darwin') {
            photoshopPlugin = "Plugin version mismatch. Please click the PhotoshopHelper icon in the menu bar, select 'Settings', and reinstall the plugin.";
        } else {
            photoshopPlugin = "Plugin version mismatch. Please right-click the PhotoshopHelper icon in the system tray, select 'Settings', and reinstall the plugin.";
        }
    }

    if (app.isPackaged) {
        // Check 2: Windows update ready to install
        if (process.platform !== 'darwin' && updateStatus.state === 'ready') {
            photoshopHelper = "PhotoshopHelper update is ready. Please right-click its icon in the system tray and select 'Update Ready, Restart' to apply.";
        }

        // Check 3: Mac update available for download
        if (process.platform === 'darwin' && updateStatus.state === 'available') {
            photoshopHelper = "PhotoshopHelper update is available. Please click its icon in the menu bar and select 'Download Update' to get the latest version.";
        }
    }

    return {
        photoshopHelper,
        photoshopPlugin
    };
}


function getReleasesUrl() {
    const owner = packageJson.build?.publish?.owner || 'dgl-10';
    const repo = packageJson.build?.publish?.repo || 'PhotoshopPlugin';
    return `https://github.com/${owner}/${repo}/releases`;
}

function openReleasesPage() {
    shell.openExternal(getReleasesUrl()).catch((error) => {
        updaterLogger.error('Failed to open the releases page:', error);
    });
}

async function checkForUpdates(source) {
    if (!autoUpdater) {
        return;
    }

    try {
        await autoUpdater.checkForUpdates();
    } catch (error) {
        // electron-updater also emits an error event; this catch prevents an unhandled rejection.
        updaterLogger.warn(`Update check rejected (${source}):`, error);
    }
}

function getUpdaterMenuItem() {
    if (!app.isPackaged) {
        return {
            label: 'Check for Updates (Dev Mode)',
            enabled: false
        };
    }

    switch (updateStatus.state) {
        case 'checking':
            return {
                label: 'Checking for Updates...',
                enabled: false
            };
        case 'no-update':
            return {
                label: 'App is up to date',
                enabled: false
            };
        case 'available':
            return {
                label: `Download Update (v${updateStatus.version})`,
                enabled: true,
                click: openReleasesPage
            };
        case 'downloading':
            return {
                label: `Downloading Update (v${updateStatus.version})...`,
                enabled: false
            };
        case 'ready':
            return {
                label: `Update Ready, Restart (v${updateStatus.version})`,
                enabled: true,
                click: () => {
                    if (autoUpdater) {
                        autoUpdater.quitAndInstall();
                    }
                }
            };
        case 'error':
            return {
                label: 'Update check failed',
                enabled: false
            };
        case 'cancelled':
            return {
                label: 'Update download cancelled',
                enabled: false
            };
        case 'idle':
        default:
            return {
                label: 'Check for Updates',
                enabled: true,
                click: () => {
                    void checkForUpdates('manual');
                }
            };
    }
}

function initializeAutoUpdater(onStateChange) {
    if (app.isPackaged) {
        try {
            const { autoUpdater: updater } = require('electron-updater');
            const log = require('electron-log');

            autoUpdater = updater;
            autoUpdater.logger = log;
            autoUpdater.autoDownload = false;
            updaterLogger = log;

            log.info('Initializing auto-updater...');

            const triggerStateChange = () => {
                if (typeof onStateChange === 'function') {
                    onStateChange();
                }
            };

            const returnToIdleAfterDelay = (expectedState) => {
                setTimeout(() => {
                    if (updateStatus.state === expectedState) {
                        updateStatus.state = 'idle';
                        triggerStateChange();
                    }
                }, TRANSIENT_STATUS_DURATION);
            };

            autoUpdater.on('checking-for-update', () => {
                log.info('Checking for update...');
                // Do not downgrade UI if we already have an update pending
                if (updateStatus.state !== 'ready' && updateStatus.state !== 'available') {
                    updateStatus.state = 'checking';
                    updateStatus.error = null;
                    triggerStateChange();
                }
            });

            autoUpdater.on('update-available', (info) => {
                log.info(`Update available: ${info.version}`);

                // If we already have this exact version pending, ignore the event
                if ((updateStatus.state === 'ready' || updateStatus.state === 'available') && info.version === updateStatus.version) {
                    log.info('Update is already pending. Ignoring.');
                    updateStatus.lastChecked = new Date();
                    triggerStateChange();
                    return;
                }

                updateStatus.version = info.version;
                updateStatus.lastChecked = new Date();
                updateStatus.error = null;

                if (process.platform === 'darwin') {
                    updateStatus.state = 'available';
                    triggerStateChange();

                    log.info('Showing manual download prompt for macOS...');

                    dialog.showMessageBox({
                        type: 'info',
                        title: 'Update Available',
                        message: `Version ${info.version} is available.`,
                        detail: 'Automatic updates are not supported on unsigned macOS builds. Please download the latest version manually from GitHub Releases.',
                        buttons: ['Open Releases Page', 'Later'],
                        defaultId: 0,
                        cancelId: 1
                    }).then((result) => {
                        if (result.response === 0) {
                            openReleasesPage();
                        }
                    }).catch((error) => {
                        log.error('Failed to show the macOS update dialog:', error);
                    });
                } else {
                    updateStatus.state = 'downloading';
                    triggerStateChange();

                    autoUpdater.downloadUpdate().catch((error) => {
                        // The error event updates the UI; this catch consumes the rejected download promise.
                        log.warn('Update download rejected:', error);
                    });
                }
            });

            autoUpdater.on('update-not-available', () => {
                log.info('Update not available.');
                // If we already have a downloaded update, do not throw it away
                if (updateStatus.state === 'ready' || updateStatus.state === 'available') {
                    updateStatus.lastChecked = new Date();
                    triggerStateChange();
                    return;
                }
                updateStatus.state = 'no-update';
                updateStatus.version = null;
                updateStatus.error = null;
                updateStatus.lastChecked = new Date();
                triggerStateChange();
                returnToIdleAfterDelay('no-update');
            });

            autoUpdater.on('update-cancelled', (info) => {
                log.warn(`Update download cancelled: ${info.version}`);
                updateStatus.state = 'cancelled';
                updateStatus.version = info.version || updateStatus.version;
                updateStatus.error = null;
                updateStatus.lastChecked = new Date();
                triggerStateChange();
                returnToIdleAfterDelay('cancelled');
            });

            autoUpdater.on('error', (err) => {
                log.error('Auto-update error:', err);
                // Do not let network errors destroy a pending ready state
                if (updateStatus.state === 'ready' || updateStatus.state === 'available') {
                    updateStatus.lastChecked = new Date();
                    triggerStateChange();
                    return;
                }
                updateStatus.state = 'error';
                updateStatus.error = err.message || 'Unknown error';
                updateStatus.lastChecked = new Date();
                triggerStateChange();
                returnToIdleAfterDelay('error');
            });

            if (process.platform !== 'darwin') {
                autoUpdater.on('update-downloaded', (info) => {
                    log.info(`Update downloaded: ${info.version}`);
                    updateStatus.state = 'ready';
                    updateStatus.version = info.version;
                    updateStatus.error = null;
                    updateStatus.lastChecked = new Date();
                    triggerStateChange();

                    dialog.showMessageBox({
                        type: 'info',
                        title: 'Update Ready',
                        message: `Version ${info.version} is ready.`,
                        detail: 'Would you like to restart Photoshop Helper now to apply the update?',
                        buttons: ['Restart Now', 'Later'],
                        defaultId: 0,
                        cancelId: 1
                    }).then((result) => {
                        if (result.response === 0) {
                            autoUpdater.quitAndInstall();
                        }
                    }).catch((error) => {
                        log.error('Failed to show the update-ready dialog:', error);
                    });
                });
            }

            // Keep one interval alive for the application lifetime and skip only active update states.
            updateCheckInterval = setInterval(() => {
                const skipStates = ['checking', 'downloading'];
                if (autoUpdater && !skipStates.includes(updateStatus.state)) {
                    log.info('Running periodic auto-update check...');
                    void checkForUpdates('periodic');
                }
            }, CHECK_INTERVAL);

            void checkForUpdates('startup');
        } catch (error) {
            console.error('Failed to initialize auto-updater:', error);
        }
    }
}

function cleanupAutoUpdater() {
    if (updateCheckInterval) {
        clearInterval(updateCheckInterval);
        updateCheckInterval = null;
    }
}

module.exports = {
    initializeAutoUpdater,
    cleanupAutoUpdater,
    getUpdaterMenuItem,
    getUpdateStatus,
    getUpdateAlert
};
