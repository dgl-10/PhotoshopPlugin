const {
    createGenerationRecord,
    executeGeneration,
    normalizeGenerationRequest,
    resultToAbsolutePath
} = require('../localGenerationApi');
const { jsonResult, toolError } = require('./toolResults');

const DEFAULT_TIMEOUT_SECONDS = 180;

/**
 * Map MCP generate_image arguments onto a Local API generation body.
 * timeout_seconds stays on the MCP layer and is not forwarded.
 *
 * @param {object} args - Validated generate_image arguments.
 * @returns {object} Body accepted by normalizeGenerationRequest.
 */
function mapGenerateImageArgs(args) {
    const params = args.params === undefined ? {} : { ...args.params };
    if (typeof args.prompt === 'string') {
        params.prompt = args.prompt;
    }

    return {
        providerId: args.providerId,
        sourceImagePath: args.sourceImagePath,
        maskImagePath: args.maskImagePath,
        referenceImagePaths: args.referenceImagePaths,
        aspect_ratio: args.aspect_ratio,
        num_images: args.num_images,
        use_mask: args.use_mask,
        force_separate_requests: args.force_separate_requests,
        params
    };
}

/**
 * Wait for a promise or a timeout, whichever happens first.
 * The underlying promise is not cancelled.
 *
 * @param {Promise<unknown>} promise - Executor promise.
 * @param {number} timeoutMs - Milliseconds to wait.
 * @returns {Promise<{timedOut: boolean}>}
 */
function raceWithTimeout(promise, timeoutMs) {
    let timer = null;
    const timeoutPromise = new Promise(resolve => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });

    return Promise.race([
        Promise.resolve(promise).then(() => ({ timedOut: false })),
        timeoutPromise
    ]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
}

/**
 * Collect absolute output paths from a finished generation.
 *
 * @param {object} generation - Generation record after executeGeneration.
 * @param {string} tempDir - Shared output directory.
 * @returns {string[]} Absolute generated file paths.
 */
function collectOutputPaths(generation, tempDir) {
    return (generation.results || [])
        .map(result => resultToAbsolutePath(result, tempDir))
        .filter(Boolean);
}

/**
 * Create the generate_image tool handler.
 *
 * Malformed input is a tool error and never creates a generation.
 * Executor failures are a successful tool call with status "failed".
 *
 * @param {object} dependencies - Shared executor dependencies.
 * @param {Function} dependencies.generate - Existing generate() function.
 * @param {string} dependencies.tempDir - Shared WebHelper/Local API output directory.
 * @param {Function} [dependencies.onGenerationAccepted] - Usage/accounting hook.
 * @returns {Function} MCP tool callback.
 */
function createGenerateImageHandler(dependencies) {
    return async (args = {}) => {
        let request;
        try {
            request = normalizeGenerationRequest(mapGenerateImageArgs(args));
        } catch (error) {
            return toolError(error.message || 'Invalid generate_image arguments.');
        }

        const generation = createGenerationRecord(request);

        if (typeof dependencies.onGenerationAccepted === 'function') {
            Promise.resolve()
                .then(() => dependencies.onGenerationAccepted(generation))
                .catch(error => {
                    console.error('[MCP] Generation accounting callback failed:', error);
                });
        }

        const timeoutSeconds = args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
        const startedAt = Date.now();
        const outcome = await raceWithTimeout(
            executeGeneration(generation, {
                generate: dependencies.generate,
                tempDir: dependencies.tempDir
            }),
            timeoutSeconds * 1000
        );
        const durationMs = Date.now() - startedAt;

        if (outcome.timedOut) {
            return jsonResult({
                generationId: generation.generationId,
                status: 'failed',
                providerId: generation.providerId,
                outputPaths: [],
                error: `Generation timed out after ${timeoutSeconds} seconds.`,
                durationMs
            });
        }

        if (generation.status === 'completed') {
            return jsonResult({
                generationId: generation.generationId,
                status: 'completed',
                providerId: generation.providerId,
                outputPaths: collectOutputPaths(generation, dependencies.tempDir),
                durationMs
            });
        }

        return jsonResult({
            generationId: generation.generationId,
            status: 'failed',
            providerId: generation.providerId,
            outputPaths: [],
            error: generation.error || 'Generation failed.',
            durationMs
        });
    };
}

module.exports = {
    DEFAULT_TIMEOUT_SECONDS,
    raceWithTimeout,
    createGenerateImageHandler,
    // Exported for tests only.
    mapGenerateImageArgs
};
