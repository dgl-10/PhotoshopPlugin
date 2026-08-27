/**
 * FromPS / ToPS - Main Plugin Entry Point
 * Photoshop UXP Plugin for capturing selections and placing results
 */

// Import modules
const ps = require('./modules/ps.js');
const fsModule = require('./modules/fs.js');
const ui = require('./modules/ui.js');
const settings = require('./modules/settings.js');

const helper = require('./modules/helper.js');
const imageUtils = require('./modules/image-utils.js');

const { entrypoints, versions } = require("uxp");

// Global state
let capturedPayloads = [];
let capturedPayload = null;  // Stores captured image, mask, bounds, context
let resultImage = null;      // Stores loaded result image data
let resultFilePath = null;   // Native path to result file
let resultFileToken = null;  // Session token for result file
let currentFeatherOptions = { enabled: false }; // Mask feathering bias settings

// Shown when PhotoshopHelper is reachable but rejects this plugin's credentials. It is a
// distinct case from the Helper being absent, and needs a different fix from the user.
const HELPER_NOT_PAIRED_MESSAGE = 'Helper not paired! Add its token in Settings';

/**
 * Initialize plugin
 */
function init() {
    console.log('FromPS/ToPS plugin (' + versions.plugin + ') initializing...');

    // Initialize UI state
    ui.initUI();

    // Initialize settings
    settings.initSettings();

    // Setup UXP entrypoints for flyout menu
    entrypoints.setup({
        panels: {
            "fromps-tops-panel": {
                show() {
                    console.log("Panel shown");
                },
                menuItems: [
                    { id: "clearAll", label: "Clear All" },
                    "-",
                    { id: "settings", label: "Settings..." }
                ],
                invokeMenu(id) {
                    if (id === "clearAll") {
                        handleClearAll();
                    } else if (id === "settings") {
                        settings.showSettingsDialog();
                    }
                }
            }
        }
    });

    // Initialize source-selection dropdown with default "Waiting for capture..." item
    ui.resetSourceDropdown(capturedPayloads);

    // Initialize sp-picker value
    const picker = document.getElementById('source-mode');
    if (picker) {
        // Set initial value programmatically
        picker.value = 'copyMerged';

        // Listen for change events
        picker.addEventListener('change', (e) => {
            console.log('Source mode changed to:', e.target.value);
        });
    }

    // Set up event listeners
    setupEventListeners();

    // Start checking Photoshop Helper status
    startHelperStatusPolling();

    console.log('FromPS/ToPS plugin initialized');
}

/**
 * Set up all event listeners
 */
