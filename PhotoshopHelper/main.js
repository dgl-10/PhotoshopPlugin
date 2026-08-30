// Prepend common macOS binary paths to PATH when launched from macOS GUI
if (process.platform === 'darwin') {
    process.env.PATH = `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin`;
}

const { app, BrowserWindow, clipboard, nativeImage, ipcMain, Tray, Menu, screen, shell, dialog } = require('electron');

// Global crash logging setup
const log = require('electron-log');
const os = require('node:os');

if (app.isPackaged) {
    log.transports.file.level = 'info';
    log.transports.console.level = 'info';
} else {
    //most verbose level
    log.transports.file.level = 'silly';
    log.transports.console.level = 'silly';
}
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{processType}] [{level}] {text}';
log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{processType}] [{level}] {text}';

// Start catching uncaught exceptions and unhandled promise rejections
log.errorHandler.startCatching({
    showDialog: true,
    onError({ error, processType, versions }) {
        const appVer = (versions && versions.app) || 'Unknown';
        const electronVer = (versions && versions.electron) || 'Unknown';
        const osVer = (versions && versions.os) || 'Unknown';

        log.error('==================================================');
        log.error(`GLOBAL CRASH DETECTED in [${processType}] process`);
        log.error('==================================================');
        log.error(`Error Message: ${error.message}`);
        log.error(`Stack Trace:\n${error.stack}`);
        log.error('---------------- Environment Details -------------');
        log.error(`App Version:      ${appVer}`);
        log.error(`Electron Version: ${electronVer}`);
        log.error(`Node Version:     ${process.version}`);
        log.error(`OS Version:       ${osVer}`);
        log.error(`Platform:         ${process.platform} (${process.arch})`);
        log.error(`Memory Usage:     ${JSON.stringify(process.memoryUsage())}`);
        log.error(`Uptime:           ${process.uptime()}s`);
        log.error(`CPU Count:        ${os.cpus().length}`);
        log.error(`Free Memory:      ${Math.round(os.freemem() / 1024 / 1024)}MB / ${Math.round(os.totalmem() / 1024 / 1024)}MB`);
        log.error('==================================================');
    }
});

// Disable sandbox to prevent GPU process crashes (exit_code=-1073741515 / STATUS_DLL_NOT_FOUND)
// on certain Windows environments (like older Windows 10 versions or specific GPU driver configurations)
// where Chromium sandboxed renderer/GPU processes fail to load system DLLs.
app.commandLine.appendSwitch('no-sandbox');

const { detectMimeTypeFromBase64, mimeTypeToExt, parseImageInput } = require('./imageUtils');
const crypto = require('node:crypto');

// Single instance lock
if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
}
app.on('second-instance', () => {
    // Someone tried to run a second instance. 
    // If a drag window is open, focus it.
    if (typeof dragWindow !== 'undefined' && dragWindow && !dragWindow.isDestroyed()) {
        dragWindow.focus();
    }
});


const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { spawnSync } = require('node:child_process');
const JSON5 = require('json5');
const { generate } = require('./apiGenerator');
const { LOCAL_API_PREFIX, createLocalGenerationRouter } = require('./localGenerationApi');
const { createAuthMiddleware, createSameOriginCorsMiddleware, createPasswordGate, isSameOriginRequest } = require('./auth');
const { writePairingFile } = require('./plugin-pairing');
const { getPluginToken, regeneratePluginToken, getLocalApiToken, regenerateLocalApiToken, saveTokenToUserEnvironment, getTokenFromUserEnvironment } = require('./user-settings');
const { getConfigPaths } = require('./setup/config-paths');
const { handleFirstRun, openSetupWindow, setPairingRefresher } = require('./setup/first-run');
const { trackUsage, isEnabled: isDonationEnabled, openLicenseActivationWindow } = require('./donation-manager');
const { initializeAutoUpdater, cleanupAutoUpdater, getUpdaterMenuItem, getUpdateStatus, getUpdateAlert } = require('./updater');

try {
    const { envPath } = getConfigPaths();
    require('dotenv').config({ path: envPath });
} catch (e) {
    // dotenv might not be installed, ignore
}


// Load secrets right at startup before accessing any API keys
// Nebula is the author's personal utility that loads secrets from GSM (Google Secret Manager) and is only used in this code block
function loadNebulaSecrets() {
    // Read env var and ensure it's not undefined or an empty/whitespace-only string
    const nebulaConstuctionString = process.env.NEBULA_CS;
    if (!nebulaConstuctionString || nebulaConstuctionString.trim() === "") {
        console.log("NEBULA_CS not set. Skipping Nebula secrets injection.");
        return;
    }

    try {
        // Execute 'nebulabroker emit' and capture stdout without writing to disk
        const result = spawnSync("nebulabroker", ["emit", "--cs", nebulaConstuctionString, "--format", "json"], {
            encoding: 'utf-8'
        });

        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(result.stderr || `Exit code ${result.status}`);

        const secrets = JSON.parse(result.stdout);

        // Inject into environment
        Object.assign(process.env, secrets);
        console.log(`Successfully loaded ${Object.keys(secrets).length} secrets from Nebula.`);

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.warn("Warning: 'nebulabroker' executable not found in PATH.");
        } else {
            console.error(`Failed to load secrets: ${error.message}`);
        }
    }
}
loadNebulaSecrets();
/////////////////////////////////////////////////////////////////////////////////////////////////

// Application constants
const packageJson = require('./package.json');
const PORT = 18345;
const VERSION = packageJson.version;

// Feature flag for /api/file/save endpoint (arbitrary file save).
// Security guard: always forced to false in packaged/installed builds (app.isPackaged).
// In development (!app.isPackaged), you can toggle IS_FILE_SAVE_ENABLED_DEV to test.
const IS_FILE_SAVE_ENABLED_DEV = false;
const IS_FILE_SAVE_ENABLED = !app.isPackaged && IS_FILE_SAVE_ENABLED_DEV;

