const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const JSON5 = require('json5');
const { waitForApiResult, downloadAndSaveImages, makeRequest } = require('./apiGeneratorResultsGetter');
const { getConfigPaths } = require('./setup/config-paths');
const { resolveTemplate } = require('./templateEngine');

// The current generator always saves image results and has request semantics only
// for text-to-image and image-to-image. Other modality names are intentionally not
// accepted until their input contracts, response handling, persistence, and UI are
// implemented end to end.
const IMPLEMENTED_GENERATION_MODES = new Set(['t2i', 'i2i']);

// Helper to reliably read providers config
function getProvidersConfig() {
    const { providersPath } = getConfigPaths();
    if (!fs.existsSync(providersPath)) throw new Error("providers.json not found");
    const providersRaw = fs.readFileSync(providersPath, 'utf8');
    return JSON5.parse(providersRaw);
}

/**
 * Resolve an image identifier into the file path read by the generation pipeline.
 *
 * Browser tasks refer to files through the WebHelper HTTP prefix, while local API
 * tasks intentionally retain absolute paths so they can use files anywhere on the
 * same machine without copying or encoding them first.
 *
 * @param {string|null|undefined} imagePath - WebHelper URL, absolute path, or temp-relative filename.
 * @param {string} tempDir - Existing WebHelper task and output directory.
 * @returns {string|null} Resolved local file path, or null when no image was provided.
 */
function resolveImageFilePath(imagePath, tempDir) {
    if (!imagePath) return null;

    // Task-owned images deliberately use path-like identifiers. Reference images
    // have a separate formatter that also accepts browser-generated Data URIs.
    if (typeof imagePath !== 'string') {
        throw new TypeError('Task image paths must be strings.');
    }

    const webHelperPrefix = '/api/webhelper/file/';
    if (imagePath.startsWith(webHelperPrefix)) {
        return path.join(tempDir, imagePath.slice(webHelperPrefix.length));
    }

    if (path.isAbsolute(imagePath)) {
        return path.normalize(imagePath);
    }

    // Preserve the historic behavior for any internal caller that supplies a
    // filename relative to the WebHelper temp directory.
    return path.join(tempDir, imagePath);
}

