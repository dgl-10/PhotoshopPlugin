'use strict';

/**
 * Client-safe provider discovery, shared by the WebHelper HTTP endpoint and the MCP tools.
 *
 * Availability is evaluated dynamically: providers whose API keys are not configured are
 * dropped, the runtime CLI provider is appended when it exists, and everything that only
 * the server may see (request templates, response handlers, preprocessors) is removed.
 */

/**
 * Build the list of providers a client may see.
 *
 * @param {object} dependencies
 * @param {Function} dependencies.loadProvidersCatalog - Returns { providers, response_handlers }.
 * @param {Function} dependencies.findMissingEnvKeys - Returns the missing API-key names of one provider.
 * @param {Function} dependencies.getRuntimeCliImageProvider - Resolves the runtime CLI provider, or null.
 * @returns {Promise<object[]>} Sanitized provider descriptions.
 */
async function listClientProviders({ loadProvidersCatalog, findMissingEnvKeys, getRuntimeCliImageProvider }) {
    const catalog = loadProvidersCatalog();

    // 1. Filter out providers for which API keys are not defined in the system
    const availableProviders = catalog.providers.filter(p => (
        findMissingEnvKeys(p, catalog.response_handlers).length === 0
    ));

    // The CLI provider is runtime state, not user-editable provider catalog data.
    const cliImageProvider = await getRuntimeCliImageProvider();
    if (cliImageProvider) availableProviders.push(cliImageProvider);

    // 2. Sanitize and elevate properties for the client
    return availableProviders.map(p => {
        const sanitized = { ...p };

        // Elevate single_image_per_request to client level if it exists in request_config
        if (p.request_config && p.request_config.single_image_per_request) {
            sanitized.single_image_per_request = true;
        } else {
            sanitized.single_image_per_request = false;
        }

        delete sanitized.request_config;
        delete sanitized.response_config;
        delete sanitized.image_format;
        delete sanitized.filename_suffix;
        delete sanitized.preprocessor;
        return sanitized;
    });
}

module.exports = { listClientProviders };
