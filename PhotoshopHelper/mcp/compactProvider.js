const { getValidGenerationModes } = require('../availableProviders');

/**
 * Keep only providers that declare a valid t2i/i2i generation_modes array.
 *
 * @param {object[]} providers - Providers that already passed the API-key scan.
 * @returns {object[]} Providers that MCP tools may advertise.
 */
function selectMcpProviders(providers) {
    return (providers || []).filter(provider => getValidGenerationModes(provider));
}

/**
 * Compact list_providers rows: id, name, generation_modes only.
 *
 * @param {object[]} providers - MCP-eligible providers.
 * @param {'t2i'|'i2i'} [mode] - Optional generation-mode filter.
 * @returns {{providers: object[]}} Lightweight provider list.
 */
function toProviderSummaries(providers, mode) {
    const summaries = [];
    for (const provider of providers) {
        const generationModes = getValidGenerationModes(provider);
        if (!generationModes) {
            continue;
        }
        if (mode && !generationModes.includes(mode)) {
            continue;
        }
        summaries.push({
            id: provider.id,
            name: provider.name,
            generation_modes: generationModes
        });
    }
    return { providers: summaries };
}

/**
 * Compact one dropdown to the option values generate() consumes.
 *
 * @param {unknown[]} options - Provider parameter options.
 * @returns {string[]} Visible option values, without UI aliases or labels.
 */
function compactDropdownOptions(options) {
    const values = [];
    for (const option of options) {
        if (option && typeof option === 'object' && !Array.isArray(option)) {
            if (option.hidden === true) {
                continue;
            }
            if (option.value !== undefined) {
                values.push(option.value);
            }
            continue;
        }
        if (typeof option === 'string') {
            values.push(option);
        }
    }
    return values;
}

/**
 * Compact one provider parameter for a model, not the WebHelper UI.
 *
 * @param {object} parameter - Provider parameter definition.
 * @returns {object|null} Compact parameter, or null when it has no name.
 */
function compactParameter(parameter) {
    if (!parameter || typeof parameter.name !== 'string' || parameter.name === '') {
        return null;
    }

    const compact = {
        name: parameter.name,
        type: parameter.type
    };

    if (parameter.default !== undefined) {
        compact.default = parameter.default;
    }

    if (parameter.type === 'dropdown' && Array.isArray(parameter.options)) {
        compact.options = compactDropdownOptions(parameter.options);
    }

    if (parameter.min !== undefined) {
        compact.min = parameter.min;
    }
    if (parameter.max !== undefined) {
        compact.max = parameter.max;
    }
    if (parameter.step !== undefined) {
        compact.step = parameter.step;
    }

    return compact;
}

/**
 * Compact one provider for get_providers_details.
 *
 * @param {object} provider - Full provider configuration.
 * @returns {object|null} Model-oriented details, or null when modes are invalid.
 */
function compactProviderDetails(provider) {
    const generationModes = getValidGenerationModes(provider);
    if (!generationModes) {
        return null;
    }

    const details = {
        id: provider.id,
        name: provider.name,
        generation_modes: generationModes
    };

    if (provider.allowed_aspect_ratios !== undefined) {
        details.allowed_aspect_ratios = provider.allowed_aspect_ratios;
    }

    if (provider.max_reference_images !== undefined) {
        details.max_reference_images = provider.max_reference_images;
    }

    if (provider.mask_handling && typeof provider.mask_handling === 'object') {
        details.mask_handling = {
            supported: Boolean(provider.mask_handling.supported),
            required: Boolean(provider.mask_handling.required)
        };
    }

    if (provider.supports_negative_prompt !== undefined) {
        details.supports_negative_prompt = provider.supports_negative_prompt;
    }

    if ((provider.request_config && provider.request_config.single_image_per_request === true)
        || provider.single_image_per_request === true) {
        details.single_image_per_request = true;
    }

    const parameters = Array.isArray(provider.parameters)
        ? provider.parameters.map(compactParameter).filter(Boolean)
        : [];
    details.parameters = parameters;

    return details;
}

/**
 * Build get_providers_details output, or an input error description.
 *
 * An unknown or inactive id is listed in notFound and does not fail the call.
 * An empty list, omitted field, or "*" is a tool input error.
 *
 * @param {object[]} providers - MCP-eligible active providers.
 * @param {unknown} providerIds - Requested provider ids.
 * @returns {{error: string}|{providers: object[], notFound: string[]}}
 */
function getProvidersDetails(providers, providerIds) {
    if (!Array.isArray(providerIds) || providerIds.length === 0) {
        return {
            error: 'providerIds must be a non-empty array of provider ids from list_providers. Wildcard "*" is not accepted.'
        };
    }

    if (providerIds.some(id => id === '*')) {
        return {
            error: 'Wildcard "*" is not accepted. Pass specific provider ids from list_providers.'
        };
    }

    const byId = new Map();
    for (const provider of providers) {
        if (provider && typeof provider.id === 'string') {
            byId.set(provider.id, provider);
        }
    }

    const details = [];
    const notFound = [];
    for (const id of providerIds) {
        const provider = typeof id === 'string' ? byId.get(id) : undefined;
        const compacted = provider ? compactProviderDetails(provider) : null;
        if (!compacted) {
            notFound.push(id);
            continue;
        }
        details.push(compacted);
    }

    return { providers: details, notFound };
}

module.exports = {
    selectMcpProviders,
    toProviderSummaries,
    compactParameter,
    getProvidersDetails,
    // Exported for tests only.
    compactProviderDetails
};
