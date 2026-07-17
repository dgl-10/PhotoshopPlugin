const { getConfigPaths } = require('./setup/config-paths');

// !!!!!!!!!!!! Attention: To disable donation prompts, set "usageTrackingEnabled": false in user-settings.json
const INITIAL_DONATION_THRESHOLD = 150;
const DONATED_NEW_DONATION_THRESHOLD = 1000;

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
            donationActivationKey: null
        }
    });
});

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

module.exports = {
    isSetupComplete,
    markSetupComplete,
    updateUsageCount,
    getCurrentUsageTrackingThreshold,
    setCurrentUsageTrackingThreshold,
    setDonationShown,
    getCurrentDonationIsStiilAlive,
    getDonationActivationKey,
    //INITIAL_DONATION_THRESHOLD,
    DONATED_THRESHOLD: DONATED_NEW_DONATION_THRESHOLD
};


