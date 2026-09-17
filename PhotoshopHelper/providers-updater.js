const fs = require('node:fs');

const JSON5 = require('json5');

const packageJson = require('./package.json');
const { getConfigPaths } = require('./setup/config-paths');
const { writeFileAtomic } = require('./atomic-write');
const { validateSharedCatalog } = require('./providers-catalog');

// Downloads the shared model list so new providers reach installed apps without a new
// app release. The published list is providers.template.json on the main branch of the
// repository the app itself is released from.

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * @returns {string} Address of the published model list.
 */
function getDefaultCatalogUrl() {
    const owner = packageJson.build?.publish?.owner || 'dgl-10';
    const repo = packageJson.build?.publish?.repo || 'PhotoshopPlugin';
    return `https://raw.githubusercontent.com/${owner}/${repo}/main/PhotoshopHelper/providers.template.json`;
}

/**
 * Make texts comparable regardless of the line endings and BOM they were saved with.
 *
 * @param {string} text - File text.
 * @returns {string} Normalized text.
 */
function normalizeText(text) {
    return text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

/**
 * Download the published model list and save it when it differs from the saved one.
 *
 * The download is parsed and validated before anything is written, and the saved copy
 * is replaced atomically, so a failed or truncated download leaves the current list
 * untouched.
 *
 * @param {object} [options]
 * @param {string} [options.url] - Address of the published list; must be https.
 * @param {Function} [options.fetchImpl] - fetch-compatible function.
 * @param {object} [options.paths] - Result of getConfigPaths().
 * @param {number} [options.timeoutMs] - Time allowed for the whole download.
 * @param {number} [options.maxBytes] - Largest accepted file.
 * @returns {Promise<{status: 'updated'|'unchanged'}>}
 * @throws {Error} When downloads are disabled, or the list cannot be downloaded or is not
 *   acceptable.
 */
async function checkForCatalogUpdate(options = {}) {
    const url = options.url || getDefaultCatalogUrl();
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const paths = options.paths || getConfigPaths();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

    // Development reads the local template, which a download must never overwrite.
    if (!paths.downloadedProvidersPath) {
        throw new Error('Model list downloads are disabled in development');
    }

    // The list decides where users' API keys are sent, so it is only taken over an
    // authenticated connection.
    if (new URL(url).protocol !== 'https:') {
        throw new Error(`Model list address must use https: ${url}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text;
    try {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Server responded with HTTP ${response.status}`);
        }
        const declaredLength = Number(response.headers?.get?.('content-length'));
        if (declaredLength > maxBytes) {
            throw new Error(`Model list is too large (${declaredLength} bytes)`);
        }
        text = await response.text();
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`No response within ${Math.round(timeoutMs / 1000)} s`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }

    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new Error(`Model list is too large (${Buffer.byteLength(text, 'utf8')} bytes)`);
    }

    let downloaded;
    try {
        downloaded = JSON5.parse(text);
    } catch (error) {
        throw new Error(`Downloaded model list is damaged or incomplete: ${error.message}`);
    }

    const problems = validateSharedCatalog(downloaded);
    if (problems.length > 0) {
        throw new Error(`Downloaded model list rejected: ${problems.join('; ')}`);
    }

    const target = paths.downloadedProvidersPath;
    if (fs.existsSync(target) && normalizeText(fs.readFileSync(target, 'utf8')) === normalizeText(text)) {
        return { status: 'unchanged' };
    }

    writeFileAtomic(target, text);
    return { status: 'updated' };
}

/**
 * Create a checker for the published model list. It has no timer of its own: the app
 * update schedule in updater.js calls checkNow(), and so does the tray menu.
 *
 * @param {object} [options] - Also accepts every option of checkForCatalogUpdate().
 * @param {Function} [options.onResult] - Called with every check's result; failures
 *   arrive as { status: 'error', error: string }.
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {{checkNow: Function}}
 */
function createCatalogUpdater(options = {}) {
    const {
        onResult,
        logger = console,
        ...checkOptions
    } = options;

    let running = null;

    function report(result) {
        if (typeof onResult !== 'function') return;
        try {
            onResult(result);
        } catch (error) {
            logger.error('[providers] Model list update callback failed:', error);
        }
    }

    /**
     * Run one check now. A check requested while another is running shares its result.
     *
     * @returns {Promise<object>} The check result; never rejects.
     */
    function checkNow() {
        if (running) {
            return running;
        }

        running = checkForCatalogUpdate(checkOptions)
            .then((result) => {
                logger.info(`[providers] Model list check: ${result.status}`);
                return result;
            })
            .catch((error) => {
                logger.warn(`[providers] Model list check failed: ${error.message}`);
                return { status: 'error', error: error.message };
            })
            .then((result) => {
                running = null;
                report(result);
                return result;
            });

        return running;
    }

    return { checkNow };
}

module.exports = { createCatalogUpdater };