function setupEventListeners() {
    // FromPS Card
    let handlerSaveLogic = (mode) => {
        if (mode === 'imageOnly') {
            handleSaveImage();
        } else if (mode === 'maskOnly') {
            handleSaveMask();
        } else if (mode === 'imageAndMask') {
            handleSaveAndMask();
        }
    }

    document.getElementById('btn-capture').addEventListener('click', () => {
        const menu = document.querySelector('#capture-options-menu sp-menu');
        const mode = menu ? menu.value : 'direct';
        const viaTempDoc = mode === 'viaTempDoc' || mode === 'fullDocViaTempDoc';
        const fullDocMask = mode === 'fullDoc' || mode === 'fullDocViaTempDoc';
        handleCapture(viaTempDoc, fullDocMask);
    });
    document.getElementById('btn-save-image').addEventListener('click', () => {
        const menu = document.querySelector('#save-options-menu sp-menu');
        const mode = menu ? menu.value : 'imageOnly';
        handlerSaveLogic(mode);
    });
    document.getElementById('btn-copy').addEventListener('click', handleCopyToClipboard);
    document.getElementById('btn-copy-mask').addEventListener('click', handleCopyMask);
    document.getElementById('btn-clear-fromps').addEventListener('click', handleClearFromPS);
    document.getElementById('btn-drag').addEventListener('click', () => {
        const menu = document.querySelector('#drag-options-menu sp-menu');
        const mode = menu ? menu.value : 'imageOnly';
        handleDragOut(mode);
    });

    // Setup dropdown menus
    setupDropdownMenu('btn-capture-options', 'capture-options-menu', (value) => {
        console.log('Capture mode changed to:', value);
        const viaTempDoc = value === 'viaTempDoc' || value === 'fullDocViaTempDoc';
        const fullDocMask = value === 'fullDoc' || value === 'fullDocViaTempDoc';
        handleCapture(viaTempDoc, fullDocMask);
    });
    setupDropdownMenu('btn-save-options', 'save-options-menu', (value) => {
        console.log('Save mode changed to:', value);
        handlerSaveLogic(value);
    });
    setupDropdownMenu('btn-drag-options', 'drag-options-menu', (value) => {
        console.log('Drag mode changed to:', value);
        handleDragOut(value);
    });
    setupDropdownMenu('btn-place-back-options', 'place-back-options-menu', (value) => {
        console.log('Place back mode changed to:', value);
        updatePlaceButtonState();
        const mode = value == 'maskSmartObject' ? 'mask' :
            value == 'smartObjectSlow' ? 'editableSo' :
                value == 'restoreSelection' ? 'selection' : 'so';
        handlePlaceBack(mode);
    });

    // Source selection dropdown — switch active capture
    document.getElementById('source-selection').addEventListener('change', (e) => {
        handleSourceSelection(e.target.value);
    });


    // ToPS Card
    document.getElementById('btn-load-file').addEventListener('click', handleLoadFile);
    document.getElementById('btn-paste').addEventListener('click', handlePaste);
    document.getElementById('btn-place-back').addEventListener('click', () => {
        const menu = document.querySelector('#place-back-options-menu sp-menu');
        const value = menu ? menu.value : 'smartObjectFast';
        const mode = value == 'maskSmartObject' ? 'mask' :
            value == 'smartObjectSlow' ? 'editableSo' :
                value == 'restoreSelection' ? 'selection' : 'so';
        handlePlaceBack(mode);
    });
    document.getElementById('btn-clear-tops').addEventListener('click', handleClearToPS);

    // Setup Feather Bias segmented buttons
    setupFeatherControls();
}

/**
 * Apply feather panel visibility based on user settings
 */
function applyFeatherVisibility() {
    const isShown = settings.getShowFeatherPanel();
    const container = document.getElementById('middle-controls-container');
    if (container) {
        if (isShown) {
            container.classList.remove('feather-hidden');
            container.classList.add('feather-visible');
        } else {
            container.classList.remove('feather-visible');
            container.classList.add('feather-hidden');
        }
    }
}

const FEATHER_LABELS = {
    'off': 'Off',
    '1': 'Outward',
    '0': 'Center',
    '-1': 'Inward'
};

/**
 * Update the Feather segmented buttons UI to reflect the active selection
 * @param {string} value - 'off', '1', '0', or '-1'
 */
function setFeatherButtonsUI(value) {
    const strVal = String(value);
    const featherButtons = document.querySelectorAll('.feather-btn');
    featherButtons.forEach(b => {
        if (b.dataset.value === strVal) {
            b.setAttribute('selected', '');
            b.classList.add('selected');
        } else {
            b.removeAttribute('selected');
            b.classList.remove('selected');
        }
    });

    const statusLabel = document.getElementById('feather-status-label');
    if (statusLabel) {
        statusLabel.textContent = FEATHER_LABELS[strVal] || 'Off';
    }
}

/**
 * Setup Feather Bias segmented buttons (sync horizontal and vertical panels)
 */
function setupFeatherControls() {
    // Initial load from settings
    const stored = settings.getFeatherSettings();
    currentFeatherOptions = Object.assign({}, stored);

    // Sync initial UI state: if enabled is true, bias is 1; if enabled is false, off
    if (!currentFeatherOptions.enabled) {
        setFeatherButtonsUI('off');
    } else {
        const valStr = currentFeatherOptions.bias !== undefined ? String(currentFeatherOptions.bias) : '1';
        setFeatherButtonsUI(valStr);
    }

    const featherButtons = document.querySelectorAll('.feather-btn');
    featherButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.dataset.value;
            setFeatherButtonsUI(val);

            if (val === 'off') {
                currentFeatherOptions.enabled = false;
                currentFeatherOptions.bias = 1.0;
                settings.saveFeatherSettings(currentFeatherOptions);
            } else {
                currentFeatherOptions.enabled = true;
                currentFeatherOptions.bias = parseFloat(val);
                // Save enabled state, keeping bias locked to 1.0 in persistent settings
                settings.saveFeatherSettings(Object.assign({}, currentFeatherOptions, { bias: 1.0 }));
            }
        });
    });

    // Apply initial panel visibility and listen for changes from Settings dialog
    applyFeatherVisibility();
    settings.onSettingsChanged(() => {
        applyFeatherVisibility();
    });
}

