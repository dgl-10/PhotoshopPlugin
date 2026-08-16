const fs = require('node:fs');

const JSON5 = require('json5');

const IMPLEMENTED_GENERATION_MODES = Object.freeze(['t2i', 'i2i']);
const ENV_KEY_PATTERN = /\{\{env:([a-zA-Z0-9_]+)\}\}/g;

/**
 * Read the active providers document.
 *
 * Missing files are treated as an empty catalog. Parse errors are left to the
 * caller so WebHelper can still return HTTP 500.
 *
 * @returns {{providers?: object[], response_handlers?: object}} Parsed providers.json.
 */
function loadProvidersDocument() {
    // Lazy require: this module is also used by unit tests that must not load Electron.
    const { getConfigPaths } = require('./setup/config-paths');
    const { providersPath } = getConfigPaths();
    if (!fs.existsSync(providersPath)) {
        return { providers: [] };
    }

    const providersRaw = fs.readFileSync(providersPath, 'utf8');
    return JSON5.parse(providersRaw);
}

/**
 * Return whether every {{env:KEY}} referenced by a provider (and its response
 * handler) is present and non-empty.
 *
 * This is the same scan used by GET /api/webhelper/providers.
 *
 * @param {object} provider - One provider configuration object.
 * @param {object} providersData - Full providers document, including handlers.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment used for key lookup.
 * @returns {boolean} True when every required key is available.
 */
function providerHasRequiredEnvKeys(provider, providersData, env = process.env) {
    let configStr = JSON.stringify(provider);

    if (provider.response_config && provider.response_config.$ref
        && providersData.response_handlers
        && providersData.response_handlers[provider.response_config.$ref]) {
        configStr += JSON.stringify(providersData.response_handlers[provider.response_config.$ref]);
    }

    const requiredKeys = [...new Set(
        [...configStr.matchAll(ENV_KEY_PATTERN)].map(match => match[1])
    )];

    return requiredKeys.every(key => env[key] && env[key].trim() !== '');
}

/**
 * Keep providers whose required API keys are present.
 *
 * @param {object} providersData - Parsed providers document.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment used for key lookup.
 * @returns {object[]} Providers that can actually be invoked.
 */
function filterProvidersWithApiKeys(providersData, env = process.env) {
    return (providersData.providers || []).filter(provider => (
        providerHasRequiredEnvKeys(provider, providersData, env)
    ));
}

/**
 * Load providers.json and drop entries whose required API keys are missing.
 *
 * @param {object} [options] - Optional overrides for tests.
 * @param {object} [options.providersData] - Preloaded providers document.
 * @param {NodeJS.ProcessEnv} [options.env] - Environment used for key lookup.
 * @returns {object[]} Available providers.
 */
function getAvailableProviders(options = {}) {
    const providersData = options.providersData || loadProvidersDocument();
    return filterProvidersWithApiKeys(providersData, options.env || process.env);
}

/**
 * Return the declared t2i/i2i modes, or null when the declaration is missing
 * or invalid. Matches the generator's uniqueness and implemented-mode rules.
 *
 * @param {object} provider - Provider configuration.
 * @returns {string[]|null} Valid modes, or null when the provider must be omitted.
 */
function getValidGenerationModes(provider) {
    const configuredModes = provider && provider.generation_modes;
    if (!Array.isArray(configuredModes) || configuredModes.length === 0) {
        return null;
    }

    const uniqueModes = [];
    const seen = new Set();
    for (const mode of configuredModes) {
        if (typeof mode !== 'string' || !IMPLEMENTED_GENERATION_MODES.includes(mode) || seen.has(mode)) {
            return null;
        }
        seen.add(mode);
        uniqueModes.push(mode);
    }

    return uniqueModes;
}

module.exports = {
    IMPLEMENTED_GENERATION_MODES,
    loadProvidersDocument,
    providerHasRequiredEnvKeys,
    getAvailableProviders,
    getValidGenerationModes,
    // Exported for tests only.
    filterProvidersWithApiKeys
};
