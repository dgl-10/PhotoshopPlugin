const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const JSON5 = require('json5');
const { waitForApiResult, downloadAndSaveImages, makeRequest } = require('./apiGeneratorResultsGetter');
const { getConfigPaths } = require('./setup/config-paths');

// Helper to reliably read providers config
function getProvidersConfig() {
    const { providersPath } = getConfigPaths();
    if (!fs.existsSync(providersPath)) throw new Error("providers.json not found");
    const providersRaw = fs.readFileSync(providersPath, 'utf8');
    return JSON5.parse(providersRaw);
}

// Convert local file to requested format
function formatImage(filePath, format) {
    if (!filePath || !fs.existsSync(filePath)) return null;

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

// Deep resolve placeholders in JSON templates
function resolvePlaceholders(template, context) {
    if (typeof template === 'string' && template.match(/^{{\??[^}]+}}$/)) {
        // If the entire string is exactly one placeholder (optional conditional ?), return the raw object/array if it exists.
        const match = template.match(/^{{\??([^}]+)}}$/);
        const key = match[1];

        if (key.startsWith('env:')) {
            const envVar = key.replace('env:', '');
            return process.env[envVar] || '';
        }
        if (context[key] !== undefined && typeof context[key] !== 'string') {
            return context[key]; // Return the raw object/array to allow deep insertion instead of stringification
        }
        // Fallthrough if it's just a string variable so it gets replaced normally below
    }

    if (typeof template === 'string') {
        // Handle conditional keys: "{{?condition}}key_name"
        // This is handled at the object level below, but we check if the string itself resolves to empty
        return template.replace(/{{([^}]+)}}/g, (match, key) => {
            if (key.startsWith('env:')) {
                const envVar = key.replace('env:', '');
                return process.env[envVar] || '';
            }
            return context[key] !== undefined ? context[key] : match;
        });
    } else if (Array.isArray(template)) {
        // Resolve each element, then flatten any nested arrays (e.g. {{resolved_image_array}} inside an array template)
        const resolved = template.map(item => resolvePlaceholders(item, context));
        return resolved.reduce((acc, item) => {
            if (Array.isArray(item)) acc.push(...item);
            else if (item !== null && item !== undefined && item !== '') acc.push(item);
            return acc;
        }, []);
    } else if (typeof template === 'object' && template !== null) {
        const result = {};
        for (const [key, value] of Object.entries(template)) {
            let actualKey = key;
            let conditionMet = true;

            // Check for conditional key syntax "{{?mask_image}}mask" or negative "{{?!aspect_ratio}}aspect_ratio"
            const match = key.match(/^{{\?(!?)([^}]+)}}(.*)$/);
            if (match) {
                const isNegation = match[1] === '!';
                const conditionVar = match[2];
                actualKey = match[3];

                const isPresent = !!context[conditionVar];
                if (isNegation) {
                    if (isPresent) conditionMet = false;
                } else {
                    if (!isPresent) conditionMet = false;
                }
            }

            if (conditionMet) {
                result[actualKey] = resolvePlaceholders(value, context);
            }
        }
        return result;
    }
    return template;
}




/**
 * Main function to start generating task
 */