// Global references
let tray = null;
let dragWindow = null;
let httpServer = null;
let currentSessionFolder = null;  // Current drag session temp folder
let currentFilePaths = [];        // Array of file paths for current drag session

// Shared secrets guarding the local HTTP server. They are resolved before the server
// starts and read through closures, so regenerating one takes effect immediately.
let pluginToken = '';
let localApiToken = '';

// How often the pairing file is refreshed, so a plugin installed after the Helper
// started still receives its token without the user restarting anything.
const PAIRING_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let pairingRefreshTimer = null;

// WebHelper specific globals
global.tasks = {};
global.queue = [];

const WEBHELPER_TEMP_DIR = path.join(os.tmpdir(), "ps_webhelper_tasks");

// Ensure temp dir exists for all temp files
if (!fs.existsSync(WEBHELPER_TEMP_DIR)) {
    fs.mkdirSync(WEBHELPER_TEMP_DIR, { recursive: true });
}

// Global temp file for clipboard operations
const TEMP_FILE_PATH = path.join(WEBHELPER_TEMP_DIR, 'ps_clipboard_temp.png');

/**
 * Rebuild and apply the context menu to the tray based on current application state
 */
function updateTrayMenu() {
    if (!tray) return;

    const menuTemplate = [
        {
            label: `Photoshop Helper v${VERSION}`,
            enabled: false
        },
        { type: 'separator' },
        {
            label: `Server running on port ${PORT}`,
            enabled: false
        },
        { type: 'separator' },

        // Dynamic Updater Menu Item
        getUpdaterMenuItem(),
        // Optional last checked timestamp item
        ...(getUpdateStatus().lastChecked ? [{
            label: `Last checked: ${getUpdateStatus().lastChecked.toLocaleTimeString()}`,
            enabled: false
        }] : []),
        { type: 'separator' }
    ];

    //if (app.isPackaged) {
    menuTemplate.push(
        {
            label: 'Settings...',
            click: async () => {
                await openSetupWindow();
            }
        },
        { type: 'separator' }
    );
    //}

    menuTemplate.push(
        {
            label: 'Open Temp Folder',
            click: () => {
                shell.openPath(WEBHELPER_TEMP_DIR);
            }
        },
        { type: 'separator' },
        {
            label: 'Open WebHelper',
            click: () => {
                shell.openExternal(`http://localhost:${PORT}/webhelper`);
            }
        },
        {
            label: 'Copy WebHelper URL',
            click: () => {
                clipboard.writeText(`http://localhost:${PORT}/webhelper`);
            }
        }
    );

    // Query HKCU\Environment once synchronously so the checkbox reflects the real state.
    const userEnvToken = getTokenFromUserEnvironment();
    const isTokenSavedInUserEnv = userEnvToken !== null && userEnvToken === localApiToken;

    menuTemplate.push(
        { type: 'separator' },
        {
            label: 'Access Tokens',
            submenu: [
                {
                    label: 'Copy Local API Token',
                    click: () => {
                        clipboard.writeText(localApiToken);
                    }
                },
                {
                    // Checkbox reflects whether the current active token is already
                    // saved to HKCU\Environment and matches the value in use.
                    label: isTokenSavedInUserEnv ? 'Token Saved in User Environment' : 'Save Token to User Environment...',
                    type: 'checkbox',
                    checked: isTokenSavedInUserEnv,
                    click: async () => {
                        if (isTokenSavedInUserEnv) {
                            // Token is already saved and up-to-date – inform and do nothing.
                            await dialog.showMessageBox({
                                type: 'info',
                                buttons: ['OK'],
                                defaultId: 0,
                                title: 'Token Already Saved',
                                message: 'PHOTOSHOP_HELPER_LOCAL_API_TOKEN is already saved in your User Environment.',
                                detail: 'The stored value matches the active token. No action is needed.'
                            });
                            return;
                        }

                        // Token is not saved yet, or the stored value is stale – prompt to save.
                        const { response } = await dialog.showMessageBox({
                            type: 'info',
                            buttons: ['Save to Environment', 'Cancel'],
                            defaultId: 0,
                            cancelId: 1,
                            title: 'Save Token to User Environment',
                            message: 'Save the Local API token to your User Environment Variables?',
                            detail: 'This sets PHOTOSHOP_HELPER_LOCAL_API_TOKEN in your user account environment so newly launched terminals, scripts, and AI agents (MCP) can access the Local Generation API automatically.'
                        });

                        if (response !== 0) {
                            return;
                        }

                        const result = saveTokenToUserEnvironment(localApiToken);
                        if (result.success) {
                            await dialog.showMessageBox({
                                type: 'info',
                                buttons: ['OK'],
                                defaultId: 0,
                                title: 'Token Saved',
                                message: 'Token saved to User Environment Variables.',
                                detail: 'PHOTOSHOP_HELPER_LOCAL_API_TOKEN has been set for your user account.\n\nNote: Any already opened terminal windows or IDEs will need to be restarted to pick up the new variable.'
                            });
                            // Rebuild the tray menu so the checkbox reflects the new state.
                            updateTrayMenu();
                        } else {
                            await dialog.showMessageBox({
                                type: 'error',
                                buttons: ['OK'],
                                defaultId: 0,
                                title: 'Failed to Save Token',
                                message: 'Could not save token to User Environment Variables.',
                                detail: result.error || 'Unknown error occurred.'
                            });
                        }
                    }
                },
                {
                    label: 'Copy Env Var Name (PHOTOSHOP_HELPER_LOCAL_API_TOKEN)',
                    click: () => {
                        clipboard.writeText('PHOTOSHOP_HELPER_LOCAL_API_TOKEN');
                    }
                },
                {
                    label: 'Regenerate Local API Token...',
                    visible: false,
                    click: async () => {
                        const isOverridden = !!(process.env.PHOTOSHOP_HELPER_LOCAL_API_TOKEN);
                        if (isOverridden) {
                            await dialog.showMessageBox({
                                type: 'info',
                                buttons: ['OK'],
                                defaultId: 0,
                                title: 'Local API Token',
                                message: 'Token is managed via environment variable / .env',
                                detail: 'A token is currently set in your environment or .env file (PHOTOSHOP_HELPER_LOCAL_API_TOKEN). To change it, update your environment or .env file directly and restart Photoshop Helper.'
                            });
                            return;
                        }

                        const { response } = await dialog.showMessageBox({
                            type: 'warning',
                            buttons: ['Regenerate', 'Cancel'],
                            defaultId: 1,
                            cancelId: 1,
                            title: 'Regenerate Local API Token',
                            message: 'Regenerate the Local API token?',
                            detail: 'The current token stops working immediately. Any external scripts or tools using this token will need to be updated with the new token.'
                        });

                        if (response !== 0) {
                            return;
                        }

                        try {
                            localApiToken = await regenerateLocalApiToken();
                            clipboard.writeText(localApiToken);

                            const envPrompt = await dialog.showMessageBox({
                                type: 'info',
                                buttons: ['Update Environment Variable', 'Copy Only'],
                                defaultId: 0,
                                cancelId: 1,
                                title: 'Token Regenerated',
                                message: 'New Local API token generated and copied to clipboard.',
                                detail: 'Do you also want to update PHOTOSHOP_HELPER_LOCAL_API_TOKEN in your Windows User Environment Variables?'
                            });

                            if (envPrompt.response === 0) {
                                const saveResult = saveTokenToUserEnvironment(localApiToken);
                                if (saveResult.success) {
                                    await dialog.showMessageBox({
                                        type: 'info',
                                        buttons: ['OK'],
                                        defaultId: 0,
                                        title: 'Environment Updated',
                                        message: 'Environment variable updated successfully.',
                                        detail: 'PHOTOSHOP_HELPER_LOCAL_API_TOKEN was updated in your user environment.\n\nRestart active terminal windows or IDEs to apply the change.'
                                    });
                                }
                            }
                        } catch (error) {
                            log.error('Failed to regenerate the local API token:', error);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Copy Plugin Pairing Token',
                    click: () => {
                        clipboard.writeText(pluginToken);
                    }
                },
                {
                    label: 'Re-pair Plugin Now',
                    click: () => {
                        refreshPluginPairing();
                    }
                },
                {
                    label: 'Regenerate Plugin Token...',
                    click: async () => {
                        const { response } = await dialog.showMessageBox({
                            type: 'warning',
                            buttons: ['Regenerate', 'Cancel'],
                            defaultId: 1,
                            cancelId: 1,
                            title: 'Regenerate Plugin Token',
                            message: 'Regenerate the Photoshop plugin token?',
                            detail: 'The current token stops working immediately. The new token is delivered to the plugin automatically, but the FromPS / ToPS panel must be closed and reopened to pick it up.'
                        });

                        if (response !== 0) {
                            return;
                        }

                        try {
                            pluginToken = await regeneratePluginToken();
                            refreshPluginPairing();
                        } catch (error) {
                            log.error('Failed to regenerate the plugin token:', error);
                        }
                    }
                }
            ]
        }
    );

    //if (await isDonationEnabled()) {
    menuTemplate.push(
        { type: 'separator' },
        {
            label: 'Support the Project, Donate...',
            click: () => {
                openLicenseActivationWindow();
            }
        });
    //}

    menuTemplate.push(
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.quit();
            }
        }
    );

    const contextMenu = Menu.buildFromTemplate(menuTemplate);

    tray.setToolTip('Photoshop Helper');
    tray.setContextMenu(contextMenu);
}