// Convert local file to requested format
function formatImage(filePath, format) {
    if (!filePath) return null;
    if (!fs.existsSync(filePath)) {
        throw new Error(`Image file not found: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');

    let mime = 'image/png';
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
    else if (ext === '.webp') mime = 'image/webp';
    else if (ext === '.gif') mime = 'image/gif';

    if (format === 'base64_raw') {
        return base64;
    } else if (format === 'data_uri') {
        return `data:${mime};base64,${base64}`;
    } else if (format === 'url') {
        // For 'url', we either need a public URL or use a temp third party service. 
        // We'll throw for now, OR return a placeholder if we assume fal accepts base64 for 'image_urls'
        // Actually, Fal API *does* accept Data URIs in the image_urls field! 
        // Let's use data_uri as a fallback for 'url' format if no public URL service is configured.
        return `data:${mime};base64,${base64}`;
    }
    return base64;
}

/**
 * Validate a provider's declared modes and reject an unsupported invocation.
 *
 * `generation_modes` is configuration policy, not request routing. Conditional
 * endpoint keys still choose between supported routes, while this check prevents
 * an unsupported mode from reaching any endpoint at all. The array is mandatory
 * and deliberately limited to the two modes implemented by the current image
 * generation pipeline.
 *
 * @param {object} provider - Resolved provider configuration.
 * @param {'t2i'|'i2i'} generationMode - Effective mode after image normalization.
 * @throws {Error} When the provider declaration is invalid or excludes the mode.
 */
function assertProviderSupportsGenerationMode(provider, generationMode) {
    const configuredModes = provider?.generation_modes;
    const providerLabel = provider?.id || provider?.name || 'unknown';

    if (!Array.isArray(configuredModes) || configuredModes.length === 0) {
        throw new Error(
            `Provider "${providerLabel}" must declare a non-empty generation_modes array.`
        );
    }

    const uniqueModes = new Set(configuredModes);
    const hasInvalidMode = configuredModes.some(mode => (
        typeof mode !== 'string' || !IMPLEMENTED_GENERATION_MODES.has(mode)
    ));

    if (hasInvalidMode || uniqueModes.size !== configuredModes.length) {
        throw new Error(
            `Provider "${providerLabel}" has invalid generation_modes; `
            + 'only unique "t2i" and "i2i" values are currently implemented.'
        );
    }

    if (!uniqueModes.has(generationMode)) {
        throw new Error(
            `Provider "${providerLabel}" does not support ${generationMode} generation.`
        );
    }
}

/**
 * Convert one reference input into the image representation expected by a provider.
 *
 * WebHelper references arrive as Data URIs, while Local Generation API references
 * arrive as absolute paths. Keeping this distinction out of task-owned source and
 * mask handling preserves the existing internal task contract.
 *
 * @param {unknown} referenceInput - Data URI or path-like reference identifier.
 * @param {number} index - Zero-based position used in validation messages.
 * @param {string} format - Provider image format.
 * @param {(imagePath: string) => string|null} resolveFilePath - Task path resolver.
 * @returns {string} Formatted image content.
 */
function formatReferenceImage(referenceInput, index, format, resolveFilePath) {
    if (typeof referenceInput !== 'string' || referenceInput.length === 0) {
        throw new TypeError(`Reference image ${index + 1} must be a non-empty string.`);
    }

    if (referenceInput.startsWith('data:image/')) {
        const commaIndex = referenceInput.indexOf(',');
        if (commaIndex < 0 || commaIndex === referenceInput.length - 1) {
            throw new Error(`Reference image ${index + 1} contains an invalid Data URI.`);
        }

        const metadata = referenceInput.slice(0, commaIndex);
        const base64 = referenceInput.slice(commaIndex + 1);
        const mimeMatch = metadata.match(/^data:(image\/[^;]+);base64$/i);
        if (!mimeMatch) {
            throw new Error(`Reference image ${index + 1} must be a base64 image Data URI.`);
        }

        const mime = mimeMatch[1];
        if (format === 'base64_raw') return base64;
        if (format === 'data_uri' || format === 'url') {
            return `data:${mime};base64,${base64}`;
        }
        return base64;
    }

    return formatImage(resolveFilePath(referenceInput), format);
}

/**
 * Resolve the first generate() argument without requiring a persistent task entry.
 *
 * A string retains the historic registry lookup. A task object is used directly,
 * while zero/null/undefined represents an intentionally empty virtual task for a
 * text-to-image request. Zero is accepted because existing callers may use it as a
 * sentinel instead of null. The generated label is diagnostic only and never
 * stores the virtual task in the shared registry.
 *
 * @param {string|object|number|null|undefined} taskOrId - Registered ID, virtual task, or empty sentinel.
 * @param {Record<string, object>|null|undefined} globalTasks - Shared task registry.
 * @returns {{task: object, taskLabel: string}} Resolved task and safe log label.
 */
function resolveGenerationTask(taskOrId, globalTasks) {
    if (taskOrId === 0 || taskOrId === null || taskOrId === undefined) {
        return {
            task: {},
            taskLabel: `virtual_task_${crypto.randomUUID()}`
        };
    }

    if (typeof taskOrId === 'object' && !Array.isArray(taskOrId)) {
        // Registered/WebHelper-shaped objects may carry taskId, while direct Local
        // API invocations carry generationId. Either value is diagnostic only.
        const embeddedLabel = [taskOrId.taskId, taskOrId.generationId]
            .find(value => typeof value === 'string' && value.trim() !== '');

        return {
            task: taskOrId,
            taskLabel: embeddedLabel?.trim() || `virtual_task_${crypto.randomUUID()}`
        };
    }

    if (typeof taskOrId !== 'string') {
        throw new TypeError('The task argument must be a task ID, task object, zero, null, or undefined.');
    }

    if (!globalTasks || typeof globalTasks !== 'object') {
        throw new Error(`Task ${taskOrId} cannot be resolved because the task registry is unavailable.`);
    }

    const hasTask = Object.prototype.hasOwnProperty.call(globalTasks, taskOrId);
    const task = hasTask ? globalTasks[taskOrId] : null;
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
        throw new Error(`Task ${taskOrId} not found.`);
    }

    return { task, taskLabel: taskOrId };
}

/**
 * Decode dimensions from an already formatted image string.
 *
 * The image utility is loaded lazily because apiGenerator.js is also imported by
 * plain Node.js tests, whereas nativeImage is available only in the Electron runtime.
 *
 * @param {string} image - Raw base64 or Data URI image.
 * @param {string} label - Human-readable input label for an actionable error.
 * @returns {{width: number, height: number}} Exact pixel dimensions.
 */
function readFormattedImageDimensions(image, label) {
    const { parseImageInput } = require('./imageUtils');
    const parsedImage = parseImageInput(image);
    if (!parsedImage) {
        throw new Error(`${label} could not be decoded as an image.`);
    }

    return parsedImage.size;
}

/**
 * Normalize semantic image roles before provider-specific preprocessing begins.
 *
 * When a task has no source, its first reference becomes the source and is removed
 * from the remaining reference list. An active mask makes that promoted reference
 * mandatory and requires an exact pixel-for-pixel dimension match.
 *
 * @param {string|null} sourceImage - Formatted task source image.
 * @param {string|null} maskImage - Formatted active mask image.
 * @param {string[]} referenceImages - Formatted reference images in caller order.
 * @param {(image: string, label: string) => {width: number, height: number}} [readDimensions]
 *     Dimension reader, injectable for tests.
 * @returns {{sourceImage: string|null, maskImage: string|null, referenceImages: string[]}}
 */
function normalizeGenerationImages(
    sourceImage,
    maskImage,
    referenceImages,
    readDimensions = readFormattedImageDimensions
) {
    const normalizedReferences = [...referenceImages];
    let normalizedSource = sourceImage;

    if (!normalizedSource && normalizedReferences.length > 0) {
        const promotedReference = normalizedReferences.shift();

        if (maskImage) {
            const sourceSize = readDimensions(promotedReference, 'The first reference image');
            const maskSize = readDimensions(maskImage, 'The mask image');
            const dimensionsMatch = sourceSize.width === maskSize.width
                && sourceSize.height === maskSize.height;

            if (!dimensionsMatch) {
                throw new Error(
                    'The first reference image must exactly match the mask image dimensions '
                    + `(${sourceSize.width}x${sourceSize.height} versus ${maskSize.width}x${maskSize.height}).`
                );
            }
        }

        normalizedSource = promotedReference;
    }

    if (!normalizedSource && maskImage) {
        throw new Error('A mask image requires a source image or at least one reference image.');
    }

    return {
        sourceImage: normalizedSource,
        maskImage,
        referenceImages: normalizedReferences
    };
}

/**
 * Enforce the output shape required when no image input survives normalization.
 *
 * A request is text-to-image only after source promotion has run: any supplied
 * reference would already have become the source. Image-to-image requests may
 * continue omitting the ratio because their output shape can be derived from the
 * source by provider preprocessing.
 *
 * @param {unknown} aspectRatio - Caller-supplied output aspect ratio.
 * @param {string|null} sourceImage - Normalized formatted source image.
 * @param {string|null} maskImage - Normalized formatted active mask image.
 * @param {string[]} referenceImages - Normalized remaining references.
 * @throws {Error} When a text-to-image request has no non-empty string ratio.
 */
function requireTextToImageAspectRatio(
    aspectRatio,
    sourceImage,
    maskImage,
    referenceImages
) {
    const isTextToImage = !sourceImage && !maskImage && referenceImages.length === 0;
    const hasAspectRatio = typeof aspectRatio === 'string' && aspectRatio.trim() !== '';

    if (isTextToImage && !hasAspectRatio) {
        throw new Error('"aspect_ratio" is required for text-to-image generation.');
    }
}

/**
 * Build the canonical list of provider-side additional images.
 *
 * All provider template representations must derive from this same array. This
 * ensures referential masks work consistently for flat arrays, wrapped object
 * arrays, and individually numbered reference fields.
 *
 * @param {string[]} referenceImages - Remaining references after source promotion.
 * @param {string|null} maskImage - Formatted active mask.
 * @param {string|undefined} maskType - Provider mask transmission strategy.
 * @returns {string[]} Ordered provider-side additional images.
 */
function buildRequestReferenceImages(referenceImages, maskImage, maskType) {
    const requestImages = [...referenceImages];

    if (maskImage && maskType === 'first_referential') {
        requestImages.unshift(maskImage);
    } else if (maskImage && maskType === 'last_referential') {
        requestImages.push(maskImage);
    }

    return requestImages;
}

/**
 * Compute the output filename suffix for a provider request.
 * Automatically appends "_t2i" for text-to-image or "_i2i" for image-to-image.
 *
 * @param {object} provider - Provider configuration object.
 * @param {object} context - Template resolution context.
 * @param {boolean} isTextToImage - True if this generation has no source/mask/reference images.
 * @returns {string} The full computed filename suffix including the mode tag.
 */
function computeFileSuffix(provider, context = {}, isTextToImage = false) {
    const providerId = provider?.id || '';
    let baseSuffix = providerId;

    if (provider?.filename_suffix) {
        if (typeof provider.filename_suffix === 'string') {
            baseSuffix = resolveTemplate(provider.filename_suffix, context);
        } else if (typeof provider.filename_suffix === 'object' && provider.filename_suffix !== null) {
            const dependField = provider.filename_suffix.depends_on;
            const val = dependField ? context[dependField] : undefined;
            let suffixTemplate;
            if (val && provider.filename_suffix.values && provider.filename_suffix.values[val]) {
                suffixTemplate = provider.filename_suffix.values[val];
            } else {
                suffixTemplate = provider.filename_suffix.default || providerId;
            }
            baseSuffix = resolveTemplate(suffixTemplate, context);
        }
    }

    const modeSuffix = isTextToImage ? 't2i' : 'i2i';
    return baseSuffix ? `${baseSuffix}_${modeSuffix}` : modeSuffix;
}

/**
 * Main function to start generating task
 */
async function generate(taskOrId, providerId, num_images, aspect_ratio, userParams, referenceImages, use_mask, force_separate_requests, tempDir, globalTasks) {
    const { task, taskLabel } = resolveGenerationTask(taskOrId, globalTasks);

    // 1. Load config
    const configData = getProvidersConfig();
    const provider = configData.providers.find(p => p.id === providerId);
    if (!provider) throw new Error(`Provider ${providerId} not found in config.`);
    const reqConfig = provider.request_config;

    // 2. Prepare Context
    const context = { ...userParams };
    if (num_images !== undefined) {
        context.num_images = num_images;
    }
    if (aspect_ratio !== undefined) {
        context.aspect_ratio = aspect_ratio;
    }
    // if (force_separate_requests !== undefined) {
    //     context.force_separate_requests = force_separate_requests;
    // }

    // Convert parameter types based on provider configuration
    if (provider.parameters) {
        provider.parameters.forEach(param => {
            const paramKey = param.name;
            if (context[paramKey] !== undefined) {
                if (param.type === 'slider' || param.type === 'number' || param.type === 'integer') {
                    context[paramKey] = Number(context[paramKey]);
                } else if (param.type === 'boolean' || param.type === 'checkbox') {
                    context[paramKey] = context[paramKey] === 'true' || context[paramKey] === true;
                } else if (param.type === 'string') {
                    context[paramKey] = String(context[paramKey]);
                }
            }
        });
    }

    // Bind the current task directory once so all source, mask, and reference paths
    // use the same browser/local resolution rules.
    const resolveFilePath = imagePath => resolveImageFilePath(imagePath, tempDir);

    const sourcePath = resolveFilePath(task.sourceImage);
    const maskPath = use_mask ? resolveFilePath(task.maskImage) : null;

    let sourceImageFormatted = formatImage(sourcePath, provider.image_format);
    let maskImageFormatted = maskPath ? formatImage(maskPath, provider.image_format) : null;

    // Preserve caller order because the first reference has special source semantics
    // when the task itself has no source image.
    const rawReferenceImages = referenceImages ?? [];
    if (!Array.isArray(rawReferenceImages)) {
        throw new TypeError('referenceImages must be an array when provided.');
    }

    let refImagesFormatted = rawReferenceImages.map((refInput, index) => (
        formatReferenceImage(refInput, index, provider.image_format, resolveFilePath)
    ));

    // Establish source/mask/reference roles before preprocessors inspect or resize
    // them. This guarantees a promoted source follows the source optimization path
    // and keeps any active mask synchronized with it.
    const normalizedImages = normalizeGenerationImages(
        sourceImageFormatted,
        maskImageFormatted,
        refImagesFormatted
    );
    sourceImageFormatted = normalizedImages.sourceImage;
    maskImageFormatted = normalizedImages.maskImage;
    refImagesFormatted = normalizedImages.referenceImages;

    // The effective mode is derived only after the first reference has had the
    // opportunity to become the source. Validate the provider capability before
    // preprocessors perform work and, most importantly, before any paid request.
    const isTextToImage = !sourceImageFormatted
        && !maskImageFormatted
        && refImagesFormatted.length === 0;
    const generationMode = isTextToImage ? 't2i' : 'i2i';
    assertProviderSupportsGenerationMode(provider, generationMode);

    // Mask capability is checked after mode normalization so an I2I-only inpainting
    // provider reports a T2I capability error for an image-less request instead of
    // the less useful secondary error about its required mask.
    if (use_mask) {
        if (!provider.mask_handling || !provider.mask_handling.supported) {
            throw new Error(`Provider "${provider.name}" does not support masks.`);
        }
        if (!task.maskImage) {
            throw new Error('Mask image is required but missing from task.');
        }
    } else if (provider.mask_handling?.required) {
        throw new Error(`Provider "${provider.name}" requires a mask.`);
    }

    // Text-to-image has no source dimensions from which a provider can infer the
    // output shape. Reject the request before preprocessors or remote calls run.
    requireTextToImageAspectRatio(
        aspect_ratio,
        sourceImageFormatted,
        maskImageFormatted,
        refImagesFormatted
    );

    if (provider.preprocessor) {
        const { runPreprocessor } = require('./apiGeneratorPreprocessors');

        for (const preprocessorConfig of provider.preprocessor) {
            const preprocessorPayload = {
                aspect_ratio: aspect_ratio,
                source_image: sourceImageFormatted,
                mask_image: maskImageFormatted,
                reference_images: refImagesFormatted,
                user_params: context
            };

            const processed = await runPreprocessor(preprocessorConfig, provider, preprocessorPayload, resolveTemplate);
            if (processed) {
                sourceImageFormatted = processed.source_image;
                maskImageFormatted = processed.mask_image;
                refImagesFormatted = processed.reference_images;
            }
        }
    }

    context.source_image = sourceImageFormatted;
    context.mask_image = maskImageFormatted;

    // Build one canonical additional-image list for every provider template style.
    const maskType = provider.mask_handling?.type;
    const requestReferenceImages = buildRequestReferenceImages(
        refImagesFormatted,
        maskImageFormatted,
        maskType
    );

    // Provide flat reference properties (reference_1, reference_2, etc.). Referential
    // masks intentionally occupy their configured position in these fields.
    requestReferenceImages.forEach((refBase64, index) => {
        context[`reference_${index + 1}`] = refBase64;
    });

    // Provide wrapped references when a provider expects objects instead of strings.
    if (reqConfig.reference_item_template) {
        context.resolved_references = requestReferenceImages.map(refBase64 => {
            const tempContext = { ...context, item: refBase64 };
            return resolveTemplate(reqConfig.reference_item_template, tempContext);
        });
    }

    // Flat array templates consume the exact same ordered images as wrapped and
    // individually numbered templates.
    context.resolved_image_array = requestReferenceImages;

    // 4. Compute Dynamic File Suffix
    const fileSuffix = computeFileSuffix(provider, context, isTextToImage);

    // 4b. Compute Display Name (nice_name) — resolved the same way as filename_suffix,
    // but sent to the client so the result header can show a human-readable model name.
    let niceProviderName = null;
    if (provider.nice_name) {
        if (typeof provider.nice_name === 'string') {
            niceProviderName = resolveTemplate(provider.nice_name, context);
        } else if (typeof provider.nice_name === 'object' && provider.nice_name !== null) {
            const dependField = provider.nice_name.depends_on;
            const val = context[dependField];
            let nameTemplate;
            if (val && provider.nice_name.values && provider.nice_name.values[val]) {
                nameTemplate = provider.nice_name.values[val];
            } else {
                nameTemplate = provider.nice_name.default || null;
            }
            niceProviderName = nameTemplate ? resolveTemplate(nameTemplate, context) : null;
        }
    }

    // 5. Execute Request(s)
    let finalResults = [];
    let supportsMultiple = reqConfig.single_image_per_request !== true;
    if (supportsMultiple && force_separate_requests === true) {
        supportsMultiple = false;
    }
    const requestCount = supportsMultiple ? 1 : (num_images || 1);

    const downloadPromises = [];

    for (let i = 0; i < requestCount; i++) {
        // Each individual request should only ask for 1 image if we are manually splitting a multi-image task.
        // This prevents creating (num_images * num_images) images if the provider template is not careful.
        const requestContext = { ...context };
        if (!supportsMultiple) {
            requestContext.num_images = 1;
        }

        // Resolve the complete request configuration at execution time. Conditional
        // keys are therefore available not only inside body_template, but also at
        // the request_config level. Providers whose text-to-image and image-to-image
        // operations use different endpoints can declare two conditional
        // endpoint_url keys driven by the normalized source_image value.
        const currentRequestConfig = resolveTemplate(reqConfig, requestContext);
        const currentUrl = currentRequestConfig.endpoint_url;
        const currentHeaders = currentRequestConfig.headers;
        const currentBody = currentRequestConfig.body_template;

        if (typeof currentUrl !== 'string' || currentUrl.trim() === '') {
            throw new Error(`Provider "${provider.name}" did not resolve a valid endpoint URL.`);
        }

        const urlObj = new URL(currentUrl);
        const options = { method: currentRequestConfig.method, headers: currentHeaders };

        console.log(`[RequestBuilder] Executing request ${i + 1}/${requestCount} for taskId ${taskLabel}`);
        try {
            const apiResult = await makeRequest(urlObj, options, currentBody);

            // Wait for generation to complete and extract URLs
            const { imageStrings, finalData, imagesConfig, downloadHeaders } = await waitForApiResult(
                apiResult, provider.response_config, configData.response_handlers, currentHeaders
            );

            // Start downloading in the background
            const downloadPromise = downloadAndSaveImages(
                imageStrings, imagesConfig, downloadHeaders, tempDir, `${taskLabel}_${i}`, fileSuffix, finalData
            ).then(results => {
                for (const result of results) {
                    if (result.status === 'done' && result.image) {
                        const fileName = result.image.replace('/api/webhelper/file/', '');
                        const ext = path.extname(fileName);
                        const baseName = path.basename(fileName, ext);

                        const logData = {
                            provider: providerId,
                            //model: requestContext.model || undefined,
                            url: currentUrl,
                            request: currentBody,
                            response_initial: apiResult,
                            response_final: result.final_response
                        };

                        const jsonFilePath = path.join(tempDir, `${baseName}.json`);
                        try {
                            fs.writeFileSync(jsonFilePath, JSON.stringify(logData, null, 2), 'utf8');
                        } catch (ioErr) {
                            console.error('[RequestBuilder] Failed to write JSON log:', ioErr);
                        }
                    }
                    // Remove final_response so it doesn't get sent back to the frontend
                    delete result.final_response;
                }
                return results;
            }).catch(err => {
                console.error(`[RequestBuilder] Download ${i + 1}/${requestCount} failed:`, err);
                const count = supportsMultiple ? (num_images || 1) : 1;
                const errResults = [];
                for (let j = 0; j < count; j++) {
                    errResults.push({
                        status: 'error',
                        error: `Download failed: ${err.message || String(err)}`
                    });
                }
                return errResults;
            });

            downloadPromises.push(downloadPromise);
        } catch (err) {
            console.error(`[RequestBuilder] Request ${i + 1}/${requestCount} failed:`, err);
            
            let errorMessage = err.message || String(err);
            // Clean the error from huge base64 chunks and long unreadable strings
            errorMessage = errorMessage.replace(/data:image\/[^;]+;base64,[a-zA-Z0-9+/=]+/g, '[BASE64_IMAGE_REMOVED]');
            errorMessage = errorMessage.replace(/[^\s]{500,}/g, match => match.substring(0, 40) + '...[TRUNCATED]');
            const hashInput = err.fallback_url ? `${errorMessage}|${err.fallback_url}` : errorMessage;
            const errorHash = crypto.createHash('md5').update(hashInput).digest('hex');
            
            const count = supportsMultiple ? (num_images || 1) : 1;
            for (let j = 0; j < count; j++) {
                finalResults.push({
                    status: 'error',
                    error: errorMessage,
                    error_hash: errorHash,
                    ...(err.fallback_url ? { fallback_url: err.fallback_url } : {})
                });
            }
        }
    }

    // Wait for all background downloads to finish
    const allBackgroundResults = await Promise.all(downloadPromises);
    for (const results of allBackgroundResults) {
        finalResults.push(...results);
    }

    // Add metadata
    return finalResults.map(res => ({
        ...res,
        params: userParams,
        providerId: providerId,
        nice_name: niceProviderName,
        num_images: num_images,
        aspect_ratio: aspect_ratio
    }));
}

module.exports = {
    generate,

    // TEST-ONLY EXPORTS: Production code imports only generate(). These helpers are
    // exposed solely so the focused unit tests can validate generation invariants
    // without making remote provider requests. If those tests are removed, remove
    // this entire test-only export block as well and keep the helpers module-private.
    resolveImageFilePath,
    resolveGenerationTask,
    normalizeGenerationImages,
    requireTextToImageAspectRatio,
    buildRequestReferenceImages,
    computeFileSuffix
};
