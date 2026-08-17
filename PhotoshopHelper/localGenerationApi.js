const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const express = require('express');

const { createAuthMiddleware } = require('./auth');

// The common prefix is versioned independently from the browser-oriented
// WebHelper API so the local service contract can evolve without breaking the UI.
const LOCAL_API_PREFIX = '/api/local/v1';

/**
 * Create an Error whose HTTP status is safe to expose to an API consumer.
 *
 * @param {string} message - Human-readable validation failure.
 * @param {number} [statusCode=400] - HTTP response status associated with the error.
 * @returns {Error & {statusCode: number}} An error carrying its response status.
 */
function createHttpError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

/**
 * Determine whether a value is a JSON object rather than an array or primitive.
 *
 * @param {unknown} value - Request value to inspect.
 * @returns {boolean} True when the value can safely be treated as a params object.
 */
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Validate and normalize one image path supplied by a local API consumer.
 *
 * Absolute paths make requests deterministic for callers launched with different
 * working directories. No file is copied: the generation core reads each normalized
 * path directly for this one generation.
 *
 * @param {unknown} value - Potential absolute path from the request body.
 * @param {string} fieldName - JSON field name used in validation messages.
 * @param {boolean} required - Whether an omitted value should be rejected.
 * @returns {string|null} A normalized absolute path, or null when optional and absent.
 */
function normalizeInputFilePath(value, fieldName, required) {
    if (value === undefined || value === null || value === '') {
        if (required) {
            throw createHttpError(`"${fieldName}" is required.`);
        }
        return null;
    }

    if (typeof value !== 'string') {
        throw createHttpError(`"${fieldName}" must be a string containing an absolute file path.`);
    }

    if (!path.isAbsolute(value)) {
        throw createHttpError(`"${fieldName}" must be an absolute file path.`);
    }

    const normalizedPath = path.normalize(value);
    let stats;

    try {
        stats = fs.statSync(normalizedPath);
        fs.accessSync(normalizedPath, fs.constants.R_OK);
    } catch (error) {
        throw createHttpError(`"${fieldName}" is not an existing readable file: ${normalizedPath}`);
    }

    if (!stats.isFile()) {
        throw createHttpError(`"${fieldName}" must point to a regular file: ${normalizedPath}`);
    }

    return normalizedPath;
}

/**
 * Validate one self-contained local generation request.
 *
 * @param {unknown} body - Parsed Express JSON request body.
 * @returns {object} Normalized image paths, provider, and generation arguments.
 */
function normalizeGenerationRequest(body) {
    if (!isPlainObject(body)) {
        throw createHttpError('The request body must be a JSON object.');
    }

    const providerId = body.providerId;
    if (typeof providerId !== 'string' || providerId.trim() === '') {
        throw createHttpError('"providerId" is required and must be a non-empty string.');
    }

    const params = body.params === undefined ? {} : body.params;
    if (!isPlainObject(params)) {
        throw createHttpError('"params" must be a JSON object.');
    }

    const numImages = body.num_images === undefined ? 1 : body.num_images;
    if (!Number.isSafeInteger(numImages) || numImages < 1 || numImages > 100) {
        throw createHttpError('"num_images" must be an integer between 1 and 100.');
    }

    const rawAspectRatio = body.aspect_ratio;
    if (rawAspectRatio !== undefined && rawAspectRatio !== null && typeof rawAspectRatio !== 'string') {
        throw createHttpError('"aspect_ratio" must be a string when provided.');
    }

    // Trim transport-only whitespace once at the API boundary. An empty string is
    // equivalent to an omitted ratio for image-to-image, but is rejected below for
    // text-to-image where an explicit output shape is mandatory.
    const aspectRatio = typeof rawAspectRatio === 'string'
        ? rawAspectRatio.trim() || undefined
        : undefined;

    if (body.use_mask !== undefined && typeof body.use_mask !== 'boolean') {
        throw createHttpError('"use_mask" must be a boolean when provided.');
    }

    if (body.force_separate_requests !== undefined && typeof body.force_separate_requests !== 'boolean') {
        throw createHttpError('"force_separate_requests" must be a boolean when provided.');
    }

    const referenceImagePaths = body.referenceImagePaths === undefined ? [] : body.referenceImagePaths;
    if (!Array.isArray(referenceImagePaths)) {
        throw createHttpError('"referenceImagePaths" must be an array of absolute file paths.');
    }

    const normalizedReferencePaths = referenceImagePaths.map((referencePath, index) => (
        normalizeInputFilePath(referencePath, `referenceImagePaths[${index}]`, true)
    ));

    // Source and mask belong to this generation rather than to a persistent parent
    // task. They remain optional so the request can use a promoted first reference
    // or represent text-to-image input.
    const sourceImagePath = normalizeInputFilePath(
        body.sourceImagePath,
        'sourceImagePath',
        false
    );
    const maskImagePath = normalizeInputFilePath(
        body.maskImagePath,
        'maskImagePath',
        false
    );
    const useMask = body.use_mask ?? Boolean(maskImagePath);

    // Asking to use a mask without supplying one is a malformed local API request.
    // A supplied mask without source is valid because generate() can promote the
    // first reference and perform the exact dimension check asynchronously.
    if (useMask && !maskImagePath) {
        throw createHttpError('"maskImagePath" is required when "use_mask" is true.');
    }

    // With no effective image input there are no dimensions to inherit. Reject the
    // request synchronously instead of creating a generation that can only fail in
    // the asynchronous core. A reference counts as image-to-image because generate()
    // promotes its first entry to source; an ignored mask deliberately does not.
    const isTextToImage = !sourceImagePath
        && !useMask
        && normalizedReferencePaths.length === 0;
    if (isTextToImage && !aspectRatio) {
        throw createHttpError('"aspect_ratio" is required for text-to-image generation.');
    }

    return {
        providerId: providerId.trim(),
        sourceImagePath,
        maskImagePath,
        params: { ...params },
        numImages,
        aspectRatio,
        referenceImagePaths: normalizedReferencePaths,
        useMask,
        forceSeparateRequests: body.force_separate_requests ?? false
    };
}