/**
 * Create system tray icon
 */
async function createTray() {
    // Create a simple 16x16 tray icon (placeholder - can be replaced with actual icon)
    const iconPath = path.join(__dirname, 'tray-icon.png');

    // If no icon exists, create a simple one using nativeImage
    let trayIcon;
    if (fs.existsSync(iconPath)) {
        trayIcon = nativeImage.createFromPath(iconPath);
    } else {
        // Create a simple blue square as placeholder icon
        trayIcon = nativeImage.createEmpty();
    }

    tray = new Tray(trayIcon);
    if (process.platform === 'darwin') {
        trayIcon.setTemplateImage(true);
    }

    tray.setToolTip('Photoshop Helper');

    // Set the initial context menu
    updateTrayMenu();
}

/**
 * Create the floating drag window
 * @param {string} previewImagePath - Path to the first image for preview
 * @param {string[]} filePaths - Array of all file paths to drag
 * @param {number} x - X position for the window
 * @param {number} y - Y position for the window
 */
function createDragWindow(previewImagePath, filePaths, x, y) {
    // Close existing drag window if any
    // Close existing drag window if any
    if (dragWindow && !dragWindow.isDestroyed()) {
        dragWindow.close();
    }
    dragWindow = null;

    // Store file paths globally for IPC access
    currentFilePaths = filePaths;

    dragWindow = new BrowserWindow({
        width: 150,
        height: 150,
        x: x - 75, // Center under cursor
        y: y - 75,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        hasShadow: false,  // Prevents rectangular shadow around the transparent preview window on macOS
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    dragWindow.loadFile('drag-window.html');

    // Send image path and count to renderer once loaded
    dragWindow.webContents.once('did-finish-load', () => {
        dragWindow.webContents.send('set-images', {
            previewPath: previewImagePath,
            count: filePaths.length
        });
    });

    // Handle drag end - closed by renderer via IPC 'drag-complete'
}

/**
 * Helper to determine if a request comes from the local machine
 */
function checkIsLocal(req) {
    //return false;
    const isLocalHost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    const isForwarded = !!req.headers['x-forwarded-for'];
    return isLocalHost && !isForwarded;
}

/**
 * Deliver the current plugin token into the Photoshop plugin's private data folder.
 *
 * Pairing is best-effort by design. When no plugin folder is found — a fresh install, or
 * an Adobe storage layout this build does not know about — the plugin still works once
 * the token is pasted into its Settings dialog.
 */
function refreshPluginPairing() {
    if (!pluginToken) {
        return;
    }

    try {
        const { written, failed } = writePairingFile({
            token: pluginToken,
            port: PORT,
            version: VERSION
        });

        if (written.length > 0) {
            log.info(`Plugin pairing file written to: ${written.join(', ')}`);
        } else {
            log.info('No Photoshop plugin data folder found. The plugin can be paired manually from its Settings dialog.');
        }

        for (const failure of failed) {
            log.warn(`Could not write plugin pairing file to ${failure.path}: ${failure.error}`);
        }
    } catch (error) {
        log.error('Plugin pairing failed:', error);
    }
}

/**
 * Start the HTTP server
 */
function startHttpServer() {

    // Cleanup old temp files/folders on startup (older than 30 days)
    try {
        const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        const items = fs.readdirSync(WEBHELPER_TEMP_DIR);
        for (const item of items) {
            const itemPath = path.join(WEBHELPER_TEMP_DIR, item);
            const stats = fs.statSync(itemPath);
            if (now - stats.mtimeMs > thirtyDaysInMs) {
                fs.rmSync(itemPath, { recursive: true, force: true });
                console.log(`Cleaned up old temp item: ${itemPath}`);
            }
        }
    } catch (e) {
        console.error('Error cleaning up temp directory on startup:', e);
    }

    const expressApp = express();

    // Parse JSON bodies (limit to 50MB for large images)
    expressApp.use(express.json({ limit: '50mb' }));

    // Reflect only this server's own origin. A wildcard policy would let any page the
    // user has open in a browser drive these endpoints, because binding to loopback does
    // not stop a local browser from reaching them.
    expressApp.use(createSameOriginCorsMiddleware());

    // The plugin is the only client of the clipboard, drag and file-save endpoints. They
    // are what turns this server into a Photoshop sandbox escape, so they always require
    // the shared secret and never accept a browser origin as proof of anything.
    const requirePluginToken = createAuthMiddleware({ getToken: () => pluginToken });

    // WebHelper's own page is a legitimate browser client, so a same-origin request is
    // accepted. The plugin reaches the same routes without an origin and uses its token.
    const requireWebHelperAccess = createAuthMiddleware({
        getToken: () => pluginToken,
        allowSameOrigin: true
    });

    // Inert unless the user sets a password. It exists for the case where WebHelper is
    // deliberately reachable beyond this machine, where an origin check proves nothing.
    const webHelperPasswordGate = createPasswordGate({
        getPassword: () => process.env.WEBHELPER_ACCESS_PASSWORD || '',
        getToken: () => pluginToken
    });

    expressApp.use('/api/clipboard', requirePluginToken);
    // OS-drag is used both by the plugin and by WebHelper's local Alt+Drag.
    // Same-origin is accepted only on a real loopback request — a tunneled
    // WebHelper page is same-origin from the browser's point of view but must
    // not be able to start a drag on this machine.
    expressApp.use('/api/drag', (req, res, next) => {
        if (checkIsLocal(req) && isSameOriginRequest(req)) {
            return next();
        }
        return requirePluginToken(req, res, next);
    });
    expressApp.use('/api/file', requirePluginToken);
    expressApp.use('/webhelper', webHelperPasswordGate);
    expressApp.use('/api/webhelper', webHelperPasswordGate, requireWebHelperAccess);

    // Mount the local service-to-service generation API over the existing provider
    // pipeline. Its token is deliberately distinct from the plugin token: the plugin's
    // secret is delivered as a file on disk, and must not unlock paid generation.
    expressApp.use(LOCAL_API_PREFIX, createLocalGenerationRouter({
        generate,
        tempDir: WEBHELPER_TEMP_DIR,
        getToken: () => localApiToken,
        onGenerationAccepted: () => trackUsage(2)
    }));

    // GET /api/status - Health check endpoint
    expressApp.get('/api/status', (req, res) => {
        const clientPluginVersion = req.query.pluginVersion || null;
        const alerts = getUpdateAlert(clientPluginVersion);
        res.json({
            status: 'running',
            version: VERSION,
            alerts
        });
    });

    // POST /api/clipboard/copy - Copy image to clipboard
    expressApp.post('/api/clipboard/copy', (req, res) => {
        trackUsage();
        try {
            const { image } = req.body;

            if (!image) {
                return res.status(400).json({
                    error: 'Missing image data'
                });
            }

            // Extract Base64 data (remove data URL prefix if present)
            let base64Data = image;
            if (image.startsWith('data:image/')) {
                base64Data = image.split(',')[1];
            }

            // Convert Base64 to Buffer
            const imageBuffer = Buffer.from(base64Data, 'base64');

            // Save to temp file first (more reliable than direct buffer)
            fs.writeFileSync(TEMP_FILE_PATH, imageBuffer);

            // Create NativeImage from file path (more reliable)
            const nativeImg = nativeImage.createFromPath(TEMP_FILE_PATH);

            if (nativeImg.isEmpty()) {
                // Try direct buffer approach as fallback
                const bufferImg = nativeImage.createFromBuffer(imageBuffer);
                if (bufferImg.isEmpty()) {
                    return res.status(400).json({
                        error: 'Invalid image data - could not parse image',
                        bufferSize: imageBuffer.length
                    });
                }
                clipboard.writeImage(bufferImg);
            } else {
                // Write to clipboard
                clipboard.writeImage(nativeImg);
            }

            // Clean up temp file
            try {
                fs.unlinkSync(TEMP_FILE_PATH);
            } catch (e) {
                // Ignore cleanup errors
            }

            res.json({
                success: true,
                message: 'Image copied to clipboard'
            });

        } catch (error) {
            console.error('Clipboard copy error:', error);
            res.status(500).json({
                error: error.message
            });
        }
    });

    // GET /api/clipboard/paste - Read image from clipboard
    expressApp.get('/api/clipboard/paste', (req, res) => {
        trackUsage();
        try {
            const image = clipboard.readImage();

            if (image.isEmpty()) {
                return res.status(404).json({
                    success: false,
                    message: 'No image in clipboard'
                });
            }

            const pngBuffer = image.toPNG();
            const base64Image = `data:image/png;base64,${pngBuffer.toString('base64')}`;

            res.json({
                success: true,
                image: base64Image
            });

        } catch (error) {
            console.error('Clipboard paste error:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    // POST /api/drag/start - Start drag and drop operation (supports multiple images)
    expressApp.post('/api/drag/start', (req, res) => {
        trackUsage();
        try {
            // Support both single image and array of images
            let images = req.body.images || [];

            // Backward compatibility: if single 'image' field is provided
            if (req.body.image && !req.body.images) {
                images = [req.body.image];
            }

            if (!images || images.length === 0) {
                return res.status(400).json({
                    error: 'Missing image data'
                });
            }

            // Cleanup previous session if any
            if (currentSessionFolder && fs.existsSync(currentSessionFolder)) {
                try {
                    fs.rmSync(currentSessionFolder, { recursive: true, force: true });
                } catch (e) {
                    console.error('Failed to cleanup previous session:', e);
                }
            }

            // Create unique session folder
            const sessionId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
            currentSessionFolder = path.join(WEBHELPER_TEMP_DIR, `ps_bridge_session_${sessionId}`);
            fs.mkdirSync(currentSessionFolder, { recursive: true });

            // Save all images to temp files
            const filePaths = [];
            for (let i = 0; i < images.length; i++) {
                let base64Data = images[i];

                // Extract Base64 data (remove data URL prefix if present)
                if (base64Data.startsWith('data:image/')) {
                    base64Data = base64Data.split(',')[1];
                }

                // Convert Base64 to Buffer and save
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const fileName = images.length === 1 ? 'image.png' : `image_${i + 1}.png`;
                const filePath = path.join(currentSessionFolder, fileName);
                fs.writeFileSync(filePath, imageBuffer);
                filePaths.push(filePath);
            }

            // Get current cursor position
            const cursorPoint = screen.getCursorScreenPoint();

            // Create floating drag window with first image as preview
            createDragWindow(filePaths[0], filePaths, cursorPoint.x, cursorPoint.y);

            res.json({
                success: true,
                message: `Drag window created with ${filePaths.length} image(s)`,
                count: filePaths.length
            });

        } catch (error) {
            console.error('Drag start error:', error);
            res.status(500).json({
                error: error.message
            });
        }
    });

    // POST /api/file/save - Save file (renaming if exists)
    expressApp.post('/api/file/save', (req, res) => {
        if (!IS_FILE_SAVE_ENABLED) {
            return res.status(403).json({
                success: false,
                supported: false,
                code: 'FEATURE_DISABLED',
                error: 'Endpoint /api/file/save is disabled for security reasons'
            });
        }

        try {
            const { path: targetPath, data } = req.body;

            if (!targetPath || !data) {
                return res.status(400).json({
                    error: 'Missing path or data'
                });
            }

            // Extract Base64 data
            let base64Data = data;
            if (data.startsWith('data:image/')) {
                base64Data = data.split(',')[1];
            }

            const buffer = Buffer.from(base64Data, 'base64');

            // Check if file exists and rename if necessary
            let finalPath = targetPath;
            const dir = path.dirname(targetPath);
            const ext = path.extname(targetPath);
            const name = path.basename(targetPath, ext);
            let counter = 1;

            while (fs.existsSync(finalPath)) {
                finalPath = path.join(dir, `${name}_${counter}${ext}`);
                counter++;
            }

            // Ensure directory exists
            fs.mkdirSync(dir, { recursive: true });

            // Write file
            fs.writeFileSync(finalPath, buffer);

            res.json({
                success: true,
                path: finalPath
            });

        } catch (error) {
            console.error('File save error:', error);
            res.status(500).json({
                error: error.message
            });
        }
    });

    // ============================================
    // WebHelper API Endpoints
    // ============================================

    // Serve static files for WebHelper
    expressApp.use('/webhelper', express.static(path.join(__dirname, 'webhelper')));

    // GET /api/is-local - Check if the request is from a local browser and identify device type
    expressApp.get('/api/is-local', (req, res) => {
        const isLocal = checkIsLocal(req);


        // 2. Mobile device check via User-Agent string (maby use npm-pakets like ua-parser-js or is-mobile)
        const userAgent = req.headers['user-agent'] || '';
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);

        // 3. Generate unique threadId for this session
        const threadId = crypto.randomUUID();

        res.json({ isLocal, isMobile, threadId });
    });


    // GET /webhelper/v0 — previous Spectre UI (fallback to /webhelper if excluded in packaged build)
    expressApp.get('/webhelper/v0', (req, res) => {
        const v0Path = path.join(__dirname, 'webhelper', 'v0', 'index.html');
        if (fs.existsSync(v0Path)) {
            res.sendFile(v0Path);
        } else {
            res.redirect('/webhelper');
        }
    });

    // // Bookmarks to the redesign folder land on the current UI.
    // expressApp.get(['/webhelper/v2', '/webhelper/v2/'], (req, res) => {
    //     res.redirect('/webhelper');
    // });

    // GET /webhelper — current generator UI
    expressApp.get('/webhelper', (req, res) => {
        res.sendFile(path.join(__dirname, 'webhelper', 'index.html'));
    });

    // GET /api/webhelper/providers - Get list of models/providers
    expressApp.get('/api/webhelper/providers', (req, res) => {
        try {
            const { providersPath } = getConfigPaths();
            if (fs.existsSync(providersPath)) {
                const providersRaw = fs.readFileSync(providersPath, 'utf8');
                const providersData = JSON5.parse(providersRaw);

                // 1. Filter out providers for which API keys are not defined in the system
                const availableProviders = (providersData.providers || []).filter(p => {
                    let configStr = JSON.stringify(p);

                    // Also check the referenced response_handler for env variables
                    if (p.response_config && p.response_config.$ref && providersData.response_handlers[p.response_config.$ref]) {
                        configStr += JSON.stringify(providersData.response_handlers[p.response_config.$ref]);
                    }

                    // Extract all "{{env:SOME_API_KEY}}" variables that this provider or its handler needs
                    const mapMatches = [...configStr.matchAll(/\{\{env:([a-zA-Z0-9_]+)\}\}/g)];
                    const requiredKeys = [...new Set(mapMatches.map(m => m[1]))];

                    // The provider is only available if ALL required API keys exist in process.env and are not empty
                    return requiredKeys.every(key => process.env[key] && process.env[key].trim() !== "");
                });

                // 2. Sanitize and elevate properties for the client
                const sanitizedProviders = availableProviders.map(p => {
                    const sanitized = { ...p };

                    // Elevate single_image_per_request to client level if it exists in request_config
                    if (p.request_config && p.request_config.single_image_per_request) {
                        sanitized.single_image_per_request = true;
                    } else {
                        sanitized.single_image_per_request = false;
                    }

                    delete sanitized.request_config;
                    delete sanitized.response_config;
                    delete sanitized.image_format;
                    delete sanitized.filename_suffix;
                    delete sanitized.preprocessor;
                    return sanitized;
                });
                res.json({ providers: sanitizedProviders });
            } else {
                res.json({ providers: [] });
            }
        } catch (error) {
            console.error('Error reading providers:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /api/webhelper/task - Create a new task and add to queue
    expressApp.post('/api/webhelper/task', (req, res) => {
        try {
            const { image, mask, threadId = 'FromPS' } = req.body;

            // Generate taskId
            const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

            // Extract Base64 data function
            const getBase64Buffer = (dataUrl) => {
                let base64Data = dataUrl;
                if (dataUrl && dataUrl.startsWith('data:image/')) {
                    base64Data = dataUrl.split(',')[1];
                }
                return base64Data ? Buffer.from(base64Data, 'base64') : null;
            };

            const getExt = (dataUrl) => {
                if (!dataUrl) return 'png';
                if (dataUrl.startsWith('data:image/')) {
                    // Data URI: extract MIME from the header
                    const mime = dataUrl.split(';')[0].substring(5);
                    return mimeTypeToExt(mime);
                }
                // Might be raw base64 — detect via magic bytes
                return mimeTypeToExt(detectMimeTypeFromBase64(dataUrl));
            };

            let imagePath = null;
            let imageExt = 'png';
            if (image) {
                const imageBuffer = getBase64Buffer(image);
                imageExt = getExt(image);
                imagePath = path.join(WEBHELPER_TEMP_DIR, `${taskId}_image.${imageExt}`);
                fs.writeFileSync(imagePath, imageBuffer);
            }

            let maskPath = null;
            let maskExt = 'png';
            if (mask && image) {
                const maskBuffer = getBase64Buffer(mask);
                maskExt = getExt(mask);
                maskPath = path.join(WEBHELPER_TEMP_DIR, `${taskId}_mask.${maskExt}`);
                fs.writeFileSync(maskPath, maskBuffer);
            }

            // Add to global state
            global.tasks[taskId] = {
                sourceImage: imagePath ? `/api/webhelper/file/${taskId}_image.${imageExt}` : null,
                maskImage: maskPath ? `/api/webhelper/file/${taskId}_mask.${maskExt}` : null,
                status: 'new',
                results: [],
                threadId: threadId
            };

            // Add to queue
            global.queue.push(taskId);

            res.json({ taskId });
        } catch (error) {
            console.error('Task creation error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /api/webhelper/task/from-file - Create a new task from an already-saved result file
    expressApp.post('/api/webhelper/task/from-file', (req, res) => {
        try {
            const { filename, sourceTaskId, threadId } = req.body;
            if (!threadId) {
                return res.status(400).json({ error: 'Missing threadId' });
            }

            if (!filename) {

                return res.status(400).json({ error: 'Missing filename' });
            }

            const normalizedTempDir = path.resolve(WEBHELPER_TEMP_DIR);

            // Security: prevent path traversal
            const filePath = path.join(WEBHELPER_TEMP_DIR, filename);
            if (!path.resolve(filePath).startsWith(normalizedTempDir)) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'Source file not found' });
            }

            // Generate new taskId
            const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

            const sourceExt = path.extname(filePath) || '.png';

            // Copy result file as the new task's source image
            const newImagePath = path.join(WEBHELPER_TEMP_DIR, `${taskId}_image${sourceExt}`);
            fs.copyFileSync(filePath, newImagePath);

            // Try to carry over the mask from the original task
            let newMaskPath = null;
            let newMaskExt = '.png';
            const sourceTask = sourceTaskId ? global.tasks[sourceTaskId] : null;
            if (sourceTask && sourceTask.maskImage) {
                // maskImage is a URL like /api/webhelper/file/{filename}, extract filename
                const maskFilename = sourceTask.maskImage.split('/').pop();
                const maskFilePath = path.join(WEBHELPER_TEMP_DIR, maskFilename);
                const originalMaskExt = path.extname(maskFilePath) || '.png';

                if (path.resolve(maskFilePath).startsWith(normalizedTempDir) && fs.existsSync(maskFilePath)) {
                    // Load both images to compare dimensions
                    const resultImg = nativeImage.createFromPath(filePath);
                    const maskImg = nativeImage.createFromPath(maskFilePath);

                    if (!resultImg.isEmpty() && !maskImg.isEmpty()) {
                        const resultSize = resultImg.getSize();
                        const maskSize = maskImg.getSize();

                        newMaskPath = path.join(WEBHELPER_TEMP_DIR, `${taskId}_mask${originalMaskExt}`);
                        newMaskExt = originalMaskExt;

                        if (resultSize.width !== maskSize.width || resultSize.height !== maskSize.height) {
                            // Resize mask to match result image dimensions (aspect ratio is assumed equal)
                            const scaledMask = maskImg.resize({ width: resultSize.width, height: resultSize.height });
                            newMaskPath = path.join(WEBHELPER_TEMP_DIR, `${taskId}_mask.png`);
                            newMaskExt = '.png';
                            fs.writeFileSync(newMaskPath, scaledMask.toPNG());
                        } else {
                            // Same size — just copy
                            fs.copyFileSync(maskFilePath, newMaskPath);
                        }
                    }
                }
            }

            // Register new task
            global.tasks[taskId] = {
                sourceImage: `/api/webhelper/file/${taskId}_image${sourceExt}`,
                maskImage: newMaskPath ? `/api/webhelper/file/${taskId}_mask${newMaskExt}` : null,
                status: 'new',
                results: [],
                threadId: threadId
            };


            global.queue.push(taskId);

            res.json({ taskId });
        } catch (error) {
            console.error('Task from-file creation error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/webhelper/queue - Get new pending tasks
    expressApp.get('/api/webhelper/queue', (req, res) => {
        const requesterThreadId = req.query.threadId;
        const isLocal = checkIsLocal(req);


        // Filter the queue based on locality and threadId
        const filteredQueue = global.queue.filter(taskId => {
            const task = global.tasks[taskId];
            if (!task) return false;

            if (isLocal) {
                // Local users see Photoshop tasks + their own session tasks
                return task.threadId === 'FromPS' || task.threadId === requesterThreadId;
            } else {
                // Remote users ONLY see their own session tasks
                return task.threadId === requesterThreadId;
            }
        });

        res.json({ tasks: filteredQueue });
    });


    // POST /api/webhelper/mark_opened - Mark tasks as picked up by browser
    expressApp.post('/api/webhelper/mark_opened', (req, res) => {
        try {
            const { taskIds } = req.body;
            if (!Array.isArray(taskIds)) {
                return res.status(400).json({ error: 'taskIds must be an array' });
            }

            // Remove from queue
            global.queue = global.queue.filter(id => !taskIds.includes(id));

            // Update status in global tasks
            for (const taskId of taskIds) {
                if (global.tasks[taskId] && global.tasks[taskId].status === 'new') {
                    global.tasks[taskId].status = 'accepted';
                }
            }

            res.json({ ok: true });
        } catch (error) {
            console.error('Mark opened error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/webhelper/task/:taskId - Get task details
    expressApp.get('/api/webhelper/task/:taskId', (req, res) => {
        const taskId = req.params.taskId;
        const task = global.tasks[taskId];

        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        res.json(task);
    });

    // GET /api/webhelper/filePreview/:filename - Serve optimized files specific to WebHelper
    expressApp.get('/api/webhelper/filePreview/:filename', (req, res) => {
        try {
            const filename = req.params.filename;
            const filePath = path.join(WEBHELPER_TEMP_DIR, filename);

            // Prevent path traversal attacks
            const normalizedPath = path.resolve(filePath);
            const normalizedTempDir = path.resolve(WEBHELPER_TEMP_DIR);

            if (!normalizedPath.startsWith(normalizedTempDir)) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            if (fs.existsSync(filePath)) {
                const maxSize = 1200;
                const minSize = 1;
                const step = 1;
                const jpgCompression = 80;
                const controller = parseImageInput(filePath);
                if (controller) {
                    const [nw, nh] = controller.getOptimizedSize(maxSize, minSize, step);
                    const resized = controller.image.resize({ width: nw, height: nh, quality: 'better' });
                    const buffer = resized.toJPEG(jpgCompression);
                    res.set('Content-Type', 'image/jpeg');
                    res.send(buffer);
                } else {
                    //res.sendFile(filePath);
                    throw new Error('File not processable');
                }
            } else {
                res.status(404).json({ error: 'File not found' });
            }
        } catch (error) {
            console.error('File serve error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // GET /api/webhelper/file/:filename - Serve files specific to WebHelper
    expressApp.get('/api/webhelper/file/:filename', (req, res) => {
        try {
            const filename = req.params.filename;
            const filePath = path.join(WEBHELPER_TEMP_DIR, filename);

            // Prevent path traversal attacks
            const normalizedPath = path.resolve(filePath);
            const normalizedTempDir = path.resolve(WEBHELPER_TEMP_DIR);

            if (!normalizedPath.startsWith(normalizedTempDir)) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            if (fs.existsSync(filePath)) {
                res.sendFile(filePath);
            } else {
                res.status(404).json({ error: 'File not found' });
            }
        } catch (error) {
            console.error('File serve error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /api/webhelper/file/copy2clipboard - Copy original file from disk to clipboard
    expressApp.post('/api/webhelper/file/copy2clipboard', (req, res) => {
        try {
            const { filename } = req.body;
            if (!filename) {
                return res.status(400).json({ error: 'Missing filename' });
            }

            const filePath = path.join(WEBHELPER_TEMP_DIR, filename);

            // Prevent path traversal attacks
            const normalizedPath = path.resolve(filePath);
            const normalizedTempDir = path.resolve(WEBHELPER_TEMP_DIR);

            if (!normalizedPath.startsWith(normalizedTempDir)) {
                return res.status(403).json({ error: 'Forbidden' });
            }

            if (!fs.existsSync(filePath)) {
                return res.status(404).json({ error: 'File not found' });
            }

            // Create NativeImage from file path (preserves full resolution)
            const nativeImg = nativeImage.createFromPath(filePath);

            if (nativeImg.isEmpty()) {
                return res.status(400).json({ error: 'Failed to create image from file' });
            }

            // Write to clipboard
            clipboard.writeImage(nativeImg);

            res.json({
                success: true,
                message: 'Original image copied to clipboard'
            });

        } catch (error) {
            console.error('High-res copy error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /api/webhelper/generate - Launch API generation
    expressApp.post('/api/webhelper/generate', async (req, res) => {
        trackUsage(2);
        const { taskId, providerId, num_images, aspect_ratio, params, referenceImages, use_mask, force_separate_requests } = req.body;

        try {
            // // MOCK TEST STUB: Throw test error immediately to track usage without invoking AI generation
            // throw new Error("Mock test mode: generation disabled for usage testing");

            // Update task status
            if (global.tasks[taskId]) {
                global.tasks[taskId].status = 'generating';
            }

            // Call the generation handler
            const newResults = await generate(taskId, providerId, num_images, aspect_ratio, params, referenceImages, use_mask, force_separate_requests, WEBHELPER_TEMP_DIR, global.tasks);

            // Append results to task
            if (global.tasks[taskId]) {
                global.tasks[taskId].results.push(...newResults);
                global.tasks[taskId].status = 'done';
            }

            res.json({ results: newResults });
        } catch (error) {
            console.error('Generation error:', error);
            const errorMsg = error.message || "Unknown error occurred";

            if (global.tasks[taskId]) {
                global.tasks[taskId].results.push({
                    error: errorMsg,
                    params: params,
                    providerId: providerId,
                    num_images: num_images,
                    aspect_ratio: aspect_ratio,
                    status: 'error'
                });
                global.tasks[taskId].status = 'error';
            }

            res.status(500).json({ error: errorMsg });
        }
    });

    // Start listening
    httpServer = expressApp.listen(PORT, '127.0.0.1', () => {
        console.log(`Photoshop Helper server running on http://localhost:${PORT}`);

        // Pair immediately, then keep refreshing so a plugin installed or first opened
        // later in this session picks up the token without a Helper restart.
        refreshPluginPairing();
        pairingRefreshTimer = setInterval(refreshPluginPairing, PAIRING_REFRESH_INTERVAL_MS);
    });

    httpServer.on('error', (error) => {
        console.error('Server error:', error);
        if (error.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use`);
        }
    });
}

ipcMain.on('start-drag', (event) => {
    if (currentFilePaths.length === 0) return;

    // Create a proper small drag icon using nativeImage
    let dragIcon;
    try {
        const img = nativeImage.createFromPath(currentFilePaths[0]);
        if (!img.isEmpty()) {
            // Resize to small icon (32x32) for drag cursor
            dragIcon = img.resize({ width: 32, height: 32 });
        }
    } catch (e) {
        console.error('Failed to create drag icon:', e);
    }

    // Fallback: create a simple colored icon if image loading failed
    if (!dragIcon || dragIcon.isEmpty()) {
        dragIcon = nativeImage.createEmpty();
    }

    try {
        if (currentFilePaths.length === 1) {
            // Single file drag
            event.sender.startDrag({
                file: currentFilePaths[0],
                icon: dragIcon
            });
        } else {
            // Multiple files drag
            event.sender.startDrag({
                files: currentFilePaths,
                icon: dragIcon
            });
        }
    } catch (e) {
        console.error('startDrag failed:', e);
    }
});

// Handle drag complete - close window and cleanup
ipcMain.on('drag-complete', () => {
    if (dragWindow && !dragWindow.isDestroyed()) {
        dragWindow.close();
        dragWindow = null;
    }

    // Cleanup session folder
    if (currentSessionFolder && fs.existsSync(currentSessionFolder)) {
        try {
            fs.rmSync(currentSessionFolder, { recursive: true, force: true });
        } catch (e) {
            console.error('Failed to cleanup session folder:', e);
        }
        currentSessionFolder = null;
        currentFilePaths = [];
    }
});

// App lifecycle
app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
        app.dock.hide();
    }

    log.info('Starting app initialization...');

    try {
        log.info('Initializing auto updater...');
        initializeAutoUpdater(() => updateTrayMenu());

        // Resolve both secrets before any route or setup window exists, so pairing can
        // occur immediately and the server has credentials ready.
        log.info('Resolving local API credentials...');
        pluginToken = await getPluginToken();
        localApiToken = await getLocalApiToken();

        setPairingRefresher(refreshPluginPairing);

        log.info('Running handleFirstRun...');
        await handleFirstRun();   // copies templates + shows wizard (packaged only)

        log.info('Creating tray icon...');
        await createTray();

        log.info('Starting HTTP server...');
        startHttpServer();

        log.info('App initialization completed successfully.');
    } catch (err) {
        log.error('Failed during app startup initialization:', err);
        throw err; // Global startCatching will catch this error and log a detailed report
    }
});

app.on('window-all-closed', () => {
    // Don't quit when all windows are closed (we're a tray app)
});

app.on('before-quit', () => {
    // Stop periodic update checks
    cleanupAutoUpdater();

    // Stop refreshing the plugin pairing file
    if (pairingRefreshTimer) {
        clearInterval(pairingRefreshTimer);
        pairingRefreshTimer = null;
    }

    // Clean up temp file
    if (fs.existsSync(TEMP_FILE_PATH)) {
        try {
            fs.unlinkSync(TEMP_FILE_PATH);
        } catch (e) {
            // Ignore cleanup errors
        }
    }

    // Close HTTP server
    if (httpServer) {
        httpServer.close();
    }
});