/**
 * Setup dropdown menu for split buttons
 */
function setupDropdownMenu(buttonId, menuId, onSelect) {
    const button = document.getElementById(buttonId);
    const menu = document.getElementById(menuId);

    if (!button || !menu) return;

    // Toggle menu on button click
    button.addEventListener('click', (e) => {
        e.stopPropagation();

        // Close all other menus
        document.querySelectorAll('.save-options-menu, .drag-options-menu, .capture-options-menu, .place-back-options-menu').forEach(m => {
            if (m !== menu) m.style.display = 'none';
        });

        const isVisible = menu.style.display !== 'none';
        menu.style.display = isVisible ? 'none' : 'block';
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
        if (!menu.contains(e.target) && e.target !== button) {
            menu.style.display = 'none';
        }
    });

    // Handle menu item selection
    const spMenu = menu.querySelector('sp-menu');
    if (spMenu) {
        spMenu.addEventListener('click', (e) => {
            const item = e.target.closest('sp-menu-item');
            if (!item || item.disabled) return;

            const selectedValue = item.value;

            // Update selection UI manually
            spMenu.querySelectorAll('sp-menu-item').forEach(i => {
                if (i === item) {
                    i.setAttribute('selected', '');
                } else {
                    i.removeAttribute('selected');
                }
            });

            menu.style.display = 'none';
            if (onSelect) onSelect(selectedValue);
        });
    }
}

// ===== FromPS Handlers =====

/**
 * Handle Capture Selection button click
 */
async function handleCapture(viaTempDocCreation, fullDocMask = false) {
    ui.clearStatus('fromps');

    try {
        // Check preconditions
        if (!ps.hasActiveDocument()) {
            ui.showError('fromps', 'No active document');
            return;
        }

        const hasSelection = await ps.hasActiveSelection();
        if (!hasSelection) {
            ui.showError('fromps', 'No active selection');
            return;
        }

        ui.showInfo('fromps', 'Capturing...');

        // Get source mode
        const sourceMode = ui.getSourceMode();

        if (capturedPayload) {
            // Offload heavy pixel data to temp files to free memory
            await fsModule.offloadPayloadPixels(capturedPayload);
        }

        // Capture selection
        capturedPayload = await ps.captureSelection(sourceMode, viaTempDocCreation, fullDocMask);
        capturedPayloads.push(capturedPayload);
        const newIndex = capturedPayloads.length - 1;

        console.log('Captured payload:', {
            bounds: capturedPayload.bounds,
            context: capturedPayload.context
        });

        // Get preview data URL and cache it in the payload for future switches
        const previewUrl = await fsModule.getPreviewDataUrl(capturedPayload);
        // Overlay is preview-only. Keep it compact and use the release-safe renderer
        // selected in image-utils; the full-resolution mask remains untouched for
        // save, drag and Place Back operations.
        const overlayUrl = await imageUtils.generateOverlayMaskForPreview(capturedPayload.maskData);
        capturedPayload.previewDataUrl = previewUrl; // Cache to avoid re-encoding on switch
        // Extract base64 string from data URL for copy/save/drag operations after switch
        capturedPayload.imageBase64 = previewUrl ? previewUrl.split(',')[1] : null;

        if (previewUrl) {
            ui.showFromPSPreview(previewUrl, overlayUrl);
            const ratioInfo = capturedPayload.aspectRatio ? ` [${capturedPayload.aspectRatio}]` : '';
            ui.showInfo('fromps', `Captured: ${capturedPayload.bounds.width}×${capturedPayload.bounds.height}${ratioInfo}`);
        } else {
            ui.showError('fromps', 'Failed to generate preview');
        }

        // Update source-selection dropdown with all captures
        ui.updateSourceDropdown(capturedPayloads, newIndex);

    } catch (error) {
        console.error('Capture error:', error);
        ui.showError('fromps', error.message || 'Capture failed');
    }
}

/**
 * Handle Clear button in FromPS card
 */
