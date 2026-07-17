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
 */
function getConfigPaths() {
    if (app.isPackaged) {
        const userDataPath = app.getPath('userData');
        return {
            envPath:        path.join(userDataPath, '.env'),
            providersPath:  path.join(userDataPath, 'providers.json'),
            userDataPath,
            // process.resourcesPath points to <app>/resources/ on Windows
            // and <app>.app/Contents/Resources/ on macOS
            resourcesPath:  process.resourcesPath
        };
    }

    // Development: keep reading from the project directory as before
    const devRoot = path.join(__dirname, '..');
    return {
        envPath:        path.join(devRoot, '.env'),
        providersPath:  path.join(devRoot, 'providers.json'),
        userDataPath:   devRoot,
        resourcesPath:  devRoot
    };
}

module.exports = { getConfigPaths };
