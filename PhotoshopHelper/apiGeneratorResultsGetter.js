const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { detectMimeTypeFromBase64, mimeTypeToExt } = require('./imageUtils');

/**
 * Resolve nested property by dot-notation path (e.g. "result.sample", "images.0.url")
 */
function getNested(obj, dotPath) {
    return dotPath.split('.').reduce((o, key) => o?.[key], obj);
}

/**
 * Substitute {{key}} and {{env:VAR}} placeholders in a string
 */
function resolveTemplateString(str, vars) {
    return str.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
        if (key.startsWith('env:')) {
            return process.env[key.replace('env:', '')] || '';
        }
        return vars[key] !== undefined ? vars[key] : match;
    });
}

/**
 * Deep-resolve placeholders in any JSON-like structure (string / array / object)
 */
function resolveTemplate(template, vars) {
    if (typeof template === 'string') {
        return resolveTemplateString(template, vars);
    }
    if (Array.isArray(template)) {
        return template.map(item => resolveTemplate(item, vars));
    }
    if (typeof template === 'object' && template !== null) {
        const result = {};
        for (const [k, v] of Object.entries(template)) {
            result[k] = resolveTemplate(v, vars);
        }
        return result;
    }
    return template;
}

/**
 * Merge a provider's response_config ($ref + params) with the base handler definition.
 * For "sync" type, params are substituted into {{format}} / {{extract}} placeholders.
 * For async types, params are merged into the template variable context.
 */
function resolveHandler(responseConfig, responseHandlers) {
    const refName = responseConfig.$ref;
    const baseHandler = responseHandlers[refName];
    if (!baseHandler) {
        throw new Error(`Response handler "${refName}" not found in response_handlers.`);
    }

    // Deep clone to avoid mutating the original config
    const handler = JSON.parse(JSON.stringify(baseHandler));
    const params = responseConfig.params || {};

    if (handler.type === 'sync') {
        // For sync: substitute params into the handler template ({{format}}, {{extract}})
        // extract is an array of strategy objects — replace the placeholder array with actual params
        if (handler.result && handler.result.images) {
            if (params.format) {
                handler.result.images.format = params.format;
            }
            if (params.extract) {
                handler.result.images.extract = params.extract;
            }
        }
    }

    // Store params for URL template resolution later
    handler._params = params;
    return handler;
}

/**
 * Modern Fetch-based request wrapper (matching official @fal-ai/client patterns)
 */
async function makeRequest(url, options, body = null) {
    const method = (options.method || 'GET').toUpperCase();
    const fetchOptions = {
        method,
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...options.headers
        },
        // Explicitly set body to undefined for GET, matching @fal-ai/client/src/request.js
        body: method !== 'GET' && body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
    };

    try {
        const res = await fetch(url, fetchOptions);
        const data = await res.text();

        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch (e) {
            parsed = data;
        }

        if (!res.ok) {
            const errorMsg = parsed.error?.message || parsed.error || parsed.detail || parsed.message || `API Error ${res.status}`;
            throw new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg));
        }

        return parsed;
    } catch (err) {
        throw new Error(`Network Error: ${err.message}`);
    }
}

/**
 * Universal polling function driven by config.
 * Returns the final poll response body when status reaches "completed".
 */
async function pollUntilDone(pollingConfig, templateVars) {
    const intervalMs = pollingConfig.interval_ms || 2000;
    const timeoutMs = pollingConfig.timeout_ms || 180000;
    const maxAttempts = Math.ceil(timeoutMs / intervalMs);
    const statusPath = pollingConfig.status.path;

    // Build polling URL
    const pollingUrl = resolveTemplateString(pollingConfig.url_template, templateVars);

    // Build polling headers — strip Content-Type for GET requests (some servers reject it)
    let headers;
    if (pollingConfig.use_request_headers) {
        const raw = templateVars._requestHeaders || {};
        headers = Object.fromEntries(Object.entries(raw).filter(([k]) => k.toLowerCase() !== 'content-type'));
    } else if (pollingConfig.headers) {
        headers = resolveTemplate(pollingConfig.headers, templateVars);
    } else {
        headers = {};
    }

    let attempts = 0;
    while (attempts < maxAttempts) {
        attempts++;
        await new Promise(r => setTimeout(r, intervalMs));

        console.log(`Polling status (Attempt ${attempts}/${maxAttempts}): ${pollingUrl}`);

        const res = await makeRequest(pollingUrl, { method: pollingConfig.method || 'GET', headers });

        const currentStatus = getNested(res, statusPath);

        if (pollingConfig.status.completed.includes(currentStatus)) {
            return res;
        }

        if (pollingConfig.status.failed.includes(currentStatus)) {
            const errorPath = pollingConfig.error_path;
            const errorMsg = errorPath ? getNested(res, errorPath) : currentStatus;
            const err = new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg || 'Polling task failed'));
            err.fallback_url = pollingUrl;
            throw err;
        }

        // If the status is not in_progress either, log a warning but keep polling
        if (!pollingConfig.status.in_progress.includes(currentStatus)) {
            console.warn(`Unknown polling status: "${currentStatus}", continuing...`);
        }
    }

    const err = new Error('Polling timeout: The generation took too long.');
    err.fallback_url = pollingUrl;
    throw err;
}

