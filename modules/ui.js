/**
 * UI State Management Module
 * Handles state transitions and DOM updates
 */

// State constants
const STATES = {
    FROM_PS: {
        IDLE: 'idle',
        CAPTURED: 'captured'
    },
    TO_PS: {
        IDLE: 'idle',
        READY: 'ready'
    }
};

// Current states
let fromPSState = STATES.FROM_PS.IDLE;
let toPSState = STATES.TO_PS.IDLE;

// Track current overlay blob URL for proper memory cleanup
let currentOverlayUrl = null;

// Timeout IDs for auto-clearing status
const statusTimeouts = {
    fromps: null,
    tops: null
};
const STATUS_TIMEOUT = 5000;

/**
 * Set FromPS card state
 * @param {string} state - 'idle' or 'captured'
 */
function setFromPSState(state) {
    const card = document.getElementById('card-fromps');
    if (!card) {
        console.error('FromPS card not found!');
        return;
    }

    console.log('setFromPSState called with:', state);
    console.log('Card classes before:', card.className);

    fromPSState = state;

    // Remove all state classes
    card.classList.remove('state-idle', 'state-captured');

    // Add appropriate state class
    if (state === STATES.FROM_PS.IDLE) {
        card.classList.add('state-idle');
    } else if (state === STATES.FROM_PS.CAPTURED) {
        card.classList.add('state-captured');
    }

    console.log('Card classes after:', card.className);
}

/**
 * Set ToPS card state
 * @param {string} state - 'idle' or 'ready'
 */
function setToPSState(state) {
    const card = document.getElementById('card-tops');
    if (!card) return;

    toPSState = state;

    // Remove all state classes
    card.classList.remove('state-idle-tops', 'state-ready');

    // Add appropriate state class
    if (state === STATES.TO_PS.IDLE) {
        card.classList.add('state-idle-tops');
    } else if (state === STATES.TO_PS.READY) {
        card.classList.add('state-ready');
    }
}

/**
 * Show preview image in FromPS card (and optional overlay)
 * @param {string} dataUrl - Image data URL
 * @param {string} [overlayUrl] - Optional overlay image data URL
 */
function showFromPSPreview(dataUrl, overlayUrl) {
    const img = document.getElementById('img-fromps');
    const overlay = document.getElementById('img-overlay-fromps');

    // Revoke previous overlay blob URL to free memory
    if (currentOverlayUrl) {
        URL.revokeObjectURL(currentOverlayUrl);
        currentOverlayUrl = null;
    }

    if (img) {
        img.src = dataUrl;
        img.style.display = 'block';
    }

    if (overlay && overlayUrl) {
        currentOverlayUrl = overlayUrl;
        overlay.src = overlayUrl;
        overlay.style.display = 'block';
    } else if (overlay) {
        overlay.style.display = 'none';
        overlay.src = '';
    }

    setFromPSState(STATES.FROM_PS.CAPTURED);
}

/**
 * Clear FromPS preview and return to idle
 */
function clearFromPSPreview() {
    const img = document.getElementById('img-fromps');
    const overlay = document.getElementById('img-overlay-fromps');

    // Revoke overlay blob URL to free memory
    if (currentOverlayUrl) {
        URL.revokeObjectURL(currentOverlayUrl);
        currentOverlayUrl = null;
    }

    if (img) {
        img.src = '';
        img.style.display = 'none';
    }

    if (overlay) {
        overlay.src = '';
        overlay.style.display = 'none';
    }

    clearStatus('fromps');
    setFromPSState(STATES.FROM_PS.IDLE);
}

/**
 * Show preview image in ToPS card
 * @param {string} dataUrl - Image data URL
 */
function showToPSPreview(dataUrl) {
    const img = document.getElementById('img-tops');
    if (img) {
        img.src = dataUrl;
        img.style.display = 'block';
    }
    setToPSState(STATES.TO_PS.READY);
}

/**
 * Clear ToPS preview and return to idle
 */
function clearToPSPreview() {
    const img = document.getElementById('img-tops');
    if (img) {
        img.src = '';
        img.style.display = 'none';
    }
    clearStatus('tops');
    setToPSState(STATES.TO_PS.IDLE);
}

/**
 * Show error message in card status area
 * Error messages persist until manually cleared or overwritten
 * @param {string} cardId - 'fromps' or 'tops'
 * @param {string} message - Error message
 */
function showError(cardId, message) {
    // Clear any pending auto-clear timer to prevent this error from being wiped by a previous success
    if (statusTimeouts[cardId]) {
        clearTimeout(statusTimeouts[cardId]);
        statusTimeouts[cardId] = null;
    }

    const status = document.getElementById(`status-${cardId}`);
    if (status) {
        status.textContent = message;
        status.className = 'status-message error';
    }
}

/**
 * Show info message in card status area
 * Info messages auto-clear after 5 seconds
 * @param {string} cardId - 'fromps' or 'tops'
 * @param {string} message - Info message
 */
function showInfo(cardId, message) {
    // Clear existing timer
    if (statusTimeouts[cardId]) {
        clearTimeout(statusTimeouts[cardId]);
    }

    const status = document.getElementById(`status-${cardId}`);
    if (status) {
        status.textContent = message;
        status.className = 'status-message info';

        // Set auto-clear timer (5 seconds)
        statusTimeouts[cardId] = setTimeout(() => {
            clearStatus(cardId);
            statusTimeouts[cardId] = null;
        }, STATUS_TIMEOUT);
    }
}

