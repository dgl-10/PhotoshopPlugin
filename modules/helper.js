/**
 * Photoshop Helper Service Module
 * Communicates with PhotoshopHelper Electron app for clipboard and drag & drop functionality
 */

// Configuration
const HELPER_URL = 'http://localhost:18345';
const HELPER_VERSION = '1.0.0';

/**
 * Check if PhotoshopHelper is running
 * @returns {Promise<boolean>}
 */
async function isHelperRunning() {

    // return {
    //     status: 'running',
    //     alerts: {
    //         photoshopPlugin: "Plugin version mismatch. Please right-click the PhotoshopHelper icon in the system tray, select 'Settings', and reinstall the plugin.",
    //         photoshopHelper: "PhotoshopHelper update is ready. Please right-click its icon in the system tray and select 'Update Ready, Restart' to apply."
    //     },
    //     version: "1.0.0"
    // };

    const { versions } = require("uxp");
    try {
        const pluginVersion = versions.plugin || 'unknown';
        const response = await fetch(`${HELPER_URL}/api/status?pluginVersion=${encodeURIComponent(pluginVersion)}`, {
            method: 'GET'
        });

        if (response.ok) {
            const data = await response.json();
            return data;
        }
        return null;
    } catch (error) {
        return null;
    }
}

/**
 * Copy image to clipboard via PhotoshopHelper
 * @param {string} base64Png - Base64 encoded PNG data (without data URL prefix)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function copyToClipboard(base64Png) {
    try {
        const response = await fetch(`${HELPER_URL}/api/clipboard/copy`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image: `data:image/png;base64,${base64Png}`
            })
        });

        const result = await response.json();

        if (!response.ok) {
            return {
                success: false,
                error: result.error || `HTTP ${response.status}`
            };
        }

        return result;

    } catch (error) {
        // Connection error - Helper not running
        if (error.name === 'TypeError' || error.message.includes('fetch') || error.message.includes('network')) {
            return {
                success: false,
                error: 'HELPER_NOT_RUNNING'
            };
        }

        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Start drag & drop operation via PhotoshopHelper
 * @param {string|string[]} base64Images - Single base64 PNG or array of base64 PNGs (without data URL prefix)
 * @returns {Promise<{success: boolean, message?: string, error?: string, count?: number}>}
 */
async function startDrag(base64Images) {
    try {
        // Normalize to array
        const imagesArray = Array.isArray(base64Images) ? base64Images : [base64Images];

        // Add data URL prefix to each image
        const images = imagesArray.map(b64 => `data:image/png;base64,${b64}`);

        const response = await fetch(`${HELPER_URL}/api/drag/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ images })
        });

        const result = await response.json();

        if (!response.ok) {
            return {
                success: false,
                error: result.error || `HTTP ${response.status}`
            };
        }

        return result;

    } catch (error) {
        // Connection error - Helper not running
        if (error.name === 'TypeError' || error.message.includes('fetch') || error.message.includes('network')) {
            return {
                success: false,
                error: 'HELPER_NOT_RUNNING'
            };
        }

        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Read image from clipboard via PhotoshopHelper
 * @returns {Promise<{success: boolean, image?: string, error?: string}>}
 */
async function readClipboard() {
    try {
        const response = await fetch(`${HELPER_URL}/api/clipboard/paste`, {
            method: 'GET'
        });

        const result = await response.json();

        if (!response.ok) {
            return {
                success: false,
                error: result.error || `HTTP ${response.status}`
            };
        }

        return result;

    } catch (error) {
        // Connection error - Helper not running
        if (error.name === 'TypeError' || error.message.includes('fetch') || error.message.includes('network')) {
            return {
                success: false,
                error: 'HELPER_NOT_RUNNING'
            };
        }

        return {
            success: false,
            error: error.message
        };
    }
}



/**
 * Save file via PhotoshopHelper (auto-renames if exists)
 * @param {string} fullPath - Full path to save to
 * @param {string} base64Data - Base64 data (with or without prefix)
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
async function saveViaHelper(fullPath, base64Data) {
    try {
        const response = await fetch(`${HELPER_URL}/api/file/save`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: fullPath,
                data: base64Data
            })
        });

        const result = await response.json();

        if (!response.ok) {
            return {
                success: false,
                error: result.error || `HTTP ${response.status}`
            };
        }

        return result;

    } catch (error) {
        // Connection error - Helper not running
        if (error.name === 'TypeError' || error.message.includes('fetch') || error.message.includes('network')) {
            return {
                success: false,
                error: 'HELPER_NOT_RUNNING'
            };
        }

        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Send image and mask to WebHelper via PhotoshopHelper
 * @param {string} base64Image - Base64 encoded PNG data (with data URL prefix)
 * @param {string} base64Mask - Base64 encoded PNG data (with data URL prefix)
 * @returns {Promise<{success: boolean, message?: string, taskId?: string, error?: string}>}
 */
async function sendToWebHelper(base64Image, base64Mask) {
    try {
        const payload = { image: base64Image };
        if (base64Mask) {
            payload.mask = base64Mask;
        }

        const response = await fetch(`${HELPER_URL}/api/webhelper/task`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (!response.ok) {
            return {
                success: false,
                error: result.error || `HTTP ${response.status}`
            };
        }

        return {
            success: true,
            taskId: result.taskId
        };

    } catch (error) {
        // Connection error - Helper not running
        if (error.name === 'TypeError' || error.message.includes('fetch') || error.message.includes('network')) {
            return {
                success: false,
                error: 'HELPER_NOT_RUNNING'
            };
        }

        return {
            success: false,
            error: error.message
        };
    }
}

module.exports = {
    HELPER_URL,
    HELPER_VERSION,
    isHelperRunning,
    copyToClipboard,
    readClipboard,
    startDrag,
    saveViaHelper,
    sendToWebHelper
};