async function handleClearFromPS() {
    if (capturedPayload) {
        // Offload heavy pixel data to temp files to free memory
        await fsModule.offloadPayloadPixels(capturedPayload);
    }
    capturedPayload = null;
    ui.clearFromPSPreview();
    ui.resetSourceDropdown(capturedPayloads);
}

/**
 * Handle Clear All (FromPS + ToPS)
 */
async function handleClearAll() {
    console.log('Clearing all states...');

    // Clear FromPS
    for (const payload of capturedPayloads) {
        await fsModule.offloadPayloadPixels(payload);
    }
    capturedPayloads = [];
    capturedPayload = null;
    ui.clearFromPSPreview();
    ui.resetSourceDropdown(capturedPayloads);

    // Clear ToPS
    handleClearToPS();

    ui.showInfo('fromps', 'All cleared ✓');
}

/**
 * Handle source selection from dropdown
 */
async function handleSourceSelection(val) {
    // Default item selected — auto-Clean
    if (val === '-1') {
        await handleClearFromPS();
        return;
    }

    const idx = parseInt(val, 10);
    if (isNaN(idx) || !capturedPayloads[idx] || capturedPayloads[idx] === capturedPayload) return;

    try {
        // 1. Offload current payload's pixels to free memory
        if (capturedPayload) {
            await fsModule.offloadPayloadPixels(capturedPayload);
        }

        // 2. Switch to selected payload
        capturedPayload = capturedPayloads[idx];

        // 3. Reload pixel data from temp files (maskData only — previewDataUrl already cached)
        await fsModule.reloadPayloadPixels(capturedPayload);

        // 4. Update preview using cached URL; regenerate overlay from restored maskData
        const previewUrl = capturedPayload.previewDataUrl || await fsModule.getPreviewDataUrl(capturedPayload);
        const overlayUrl = await imageUtils.generateOverlayMaskForPreview(capturedPayload.maskData);
        if (previewUrl) {
            ui.showFromPSPreview(previewUrl, overlayUrl);
            const ratioInfo = capturedPayload.aspectRatio ? ` [${capturedPayload.aspectRatio}]` : '';
            ui.showInfo('fromps', `Capture ${idx + 1}: ${capturedPayload.bounds.width}×${capturedPayload.bounds.height}${ratioInfo}`);
        }
    } catch (error) {
        console.error('Source switch error:', error);
        ui.showError('fromps', 'Failed to switch capture');
    }
}


/**
 * Gets a safe base filename from the captured layer name
 * Removes forbidden characters: / \ : * ? " < > |
 */
