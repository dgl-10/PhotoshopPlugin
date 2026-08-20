const { BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const userSettings = require('../user-settings');
const { getGumroadConfig } = require('../donation-manager');

let activationWindow = null;
let isCloseLocked = false;

function openLicenseActivationWindow(isReminder = false, isHardcore = false, lockoutSeconds = 15) {
    if (activationWindow && !activationWindow.isDestroyed()) {
        if (isHardcore) {
            isCloseLocked = true;
            activationWindow.setAlwaysOnTop(true);
            activationWindow.webContents.send('activation-init', {
                donationIsAlive: false,
                isReminder: true,
                isHardcore: true,
                lockoutSeconds
            });
        }
        activationWindow.focus();
        return;
    }

    isCloseLocked = isHardcore;

    activationWindow = new BrowserWindow({
        width: 600,
        height: 500,
        resizable: false,
        title: 'PhotoshopHelper — Support & Donation',
        center: true,
        alwaysOnTop: isHardcore,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'license-activation-preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    // Prevent closing via system [X] button, Alt+F4, or taskbar while lockout timer is running
    activationWindow.on('close', (e) => {
        if (isCloseLocked) {
            e.preventDefault();
        }
    });

    activationWindow.loadFile(path.join(__dirname, 'license-activation.html'));

    activationWindow.webContents.once('did-finish-load', async () => {
        const donationIsAlive = await userSettings.getCurrentDonationIsStiilAlive();
        if (!activationWindow.isDestroyed()) {
            activationWindow.webContents.send('activation-init', {
                donationIsAlive,
                isReminder,
                isHardcore,
                lockoutSeconds
            });
        }
    });
}

// IPC verification handler
ipcMain.handle('activation-verify', async (event, licenseKey) => {
    const { productId } = getGumroadConfig();

    if (!productId || productId.startsWith('YOUR_GUMROAD_PRODUCT_ID')) {
        console.error('[Activation] Product ID is not configured in donation-manager.js');
        return { success: false, message: 'Supporter-key verification is not configured yet.' };
    }

    try {
        console.log(`[Activation] Verifying donation key against Gumroad API for product: ${productId}`);
        const response = await fetch('https://api.gumroad.com/v2/licenses/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                product_id: productId,
                license_key: licenseKey,
                increment_uses_count: 'true'
            })
        });

        const data = await response.json();

        if (data && data.success && data.purchase) {
            /**
             * Gumroad API License Verification Response Specification:
             * 
             * @typedef {Object} GumroadVerifyResponse
             * @property {boolean} success - Whether the request succeeded.
             * @property {number} uses - Current number of times this license has been used.
             * @property {Object} purchase - The purchase associated with this license.
             * @property {string} purchase.seller_id - Unique identifier of the seller.
             * @property {string} purchase.product_id - Unique identifier of the product.
             * @property {string} purchase.product_name - Name of the product.
             * @property {string} purchase.permalink - Short permalink slug.
             * @property {string} purchase.product_permalink - Full product URL.
             * @property {string} purchase.email - Email address of the buyer.
             * @property {number} purchase.price - Price paid in cents.
             * @property {number} purchase.gumroad_fee - Gumroad fee in cents.
             * @property {string} purchase.currency - ISO currency code.
             * @property {number} purchase.quantity - Number of units purchased.
             * @property {boolean} purchase.discover_fee_charged - Whether a Gumroad Discover fee was charged.
             * @property {boolean} purchase.can_contact - Whether the seller can contact the buyer.
             * @property {string} purchase.referrer - Referrer URL or "direct".
             * @property {Object} purchase.card - Payment card details.
             * @property {string|null} purchase.card.visual - Masked card number.
             * @property {string|null} purchase.card.type - Card type (e.g. "visa").
             * @property {number} purchase.order_number - Numeric order identifier.
             * @property {string} purchase.sale_id - Unique identifier of the sale.
             * @property {string} purchase.sale_timestamp - ISO 8601 timestamp of the sale.
             * @property {string} purchase.purchaser_id - Unique identifier of the purchaser.
             * @property {string|null} purchase.subscription_id - Subscription identifier if applicable.
             * @property {string} purchase.variants - Formatted string of selected variants.
             * @property {string} purchase.license_key - License key for the purchase.
             * @property {boolean} purchase.is_multiseat_license - Whether this is a multi-seat license.
             * @property {string} purchase.ip_country - Country name based on buyer's IP address.
             * @property {string|null} purchase.recurrence - Subscription billing interval if applicable.
             * @property {boolean} purchase.is_gift_receiver_purchase - Whether this purchase was received as a gift.
             * @property {boolean} purchase.refunded - Whether the purchase has been refunded.
             * @property {boolean} purchase.disputed - Whether a dispute has been filed.
             * @property {boolean} purchase.dispute_won - Whether the dispute was won by the seller.
             * @property {string} purchase.id - Unique identifier for the purchase.
             * @property {string} purchase.created_at - ISO 8601 timestamp of when the purchase was created.
             * @property {Array} purchase.custom_fields - Custom fields from the purchase.
             * @property {boolean} purchase.chargebacked - Whether the purchase was charged back (non-subscription product only).
             * @property {string|null} purchase.subscription_ended_at - Timestamp when the subscription ended (subscription product only).
             * @property {string|null} purchase.subscription_cancelled_at - Timestamp when the subscription was cancelled (subscription product only).
             * @property {string|null} purchase.subscription_failed_at - Timestamp of the last failed charge (subscription product only).
             */

            const purchase = data.purchase;

            if (purchase.refunded || purchase.chargebacked) {
                return { success: false, message: 'This supporter key is no longer valid.' };
            }

            // Generate the current activation key signature
            const donationActivationKey = `gumroad:[${purchase.id}][${purchase.sale_timestamp}][${purchase.price}]`;

            // Prevent re-using the same key on the same device if it has already been activated here.
            // This stops users from "re-charging" their usage ticks for free once their limit is exhausted.
            const currentSavedKey = await userSettings.getDonationActivationKey();
            if (currentSavedKey === donationActivationKey) {
                return { 
                    success: false, 
                    message: 'This supporter key has already been used to activate this device. To extend limits, please make a new donation.' 
                };
            }

            // Enforce multi-device limit on Gumroad's side.
            // If uses > 3, it has been verified on too many devices/installations.
            if (data.uses > 3) {
                return { success: false, message: 'This supporter key has already been registered on too many devices.' };
            }

            // Save key to store and update usage tracking threshold to the donated level
            await userSettings.setCurrentUsageTrackingThreshold(userSettings.DONATED_THRESHOLD, donationActivationKey);

            // Immediately unlock closing and disable alwaysOnTop upon successful key activation
            isCloseLocked = false;
            if (activationWindow && !activationWindow.isDestroyed()) {
                activationWindow.setAlwaysOnTop(false);
            }

            console.log('[Activation] Donation key verified successfully. User upgraded to Donated level.');
            return { success: true };
        } else {
            const errorMsg = (data && data.message) || 'Invalid supporter key.';
            console.warn(`[Activation] Verification failed: ${errorMsg}`);
            return { success: false, message: errorMsg };
        }
    } catch (err) {
        console.error('[Activation] Network error during Gumroad verification:', err);
        return { success: false, message: 'Network error. Please check your internet connection and try again.' };
    }
});

// IPC unlock close handler (when countdown expires)
ipcMain.on('activation-unlock-close', () => {
    isCloseLocked = false;
});

// IPC close window handler
ipcMain.on('activation-close', (event) => {
    isCloseLocked = false;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
        win.close();
    }
});

// IPC buy redirect handler
ipcMain.on('activation-buy', () => {
    const { productUrl } = getGumroadConfig();
    try {
        shell.openExternal(productUrl);
    } catch (err) {
        console.error('[Activation] Failed to open Gumroad purchase URL:', err);
    }
});

module.exports = {
    openLicenseActivationWindow
};
