'use strict';

/**
 * Main-process module for the CLI Settings window (Window A).
 *
 * Shows a table of the four supported CLIs with their installation status,
 * enabled checkbox, native image gen checkbox, and a "Configure" button that
 * opens the Model Config window (Window B) for the selected CLI.
 *
 * Pattern mirrors assist-window.js: one module, one BrowserWindow reference,
 * IPC handlers registered once, window state remembered between opens.
 */

const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

const {
    getCliConfig,
    setCliEnabled,
    setCliNativeImageGen
} = require('./cli-service');

const DEFAULT_WIDTH = 680;
const DEFAULT_HEIGHT = 460;
const MIN_WIDTH = 600;
const MIN_HEIGHT = 460;

let settingsWindow = null;
let ipcRegistered = false;

/** Reference injected by initCliSettingsWindow(); Window B opener lives here. */
let openCliModelsWindow = () => { };

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Bring an existing window to the front of every other window.
 * Mirrors the pattern from assist-window.js.
 *
 * @param {import('electron').BrowserWindow} win
 */
function bringToFront(win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.setAlwaysOnTop(true);
    win.focus();
    win.setAlwaysOnTop(false);
}

// ── IPC ────────────────────────────────────────────────────────────────────

/**
 * Register IPC handlers. Safe to call more than once — only the first call
 * registers anything.
 */
function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;

    // Return install status + stored settings for all 4 CLIs.
    ipcMain.handle('cli-settings:get-state', async () => {
        return getCliConfig();
    });

    // Toggle a CLI's enabled flag.
    ipcMain.handle('cli-settings:set-enabled', async (_event, { cli, value }) => {
        await setCliEnabled(cli, value);
    });

    // Toggle a CLI's native image generation flag.
    ipcMain.handle('cli-settings:set-native-image-gen', async (_event, { cli, value }) => {
        await setCliNativeImageGen(cli, value);
    });

    // Open the Model Config window for the requested CLI (Window B).
    ipcMain.handle('cli-settings:open-model-config', async (_event, { cli }) => {
        await openCliModelsWindow(cli, { parent: settingsWindow });
    });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Wire this module to the Model Config window opener. Must be called once
 * during startup, before the first openCliSettingsWindow() call.
 *
 * @param {object}   options
 * @param {Function} options.openModelsWindow - Async function that opens Window B
 *   for a given CLI name: (cli: string) => Promise<void>.
 */
function initCliSettingsWindow({ openModelsWindow }) {
    openCliModelsWindow = openModelsWindow || (() => { });
    registerIpc();
}

/**
 * Open the CLI Settings window, or bring the existing one to the front.
 *
 * @param {object} [options]
 * @param {import('electron').BrowserWindow} [options.parent]
 * @param {boolean} [options.modal]
 * @returns {Promise<void>}
 */
async function openCliSettingsWindow(options = {}) {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        bringToFront(settingsWindow);
        return;
    }

    const parentWindow = options.parent && !options.parent.isDestroyed() ? options.parent : null;

    settingsWindow = new BrowserWindow({
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        parent: parentWindow,
        modal: Boolean(parentWindow && options.modal),
        title: 'PhotoshopHelper — AI CLI Settings',
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'cli-settings-preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    // Loaded from disk — never from the Express server.
    settingsWindow.loadFile(path.join(__dirname, 'cli-settings-window.html'));

    const win = settingsWindow;
    win.on('closed', () => {
        if (settingsWindow === win) settingsWindow = null;
    });

    bringToFront(settingsWindow);
}

module.exports = { initCliSettingsWindow, openCliSettingsWindow };