function getSafeBaseName(defaultName = 'capture') {
    if (!capturedPayload || !capturedPayload.context || !capturedPayload.context.layerName) {
        return defaultName;
    }
    // Replace forbidden characters with underscore and trim
    return capturedPayload.context.layerName
        .replace(/[\\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ') // Collapse multiple spaces
        .trim();
}

/**
 * Handle Save Image button click
 */
async function handleSaveImage() {
    if (!capturedPayload || !capturedPayload.imageData) {
        ui.showError('fromps', 'No image to save');
        return;
    }

    try {
        ui.showInfo('fromps', 'Saving image...');

        const safeName = getSafeBaseName();
        const defaultName = `${safeName}_capture.png`;

        const success = await fsModule.saveImage(capturedPayload, defaultName);

        if (success) {
            ui.showInfo('fromps', 'Image saved successfully');
        } else {
            ui.clearStatus('fromps'); // User cancelled
        }
    } catch (error) {
        console.error('Save image error:', error);
        ui.showError('fromps', 'Failed to save image');
    }
}

/**
 * Handle Save Mask button click
 */
async function handleSaveMask() {
    if (!capturedPayload || !capturedPayload.maskData) {
        ui.showError('fromps', 'No mask to save');
        return;
    }

    try {
        ui.showInfo('fromps', 'Saving mask...');

        const safeName = getSafeBaseName();
        const defaultName = `${safeName}_mask.png`;

        const success = await fsModule.saveMask(capturedPayload.maskData, defaultName);

        if (success) {
            ui.showInfo('fromps', 'Mask saved successfully');
        } else {
            ui.clearStatus('fromps');
        }
    } catch (error) {
        console.error('Save mask error:', error);
        ui.showError('fromps', 'Failed to save mask');
    }
}

/**
 * Handle Save Image & Mask button click
 */
async function handleSaveAndMask() {
    if (!capturedPayload || !capturedPayload.imageData) {
        ui.showError('fromps', 'No image to save');
        return;
    }

    try {
        ui.showInfo('fromps', 'Select location for image...');

        const safeName = getSafeBaseName();
        // We now pass a default filename with extension to getFileForSaving
        const defaultName = `${safeName}.png`;

        const result = await fsModule.saveImageAndMask(capturedPayload, defaultName);

        if (!result || result.cancelled) {
            ui.clearStatus('fromps'); // User cancelled
            return;
        }

        if (result.maskSaved) {
            ui.showInfo('fromps', 'Image and mask saved successfully');
        } else if (capturedPayload.maskData) {
            // Mask auto-save via Helper was not possible (e.g. disabled or helper offline).
            // Fallback: prompt the user with a file picker dialog to save the mask directly via UXP.
            ui.showInfo('fromps', 'Image saved. Choose location for mask...');
            const maskDefaultName = `${safeName}_mask.png`;
            const maskSaved = await fsModule.saveMask(capturedPayload.maskData, maskDefaultName);

            if (maskSaved) {
                ui.showInfo('fromps', 'Image and mask saved successfully');
            } else {
                ui.showInfo('fromps', 'Image saved (mask save cancelled)');
            }
        } else {
            ui.showInfo('fromps', 'Image saved successfully');
        }
    } catch (error) {
        if (error.message && error.message.startsWith('MASK_EXISTS')) {
            const maskName = error.message.split(':')[1] || 'mask file';
            ui.showError('fromps', `Mask exists: ${maskName}`);
        } else {
            console.error('Save both error:', error);
            ui.showError('fromps', error.message || 'Failed to save files');
        }
    }
}

/**
 * Handle Copy to Clipboard button click
 * Uses Photoshop Helper webservice for reliable clipboard access
 */
async function handleCopyToClipboard() {
    if (!capturedPayload) {
        ui.showError('fromps', 'No image to copy');
        return;
    }

    try {
        ui.showInfo('fromps', 'Copying to clipboard...');

        // Get image as base64 PNG — use cached value if available (avoids re-encoding after switch)
        const base64 = capturedPayload.imageBase64 || await fsModule.imageDataToBase64(capturedPayload.imageData);

        if (!base64) {
            ui.showError('fromps', 'Failed to encode image');
            return;
        }

        // Call Photoshop Helper webservice
        const result = await helper.copyToClipboard(base64);

        if (result.success) {
            ui.showInfo('fromps', 'Copied to clipboard ✓');
        } else if (result.error === 'HELPER_NOT_RUNNING') {
            ui.showError('fromps', 'Helper not running! Start PhotoshopHelper app');
        } else if (result.error === 'HELPER_NOT_PAIRED') {
            ui.showError('fromps', HELPER_NOT_PAIRED_MESSAGE);
        } else {
            ui.showError('fromps', `Clipboard failed: ${result.error}`);
        }

    } catch (error) {
        console.error('Clipboard error:', error);
        ui.showError('fromps', `Clipboard failed: ${error.message}`);
    }
}

/**
 * Handle Copy Mask to Clipboard button click
 */
async function handleCopyMask() {
    if (!capturedPayload || !capturedPayload.maskData) {
        ui.showError('fromps', 'No mask to copy');
        return;
    }

    try {
        ui.showInfo('fromps', 'Copying mask...');

        // Get mask as base64 PNG
        const base64 = await fsModule.maskDataToBase64(capturedPayload.maskData);

        if (!base64) {
            ui.showError('fromps', 'Failed to encode mask');
            return;
        }

        // Call Photoshop Helper webservice
        const result = await helper.copyToClipboard(base64);

        if (result.success) {
            ui.showInfo('fromps', 'Mask copied to clipboard ✓');
        } else if (result.error === 'HELPER_NOT_RUNNING') {
            ui.showError('fromps', 'Helper not running! Start PhotoshopHelper app');
        } else if (result.error === 'HELPER_NOT_PAIRED') {
            ui.showError('fromps', HELPER_NOT_PAIRED_MESSAGE);
        } else {
            ui.showError('fromps', `Clipboard failed: ${result.error}`);
        }

    } catch (error) {
        console.error('Clipboard error:', error);
        ui.showError('fromps', `Clipboard failed: ${error.message}`);
    }
}

/**
 * Handle Drag button click in FromPS card
 * Sends both image and mask as two files via PhotoshopHelper
 */
async function handleDragOut(mode) {
    if (mode === 'imageAndMask2WebHelper') {
        if (!capturedPayload || !capturedPayload.imageData) {
            ui.showError('fromps', 'No image to send');
            return;
        }

        try {
            ui.showInfo('fromps', 'Sending to WebHelper...');

            const imageBase64 = capturedPayload.imageBase64 || await fsModule.imageDataToBase64(capturedPayload.imageData);

            let maskBase64 = null;
            if (capturedPayload.maskData) {
                maskBase64 = await fsModule.maskDataToBase64(capturedPayload.maskData);
            }

            if (!imageBase64) {
                ui.showError('fromps', 'Failed to encode image');
                return;
            }

            const result = await helper.sendToWebHelper(
                `data:image/png;base64,${imageBase64}`,
                maskBase64 ? `data:image/png;base64,${maskBase64}` : null
            );

            if (result.success) {
                ui.showInfo('fromps', 'Sent to WebHelper! Check browser.');
            } else if (result.error === 'HELPER_NOT_RUNNING') {
                ui.showError('fromps', 'Helper not running! Start PhotoshopHelper app');
            } else if (result.error === 'HELPER_NOT_PAIRED') {
                ui.showError('fromps', HELPER_NOT_PAIRED_MESSAGE);
            } else {
                ui.showError('fromps', `Failed to send: ${result.error}`);
            }
        } catch (error) {
            console.error('WebHelper error:', error);
            ui.showError('fromps', `Send failed: ${error.message}`);
        }
        return;
    }

    if (!capturedPayload) {
        ui.showError('fromps', 'No image to drag');
        return;
    }

    try {
        ui.showInfo('fromps', 'Starting drag...');

        // 1. Prepare Data
        // Re-encoding image/mask based on mode
        const mustImage = mode !== "maskOnly";
        const mustMask = mode !== "imageOnly";

        let imageBase64 = null;
        let maskBase64 = null;
        if (mustImage) {
            // Use cached base64 if available — avoids re-encoding restored imageData after switch
            imageBase64 = capturedPayload.imageBase64 || await fsModule.imageDataToBase64(capturedPayload.imageData);
        }
        if (mustMask && capturedPayload.maskData) {
            //Load mask
            maskBase64 = await fsModule.maskDataToBase64(capturedPayload.maskData);
        }

        // 2. Validate (Unified Error Check)
        let errorMsg = null;
        // Case: Both required and both failed
        if (mustImage && mustMask && !imageBase64 && !maskBase64) {
            errorMsg = 'Failed to encode image and mask';
        }
        // Case: Image required and failed
        else if (mustImage && !imageBase64) {
            errorMsg = 'Failed to encode image';
        }
        // Case: Mask required and failed
        else if (mustMask && !maskBase64) {
            // Special check: if we needed a mask but don't even have source data
            if (!capturedPayload.maskData) {
                errorMsg = 'No mask available to drag';
            } else {
                errorMsg = 'Failed to encode mask';
            }
        }
        // Case: Fallback (should be covered above)
        else if (!imageBase64 && !maskBase64) {
            errorMsg = 'Nothing to drag';
        }
        if (errorMsg) {
            ui.showError('fromps', errorMsg);
            return;
        }

        // 3. Build Drag Array
        const imagesToDrag = [];
        if (mustImage && imageBase64) imagesToDrag.push(imageBase64);
        if (mustMask && maskBase64) imagesToDrag.push(maskBase64);

        // Call Photoshop Helper to start drag operation
        const result = await helper.startDrag(imagesToDrag);

        if (result.success) {
            ui.showInfo('fromps', `Drag ready (${result.count} file(s)) — drag from popup`);
        } else if (result.error === 'HELPER_NOT_RUNNING') {
            ui.showError('fromps', 'Helper not running! Start PhotoshopHelper app');
        } else if (result.error === 'HELPER_NOT_PAIRED') {
            ui.showError('fromps', HELPER_NOT_PAIRED_MESSAGE);
        } else {
            ui.showError('fromps', `Drag failed: ${result.error}`);
        }

    } catch (error) {
        console.error('Drag error:', error);
        ui.showError('fromps', `Drag failed: ${error.message}`);
    }
}

// ===== ToPS Handlers =====

/**
 * Handle Load File button click
 */
async function handleLoadFile() {
    ui.clearStatus('tops');

    try {
        ui.showInfo('tops', 'Loading...');

        const loadedFile = await fsModule.loadFile();

        if (loadedFile) {
            resultImage = loadedFile.arrayBuffer;
            resultFilePath = loadedFile.nativePath;
            resultFileToken = loadedFile.token;

            ui.showToPSPreview(loadedFile.dataUrl);
            ui.showInfo('tops', 'Image loaded');

            // Enable place button if we have capture data
            updatePlaceButtonState();
        } else {
            ui.clearStatus('tops'); // User cancelled
        }
    } catch (error) {
        console.error('Load file error:', error);
        ui.showError('tops', 'Failed to load file');
    }
}

/**
 * Handle Paste button click (best-effort)
 */
async function handlePaste() {
    try {
        ui.showInfo('tops', 'Pasting...');

        // 1. Try Photoshop Helper (Preferred because UXP clipboard is flaky)
        const helperResult = await helper.readClipboard();

        if (helperResult.success && helperResult.image) {
            // Helper returns data URL
            const dataUrl = helperResult.image;
            const base64 = dataUrl.split(',')[1];

            resultImage = fsModule.base64ToArrayBuffer(base64);

            ui.showToPSPreview(dataUrl);

            // Save to temp
            const saved = await fsModule.saveToTemp(resultImage, 'paste_result.png');
            resultFilePath = saved.nativePath;
            resultFileToken = saved.token;

            ui.showInfo('tops', 'Image pasted (Helper)');
            updatePlaceButtonState();
            return;
        }

        // 2. Fallback to standard UXP Clipboard API
        if (navigator.clipboard && navigator.clipboard.read) {
            try {
                const items = await navigator.clipboard.read();
                let blob = null;

                // items might not be iterable in some UXP versions, check isArray
                if (items && typeof items[Symbol.iterator] === 'function') {
                    for (const item of items) {
                        if (item.types.includes('image/png')) {
                            blob = await item.getType('image/png');
                            break;
                        } else if (item.types.includes('image/jpeg')) {
                            blob = await item.getType('image/jpeg');
                            break;
                        }
                    }
                } else {
                    console.warn('Clipboard items not iterable:', items);
                }

                if (blob) {
                    resultImage = await blob.arrayBuffer();
                    const base64 = fsModule.arrayBufferToBase64(resultImage);
                    const mimeType = blob.type || 'image/png';
                    const dataUrl = `data:${mimeType};base64,${base64}`;

                    ui.showToPSPreview(dataUrl);

                    const saved = await fsModule.saveToTemp(resultImage, 'paste_result.png');
                    resultFilePath = saved.nativePath;
                    resultFileToken = saved.token;

                    ui.showInfo('tops', 'Image pasted');
                    updatePlaceButtonState();
                } else {
                    if (helperResult.error === 'HELPER_NOT_RUNNING') {
                        ui.showError('tops', 'Start Helper for better Paste support');
                    } else if (helperResult.error === 'HELPER_NOT_PAIRED') {
                        ui.showError('tops', HELPER_NOT_PAIRED_MESSAGE);
                    } else {
                        ui.showError('tops', 'No image in clipboard');
                    }
                }
            } catch (err) {
                console.error('Clipboard read failed:', err);
                if (helperResult.error === 'HELPER_NOT_RUNNING') {
                    ui.showError('tops', 'Paste failed. Start PhotoshopHelper!');
                } else if (helperResult.error === 'HELPER_NOT_PAIRED') {
                    ui.showError('tops', HELPER_NOT_PAIRED_MESSAGE);
                } else {
                    ui.showError('tops', 'Paste failed');
                }
            }
        } else {
            if (helperResult.error === 'HELPER_NOT_RUNNING') {
                ui.showError('tops', 'Start PhotoshopHelper to Paste');
            } else if (helperResult.error === 'HELPER_NOT_PAIRED') {
                ui.showError('tops', HELPER_NOT_PAIRED_MESSAGE);
            } else {
                ui.showError('tops', 'Clipboard API not supported');
            }
        }
    } catch (error) {
        console.error('Paste error:', error);
        ui.showError('tops', 'Paste not supported');
    }
}



/**
 * Handle Place Back button click
 */
async function handlePlaceBack(mode = 'so') {
    ui.clearStatus('tops');

    // Check preconditions
    if (!capturedPayload) {
        ui.showError('tops', 'No capture data. Use FromPS first.');
        return;
    }

    if (mode !== 'selection' && (!resultImage || !resultFileToken)) {
        ui.showError('tops', 'No result image loaded');
        return;
    }

    if (!ps.hasActiveDocument()) {
        ui.showError('tops', 'No active document');
        return;
    }

    try {
        // Determine effective feather options
        const isFeatherVisible = settings.getShowFeatherPanel();
        let effectiveFeather;
        if (!isFeatherVisible) {
            effectiveFeather = Object.assign({}, settings.getFeatherSettings(), { enabled: false });
        } else {
            effectiveFeather = Object.assign({}, settings.getFeatherSettings(), currentFeatherOptions);
        }

        // Place back into Photoshop
        await ps.placeBack(
            mode,
            resultFileToken,
            capturedPayload.bounds,
            capturedPayload.maskData,
            effectiveFeather
        );

        // Auto-reset rule: if feather was visible, enabled, and had non-default bias (0 or -1), reset to 1.0
        if (isFeatherVisible && currentFeatherOptions.enabled && currentFeatherOptions.bias !== 1.0) {
            currentFeatherOptions.bias = 1.0;
            setFeatherButtonsUI('1');
        }

        // Detect platform dynamically to show proper keyboard shortcut
        let isMac = false;
        try {
            isMac = require('os').platform() === 'darwin';
        } catch (e) {
            // Fallback detection via navigator if UXP 'os' module fails
            isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        }
        const undoShortcut = isMac ? 'Cmd+Z' : 'Ctrl+Z';

        const successMessage = mode === 'selection'
            ? `Selection restored! ${undoShortcut} to undo.`
            : `Placed successfully! ${undoShortcut} to undo.`;
        ui.showInfo('tops', successMessage);

    } catch (error) {
        console.error('Place back error:', error);
        ui.showError('tops', error.message || 'Failed to place');
    }
}

/**
 * Handle Clear button in ToPS card
 */
function handleClearToPS() {
    resultImage = null;
    resultFilePath = null;
    resultFileToken = null;
    ui.clearToPSPreview();
    updatePlaceButtonState();
}

/**
 * Update Place Back button enabled state
 */
function updatePlaceButtonState() {
    const menu = document.querySelector('#place-back-options-menu sp-menu');
    const isSelectionOnly = menu && menu.value === 'restoreSelection';
    const hasData = isSelectionOnly ? !!capturedPayload : !!(resultImage || resultFileToken);
    ui.setPlaceButtonEnabled(!!hasData);
}

/**
 * Start periodic polling of Photoshop Helper status
 */
function startHelperStatusPolling() {
    // First call is 2 minutes after startup
    setTimeout(pollHelperStatus, 2 * 60 * 1000); //2 minutes
    //pollHelperStatus();
}

/**
 * Periodically check status of Photoshop Helper
 */
async function pollHelperStatus() {
    const statusData = await helper.isHelperRunning();
    let nextDelay = null;

    if (statusData && statusData.status === 'running') {
        // Photoshop Helper is running
        nextDelay = 60 * 60 * 1000; // 1 hour

        // Consolidate alerts in tooltip
        const alerts = statusData.alerts || {};
        const messages = [];
        let isPlugin = false;
        if (alerts.photoshopPlugin) { messages.push(alerts.photoshopPlugin); isPlugin = true; }
        if (alerts.photoshopHelper) messages.push(alerts.photoshopHelper);

        switch (messages.length) {
            case 1:
                ui.showStatusWarning(messages[0]);
                //if (isPlugin) nextDelay = null; 
                break;
            case 2:
                ui.showStatusWarning(messages.join('\n\n'));
                break;
            default:
                ui.hideStatusWarning();
                break;
        }
    } else {
        // Photoshop Helper is not running
        ui.showStatusWarning("Photoshop Helper is not running. As a result, the plugin is limited to minimal functionality.");
        nextDelay = 30 * 1000; // 30 seconds
    }

    if (nextDelay) setTimeout(pollHelperStatus, nextDelay);
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);

// Also try immediate init in case DOMContentLoaded already fired
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
}
