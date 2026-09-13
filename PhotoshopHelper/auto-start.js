'use strict';

/**
 * User-facing labels used by the tray menu.
 *
 * macOS support is intentionally described as experimental because the project
 * distributes an unsigned build and cannot guarantee that SMAppService will
 * accept the registration on every supported macOS version.
 */
const AUTO_START_LABEL = 'Start at Login';
const MAC_AUTO_START_LABEL = 'Start at Login (Experimental)';
const MAC_APPROVAL_REQUIRED_LABEL = 'Start at Login (Approval Required)';

// Keep this runtime-safe literal synchronized with build.appId in package.json.
// electron-builder removes build metadata from the package.json stored in app.asar,
// while its NSIS ${APP_ID} define retains the same source value during packaging.
const WINDOWS_AUTO_START_NAME = 'com.photoshop-helper';

/**
 * Convert Electron's platform-specific login-item response into the small,
 * predictable state needed by the tray menu.
 *
 * Keeping this conversion free of Electron dependencies makes every known
 * Windows and macOS state testable on the Windows-only development machine.
 * In particular, macOS's `requires-approval` value means that a login item is
 * already registered even though macOS will not launch it until the user grants
 * approval. Treating it as registered keeps the checkbox checked and allows the
 * next click to unregister it instead of repeatedly attempting to register it.
 *
 * @param {NodeJS.Platform|string} platform - Current Node.js platform name.
 * @param {object} [settings={}] - Value returned by app.getLoginItemSettings().
 * @returns {{supported: boolean, checked: boolean, approvalRequired: boolean, label: string}}
 */
function interpretAutoStartSettings(platform, settings = {}) {
    if (platform === 'win32') {
        // Electron always exposes executableWillLaunchAtLogin on current Windows
        // builds. The fallback preserves compatibility with older Electron builds.
        const checked = typeof settings.executableWillLaunchAtLogin === 'boolean'
            ? settings.executableWillLaunchAtLogin
            : Boolean(settings.openAtLogin);

        return {
            supported: true,
            checked,
            approvalRequired: false,
            label: AUTO_START_LABEL
        };
    }

    if (platform === 'darwin') {
        const approvalRequired = settings.status === 'requires-approval';
        const checked = settings.status === 'enabled' || approvalRequired;

        return {
            supported: true,
            checked,
            approvalRequired,
            label: approvalRequired ? MAC_APPROVAL_REQUIRED_LABEL : MAC_AUTO_START_LABEL
        };
    }

    // Electron does not implement login-item settings on Linux. Returning a
    // disabled state avoids presenting a checkbox that can never take effect.
    return {
        supported: false,
        checked: false,
        approvalRequired: false,
        label: AUTO_START_LABEL
    };
}

module.exports = {
    WINDOWS_AUTO_START_NAME,
    interpretAutoStartSettings
};
