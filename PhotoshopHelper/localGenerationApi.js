const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const express = require('express');

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
 * Absolute paths make task reuse deterministic for callers launched with different
 * working directories. No file is copied: the task retains this normalized path and
 * the generation core reads it directly whenever a generation is requested.
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
 * Validate the body used to create a reusable local task.
 *
 * The source and optional mask belong to the task because every later generation
 * may reuse them with a different provider, prompt, parameter set, or mask mode.
 *
 * @param {unknown} body - Parsed Express JSON request body.
 * @returns {{sourceImagePath: string, maskImagePath: string|null}} Normalized task inputs.
 */
function normalizeTaskRequest(body) {
    if (!isPlainObject(body)) {
        throw createHttpError('The request body must be a JSON object.');
    }

    return {
        sourceImagePath: normalizeInputFilePath(body.sourceImagePath, 'sourceImagePath', true),
        maskImagePath: normalizeInputFilePath(body.maskImagePath, 'maskImagePath', false)
    };
}

/**
 * Validate a generation request that will run against an existing local task.
 *
 * @param {unknown} body - Parsed Express JSON request body.
 * @returns {object} Normalized provider and per-generation arguments.
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

    const aspectRatio = body.aspect_ratio;
    if (aspectRatio !== undefined && aspectRatio !== null && typeof aspectRatio !== 'string') {
        throw createHttpError('"aspect_ratio" must be a string when provided.');
    }

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

    return {
        providerId: providerId.trim(),
        params: { ...params },
        numImages,
        aspectRatio: aspectRatio ?? undefined,
        referenceImagePaths: normalizedReferencePaths,
        useMask: body.use_mask,
        forceSeparateRequests: body.force_separate_requests ?? false
    };
}

/**
 * Compare a supplied token without leaking partial-match timing information.
 *
 * @param {string} suppliedToken - Token extracted from an HTTP header.
 * @param {string} expectedToken - Token configured in the environment.
 * @returns {boolean} True only when both UTF-8 byte sequences match exactly.
 */