/**
 * Convert a WebHelper result URL into an absolute generated file path.
 *
 * @param {object} result - One result returned by apiGenerator.generate().
 * @param {string} tempDir - Directory where generated images are saved.
 * @returns {string|null} Absolute output path, or null for a failed/non-file result.
 */
function resultToAbsolutePath(result, tempDir) {
    if (!result || result.status !== 'done' || typeof result.image !== 'string') {
        return null;
    }

    if (path.isAbsolute(result.image) && !result.image.startsWith('/api/webhelper/file/')) {
        return path.normalize(result.image);
    }

    const webHelperPrefix = '/api/webhelper/file/';
    if (!result.image.startsWith(webHelperPrefix)) {
        return null;
    }

    // Generated files are always written directly into the shared WebHelper output
    // directory, so only the filename portion is accepted from an internal URL.
    const filename = path.basename(result.image.slice(webHelperPrefix.length));
    return path.resolve(tempDir, filename);
}

/**
 * Build the relative URL for one generation status resource.
 *
 * @param {string} generationId - Generation identifier.
 * @returns {string} URL accepted by the generation GET endpoint.
 */
function getGenerationStatusUrl(generationId) {
    return `${LOCAL_API_PREFIX}/generations/${encodeURIComponent(generationId)}`;
}

/**
 * Build the binary-free representation of one generation attempt.
 *
 * @param {object} generation - Internal generation state.
 * @param {string} tempDir - Directory containing generated output files.
 * @returns {object} Public generation representation.
 */
function serializeGeneration(generation, tempDir) {
    const outputPaths = (generation.results || [])
        .map(result => resultToAbsolutePath(result, tempDir))
        .filter(Boolean);

    return {
        generationId: generation.generationId,
        status: generation.status,
        providerId: generation.providerId,
        createdAt: generation.createdAt,
        startedAt: generation.startedAt || null,
        completedAt: generation.completedAt || null,
        outputPaths,
        error: generation.error || null,
        statusUrl: getGenerationStatusUrl(generation.generationId)
    };
}

/**
 * Execute one self-contained generation.
 *
 * @param {object} generation - Mutable generation state.
 * @param {object} dependencies - Existing generator and filesystem dependencies.
 * @returns {Promise<void>} Resolves after this generation reaches a terminal state.
 */
