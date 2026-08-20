const { getConfigPaths } = require('./setup/config-paths');
const { generateToken } = require('./auth');

// !!!!!!!!!!!! Attention: To disable donation prompts, set "usageTrackingEnabled": false in user-settings.json
const INITIAL_DONATION_THRESHOLD = 150;
const DONATED_NEW_DONATION_THRESHOLD = 1000;

// Hardcore lockout thresholds and configuration
const HARDCORE_UNPAID_THRESHOLD = 750; // Actions beyond initial threshold before aggressive mode triggers for non-donors
const HARDCORE_LOCKOUT_SECONDS = 15; // Lockout countdown duration in seconds
const ENABLE_HARDCORE_FOR_DONORS = false; // Future-proof toggle for donors (disabled by default)
const HARDCORE_DONOR_THRESHOLD = 2000; // Aggressive threshold for donors if enabled


// Initialize the import dynamically.
// storePromise will resolve to the Store instance.
// getConfigPaths() is called lazily inside the callback to ensure app.getPath('userData')
// is only accessed after app is ready (not at module load time).
const storePromise = import('electron-store').then(StoreModule => {
    const Store = StoreModule.default;
    const { userDataPath } = getConfigPaths();
    return new Store({
        cwd: userDataPath,
        name: 'user-settings',
        defaults: {
            isSetupComplete: false,
            firstRunDate: null,
            usageTrackingEnabled: true,
            usageTrackingThreshold: INITIAL_DONATION_THRESHOLD,
            usageTrackingCount: INITIAL_DONATION_THRESHOLD,
            usageTrackingDonationShown: 0,
            donationActivationKey: null,
            // Shared secrets for the local HTTP server. Both are created on first use
            // rather than shipped with a value, so every installation is distinct.
            pluginToken: null,
            localApiToken: null
        }
    });
});

/**
 * Read a persisted secret, creating and storing one on first use.
 *
 * The read and the write happen without an intervening await, so concurrent callers
 * cannot each generate a different secret for the same key.
 *
 * @param {string} key - Settings key holding the secret.
 * @returns {Promise<string>} The stored secret.
 */
async function getOrCreateSecret(key) {
    const store = await storePromise;
    const existing = store.get(key);

    if (typeof existing === 'string' && existing !== '') {
        return existing;
    }

    const created = generateToken();
    store.set(key, created);
    return created;
}

async function isSetupComplete() {
    const store = await storePromise;
    return store.get('isSetupComplete');
}

async function markSetupComplete() {
    const store = await storePromise;
    store.set('isSetupComplete', true);

    // If this is the first run, record the date
    if (!store.get('firstRunDate')) {
        store.set('firstRunDate', new Date().toISOString());
    }
}

async function getCurrentDonationIsStiilAlive() {
    const store = await storePromise;
    const enabled = store.get("usageTrackingEnabled") ?? true;
    if (!enabled)
        return false;

    const threshold = store.get('usageTrackingThreshold') ?? INITIAL_DONATION_THRESHOLD;
    if (threshold < DONATED_NEW_DONATION_THRESHOLD)
        return false;

    const count = store.get('usageTrackingCount') ?? threshold;
    return count > 0;
}

async function updateUsageCount(ticks = 1) {
    const store = await storePromise;
    let count = store.get('usageTrackingCount') ?? store.get('usageTrackingThreshold') ?? INITIAL_DONATION_THRESHOLD;
    count -= Math.abs(ticks);
    store.set('usageTrackingCount', count);
    if (count > 0)
        return { count: count, donationShown: 0 };
    else {
        let donationShown = store.get('usageTrackingDonationShown') ?? 0;
        return { count: count, donationShown: donationShown };
    }
}

async function getCurrentUsageTrackingThreshold() {
    const store = await storePromise;
    let enabled = store.get("usageTrackingEnabled") ?? true;
    if (!enabled)
        return -1;

    return store.get('usageTrackingThreshold') ?? INITIAL_DONATION_THRESHOLD;
}

async function setCurrentUsageTrackingThreshold(threshold, donationActivationKey = null) {
    const store = await storePromise;
    let parsedThreshold = parseInt(threshold);
    if (!isNaN(parsedThreshold) && parsedThreshold > 0) {
        store.set("usageTrackingEnabled", true);
        store.set('usageTrackingThreshold', parsedThreshold);

        // Get current remaining usages
        const currentCount = store.get('usageTrackingCount') ?? 0;
        // If there are unused ticks, add them to the new threshold
        const newCount = parsedThreshold + (currentCount > 0 ? currentCount : 0);

        store.set('usageTrackingCount', newCount);
        store.set('usageTrackingDonationShown', 0);
        store.set('donationActivationKey', donationActivationKey);
    } else {
        store.set("usageTrackingEnabled", false);
    }
}

async function setDonationShown(value) {
    const store = await storePromise;
    store.set('usageTrackingDonationShown', value);
}

async function getDonationActivationKey() {
    const store = await storePromise;
    return store.get('donationActivationKey') ?? null;
}

/**
 * Get the secret shared with the Photoshop plugin.
 *
 * This secret is delivered to the plugin automatically by writing it into the plugin's
 * private UXP data folder, so it exists as a readable file on disk. It therefore guards
 * only the sandbox-escape endpoints and never the endpoints that spend money.
 *
 * @returns {Promise<string>} The plugin pairing token.
 */
async function getPluginToken() {
    return getOrCreateSecret('pluginToken');
}

/**
 * Replace the plugin pairing secret with a freshly generated one.
 *
 * Used when the user wants to invalidate a token that may have been exposed. The plugin
 * has to be paired again afterwards.
 *
 * @returns {Promise<string>} The newly generated plugin pairing token.
 */
async function regeneratePluginToken() {
    const store = await storePromise;
    const created = generateToken();
    store.set('pluginToken', created);
    return created;
}

/**
 * Get the secret guarding the Local Generation API and the MCP server.
 *
 * This is deliberately a different secret from the plugin token: it protects operations
 * that call paid providers, so it must not be compromised by the plugin token's presence
 * on disk. An explicit environment variable takes precedence for setups that pin the
 * value externally.
 *
 * @returns {Promise<string>} The local service API token.
 */
async function getLocalApiToken() {
    const configured = process.env.LOCAL_GENERATION_API_TOKEN;

    if (typeof configured === 'string' && configured.trim() !== '') {
        return configured.trim();
    }

    return getOrCreateSecret('localApiToken');
}

module.exports = {
    isSetupComplete,
    markSetupComplete,
    updateUsageCount,
    getCurrentUsageTrackingThreshold,
    setCurrentUsageTrackingThreshold,
    setDonationShown,
    getCurrentDonationIsStiilAlive,
    getDonationActivationKey,
    getPluginToken,
    regeneratePluginToken,
    getLocalApiToken,
    INITIAL_DONATION_THRESHOLD,
    DONATED_THRESHOLD: DONATED_NEW_DONATION_THRESHOLD,
    HARDCORE_UNPAID_THRESHOLD,
    HARDCORE_LOCKOUT_SECONDS,
    ENABLE_HARDCORE_FOR_DONORS,
    HARDCORE_DONOR_THRESHOLD
};


