const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Delivery of the shared secret to the Photoshop plugin.
 *
 * UXP gives a plugin a private data folder that it can read without a file picker, and
 * the Helper — an ordinary desktop process — can write into that same folder directly.
 * Dropping the token there pairs the two automatically, with no code to copy by hand.
 *
 * The location is an Adobe implementation detail that has moved between host versions,
 * so every plausible folder is enumerated rather than one path being assumed. Failure is
 * never fatal: the plugin falls back to a token entered manually in its settings dialog.
 */

// The published plugin and the development manifest declare different identifiers, and a
// developer commonly has both installed at once. Both are paired.
const PLUGIN_IDS = ['com.fromps-tops', 'com.fromps-tops.dev'];

const PAIRING_FILENAME = 'photoshop-helper.json';

// PluginsStorage nests plugin folders under host-app and host-version segments whose
// names vary (PHSP, PHSPBETA, version numbers, External/Internal/Develop). Rather than
// encode that shape, the scan walks down a bounded number of levels looking for a folder
// named after the plugin, which keeps working when Adobe adds or renames a segment.
const MAX_SCAN_DEPTH = 5;

/**
 * Get the platform's UXP plugin storage roots.
 *
 * @returns {string[]} Existing PluginsStorage directories.
 */
function getPluginsStorageRoots() {
    const roots = [];

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        roots.push(path.join(appData, 'Adobe', 'UXP', 'PluginsStorage'));
    } else if (process.platform === 'darwin') {
        roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'UXP', 'PluginsStorage'));
    }

    return roots.filter(root => {
        try {
            return fs.statSync(root).isDirectory();
        } catch (error) {
            return false;
        }
    });
}

/**
 * List the subdirectories of a directory, treating any failure as "none".
 *
 * @param {string} directory - Directory to enumerate.
 * @returns {string[]} Absolute paths of the contained directories.
 */
function listSubdirectories(directory) {
    try {
        return fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => path.join(directory, entry.name));
    } catch (error) {
        // An unreadable or vanished directory simply yields no pairing targets.
        return [];
    }
}

/**
 * Find the data folders belonging to this project's plugin.
 *
 * @returns {string[]} Absolute paths of every discovered PluginData directory.
 */
function findPluginDataFolders() {
    const found = [];
    let currentLevel = getPluginsStorageRoots();

    for (let depth = 0; depth < MAX_SCAN_DEPTH && currentLevel.length > 0; depth += 1) {
        const nextLevel = [];

        for (const directory of currentLevel) {
            if (PLUGIN_IDS.includes(path.basename(directory))) {
                // The plugin folder exists, so the plugin is installed. PluginData itself
                // may not have been created yet if the panel has never been opened.
                found.push(path.join(directory, 'PluginData'));
                continue;
            }

            nextLevel.push(...listSubdirectories(directory));
        }

        currentLevel = nextLevel;
    }

    return found;
}

/**
 * Write the pairing file into every data folder belonging to this project's plugin.
 *
 * @param {object} pairing - Values the plugin needs in order to reach the Helper.
 * @param {string} pairing.token - Shared secret for the plugin-only endpoints.
 * @param {number} pairing.port - Port the local server listens on.
 * @param {string} [pairing.version] - Helper version, for diagnostics.
 * @returns {{written: string[], failed: Array<{path: string, error: string}>}} Outcome per folder.
 */
function writePairingFile(pairing) {
    const written = [];
    const failed = [];

    if (!pairing || !pairing.token) {
        throw new TypeError('writePairingFile requires a token.');
    }

    const contents = JSON.stringify({
        token: pairing.token,
        port: pairing.port,
        version: pairing.version || null,
        updatedAt: new Date().toISOString()
    }, null, 2);

    for (const dataFolder of findPluginDataFolders()) {
        const filePath = path.join(dataFolder, PAIRING_FILENAME);

        try {
            fs.mkdirSync(dataFolder, { recursive: true });

            // The file is a credential, so it is created without group or world access on
            // platforms that honour the mode. Windows ignores it and relies on the ACL of
            // the per-user AppData directory the file already lives in.
            fs.writeFileSync(filePath, contents, { mode: 0o600 });
            written.push(filePath);
        } catch (error) {
            failed.push({ path: filePath, error: error.message });
        }
    }

    return { written, failed };
}

/**
 * Remove the pairing file from every plugin data folder.
 *
 * @returns {string[]} Absolute paths of the files that were removed.
 */
function removePairingFiles() {
    const removed = [];

    for (const dataFolder of findPluginDataFolders()) {
        const filePath = path.join(dataFolder, PAIRING_FILENAME);

        try {
            fs.rmSync(filePath, { force: true });
            removed.push(filePath);
        } catch (error) {
            // A file that cannot be removed is reported by its absence from the result.
        }
    }

    return removed;
}

module.exports = {
    PLUGIN_IDS,
    PAIRING_FILENAME,
    findPluginDataFolders,
    writePairingFile,
    removePairingFiles
};
