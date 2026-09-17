const { app } = require('electron');
const path = require('node:path');

/**
 * Returns the correct paths for runtime config files.
 *
 * - Development (npm start):  reads from __dirname/../  (project root of PhotoshopHelper)
 * - Production  (packaged):   reads/writes from app.getPath('userData')
 *
 * Using a single source of truth here prevents scattered path.join(__dirname, ...) calls
 * spread across main.js and other modules.
 *
 * The model list is read from two files (see providers-catalog.js):
 * - sharedProvidersPath: the shared list. A packaged app uses its copy downloaded from
 *   the repository; development reads the local providers.template.json directly.
 * - userProvidersPath:   the user's own models and changes, laid over the shared list.
 * downloadedProvidersPath is where the downloaded shared list is saved; it is null in
 * development, where nothing is downloaded.
 */
function getConfigPaths() {
    if (app && app.isPackaged) {
        const userDataPath = app.getPath('userData');
        const downloadedProvidersPath = path.join(userDataPath, 'providers.remote.json');
        return {
            envPath:                 path.join(userDataPath, '.env'),
            sharedProvidersPath:     downloadedProvidersPath,
            downloadedProvidersPath,
            userProvidersPath:       path.join(userDataPath, 'providers.user.json'),
            userDataPath,
            // process.resourcesPath points to <app>/resources/ on Windows
            // and <app>.app/Contents/Resources/ on macOS
            resourcesPath:           process.resourcesPath
        };
    }

    // Development: keep reading from the project directory as before
    const devRoot = path.join(__dirname, '..');
    return {
        envPath:                 path.join(devRoot, '.env'),
        sharedProvidersPath:     path.join(devRoot, 'providers.template.json'),
        downloadedProvidersPath: null,
        userProvidersPath:       path.join(devRoot, 'providers.user.json'),
        userDataPath:            devRoot,
        resourcesPath:           devRoot
    };
}

module.exports = { getConfigPaths };