async function generate(taskId, providerId, num_images, aspect_ratio, userParams, referenceImages, use_mask, force_separate_requests, tempDir, globalTasks) {
    if (!globalTasks[taskId]) throw new Error(`Task ${taskId} not found.`);
    const task = globalTasks[taskId];

    // 1. Load config
    const configData = getProvidersConfig();
    const provider = configData.providers.find(p => p.id === providerId);
    if (!provider) throw new Error(`Provider ${providerId} not found in config.`);
    const reqConfig = provider.request_config;

    // 2. Validate configuration
    if (use_mask) {
        if (!provider.mask_handling || !provider.mask_handling.supported) {
            throw new Error(`Provider "${provider.name}" does not support masks.`);
        }
        if (!task.maskImage) {
            throw new Error(`Mask image is required but missing from task.`);
        }
    } else {
        if (provider.mask_handling && provider.mask_handling.required) {
            throw new Error(`Provider "${provider.name}" requires a mask.`);
        }
    }

    // 3. Prepare Context Context
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

    // Convert paths to actual absolute file paths (removing API prefix)
    const resolveFilePath = (apiPath) => apiPath ? path.join(tempDir, apiPath.replace('/api/webhelper/file/', '')) : null;

    const sourcePath = resolveFilePath(task.sourceImage);
    const maskPath = use_mask ? resolveFilePath(task.maskImage) : null;

    let sourceImageFormatted = formatImage(sourcePath, provider.image_format);
    let maskImageFormatted = maskPath ? formatImage(maskPath, provider.image_format) : null;

    // Process reference images even if mask handling is false or simple
    let refImagesFormatted = (referenceImages || [])
        .map(refInput => {
            if (typeof refInput === 'string' && refInput.startsWith('data:image/')) {
                const parts = refInput.split(',');
                if (parts.length !== 2) return null;
                const base64 = parts[1];
                let mime = 'image/png';
                const match = parts[0].match(/data:(image\/[^;]+)/);
                if (match) mime = match[1];

                if (provider.image_format === 'base64_raw') return base64;
                if (provider.image_format === 'data_uri' || provider.image_format === 'url') return `data:${mime};base64,${base64}`;
                return base64;
            }
            return formatImage(resolveFilePath(refInput), provider.image_format);
        })
        .filter(Boolean);

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

            const processed = await runPreprocessor(preprocessorConfig, provider, preprocessorPayload, resolvePlaceholders);
            if (processed) {
                sourceImageFormatted = processed.source_image;
                maskImageFormatted = processed.mask_image;
                refImagesFormatted = processed.reference_images;
            }
        }
    }

    context.source_image = sourceImageFormatted;
    context.mask_image = maskImageFormatted;

    // Build resolved_image_array: [mask?] + [refs?] or [refs?] + [mask?] depending on type.
    const maskType = provider.mask_handling?.type;

    // Provide flat reference properties (reference_1, reference_2, etc.)
    refImagesFormatted.forEach((refBase64, index) => {
        context[`reference_${index + 1}`] = refBase64;
    });

    // Provide resolved_references if reference_item_template exists
    if (reqConfig.reference_item_template) {
        context.resolved_references = refImagesFormatted.map(refBase64 => {
            const tempContext = { ...context, item: refBase64 };
            return resolvePlaceholders(reqConfig.reference_item_template, tempContext);
        });
    }

    if (maskType === 'first_referential' || maskType === 'last_referential') {
        //используй реферальную картинку как инпаинт маску.
        if (maskType === 'first_referential' && context.mask_image) {
            // mask before references: [mask, ref1, ref2, ...]
            context.resolved_image_array = [context.mask_image, ...refImagesFormatted];
        } else if (maskType === 'last_referential' && context.mask_image) {
            // mask after references: [ref1, ref2, ..., mask]
            context.resolved_image_array = [...refImagesFormatted, context.mask_image];
        } else {
            // no mask or simple: [ref1, ref2, ...]
            context.resolved_image_array = refImagesFormatted;
        }
    } else {
        // Fallback: populate with refs (even if empty) to ensure variable is defined for the parser
        context.resolved_image_array = refImagesFormatted;
    }

    // 4. Compute Dynamic File Suffix
    let fileSuffix = providerId;
    if (provider.filename_suffix) {
        if (typeof provider.filename_suffix === 'string') {
            fileSuffix = resolvePlaceholders(provider.filename_suffix, context);
        } else if (typeof provider.filename_suffix === 'object' && provider.filename_suffix !== null) {
            const dependField = provider.filename_suffix.depends_on;
            const val = context[dependField];
            let suffixTemplate;
            if (val && provider.filename_suffix.values && provider.filename_suffix.values[val]) {
                suffixTemplate = provider.filename_suffix.values[val];
            } else {
                suffixTemplate = provider.filename_suffix.default || providerId;
            }
            fileSuffix = resolvePlaceholders(suffixTemplate, context);
        }
    }

    // 4b. Compute Display Name (nice_name) — resolved the same way as filename_suffix,
    // but sent to the client so the result header can show a human-readable model name.
    let niceProviderName = null;
    if (provider.nice_name) {
        if (typeof provider.nice_name === 'string') {
            niceProviderName = resolvePlaceholders(provider.nice_name, context);
        } else if (typeof provider.nice_name === 'object' && provider.nice_name !== null) {
            const dependField = provider.nice_name.depends_on;
            const val = context[dependField];
            let nameTemplate;
            if (val && provider.nice_name.values && provider.nice_name.values[val]) {
                nameTemplate = provider.nice_name.values[val];
            } else {
                nameTemplate = provider.nice_name.default || null;
            }
            niceProviderName = nameTemplate ? resolvePlaceholders(nameTemplate, context) : null;
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

        const currentUrl = resolvePlaceholders(reqConfig.endpoint_url, requestContext);
        const currentHeaders = resolvePlaceholders(reqConfig.headers, requestContext);
        const currentBody = resolvePlaceholders(reqConfig.body_template, requestContext);

        const urlObj = new URL(currentUrl);
        const options = { method: reqConfig.method, headers: currentHeaders };

        console.log(`[RequestBuilder] Executing request ${i + 1}/${requestCount} for taskId ${taskId}`);
        try {
            const apiResult = await makeRequest(urlObj, options, currentBody);

            // Wait for generation to complete and extract URLs
            const { imageStrings, finalData, imagesConfig, downloadHeaders } = await waitForApiResult(
                apiResult, provider.response_config, configData.response_handlers, currentHeaders
            );

            // Start downloading in the background
            const downloadPromise = downloadAndSaveImages(
                imageStrings, imagesConfig, downloadHeaders, tempDir, `${taskId}_${i}`, fileSuffix, finalData
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
    generate
};
