'use strict';

/**
 * The AI Assist window: an ordinary Electron window that shows the FromPS / ToPS AI
 * connection, the running task, and the last report.
 *
 * It replaces the old in-plugin dialog (see ui02.00 in the PreRelease docs): UXP cannot
 * draw a window that resizes itself to long, changing text, so everything long now lives
 * here instead, in Helper's own Chromium. The plugin keeps only a fixed-height status line
 * that can ask this window to open, but the window never talks to Photoshop itself — it
 * reads the same document-agent service the plugin's line polls over HTTP, straight
 * through IPC. It is never served over HTTP, so it cannot be reached from a browser or
 * through a tunnel.
 */

const path = require('node:path');
const { BrowserWindow, ipcMain, clipboard } = require('electron');

const { buildInstallCommands, buildAgentInstructions } = require('./mcp-setup');
const { getCliConfig } = require('./cli-service');
const { openCliSettingsWindow } = require('./cli-settings-window');
const { openCliModelsWindow } = require('./cli-models-window');
const {
    getAssistWindowBounds,
    setAssistWindowBounds,
    getTokenFromUserEnvironment,
    getLocalApiToken
} = require('../user-settings');

const DEFAULT_WIDTH = 460;
const DEFAULT_HEIGHT = 640;
const MIN_WIDTH = 380;
const MIN_HEIGHT = 420;

let assistWindow = null;
let ipcRegistered = false;

// Set once by initAssistWindow(); openAssistWindow() and the IPC handlers below read the
// current service and port through these instead of taking them as parameters, so every
// call site (the tray menu, the plugin's HTTP route) can ask for the window with nothing
// more than an optional section name.
let getAgentService = () => null;
let helperPort = null;

/**
 * Bring an existing window in front of every other window, including ones owned by other
 * applications. Helper is a background application, so plain focus()/show() is not always
 * enough on Windows to raise it above the currently active app — toggling always-on-top is
 * the documented Electron workaround (see "What to verify by hand" in the testing guide).
 *
 * @param {import('electron').BrowserWindow} win - Window to raise.
 */
function bringToFront(win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.setAlwaysOnTop(true);
    win.focus();
    win.setAlwaysOnTop(false);
}

/**
 * Register the IPC handlers the window's preload calls. Safe to call more than once; only
 * the first call registers anything.
 */
function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;

    ipcMain.handle('agent-assist:get-state', () => {
        const service = getAgentService();
        return service ? service.getState() : null;
    });

    ipcMain.handle('agent-assist:stop', () => {
        const service = getAgentService();
        return service ? service.stop() : { stopped: false, message: 'The agent service is not ready yet.' };
    });

    ipcMain.handle('agent-assist:get-setup', async () => {
        const userEnvToken = getTokenFromUserEnvironment();
        const localToken = await getLocalApiToken();
        const tokenSaved = Boolean(userEnvToken && userEnvToken === localToken);

        return {
            tokenSaved,
            commands: buildInstallCommands({ port: helperPort }),
            instructionsForAnAgent: buildAgentInstructions({ port: helperPort })
        };
    });

    ipcMain.handle('agent-assist:copy-text', (event, text) => {
        clipboard.writeText(String(text || ''));
    });

    ipcMain.handle('agent-assist:get-cli-config', async () => {
        return getCliConfig();
    });

    ipcMain.handle('agent-assist:open-cli-settings', async (_event, { cli } = {}) => {
        if (cli && cli !== 'any') {
            await openCliModelsWindow(cli, { parent: assistWindow });
        } else {
            await openCliSettingsWindow({ parent: assistWindow, modal: true });
        }
    });
}

/**
 * Wire the window module to the running document-agent service. Call once during startup,
 * before the first openAssistWindow() — from the tray menu or from the plugin's HTTP route.
 *
 * @param {object} options
 * @param {object} options.agentService - The service built by agent/index.js.
 * @param {number} options.port - Helper's HTTP port, for the MCP setup commands.
 */
function initAssistWindow({ agentService, port }) {
    getAgentService = () => agentService;
    helperPort = port;
    registerIpc();
}

/**
 * Open the AI Assist window, or bring the existing one to the front.
 *
 * @param {object} [options]
 * @param {string} [options.section] - 'connect' shows the connect-an-agent step right
 *   away, whatever the window would otherwise show first. Left out, the window opens on
 *   whatever the current state naturally shows (task, report, or the connect step when no
 *   agent has ever connected).
 * @returns {Promise<void>}
 */
async function openAssistWindow({ section } = {}) {
    if (assistWindow && !assistWindow.isDestroyed()) {
        bringToFront(assistWindow);
        if (section) assistWindow.webContents.send('assist-show-section', section);
        return;
    }

    const bounds = await getAssistWindowBounds();

    assistWindow = new BrowserWindow({
        width: (bounds && bounds.width) || DEFAULT_WIDTH,
        height: (bounds && bounds.height) || DEFAULT_HEIGHT,
        x: bounds ? bounds.x : undefined,
        y: bounds ? bounds.y : undefined,
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        title: 'PhotoshopHelper — AI Assist',
        autoHideMenuBar: true,
        // Not always-on-top by default: it is a normal window the person can put behind
        // Photoshop while a task runs, unlike bringToFront()'s momentary use of the flag.
        webPreferences: {
            preload: path.join(__dirname, 'assist-window-preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    // Loaded from disk, never from Helper's Express server: the window must not be
    // reachable from a browser or through a tunnel the way WebHelper is.
    assistWindow.loadFile(path.join(__dirname, 'assist-window.html'));

    assistWindow.webContents.once('did-finish-load', () => {
        if (section && assistWindow) assistWindow.webContents.send('assist-show-section', section);
    });

    const win = assistWindow;
    win.on('close', () => {
        if (!win.isDestroyed()) {
            setAssistWindowBounds(win.getBounds()).catch(() => {
                // Losing the remembered size/position is not worth failing the close over.
            });
        }
    });
    win.on('closed', () => {
        if (assistWindow === win) assistWindow = null;
    });

    bringToFront(assistWindow);
}

module.exports = { initAssistWindow, openAssistWindow };
