const { dialog, shell } = require('electron');
const userSettings = require('./user-settings');

// !!!!!!!!!!!! Attention: To disable donation prompts, set "usageTrackingEnabled": false in user-settings.json

/**
 * Get the nominal milestone for the given count beyond threshold.
 * 
 * @param {number} over - Usages beyond threshold (always >= 0)
 * @param {number} threshold - The current usage tracking threshold
 * @returns {number} The aligned milestone, or -1 if threshold is not reached/not ready to show
 */
function getMilestone(over, threshold) {
    const donated_threshold = userSettings.DONATED_THRESHOLD;
    if (threshold < donated_threshold) {
        if (over < 1) {
            return -1;
        }

        // if (over <= 101) {
        //     return 1 + Math.floor((over - 1) / 25) * 25;
        // } else if (over <= 206) {
        //     return 101 + Math.floor((over - 101) / 15) * 15;
        // } else {
        //     return 206 + Math.floor((over - 206) / 7) * 7;
        // }

        if (over <= 106) {
            return 1 + Math.floor((over - 1) / 35) * 35;
        } else if (over <= 206) {
            return 106 + Math.floor((over - 106) / 20) * 20;
        } else {
            return 206 + Math.floor((over - 206) / 12) * 12;
        }
    } else {
        if (over < 1) {
            return -1;
        }

        //return 1 + Math.floor((over - 1) / 35) * 35;
        return 1 + Math.floor((over - 1) / 50) * 50;
    }
}

async function isEnabled() {
    return await userSettings.getCurrentUsageTrackingThreshold() > 0;
}


async function trackUsage(ticks = 1) {
    try {
        const threshold = await userSettings.getCurrentUsageTrackingThreshold();
        if (threshold <= 0) return;

        // Delegate state management to user-settings
        const data = await userSettings.updateUsageCount(ticks);

        // Check if action count reached the threshold (or multiples of it)
        if (data.count <= 0) {
            const currentOver = -data.count;
            const hasBeenShown = data.donationShown < 0;

            let showDonation = false;
            if (!hasBeenShown) {
                //const firstShowPoint = threshold < userSettings.DONATED_THRESHOLD ? 1 : (userSettings.DONATED_THRESHOLD + 1);
                const firstShowPoint = 1;
                showDonation = currentOver >= firstShowPoint;
            } else {
                const currentMilestone = getMilestone(currentOver, threshold);
                const lastMilestone = getMilestone(-data.donationShown, threshold);
                if (currentMilestone > lastMilestone) {
                    showDonation = true;
                }
            }

            if (showDonation) {
                // Save the count at which we showed the donation dialog
                await userSettings.setDonationShown(data.count);

                const { openLicenseActivationWindow } = require('./setup/license-activation');
                openLicenseActivationWindow(true);
            }
        }
    } catch (err) {
        console.error('Error in donation-manager:', err);
    }
}

function getGumroadConfig() {
    return {
        productId: 'PLHY3BdSRtqc8ijqO_ZFIw==',
        productUrl: 'https://dgl10.gumroad.com/l/photoshop-plugin'
    };
}

module.exports = {
    isEnabled,
    trackUsage,
    openLicenseActivationWindow: () => {
        const { openLicenseActivationWindow } = require('./setup/license-activation');
        openLicenseActivationWindow(false);
    },
    getGumroadConfig
};

