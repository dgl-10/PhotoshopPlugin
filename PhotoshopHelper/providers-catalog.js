const fs = require('node:fs');
const path = require('node:path');

const JSON5 = require('json5');

const { getConfigPaths } = require('./setup/config-paths');
const { writeFileAtomic } = require('./atomic-write');

// The model list is assembled from two files on every read:
//
//   shared  the list published as providers.template.json. A packaged app reads its
//           downloaded copy (providers.remote.json, written by providers-updater.js);
//           development reads the local template directly.
//   user    providers.user.json with the user's own models and changes. The app only
//           creates it empty and never writes to it afterwards.
//
// The user file is laid over the shared list by provider id, so a new shared list never
// has to be merged into a file the user edits.

const ENV_PLACEHOLDER_PATTERN = /\{\{env:([a-zA-Z0-9_]+)\}\}/g;

/**
 * @param {object|null|undefined} catalog - Parsed catalog.
 * @returns {object[]} Provider entries that at least have a string id.
 */
function providerList(catalog) {
    if (!Array.isArray(catalog?.providers)) {
        return [];
    }
    return catalog.providers.filter(provider => (
        provider && typeof provider === 'object' && typeof provider.id === 'string' && provider.id !== ''
    ));
}

/**
 * @param {object|null|undefined} catalog - Parsed catalog.
 * @returns {object} Its response_handlers map, or an empty object.
 */
function handlerMap(catalog) {
    const handlers = catalog?.response_handlers;
    return handlers && typeof handlers === 'object' && !Array.isArray(handlers) ? handlers : {};
}

/**
 * Check that a downloaded list is complete enough to replace the current shared list.
 *
 * @param {object} catalog - Parsed catalog.
 * @returns {string[]} Problems found; an empty array means the list is usable.
 */
function validateSharedCatalog(catalog) {
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
        return ['the list is not a JSON object'];
    }

    const problems = [];

    const handlers = catalog.response_handlers;
    const hasHandlers = handlers && typeof handlers === 'object' && !Array.isArray(handlers);
    if (!hasHandlers) {
        problems.push('response_handlers must be an object');
    }

    if (!Array.isArray(catalog.providers) || catalog.providers.length === 0) {
        problems.push('providers must be a non-empty array');
        return problems;
    }

    const ids = new Set();
    catalog.providers.forEach((provider, index) => {
        if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
            problems.push(`providers[${index}] is not an object`);
            return;
        }
        if (typeof provider.id !== 'string' || provider.id.trim() === '') {
            problems.push(`providers[${index}] has no id`);
            return;
        }

        const label = `provider "${provider.id}"`;
        if (ids.has(provider.id)) {
            problems.push(`${label} is listed more than once`);
        }
        ids.add(provider.id);

        if (typeof provider.name !== 'string' || provider.name.trim() === '') {
            problems.push(`${label} has no name`);
        }
        if (!provider.request_config || typeof provider.request_config !== 'object') {
            problems.push(`${label} has no request_config`);
        }
        if (!provider.response_config || typeof provider.response_config !== 'object') {
            problems.push(`${label} has no response_config`);
        } else {
            const ref = provider.response_config.$ref;
            if (ref !== undefined && !(hasHandlers && Object.prototype.hasOwnProperty.call(handlers, ref))) {
                problems.push(`${label} refers to unknown response handler "${ref}"`);
            }
        }
    });

    return problems;
}

/**
 * Read and parse a catalog file.
 *
 * @param {string|null|undefined} filePath - Catalog file.
 * @returns {object|null} Parsed catalog, or null when there is no such file.
 * @throws {Error} When the file exists but is not valid JSON5; the message names the file.
 */
function readCatalogFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }
    try {
        return JSON5.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`${path.basename(filePath)}: ${error.message}`);
    }
}

/**
 * Lay the user's catalog over the shared one.
 *
 * A user provider with the id of a shared provider replaces it entirely, and one with
 * "disabled": true hides it. User providers with new ids are appended. Response handlers
 * are combined by name with the same precedence.
 *
 * @param {object|null} shared - Shared catalog.
 * @param {object|null} user - User catalog.
 * @returns {{response_handlers: object, providers: object[]}}
 */