/**
 * Extract image strings (URLs or base64) from the final response data
 * using the ordered extract[] strategies. Returns the first strategy that yields results.
 */
function extractImages(responseData, imagesConfig) {
    const strategies = imagesConfig.extract;

    for (const strategy of strategies) {
        const data = getNested(responseData, strategy.path);
        if (data === undefined || data === null) continue;

        if (strategy.mode === 'array') {
            if (!Array.isArray(data) || data.length === 0) continue;
            const urls = data.map(item => {
                if (strategy.item_path) return getNested(item, strategy.item_path);
                return typeof item === 'string' ? item : null;
            }).filter(Boolean);
            if (urls.length > 0) return urls;
        }

        if (strategy.mode === 'single') {
            let value;
            if (strategy.item_path) {
                value = getNested(data, strategy.item_path);
            } else if (typeof data === 'string') {
                value = data;
            } else if (typeof data === 'object') {
                // If data is an object and no item_path, treat it as single value
                value = data.url || data;
            }
            if (value) return [value];
        }
    }

    console.error('Failed to extract images from response:', JSON.stringify(responseData).substring(0, 500));
    throw new Error('Could not extract image data from provider response.');
}

/**
 * Generates a unique filename using base_name_YYYY-MM-DD_idx format
 */
function getUniqueFilename(folder, baseName = "generated_image", ext = "png", fileSuffix = "") {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    // Pattern: baseName_dateStr_(\d+)
    const pattern = new RegExp(`^${baseName}_${dateStr}_(\\d+)`);

    const existingNumbers = new Set();
    const files = fs.readdirSync(folder);

    for (const filename of files) {
        if (filename.startsWith(`${baseName}_${dateStr}_`)) {
            const match = filename.match(pattern);
            if (match) {
                existingNumbers.add(parseInt(match[1], 10));
            }
        }
    }

    let i = 1;
    while (existingNumbers.has(i)) {
        i++;
    }

    const suffixPart = fileSuffix ? `.${fileSuffix}` : "";
    return path.join(folder, `${baseName}_${dateStr}_${i}.wh${suffixPart}.${ext}`);
}

/**
 * Download a URL or decode base64 and save to disk.
 * Returns { image: "/api/webhelper/file/...", status: "done" }
 */