function tokensMatch(suppliedToken, expectedToken) {
    const suppliedBuffer = Buffer.from(suppliedToken, 'utf8');
    const expectedBuffer = Buffer.from(expectedToken, 'utf8');

    if (suppliedBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

/**
 * Create optional authentication middleware for every local automation route.
 *
 * @param {string} expectedToken - Configured LOCAL_GENERATION_API_TOKEN value.
 * @returns {import('express').RequestHandler} Express authentication middleware.
 */
function createOptionalTokenMiddleware(expectedToken) {
    return (req, res, next) => {
        if (!expectedToken) {
            return next();
        }

        const authorization = req.get('authorization') || '';
        const bearerPrefix = 'Bearer ';
        const bearerToken = authorization.startsWith(bearerPrefix)
            ? authorization.slice(bearerPrefix.length)
            : '';
        const apiKeyToken = req.get('x-api-key') || '';
        const suppliedToken = bearerToken || apiKeyToken;

        if (!suppliedToken || !tokensMatch(suppliedToken, expectedToken)) {
            return res.status(401).json({ error: 'Unauthorized.' });
        }

        return next();
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
 * @param {string} taskId - Parent task identifier.
 * @param {string} generationId - Child generation identifier.
 * @returns {string} URL accepted by the generation GET endpoint.
 */
function getGenerationStatusUrl(taskId, generationId) {
    return `${LOCAL_API_PREFIX}/tasks/${encodeURIComponent(taskId)}/generations/${encodeURIComponent(generationId)}`;
}

/**
 * Build the binary-free representation of one generation attempt.
 *
 * @param {object} generation - Internal generation state stored under its task.
 * @param {string} tempDir - Directory containing generated output files.
 * @returns {object} Public generation representation.
 */
function serializeGeneration(generation, tempDir) {
    const outputPaths = (generation.results || [])
        .map(result => resultToAbsolutePath(result, tempDir))
        .filter(Boolean);

    return {
        generationId: generation.generationId,
        taskId: generation.taskId,
        status: generation.status,
        providerId: generation.providerId,
        createdAt: generation.createdAt,
        startedAt: generation.startedAt || null,
        completedAt: generation.completedAt || null,
        outputPaths,
        error: generation.error || null,
        statusUrl: getGenerationStatusUrl(generation.taskId, generation.generationId)
    };
}

/**
 * Build the reusable task representation, including summaries of all generations.
 *
 * @param {object} task - Internal task stored in the shared task registry.
 * @param {string} tempDir - Directory containing generated output files.
 * @returns {object} Public task representation.
 */
function serializeTask(task, tempDir) {
    const generations = Object.values(task.generations || {})
        .map(generation => serializeGeneration(generation, tempDir));

    return {
        taskId: task.taskId,
        status: task.status,
        sourceImagePath: task.sourceImage,
        maskImagePath: task.maskImage,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        generationCount: generations.length,
        generations
    };
}

/**
 * Execute one generation without changing the reusable parent task's readiness.
 *
 * Multiple generation objects may run sequentially or concurrently against the same
 * task. Each one owns its parameters, status, results, timestamps, and error while
 * the source and mask paths remain stored once on the parent task.
 *
 * @param {object} task - Reusable parent task from the shared registry.
 * @param {object} generation - Mutable child generation state.
 * @param {object} dependencies - Existing generator and filesystem dependencies.
 * @returns {Promise<void>} Resolves after this generation reaches a terminal state.
 */
async function executeGeneration(task, generation, dependencies) {
    generation.status = 'running';
    generation.startedAt = new Date().toISOString();
    task.updatedAt = generation.startedAt;

    try {
        const results = await dependencies.generate(
            task.taskId,
            generation.providerId,
            generation.numImages,
            generation.aspectRatio,
            generation.params,
            generation.referenceImagePaths,
            generation.useMask,
            generation.forceSeparateRequests,
            dependencies.tempDir,
            dependencies.tasks
        );

        generation.results.push(...results);
        task.results.push(...results);

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
        task.updatedAt = generation.completedAt;
    }
}

/**
 * Find a local API task without exposing regular WebHelper tasks through this API.
 *
 * @param {Record<string, object>} tasks - Shared task registry.
 * @param {string} taskId - Requested task identifier.
 * @returns {object|null} Matching local task, or null when it is absent/ineligible.
 */
function findLocalTask(tasks, taskId) {
    const task = tasks[taskId];
    return task && task.localApiTask === true ? task : null;
}

/**
 * Create the reusable task and child-generation local API.
 *
 * @param {object} options - Runtime dependencies supplied by main.js.
 * @param {Function} options.generate - Existing provider-driven generation function.
 * @param {Record<string, object>} options.tasks - Shared in-memory task registry.
 * @param {string} options.tempDir - Existing WebHelper generation output directory.
 * @param {string} [options.token=''] - Optional shared token for local callers.
 * @param {Function} [options.onGenerationAccepted] - Optional usage/accounting callback.
 * @returns {import('express').Router} A router mounted at LOCAL_API_PREFIX.
 */
function createLocalGenerationRouter(options) {
    if (!options || typeof options.generate !== 'function') {
        throw new TypeError('createLocalGenerationRouter requires a generate function.');
    }
    if (!options.tasks || typeof options.tasks !== 'object') {
        throw new TypeError('createLocalGenerationRouter requires a shared tasks object.');
    }
    if (!options.tempDir || typeof options.tempDir !== 'string') {
        throw new TypeError('createLocalGenerationRouter requires a tempDir path.');
    }

    const dependencies = {
        generate: options.generate,
        tasks: options.tasks,
        tempDir: path.resolve(options.tempDir)
    };
    const router = express.Router();

    router.use(createOptionalTokenMiddleware(options.token || ''));

    // Create the reusable source/mask task without copying either input file.
    router.post('/tasks', (req, res) => {
        try {
            const request = normalizeTaskRequest(req.body);
            const taskId = `local_task_${Date.now()}_${crypto.randomUUID()}`;
            const createdAt = new Date().toISOString();
            const taskUrl = `${LOCAL_API_PREFIX}/tasks/${encodeURIComponent(taskId)}`;

            const task = {
                taskId,
                sourceImage: request.sourceImagePath,
                maskImage: request.maskImagePath,
                status: 'ready',
                results: [],
                threadId: 'LocalAPI',
                createdAt,
                updatedAt: createdAt,
                generations: {},
                localApiTask: true
            };

            options.tasks[taskId] = task;

            return res.location(taskUrl).status(201).json({
                taskId,
                status: task.status,
                taskUrl
            });
        } catch (error) {
            const statusCode = error.statusCode || 500;
            if (statusCode >= 500) {
                console.error('[LocalGenerationAPI] Failed to create task:', error);
            }
            return res.status(statusCode).json({ error: error.message || 'Unable to create task.' });
        }
    });

    // Return the task plus independent summaries for every generation run on it.
    router.get('/tasks/:taskId', (req, res) => {
        const task = findLocalTask(options.tasks, req.params.taskId);
        if (!task) {
            return res.status(404).json({ error: 'Local task not found.' });
        }

        return res.json(serializeTask(task, dependencies.tempDir));
    });

    // Accept one provider invocation against the reusable parent task.
    router.post('/tasks/:taskId/generations', (req, res) => {
        try {
            const task = findLocalTask(options.tasks, req.params.taskId);
            if (!task) {
                throw createHttpError('Local task not found.', 404);
            }

            const request = normalizeGenerationRequest(req.body);
            const useMask = request.useMask ?? Boolean(task.maskImage);

            // Revalidate retained paths when generation begins because a caller may
            // delete or move a file after creating the reusable task.
            normalizeInputFilePath(task.sourceImage, 'sourceImagePath', true);
            if (useMask) {
                normalizeInputFilePath(task.maskImage, 'maskImagePath', true);
            }

            const generationId = `generation_${Date.now()}_${crypto.randomUUID()}`;
            const createdAt = new Date().toISOString();
            const generation = {
                generationId,
                taskId: task.taskId,
                status: 'queued',
                providerId: request.providerId,
                params: request.params,
                numImages: request.numImages,
                aspectRatio: request.aspectRatio,
                referenceImagePaths: request.referenceImagePaths,
                useMask,
                forceSeparateRequests: request.forceSeparateRequests,
                results: [],
                createdAt,
                startedAt: null,
                completedAt: null,
                error: null
            };

            task.generations[generationId] = generation;
            task.updatedAt = createdAt;

            if (typeof options.onGenerationAccepted === 'function') {
                // Accounting is intentionally detached from both the response and
                // generation result so it can never prevent a provider invocation.
                Promise.resolve().then(() => options.onGenerationAccepted(generation)).catch(error => {
                    console.error('[LocalGenerationAPI] Generation accounting callback failed:', error);
                });
            }

            const statusUrl = getGenerationStatusUrl(task.taskId, generationId);
            res.location(statusUrl).status(202).json({
                taskId: task.taskId,
                generationId,
                status: generation.status,
                statusUrl
            });

            // Run only after the accepted response is committed so provider latency
            // never turns this endpoint into a synchronous generation request.
            setImmediate(() => {
                void executeGeneration(task, generation, dependencies);
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
    router.get('/tasks/:taskId/generations/:generationId', (req, res) => {
        const task = findLocalTask(options.tasks, req.params.taskId);
        const generation = task && task.generations
            ? task.generations[req.params.generationId]
            : null;

        if (!generation) {
            return res.status(404).json({ error: 'Generation not found.' });
        }

        return res.json(serializeGeneration(generation, dependencies.tempDir));
    });

    return router;
}

module.exports = {
    LOCAL_API_PREFIX,
    createLocalGenerationRouter,
    normalizeGenerationRequest,
    normalizeTaskRequest,
    resultToAbsolutePath,
    serializeGeneration,
    serializeTask
};
