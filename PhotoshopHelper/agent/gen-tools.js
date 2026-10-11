'use strict';

/**
 * The generation tools the MCP server hands to an agent.
 *
 * Everything here is prefixed `gen_` and has nothing to do with the Photoshop document or
 * with a task: no task id, no plugin channel, no journal. The tools are thin wrappers over
 * the same generation service that backs the Local Generation API, so a generation started
 * here can also be read over HTTP and the other way round. Provider parameters are passed
 * through exactly as the HTTP API expects them; no defaults are filled in on the way.
 */

const path = require('node:path');

// Same reasoning as DIALOG_WAIT_MS in mcp-tools.js: an MCP client throws away a tool call
// that outlasts its own limit (as low as 60 seconds), so no single status call may wait
// longer than this, however long the generation itself takes.
const MAX_STATUS_WAIT_MS = 40_000;
const DEFAULT_STATUS_WAIT_MS = 30_000;

/**
 * @param {string} text - Text for the agent.
 * @param {boolean} [isError] - Whether this is a refusal.
 * @returns {object} An MCP tool result.
 */
function textResult(text, isError = false) {
    const result = { content: [{ type: 'text', text }] };
    if (isError) result.isError = true;
    return result;
}

/**
 * @param {object} provider - Full provider description from discovery.
 * @returns {object} The short form shown in the provider list.
 */
function summarizeProvider(provider) {
    return {
        id: provider.id,
        name: provider.name,
        generation_modes: provider.generation_modes,
        mask_handling: provider.mask_handling
            ? { supported: provider.mask_handling.supported, required: provider.mask_handling.required }
            : undefined,
        max_reference_images: provider.max_reference_images,
        single_image_per_request: provider.single_image_per_request
    };
}

/**
 * Build the generation tool layer.
 *
 * @param {object} options
 * @param {object} options.service - Generation service from localGenerationApi.js.
 * @param {() => Promise<object[]>} options.listProviders - Client-safe provider discovery.
 * @param {string} options.docsDir - Folder that holds Local_Generation_API.md and
 *   Providers_Configuration_Guide.md (the app's resources folder, in dev and in a
 *   packaged build alike).
 * @returns {{list: Function, call: Function, names: string[]}} Tool definitions and dispatcher.
 */
