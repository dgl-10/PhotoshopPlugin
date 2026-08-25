const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { getConfigPaths } = require('./config-paths');

const __isDevCheck = 0; // 0 = production, 1 = dev + firstrun check, 2 = dev + disable firstrun check

// ---------------------------------------------------------------------------
// Setup state — stored and managed via user-settings.js
// ---------------------------------------------------------------------------

const userSettings = require('../user-settings');

async function isSetupComplete() {
    if (__isDevCheck == 2) return false;
    return await userSettings.isSetupComplete();
}

async function markSetupComplete() {
    if (__isDevCheck == 2) return;
    await userSettings.markSetupComplete();
}

// ---------------------------------------------------------------------------
// Template → userData copying
// ---------------------------------------------------------------------------

/**
 * Copies bundled template files to the user's data directory on first launch.
 * Only copies a file if it does NOT already exist in userData.
 */
function copyTemplatesIfNeeded() {
    const { envPath, providersPath, resourcesPath } = getConfigPaths();

    const envTemplate = path.join(resourcesPath, '.env.template');
    const providersTemplate = path.join(resourcesPath, 'providers.template.json');

    if (!fs.existsSync(envPath) && fs.existsSync(envTemplate)) {
        fs.copyFileSync(envTemplate, envPath);
        console.log('[setup] .env.template → userData/.env');
    }

    if (!fs.existsSync(providersPath) && fs.existsSync(providersTemplate)) {
        fs.copyFileSync(providersTemplate, providersPath);
        console.log('[setup] providers.template.json → userData/providers.json');
    }
}

// ---------------------------------------------------------------------------
// First-Run Wizard window
// ---------------------------------------------------------------------------

let wizardWindow = null;
let onRefreshPairing = null;
let pairingPollTimer = null;

function setPairingRefresher(fn) {
    onRefreshPairing = fn;
}

function startPairingPolling() {
    stopPairingPolling();
    if (typeof onRefreshPairing === 'function') {
        onRefreshPairing();
        pairingPollTimer = setInterval(() => {
            if (typeof onRefreshPairing === 'function') {
                onRefreshPairing();
            }
        }, 2500);
    }
}

function stopPairingPolling() {
    if (pairingPollTimer) {
        clearInterval(pairingPollTimer);
        pairingPollTimer = null;
    }
}

function createFirstRunWizard(isFirstRun, userDataPath, pluginPath, pluginFilePath) {
    if (wizardWindow && !wizardWindow.isDestroyed()) {
        wizardWindow.close();
    }

    wizardWindow = new BrowserWindow({
        width: 670,
        height: 580,
        resizable: false,
        title: isFirstRun ? 'PhotoshopHelper — First Run Setup' : 'PhotoshopHelper — Settings',
        // Center on screen
        center: true,
        autoHideMenuBar: true,
        webPreferences: {
            // Use a dedicated preload so the main drag-window preload stays clean
            preload: path.join(__dirname, 'wizard-preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    wizardWindow.isFirstRun = isFirstRun;
    startPairingPolling();

    wizardWindow.loadFile(path.join(__dirname, 'first-run-wizard.html'));

    wizardWindow.webContents.once('did-finish-load', () => {
        // Send paths to the renderer so it can display them and act on them
        wizardWindow.webContents.send('wizard-init', { isFirstRun, userDataPath, pluginPath, pluginFilePath });
    });

    wizardWindow.on('closed', () => {
        stopPairingPolling();
        if (typeof onRefreshPairing === 'function') {
            onRefreshPairing();
        }
        wizardWindow = null;
    });
}

// ---------------------------------------------------------------------------
// IPC handlers (registered once at module load)
// ---------------------------------------------------------------------------

// "Open Settings Folder" button — reveals .env in Explorer / Finder
ipcMain.on('wizard-open-settings', (event, userDataPath, fileName) => {
    try {
        if (fileName) {
            shell.showItemInFolder(path.join(userDataPath, fileName));
        } else {
            shell.openPath(userDataPath).catch(err => {
                console.error('[setup] Failed to open path asynchronously:', err);
            });
        }
    } catch (error) {
        console.error('[setup] Error in wizard-open-settings handler:', error);
    }
});


// "Done" button — persists the flag and closes the wizard window
ipcMain.on('wizard-complete', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        if (win.isFirstRun) {
            await markSetupComplete();
        }
        if (!win.isDestroyed()) win.close();
    }
    if (typeof onRefreshPairing === 'function') {
        onRefreshPairing();
    }
});

// "Restart App" button — relaunches Electron application
ipcMain.on('wizard-relaunch', () => {
    app.relaunch();
    app.exit(0);
});

// ---------------------------------------------------------------------------
// Entry point called from main.js
// ---------------------------------------------------------------------------

/**
 * Should be called inside app.whenReady().
 *
 * In development (npm start) this function is a no-op so it never interferes
 * with the normal development workflow.
 */
async function handleFirstRun() {
    if (!app.isPackaged && __isDevCheck == 0) {
        console.log('[setup] Development mode — skipping first-run logic.');
        return;
    }

    if (__isDevCheck == 0) copyTemplatesIfNeeded();

    const completed = await isSetupComplete();
    if (!completed) {
        await handleFirstRun_(true);
    }
}
async function handleFirstRun_(isFirstRun) {
    const { userDataPath, resourcesPath } = getConfigPaths();
    let pluginPath = resourcesPath;
    if (!app.isPackaged) {
        pluginPath = path.join(pluginPath, '..'); //parent folder
    }
    const pluginFilePath = path.join(pluginPath, 'plugin.ccx');
    createFirstRunWizard(isFirstRun, userDataPath, pluginPath, pluginFilePath);
}
async function openSetupWindow() {
    await handleFirstRun_(false);
}


module.exports = { handleFirstRun, openSetupWindow, setPairingRefresher };