async function downloadOrSaveImage(imageStr, format, downloadHeaders, tempDir, taskId, idx, fileSuffix) {
    let ext = 'png';
    let buffer = null;

    if (format === 'url') {
        try {
            // Download from URL using fetch (handles redirects automatically)
            const res = await fetch(imageStr, { headers: downloadHeaders || {} });
            if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText})`);

            const contentType = res.headers.get('content-type');
            if (contentType) {
                if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) ext = 'jpg';
                else if (contentType.includes('image/webp')) ext = 'webp';
                else if (contentType.includes('image/gif')) ext = 'gif';
            } else {
                try {
                    const urlObj = new URL(imageStr);
                    const pathExt = path.extname(urlObj.pathname).toLowerCase();
                    if (pathExt === '.jpg' || pathExt === '.jpeg') ext = 'jpg';
                    else if (pathExt === '.webp') ext = 'webp';
                    else if (pathExt === '.gif') ext = 'gif';
                } catch (e) {
                    // Ignore invalid URLs
                }
            }

            const filePath = getUniqueFilename(tempDir, "generated_image", ext, fileSuffix);
            const fileName = path.basename(filePath);
            const fileStream = fs.createWriteStream(filePath);
            await new Promise((resolve, reject) => {
                Readable.fromWeb(res.body).pipe(fileStream);
                fileStream.on('finish', resolve);
                fileStream.on('error', reject);
            });
            
            return {
                image: `/api/webhelper/file/${fileName}`,
                status: 'done'
            };
        } catch (downloadErr) {
            console.error('[ResultsGetter] Download failed:', downloadErr);
            return {
                status: 'error',
                error: `Download failed: ${downloadErr.message}`,
                fallback_url: imageStr
            };
        }
    } 
    
    if (format === 'data_uri') {
        if (imageStr.startsWith('data:image/')) {
            const mime = imageStr.split(';')[0].substring(5);
            if (mime === 'image/jpeg' || mime === 'image/jpg') ext = 'jpg';
            else if (mime === 'image/webp') ext = 'webp';
            else if (mime === 'image/gif') ext = 'gif';
        }
        const base64Data = imageStr.split(',')[1] || imageStr;
        buffer = Buffer.from(base64Data, 'base64');
    } else {
        // Detect MIME type from actual magic bytes and derive extension
        ext = mimeTypeToExt(detectMimeTypeFromBase64(imageStr));
        
        buffer = Buffer.from(imageStr, 'base64');
    }

    const filePath = getUniqueFilename(tempDir, "generated_image", ext, fileSuffix);
    const fileName = path.basename(filePath);
    fs.writeFileSync(filePath, buffer);

    return {
        image: `/api/webhelper/file/${fileName}`,
        status: 'done'
    };
}

/**
 * Wait for API generation to complete and extract image URLs/Base64.
 *
 * @param {object} submitResponse - The JSON response from the initial POST request
 * @param {object} providerResponseConfig - Provider's response_config (with $ref and params)
 * @param {object} responseHandlers - The top-level response_handlers from providers.json
 * @param {object} requestHeaders - Headers used for the original request (for use_request_headers)
 * @returns {Promise<Object>} { imageStrings, finalData, imagesConfig, downloadHeaders }
 */
async function waitForApiResult(submitResponse, providerResponseConfig, responseHandlers, requestHeaders) {
    // 1. Resolve the handler config by merging $ref with params
    const handler = resolveHandler(providerResponseConfig, responseHandlers);

    // Build template variable context: params + variables_from_submit
    const templateVars = { ...(handler._params || {}) };
    templateVars._requestHeaders = requestHeaders;

    let finalData;

    if (handler.type === 'sync') {
        // Result is already in the submit response
        finalData = submitResponse;

    } else if (handler.type === 'async_poll') {
        // Extract variables from submit response for URL templates
        if (handler.polling.variables_from_submit) {
            for (const [varName, jsonPath] of Object.entries(handler.polling.variables_from_submit)) {
                templateVars[varName] = getNested(submitResponse, jsonPath);
            }
        }

        // Poll until done — result is in the poll response itself
        finalData = await pollUntilDone(handler.polling, templateVars);

    } else if (handler.type === 'async_poll_and_get') {
        // Extract variables from submit response
        if (handler.polling.variables_from_submit) {
            for (const [varName, jsonPath] of Object.entries(handler.polling.variables_from_submit)) {
                templateVars[varName] = getNested(submitResponse, jsonPath);
            }
        }

        // Poll until done
        await pollUntilDone(handler.polling, templateVars);

        // Fetch result from separate endpoint
        const resultUrl = resolveTemplateString(handler.result.url_template, templateVars);
        let resultHeaders;
        if (handler.result.use_request_headers) {
            // Strip Content-Type for GET requests
            const raw = requestHeaders || {};
            resultHeaders = Object.fromEntries(Object.entries(raw).filter(([k]) => k.toLowerCase() !== 'content-type'));
        } else if (handler.result.headers) {
            resultHeaders = resolveTemplate(handler.result.headers, templateVars);
        } else {
            resultHeaders = {};
        }

        console.log(`[ResultsGetter] Fetching result from: ${resultUrl}`);
        finalData = await makeRequest(resultUrl, { method: handler.result.method || 'GET', headers: resultHeaders });

    } else {
        throw new Error(`Unknown response handler type: "${handler.type}"`);
    }

    // 3. Extract images from the final response data
    const imagesConfig = handler.result.images;
    const imageStrings = extractImages(finalData, imagesConfig);

    // 4. Compute download headers
    const downloadHeaders = imagesConfig.download_headers
        ? resolveTemplate(imagesConfig.download_headers, templateVars)
        : null;

    return { imageStrings, finalData, imagesConfig, downloadHeaders };
}

/**
 * Download and save images based on the extracted configuration.
 *
 * @param {Array<string>} imageStrings - URLs or Base64 strings
 * @param {object} imagesConfig - The configuration for images from the response handler
 * @param {object|null} downloadHeaders - Headers to use for downloading
 * @param {string} tempDir - Directory to save downloaded images
 * @param {string} taskId - Task identifier for file naming
 * @param {string} fileSuffix - Suffix for the generated file name
 * @param {object} finalData - The final JSON payload from the API (for logging)
 * @returns {Promise<Array>} Array of { image, status, final_response } objects
 */
async function downloadAndSaveImages(imageStrings, imagesConfig, downloadHeaders, tempDir, taskId, fileSuffix, finalData) {
    const results = [];
    for (let i = 0; i < imageStrings.length; i++) {
        const result = await downloadOrSaveImage(imageStrings[i], imagesConfig.format, downloadHeaders, tempDir, taskId, i, fileSuffix);
        result.final_response = finalData;
        results.push(result);
    }
    return results;
}

module.exports = { waitForApiResult, downloadAndSaveImages, makeRequest };