/**
 * Clear status message
 * @param {string} cardId - 'fromps' or 'tops'
 */
function clearStatus(cardId) {
    // Clear timer if exists
    if (statusTimeouts[cardId]) {
        clearTimeout(statusTimeouts[cardId]);
        statusTimeouts[cardId] = null;
    }

    const status = document.getElementById(`status-${cardId}`);
    if (status) {
        status.textContent = '';
        status.className = 'status-message';
    }
}

/**
 * Enable/disable capture button based on selection state
 * @param {boolean} enabled
 */
function setCaptureButtonEnabled(enabled) {
    const btn = document.getElementById('btn-capture');
    if (btn) {
        btn.disabled = !enabled;
    }
}

/**
 * Enable/disable place button based on data availability
 * @param {boolean} enabled
 */
function setPlaceButtonEnabled(enabled) {
    const btn = document.getElementById('btn-place-back');
    if (btn) {
        btn.disabled = !enabled;
    }
    const btnOptions = document.getElementById('btn-place-back-options');
    if (btnOptions) {
        btnOptions.disabled = !enabled;
    }
}

/**
 * Get current source mode selection
 * @returns {string} 'copyMerged' or 'currentLayer'
 */
function getSourceMode() {
    const select = document.getElementById('source-mode');
    return select ? select.value : 'copyMerged';
}



/**
 * Update the source-selection dropdown with all captured payloads.
 * Rebuilds the sp-menu items and marks the current index as selected.
 * @param {Array} payloads - Array of capturedPayload objects
 * @param {number} currentIndex - Index of the currently active payload
 */
function updateSourceDropdown(payloads, currentIndex) {
    const dropdown = document.getElementById('source-selection');
    if (!dropdown) return;
    const menu = dropdown.querySelector('sp-menu');
    if (!menu) return;

    menu.innerHTML = '';

    // Default item — always first
    const defaultItem = document.createElement('sp-menu-item');
    defaultItem.value = '-1';
    defaultItem.textContent = 'Waiting for capture...';
    if (currentIndex === -1) defaultItem.setAttribute('selected', '');
    menu.appendChild(defaultItem);

    // Capture history items - iterate in reverse to show newest first
    for (let i = payloads.length - 1; i >= 0; i--) {
        const payload = payloads[i];
        const item = document.createElement('sp-menu-item');
        item.value = String(i);
        const name = payload.context && payload.context.layerName
            ? payload.context.layerName
            : `Capture ${i + 1}`;
        const ratioInfo = payload.aspectRatio ? ` [${payload.aspectRatio}]` : '';
        const sizeInfo = ` (${payload.bounds.width}\u00d7${payload.bounds.height})`;

        item.textContent = `${i + 1}:${ratioInfo}${sizeInfo} - ${name}`;
        if (i === currentIndex) item.setAttribute('selected', '');
        menu.appendChild(item);
    }

    dropdown.value = String(currentIndex);
}

/**
 * Reset the source-selection dropdown to default "Waiting for capture..." state.
 * Preserves capture history items for switching back.
 * @param {Array} payloads - Array of capturedPayload objects (to keep history in dropdown)
 */
function resetSourceDropdown(payloads) {
    updateSourceDropdown(payloads || [], -1);
}

/**
 * Initialize UI to default states
 */
function initUI() {
    setFromPSState(STATES.FROM_PS.IDLE);
    setToPSState(STATES.TO_PS.IDLE);
    setCaptureButtonEnabled(true); // Will be updated based on selection
    setPlaceButtonEnabled(false);

    // Setup tooltip hover handlers for UXP compatibility
    const warningButton = document.getElementById('status-warning-button');
    const warningTooltip = document.getElementById('status-warning-tooltip');
    if (warningButton && warningTooltip) {
        warningButton.addEventListener('mouseenter', () => {
            warningTooltip.setAttribute('open', '');
        });
        warningButton.addEventListener('mouseleave', () => {
            warningTooltip.removeAttribute('open');
        });
    }
}

/**
 * Get current FromPS state
 * @returns {string}
 */
function getFromPSState() {
    return fromPSState;
}

/**
 * Get current ToPS state
 * @returns {string}
 */
function getToPSState() {
    return toPSState;
}

/**
 * Show status warning icon with a custom tooltip
 * @param {string} tooltipText
 */
function showStatusWarning(tooltipText) {
    const container = document.getElementById('status-warning-container');
    const tooltip = document.getElementById('status-warning-tooltip');
    if (container) {
        container.style.display = 'block';
    }
    if (tooltip) {
        tooltip.textContent = tooltipText;
    }
}

/**
 * Hide status warning icon
 */
function hideStatusWarning() {
    const container = document.getElementById('status-warning-container');
    const tooltip = document.getElementById('status-warning-tooltip');
    if (container) {
        container.style.display = 'none';
    }
    if (tooltip) {
        tooltip.textContent = '';
        tooltip.removeAttribute('open');
    }
}

module.exports = {
    STATES,
    setFromPSState,
    setToPSState,
    showFromPSPreview,
    clearFromPSPreview,
    showToPSPreview,
    clearToPSPreview,
    showError,
    showInfo,
    clearStatus,
    setCaptureButtonEnabled,
    setPlaceButtonEnabled,
    getSourceMode,
    updateSourceDropdown,
    resetSourceDropdown,

    initUI,
    getFromPSState,
    getToPSState,
    showStatusWarning,
    hideStatusWarning
};