function mergeCatalogs(shared, user) {
    const sharedProviders = providerList(shared);
    const userProviders = providerList(user);

    // The first entry wins when an id repeats, as Array.find did with a single file.
    const overrides = new Map();
    for (const provider of userProviders) {
        if (!overrides.has(provider.id)) {
            overrides.set(provider.id, provider);
        }
    }

    const providers = [];
    const seen = new Set();
    for (const provider of [...sharedProviders, ...userProviders]) {
        if (seen.has(provider.id)) continue;
        seen.add(provider.id);

        const chosen = overrides.get(provider.id) || provider;
        if (chosen.disabled !== true) {
            providers.push(chosen);
        }
    }

    return {
        response_handlers: { ...handlerMap(shared), ...handlerMap(user) },
        providers
    };
}

/**
 * Load the model list the app works with.
 *
 * @param {object} [options]
 * @param {object} [options.paths] - Result of getConfigPaths().
 * @returns {{response_handlers: object, providers: object[]}}
 * @throws {Error} When a file is not valid JSON5.
 */
function loadProvidersCatalog(options = {}) {
    const paths = options.paths || getConfigPaths();
    return mergeCatalogs(
        readCatalogFile(paths.sharedProvidersPath),
        readCatalogFile(paths.userProvidersPath)
    );
}

/**
 * List the environment variables a provider needs, from its {{env:NAME}} placeholders
 * and those of the response handler it refers to, and keep those that are unset or blank.
 *
 * @param {object} provider - Provider configuration.
 * @param {object} [responseHandlers] - Catalog response_handlers map.
 * @param {object} [env] - Environment to check.
 * @returns {string[]} Missing variable names.
 */
function findMissingEnvKeys(provider, responseHandlers = {}, env = process.env) {
    let configText = JSON.stringify(provider);

    const ref = provider?.response_config?.$ref;
    if (ref && responseHandlers && responseHandlers[ref]) {
        configText += JSON.stringify(responseHandlers[ref]);
    }

    const names = new Set([...configText.matchAll(ENV_PLACEHOLDER_PATTERN)].map(match => match[1]));
    return [...names].filter(name => !(typeof env[name] === 'string' && env[name].trim() !== ''));
}

const EMPTY_USER_CATALOG_TEXT = [
    '{',
    '    // providers.user.json: your own models and your changes to the shared ones.',
    '    //',
    '    // The shared model list is updated automatically, so do not copy it here.',
    '    // It is laid over by this file on every read:',
    '    //   - a model with a new "id" is added;',
    '    //   - a model with the "id" of a shared one replaces it entirely;',
    '    //   - { "id": "<shared id>", "disabled": true } hides a shared model.',
    '    // Response handlers here replace shared ones of the same name.',
    '    // Reload WebHelper after saving. See Providers_Configuration_Guide.md for the format.',
    '    "response_handlers": {},',
    '    "providers": []',
    '}',
    ''
].join('\n');

/**
 * Create an empty providers.user.json with instructions when there is none yet, so the
 * user finds the place for their own models next to .env.
 *
 * @param {object} [options]
 * @param {object} [options.paths] - Result of getConfigPaths().
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {boolean} True when the file was created.
 */
function ensureUserCatalogFile(options = {}) {
    const paths = options.paths || getConfigPaths();
    const logger = options.logger || console;

    if (!paths.userProvidersPath || fs.existsSync(paths.userProvidersPath)) {
        return false;
    }

    writeFileAtomic(paths.userProvidersPath, EMPTY_USER_CATALOG_TEXT);
    logger.info(`[providers] Created ${path.basename(paths.userProvidersPath)}`);
    return true;
}

module.exports = {
    validateSharedCatalog,
    loadProvidersCatalog,
    findMissingEnvKeys,
    ensureUserCatalogFile
};
