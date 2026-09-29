'use strict';

/**
 * Main-process module for the CLI Model Config window (Window B).
 *
 * Opens a separate BrowserWindow for each CLI so the user can configure
 * Light / Medium / High tier model and effort settings. The CLI name is
 * passed to the renderer via a URL hash fragment (e.g. cli-models-window.html#claude).
 *
 * One window per CLI can be open at a time. Asking to open the same CLI's
 * window again just brings it to the front.
 *
 * Pattern mirrors assist-window.js and cli-settings-window.js.
 */

const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');

const {
    getCliConfig,
    fetchModelsForCli,
    getCachedModels,
    setCliEnabled,
    setCliNativeImageGen,
    setCliTiers
} = require('./cli-service');

const DEFAULT_WIDTH = 850;
const DEFAULT_HEIGHT = 580;
const MIN_WIDTH = 850;
const MIN_HEIGHT = 580;

/** Map<cli, BrowserWindow> — at most one open window per CLI. */
const openWindows = new Map();

let ipcRegistered = false;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Bring a window to the front.
 *
 * @param {import('electron').BrowserWindow} win
 */
function bringToFront(win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

// ── IPC ────────────────────────────────────────────────────────────────────

/**
 * Register IPC handlers once. All handlers accept { cli } in the payload
 * so a single registered handler can serve every open window.
 */
function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;

    // Load stored tier settings + cached model list for the requested CLI.
    ipcMain.handle('cli-models:get-state', async (_event, { cli }) => {
        const config = await getCliConfig();
        const settings = config[cli] || null;
        const cache = getCachedModels(cli);
        return { settings, cache };
    });

    // Toggle enabled state for this CLI.
    ipcMain.handle('cli-models:set-enabled', async (_event, { cli, value }) => {
        await setCliEnabled(cli, value);
        return { ok: true };
    });

    // Toggle native image gen state for this CLI.
    ipcMain.handle('cli-models:set-native-image-gen', async (_event, { cli, value }) => {
        await setCliNativeImageGen(cli, value);
        return { ok: true };
    });

    // Save all settings at once (enabled, nativeImageGen, tiers).
    ipcMain.handle('cli-models:save', async (_event, { cli, enabled, nativeImageGen, tiers }) => {
        if (typeof enabled === 'boolean') {
            await setCliEnabled(cli, enabled);
        }
        if (typeof nativeImageGen === 'boolean') {
            await setCliNativeImageGen(cli, nativeImageGen);
        }
        if (tiers) {
            await setCliTiers(cli, tiers);
        }
        return { ok: true };
    });

    // Save all three tiers at once.
    ipcMain.handle('cli-models:save-tiers', async (_event, { cli, tiers }) => {
        await setCliTiers(cli, tiers);
        return { ok: true };
    });

    // Fetch a fresh model list from the CLI and return it (cache is updated inside).
    ipcMain.handle('cli-models:refresh-models', async (_event, { cli }) => {
        return fetchModelsForCli(cli);
    });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Register IPC handlers. Call once during startup.
 */
function initCliModelsWindow() {
    registerIpc();
}

/**
 * Open the Model Config window for a specific CLI, or bring the existing one
 * to the front. Opens as a modal window over Window A when a parent is passed.
 *
 * @param {string} cli - One of: claude, codex, grok, agy.
 * @param {object} [options]
 * @param {import('electron').BrowserWindow} [options.parent]
 * @returns {Promise<void>}
 */
async function openCliModelsWindow(cli, options = {}) {
    const existing = openWindows.get(cli);
    if (existing && !existing.isDestroyed()) {
        bringToFront(existing);
        return;
    }

    const parentWindow = options.parent && !options.parent.isDestroyed() ? options.parent : null;

    const win = new BrowserWindow({
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        parent: parentWindow,
        modal: Boolean(parentWindow),
        skipTaskbar: true,
        title: `PhotoshopHelper — Model Configuration`,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'cli-models-preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    // The CLI name is passed as a URL hash so the renderer can identify itself
    // without an extra IPC round-trip.
    win.loadFile(
        path.join(__dirname, 'cli-models-window.html'),
        { hash: cli }
    );

    openWindows.set(cli, win);

    win.on('closed', () => {
        if (openWindows.get(cli) === win) openWindows.delete(cli);
    });

    bringToFront(win);
}

module.exports = { initCliModelsWindow, openCliModelsWindow };