function createGenerationTools({ service, listProviders, docsDir }) {
    const apiDocPath = path.join(docsDir, 'Local_Generation_API.md');
    const providersGuidePath = path.join(docsDir, 'Providers_Configuration_Guide.md');

    // Repeated in the descriptions an agent reads at the moment it decides what to do.
    const apiDocPointer =
        `The full contract is in ${apiDocPath}. These tools are a thin layer over the `
        + 'Local Generation API described there: if you would rather call that HTTP API '
        + 'yourself, do — the document says how.';

    const TOOLS = [
        {
            name: 'gen_list_providers',
            description:
                'List the image-generation providers that are available right now: id, name, '
                + 'the generation modes they support (t2i = text to image, i2i = image to '
                + 'image), whether they take a mask, and how many reference images. Short '
                + 'on purpose — call gen_get_provider for the parameters of one provider. '
                + 'Generation spends money on a paid provider. ' + apiDocPointer,
            inputSchema: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['t2i', 'i2i'],
                        description: 'Only providers that support this mode.'
                    }
                },
                additionalProperties: false
            }
        },
        {
            name: 'gen_get_provider',
            description:
                'The full description of one provider: every parameter with its type, default '
                + 'and allowed values, aspect-ratio rules, reference-image limits and mask '
                + 'handling. Read it before gen_start: the request must carry every '
                + '`parameters[].name` in `params`. The rules for turning this description '
                + `into a request are in ${apiDocPath}, section "How to turn a discovered `
                + 'provider into a request".',
            inputSchema: {
                type: 'object',
                properties: {
                    provider_id: { type: 'string', description: 'The `id` from gen_list_providers.' }
                },
                required: ['provider_id'],
                additionalProperties: false
            }
        },
        {
            name: 'gen_start',
            description:
                'Start one image generation on a paid provider and return its generationId '
                + 'at once; the work runs in the background — follow it with gen_get_status. '
                + 'The arguments are exactly the body of POST /api/local/v1/generations. Name '
                + 'the provider with `providerId` (from gen_list_providers) OR give a complete '
                + 'inline `provider` object, never both. Inputs are absolute local file paths, '
                + 'never image bytes. The server does NOT fill in defaults: `params` must '
                + 'contain every `parameters[].name` of the provider (copy `default` where you '
                + 'do not override it), otherwise the literal text "{{name}}" can be sent to '
                + 'the paid provider. `num_images` and `aspect_ratio` are root fields, never '
                + 'keys of `params`. `aspect_ratio` is required for text-to-image. '
                + 'Without sourceImagePath, the first referenceImagePaths entry becomes the '
                + 'source. '
                + apiDocPointer + ' '
                + 'To write an inline `provider` object, read ONLY these sections of '
                + `${providersGuidePath}: 3.2 Image Format, 3.3 Mask Handling, 3.4 Reference `
                + 'Images, 3.10 Generation Modes, 4 Request Configuration, 5 Placeholder '
                + 'System, 7 Response Configuration, 8 Response Handlers (pick an existing '
                + '$ref), 9 Preprocessors (only if needed).',
            inputSchema: {
                type: 'object',
                properties: {
                    providerId: {
                        type: 'string',
                        description: 'Provider id. Mutually exclusive with `provider`.'
                    },
                    provider: {
                        type: 'object',
                        description: 'Complete inline provider configuration. Mutually exclusive with `providerId`.'
                    },
                    sourceImagePath: { type: 'string', description: 'Absolute path to the source image.' },
                    maskImagePath: { type: 'string', description: 'Absolute path to the mask image.' },
                    referenceImagePaths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Ordered absolute paths of reference images.'
                    },
                    params: {
                        type: 'object',
                        description: 'Provider parameter values keyed by `parameters[].name`; every declared parameter must be present.'
                    },
                    num_images: { type: 'integer', minimum: 1, maximum: 100, description: 'Output count. Default 1.' },
                    aspect_ratio: { type: 'string', description: 'For example "1:1". Required for text-to-image.' },
                    use_mask: { type: 'boolean', description: 'Whether to use maskImagePath. Defaults to true when a mask path is given.' },
                    force_separate_requests: { type: 'boolean', description: 'One provider request per output. Default false.' }
                },
                additionalProperties: false
            }
        },
        {
            name: 'gen_get_status',
            description:
                'Read the state of a generation started with gen_start: queued, running, '
                + 'completed or failed. When it is completed, `outputPaths` lists the absolute '
                + 'paths of the generated files — open them yourself if you need to look at '
                + 'them. The call waits for the generation to finish, but at most '
                + `${Math.round(MAX_STATUS_WAIT_MS / 1000)} seconds, so call it again while it `
                + 'says the generation is still running. Generation state is kept in memory and '
                + 'is lost when Photoshop Helper restarts.',
            inputSchema: {
                type: 'object',
                properties: {
                    generation_id: { type: 'string', description: 'The generationId from gen_start.' },
                    wait_seconds: {
                        type: 'number',
                        description: `How long to wait for the end, 0 to ${Math.round(MAX_STATUS_WAIT_MS / 1000)}. Default ${Math.round(DEFAULT_STATUS_WAIT_MS / 1000)}.`
                    }
                },
                required: ['generation_id'],
                additionalProperties: false
            }
        }
    ];

    /**
     * @param {object} args - Tool arguments.
     * @returns {Promise<object>} MCP tool result.
     */
    async function listProvidersTool(args) {
        const providers = await listProviders();
        const wanted = args.mode;
        const shown = wanted
            ? providers.filter(p => Array.isArray(p.generation_modes) && p.generation_modes.includes(wanted))
            : providers;

        if (shown.length === 0) {
            return textResult(
                wanted
                    ? `No available provider supports the mode "${wanted}".`
                    : 'No providers are available. API keys may be missing in Photoshop Helper.',
                true
            );
        }
        return textResult(JSON.stringify({ providers: shown.map(summarizeProvider) }, null, 2));
    }

    /**
     * @param {object} args - Tool arguments.
     * @returns {Promise<object>} MCP tool result.
     */
    async function getProviderTool(args) {
        const id = typeof args.provider_id === 'string' ? args.provider_id.trim() : '';
        if (!id) return textResult('gen_get_provider needs "provider_id".', true);

        const providers = await listProviders();
        const provider = providers.find(p => p.id === id);
        if (!provider) {
            return textResult(
                `There is no available provider "${id}". Available: ${providers.map(p => p.id).join(', ') || '(none)'}.`,
                true
            );
        }
        return textResult(JSON.stringify(provider, null, 2));
    }

    /**
     * @param {object} args - Tool arguments, the body of POST /generations.
     * @returns {Promise<object>} MCP tool result.
     */
    async function startTool(args) {
        let accepted;
        try {
            accepted = await service.accept(args);
        } catch (error) {
            // A rejected request carries a message written for an API consumer, which is
            // exactly what the agent needs. Anything without a status is our own fault.
            if (error && error.statusCode && error.statusCode < 500) {
                return textResult(`The generation was not started: ${error.message}`, true);
            }
            throw error;
        }

        return textResult(JSON.stringify({
            generationId: accepted.generationId,
            status: accepted.status,
            next: 'Call gen_get_status with this generationId until it is completed or failed.'
        }, null, 2));
    }

    /**
     * @param {object} args - Tool arguments.
     * @returns {Promise<object>} MCP tool result.
     */
    async function getStatusTool(args) {
        const id = typeof args.generation_id === 'string' ? args.generation_id.trim() : '';
        if (!id) return textResult('gen_get_status needs "generation_id".', true);

        const requested = Number.isFinite(args.wait_seconds)
            ? args.wait_seconds * 1000
            : DEFAULT_STATUS_WAIT_MS;
        const waitMs = Math.min(MAX_STATUS_WAIT_MS, Math.max(0, requested));

        const generation = await service.waitForCompletion(id, waitMs);
        if (!generation) {
            return textResult(
                `There is no generation "${id}". Generations are kept in memory only, so one `
                + 'started before Photoshop Helper restarted is gone.',
                true
            );
        }

        const terminal = generation.status === 'completed' || generation.status === 'failed';
        const payload = { ...generation };
        // The status URL is for HTTP clients; the agent addresses the generation by id.
        delete payload.statusUrl;
        if (!terminal) {
            payload.next = 'Still in progress. Call gen_get_status again.';
        }
        return textResult(JSON.stringify(payload, null, 2), generation.status === 'failed');
    }

    const HANDLERS = {
        gen_list_providers: listProvidersTool,
        gen_get_provider: getProviderTool,
        gen_start: startTool,
        gen_get_status: getStatusTool
    };

    return {
        names: Object.keys(HANDLERS),

        /**
         * @returns {object[]} Tool definitions for tools/list.
         */
        list() {
            return TOOLS;
        },

        /**
         * @param {string} name - Tool name.
         * @param {object} args - Tool arguments.
         * @returns {Promise<object>} MCP tool result.
         */
        async call(name, args = {}) {
            const handler = HANDLERS[name];
            if (!handler) {
                return textResult(`There is no tool "${name}". Available: ${Object.keys(HANDLERS).join(', ')}.`, true);
            }
            try {
                return await handler(args || {});
            } catch (error) {
                return textResult(`${name} failed: ${error.message}`, true);
            }
        }
    };
}

module.exports = {
    createGenerationTools,
    MAX_STATUS_WAIT_MS
};