async function executeGeneration(generation, dependencies) {
    generation.status = 'running';
    generation.startedAt = new Date().toISOString();

    try {
        // The core accepts an unregistered input object. Supplying generationId keeps
        // its diagnostic logs traceable without inventing an internal task ID.
        const generationInput = {
            generationId: generation.generationId,
            sourceImage: generation.sourceImagePath,
            maskImage: generation.maskImagePath
        };
        const results = await dependencies.generate(
            generationInput,
            generation.providerId,
            generation.numImages,
            generation.aspectRatio,
            generation.params,
            generation.referenceImagePaths,
            generation.useMask,
            generation.forceSeparateRequests,
            dependencies.tempDir
        );

        generation.results.push(...results);

        const outputPaths = results
            .map(result => resultToAbsolutePath(result, dependencies.tempDir))
            .filter(Boolean);

        if (outputPaths.length === 0) {
            const resultErrors = results
                .filter(result => result && result.status === 'error' && result.error)
                .map(result => result.error);
            throw new Error(resultErrors[0] || 'Generation completed without producing an output file.');
        }

        generation.status = 'completed';
    } catch (error) {
        generation.status = 'failed';
        generation.error = error && error.message ? error.message : String(error);
        console.error(`[LocalGenerationAPI] Generation ${generation.generationId} failed:`, error);
    } finally {
        generation.completedAt = new Date().toISOString();
    }
}

/**
 * Create the direct local generation API.
 *
 * @param {object} options - Runtime dependencies supplied by main.js.
 * @param {Function} options.generate - Existing provider-driven generation function.
 * @param {string} options.tempDir - Existing WebHelper generation output directory.
 * @param {Function} options.getToken - Returns the shared token required of every caller.
 * @param {Function} [options.onGenerationAccepted] - Optional usage/accounting callback.
 * @returns {import('express').Router} A router mounted at LOCAL_API_PREFIX.
 */
function createLocalGenerationRouter(options) {
    if (!options || typeof options.generate !== 'function') {
        throw new TypeError('createLocalGenerationRouter requires a generate function.');
    }
    if (!options.tempDir || typeof options.tempDir !== 'string') {
        throw new TypeError('createLocalGenerationRouter requires a tempDir path.');
    }
    if (typeof options.getToken !== 'function') {
        throw new TypeError('createLocalGenerationRouter requires a getToken function.');
    }

    const dependencies = {
        generate: options.generate,
        tempDir: path.resolve(options.tempDir)
    };
    // Generation state is deliberately private to this router. Local API requests
    // never enter WebHelper's task registry and cannot affect Photoshop/UI tasks.
    const generations = new Map();
    const router = express.Router();

    // These routes invoke paid providers, so the token is always required. Same-origin
    // browser requests get no exemption: no browser UI is a client of this API.
    router.use(createAuthMiddleware({ getToken: options.getToken }));

    // Accept one complete provider invocation without a preliminary task resource.
    router.post('/generations', (req, res) => {
        try {
            const request = normalizeGenerationRequest(req.body);
            const generationId = `generation_${Date.now()}_${crypto.randomUUID()}`;
            const createdAt = new Date().toISOString();
            const generation = {
                generationId,
                status: 'queued',
                providerId: request.providerId,
                sourceImagePath: request.sourceImagePath,
                maskImagePath: request.maskImagePath,
                params: request.params,
                numImages: request.numImages,
                aspectRatio: request.aspectRatio,
                referenceImagePaths: request.referenceImagePaths,
                useMask: request.useMask,
                forceSeparateRequests: request.forceSeparateRequests,
                results: [],
                createdAt,
                startedAt: null,
                completedAt: null,
                error: null
            };

            generations.set(generationId, generation);

            if (typeof options.onGenerationAccepted === 'function') {
                // Accounting is intentionally detached from both the response and
                // generation result so it can never prevent a provider invocation.
                Promise.resolve().then(() => options.onGenerationAccepted(generation)).catch(error => {
                    console.error('[LocalGenerationAPI] Generation accounting callback failed:', error);
                });
            }

            const statusUrl = getGenerationStatusUrl(generationId);
            res.location(statusUrl).status(202).json({
                generationId,
                status: generation.status,
                statusUrl
            });

            // Run only after the accepted response is committed so provider latency
            // never turns this endpoint into a synchronous generation request.
            setImmediate(() => {
                void executeGeneration(generation, dependencies);
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            if (statusCode >= 500) {
                console.error('[LocalGenerationAPI] Failed to accept generation:', error);
            }
            res.status(statusCode).json({ error: error.message || 'Unable to accept generation.' });
        }
    });

    // Return the status and output paths for one specific generation attempt.
    router.get('/generations/:generationId', (req, res) => {
        const generation = generations.get(req.params.generationId);

        if (!generation) {
            return res.status(404).json({ error: 'Generation not found.' });
        }

        return res.json(serializeGeneration(generation, dependencies.tempDir));
    });

    return router;
}

module.exports = {
    LOCAL_API_PREFIX,
    createLocalGenerationRouter
};
