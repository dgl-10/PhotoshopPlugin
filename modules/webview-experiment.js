'use strict';

/**
 * Experimental stand module for testing UXP <webview> in Photoshop plugin.
 * Isolated from production AI Assist code.
 */

const { versions, shell } = require('uxp');
let psApp = null;
try {
    psApp = require('photoshop').app;
} catch (e) {
    // Photoshop app might not be available in mock or unit test environments
}

const HELPER_WEBVIEW_URL = 'http://127.0.0.1:18345/webview-test/';
const LOCAL_WEBVIEW_URL = 'plugin:/local-webview-test.html';

let isInitialized = false;
let messageListenerWired = false;
let activeDialog = null;

/**
 * Parse major version number from semantic version string
 * @param {string} verStr - Version string (e.g., "8.1.0")
 * @returns {number} Major version number
 */
function getMajorVersion(verStr) {
    if (!verStr || typeof verStr !== 'string') return 0;
    const match = verStr.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

/**
 * Initialize webview dialog and wire event listeners
 */
function ensureInitialized() {
    if (isInitialized) return;

    const dialog = document.getElementById('webview-test-dialog');
    const webview = document.getElementById('webview-test-element');
    const errorOverlay = document.getElementById('webview-test-error');
    const statusText = document.getElementById('webview-test-status');

    if (!dialog || !webview) {
        console.error('[webview-test] Required DOM elements not found in document');
        return;
    }

    // Set version labels in dialog header
    const versionLabel = document.getElementById('webview-test-versions');
    if (versionLabel) {
        const uxpVer = versions.uxp || 'unknown';
        const psVer = psApp ? psApp.version : 'unknown';
        const pluginVer = versions.plugin || 'unknown';
        versionLabel.textContent = `UXP: ${uxpVer} | PS: ${psVer} | Plugin: ${pluginVer}`;
    }

    // Webview lifecycle events
    webview.addEventListener('loadstart', (e) => {
        console.log(`[webview-test] loadstart: URL=${e.url}`);
        if (statusText) statusText.textContent = 'Loading...';
        if (errorOverlay) errorOverlay.style.display = 'none';
    });

    webview.addEventListener('loadstop', (e) => {
        console.log(`[webview-test] loadstop: URL=${e.url}`);
        if (statusText) statusText.textContent = 'Loaded';
        if (errorOverlay) errorOverlay.style.display = 'none';

        // Send initial greeting to webview once loaded
        try {
            webview.postMessage({
                type: 'plugin-greeting',
                source: 'FromPS-ToPS Plugin',
                versions: {
                    uxp: versions.uxp || 'unknown',
                    ps: psApp ? psApp.version : 'unknown',
                    plugin: versions.plugin || 'unknown'
                },
                timestamp: Date.now()
            });
        } catch (msgErr) {
            console.warn('[webview-test] Failed to post initial greeting:', msgErr);
        }
    });

    webview.addEventListener('loaderror', (e) => {
        console.error(`[webview-test] loaderror: URL=${e.url}, code=${e.code}, message=${e.message}`);
        if (statusText) statusText.textContent = `Error (${e.code})`;
        if (errorOverlay) {
            errorOverlay.style.display = 'flex';
            const detailEl = document.getElementById('webview-test-error-detail');
            if (detailEl) {
                detailEl.textContent = `Code: ${e.code} | ${e.message || 'Helper connection failed'}`;
            }
        }
    });

    // Close button inside plugin dialog header
    const closeHeaderBtn = document.getElementById('webview-test-btn-close');
    if (closeHeaderBtn) {
        closeHeaderBtn.addEventListener('click', () => {
            dialog.close();
        });
    }

    // Webview lifecycle events for panel-embedded instance
    const panelWebview = document.getElementById('webview-test-panel-element');
    const panelStatus = document.getElementById('webview-panel-status');
    if (panelWebview) {
        panelWebview.addEventListener('loadstart', (e) => {
            console.log(`[webview-test:panel] loadstart: URL=${e.url}`);
            if (panelStatus) panelStatus.textContent = 'Loading...';
        });
        panelWebview.addEventListener('loadstop', (e) => {
            console.log(`[webview-test:panel] loadstop: URL=${e.url}`);
            if (panelStatus) panelStatus.textContent = 'Loaded';
        });
        panelWebview.addEventListener('loaderror', (e) => {
            console.error(`[webview-test:panel] loaderror: URL=${e.url}, code=${e.code}, message=${e.message}`);
            if (panelStatus) panelStatus.textContent = `Error (${e.code})`;
        });
    }

    // Listen to messages from WebView (MessageBridge)
    if (!messageListenerWired) {
        window.addEventListener('message', (event) => {
            console.log(`[webview-test] Plugin received message from Origin=${event.origin}:`, event.data);

            const payload = event.data;
            if (!payload || typeof payload !== 'object') return;

            if (payload.type === 'close-dialog') {
                console.log('[webview-test] Close requested via message bridge');
                if (dialog && dialog.open) {
                    dialog.close();
                }
            } else if (payload.type === 'open-external' && payload.url) {
                console.log('[webview-test] Opening external URL via shell.openExternal:', payload.url);
                try {
                    shell.openExternal(payload.url);
                } catch (shellErr) {
                    console.error('[webview-test] shell.openExternal failed:', shellErr);
                }
            } else if (payload.type === 'ping' || payload.type === 'local-ping') {
                console.log('[webview-test] Replying pong to webview');
                try {
                    webview.postMessage({
                        type: 'pong',
                        replyTo: payload,
                        pluginTimestamp: Date.now()
                    });
                } catch (replyErr) {
                    console.warn('[webview-test] Could not reply pong:', replyErr);
                }
            }
        });
        messageListenerWired = true;
    }

    isInitialized = true;
}

/**
 * Open webview in a non-modal dialog (dialog.show)
 */
function showWebviewNonModal() {
    ensureInitialized();
    const dialog = document.getElementById('webview-test-dialog');
    const webview = document.getElementById('webview-test-element');
    if (!dialog || !webview) return;

    activeDialog = dialog;

    console.log('[webview-test] Opening non-modal dialog.show()...');
    try {
        dialog.show({ size: { width: 520, height: 640 } });
    } catch (e) {
        console.warn('[webview-test] dialog.show({size}) failed, retrying dialog.show():', e);
        try {
            dialog.show();
        } catch (err2) {
            console.error('[webview-test] dialog.show() completely failed:', err2);
            return;
        }
    }

    // Set src after the dialog window is displayed so the native window handle is ready
    if (webview.src !== HELPER_WEBVIEW_URL) {
        webview.src = HELPER_WEBVIEW_URL;
    } else if (typeof webview.reload === 'function') {
        webview.reload();
    } else {
        webview.src = HELPER_WEBVIEW_URL;
    }
}

/**
 * Open webview in a modal dialog (dialog.showModal)
 */
function showWebviewModal() {
    ensureInitialized();
    const dialog = document.getElementById('webview-test-dialog');
    const webview = document.getElementById('webview-test-element');
    if (!dialog || !webview) return;

    activeDialog = dialog;

    console.log('[webview-test] Opening modal dialog.showModal()...');
    try {
        dialog.showModal({ size: { width: 520, height: 640 } });
    } catch (e) {
        console.warn('[webview-test] dialog.showModal({size}) failed, retrying dialog.showModal():', e);
        try {
            dialog.showModal();
        } catch (err2) {
            console.error('[webview-test] dialog.showModal() completely failed:', err2);
            return;
        }
    }

    // Set src after the modal dialog window is displayed
    if (webview.src !== HELPER_WEBVIEW_URL) {
        webview.src = HELPER_WEBVIEW_URL;
    } else if (typeof webview.reload === 'function') {
        webview.reload();
    } else {
        webview.src = HELPER_WEBVIEW_URL;
    }
}

/**
 * Toggle webview embedded inside the main panel
 */
function togglePanelWebview() {
    ensureInitialized();
    const container = document.getElementById('webview-test-panel-block');
    const webview = document.getElementById('webview-test-panel-element');
    if (!container || !webview) {
        console.error('[webview-test] Panel container or webview not found');
        return;
    }

    if (container.style.display === 'none' || !container.style.display) {
        container.style.display = 'block';
        webview.src = HELPER_WEBVIEW_URL;
        console.log('[webview-test] Embedded panel webview shown with URL:', HELPER_WEBVIEW_URL);
    } else {
        container.style.display = 'none';
        webview.src = 'about:blank';
        console.log('[webview-test] Embedded panel webview hidden');
    }
}

/**
 * Open local page from plugin folder (plugin:/local-webview-test.html)
 */
function showLocalWebview() {
    const uxpMajor = getMajorVersion(versions.uxp);
    console.log(`[webview-test] Testing local webview. UXP version: ${versions.uxp} (Major: ${uxpMajor})`);

    if (uxpMajor < 8) {
        const msg = `Local webview rendering requires UXP v8.0+. Current version is UXP ${versions.uxp || 'unknown'}. Remote URLs only.`;
        console.warn(`[webview-test] ${msg}`);
        alert(msg);
        return;
    }

    ensureInitialized();
    const dialog = document.getElementById('webview-test-dialog');
    const webview = document.getElementById('webview-test-element');
    if (!dialog || !webview) return;

    activeDialog = dialog;
    webview.src = LOCAL_WEBVIEW_URL;

    console.log('[webview-test] Opening local webview page via dialog.show()...');
    try {
        dialog.show({ size: { width: 520, height: 640 } });
    } catch (e) {
        dialog.show();
    }
}

/**
 * Handle menu invocation from panel
 * @param {string} menuId - Menu item ID
 */
function handleMenu(menuId) {
    switch (menuId) {
        case 'testWebviewNonModal':
            showWebviewNonModal();
            break;
        case 'testWebviewModal':
            showWebviewModal();
            break;
        case 'testWebviewPanel':
            togglePanelWebview();
            break;
        case 'testWebviewLocal':
            showLocalWebview();
            break;
        default:
            console.warn(`[webview-test] Unhandled test menu id: ${menuId}`);
    }
}

module.exports = {
    handleMenu,
    showWebviewNonModal,
    showWebviewModal,
    togglePanelWebview,
    showLocalWebview
};
