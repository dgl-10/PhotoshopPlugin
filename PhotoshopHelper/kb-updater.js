'use strict';

const fs = require('node:fs');
const path = require('node:path');

const packageJson = require('./package.json');
const { getConfigPaths } = require('./setup/config-paths');

// Downloads the author knowledge base so new articles and corrections reach installed apps
// without a new app release. The knowledge base is the knowledge-base/ directory on the
// main branch of the repository the app is released from.
//
// Strategy:
// 1. Query the GitHub Git Trees API for the main branch:
//    GET https://api.github.com/repos/:owner/:repo/git/trees/main?recursive=1
//    This discovers all files under PhotoshopHelper/knowledge-base/ dynamically with zero
//    manual manifests to maintain.
// 2. Download all discovered .md files via raw.githubusercontent.com into a temporary
//    directory created right next to the target folder (ensuring same filesystem/mount).
// 3. Compare the downloaded files with the current local copy on disk:
//    If all files and their contents match, the temporary directory is discarded and
//    { status: 'unchanged' } is returned.
// 4. If any file changed, was added, or was removed, atomically replace the target directory.
//    If the second rename step fails, the old directory is rolled back immediately.

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_MAX_TREE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const KB_REPO_PREFIX = 'PhotoshopHelper/knowledge-base/';

/**
 * @returns {string} URL to query Git tree for repo main branch.
 */
function getDefaultTreeUrl() {
    const owner = packageJson.build?.publish?.owner || 'dgl-10';
    const repo = packageJson.build?.publish?.repo || 'PhotoshopPlugin';
    return `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`;
}

/**
 * @returns {string} Base raw.githubusercontent.com URL for knowledge-base/ files.
 */
function getDefaultRawBaseUrl() {
    const owner = packageJson.build?.publish?.owner || 'dgl-10';
    const repo = packageJson.build?.publish?.repo || 'PhotoshopPlugin';
    return `https://raw.githubusercontent.com/${owner}/${repo}/main/${KB_REPO_PREFIX.replace(/\/$/, '')}`;
}

/**
 * Fetch a single URL and return its text. Throws on HTTP error or timeout.
 *
 * @param {string} url - URL to fetch; must be https.
 * @param {Function} fetchImpl - fetch-compatible function.
 * @param {number} timeoutMs - Abort after this many milliseconds.
 * @param {number} maxBytes - Reject responses larger than this.
 * @param {object} [headers] - Extra request headers.
 * @returns {Promise<string>} Response text.
 */
async function fetchText(url, fetchImpl, timeoutMs, maxBytes, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let text;
    try {
        const response = await fetchImpl(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': `PhotoshopHelper/${packageJson.version || '1.0.0'}`,
                ...headers
            }
        });
        if (!response.ok) {
            throw new Error(`Server responded with HTTP ${response.status}`);
        }
        const declaredLength = Number(response.headers?.get?.('content-length'));
        if (declaredLength > maxBytes) {
            throw new Error(`File too large (declared ${declaredLength} bytes): ${url}`);
        }
        text = await response.text();
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`No response within ${Math.round(timeoutMs / 1000)} s: ${url}`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        throw new Error(
            `File too large (${Buffer.byteLength(text, 'utf8')} bytes): ${url}`
        );
    }
    return text;
}

/**
 * Extract and validate relative knowledge-base file paths from a GitHub tree API response.
 *
 * @param {Array<{path: string, type: string}>} tree - The "tree" array from GitHub API.
 * @returns {string[]} List of safe relative paths (e.g. ['rules.md', 'articles/foo.md']).
 * @throws {Error} If tree is invalid or contains unsafe paths.
 */
function extractKbFilesFromTree(tree) {
    if (!Array.isArray(tree)) {
        throw new Error('Invalid GitHub tree response: "tree" array is missing');
    }

    const files = [];
    for (const item of tree) {
        if (!item || item.type !== 'blob' || typeof item.path !== 'string') continue;
        if (!item.path.startsWith(KB_REPO_PREFIX)) continue;
        if (!item.path.endsWith('.md')) continue;

        const relPath = item.path.slice(KB_REPO_PREFIX.length);
        if (!relPath.trim()) continue;

        // Prevent path traversal: entries must be clean relative paths.
        const normalized = path.posix.normalize(relPath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
            throw new Error(`Knowledge base tree contains an unsafe path: ${relPath}`);
        }

        files.push(normalized);
    }

    if (files.length === 0) {
        throw new Error('No knowledge base articles found in repository tree');
    }

    return files.sort();
}

/**
 * Recursively list all .md files in a directory as posix relative paths.
 *
 * @param {string} dir - Directory to scan.
 * @param {string} [rel] - Accumulated relative path.
 * @returns {string[]} Sorted relative paths.
 */
function listRelativeFiles(dir, rel = '') {
    if (!fs.existsSync(dir)) return [];
    const result = [];
    for (const entry of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const entryRel = rel ? `${rel}/${entry}` : entry;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            result.push(...listRelativeFiles(fullPath, entryRel));
        } else if (entry.endsWith('.md')) {
            result.push(entryRel.replace(/\\/g, '/'));
        }
    }
    return result.sort();
}

/**
 * Make texts comparable regardless of line endings.
 *
 * @param {string} text - File text.
 * @returns {string} Normalized text.
 */
function normalizeText(text) {
    return String(text || '').replace(/\r\n/g, '\n');
}

/**
 * Check if the contents of all files in tempDir are identical to targetDir.
 *
 * @param {string} tempDir - Directory with freshly downloaded files.
 * @param {string} targetDir - Current local directory.
 * @returns {boolean} True if every file in tempDir matches targetDir and no files were added/removed.
 */
function isContentIdentical(tempDir, targetDir) {
    if (!fs.existsSync(targetDir)) return false;

    const tempFiles = listRelativeFiles(tempDir);
    const targetFiles = listRelativeFiles(targetDir);

    if (tempFiles.length !== targetFiles.length) return false;

    for (let i = 0; i < tempFiles.length; i++) {
        if (tempFiles[i] !== targetFiles[i]) return false;

        const tempContent = fs.readFileSync(path.join(tempDir, tempFiles[i].replace(/\//g, path.sep)), 'utf8');
        const targetContent = fs.readFileSync(path.join(targetDir, targetFiles[i].replace(/\//g, path.sep)), 'utf8');

        if (normalizeText(tempContent) !== normalizeText(targetContent)) {
            return false;
        }
    }

    return true;
}

/**
 * Download the knowledge base and replace the local copy atomically.
 *
 * "All or nothing": every file is downloaded into a temporary directory placed alongside
 * targetDir before anything is replaced. The previous copy is left untouched if any
 * download fails, and rolled back if the atomic rename fails.
 *
 * @param {object} [options]
 * @param {string} [options.treeUrl] - URL to query Git tree (GitHub API); must be https.
 * @param {string} [options.rawBaseUrl] - Base raw.githubusercontent.com URL; must be https.
 * @param {Function} [options.fetchImpl] - fetch-compatible function.
 * @param {object} [options.paths] - Result of getConfigPaths().
 * @param {number} [options.timeoutMs] - Time allowed for each individual download.
 * @param {number} [options.maxTreeBytes] - Largest accepted tree response.
 * @param {number} [options.maxFileBytes] - Largest accepted single file.
 * @returns {Promise<{status: 'updated'|'unchanged'}>}
 */
async function checkForKbUpdate(options = {}) {
    const treeUrl = options.treeUrl || getDefaultTreeUrl();
    const rawBaseUrl = options.rawBaseUrl || getDefaultRawBaseUrl();
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const paths = options.paths || getConfigPaths();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxTreeBytes = options.maxTreeBytes ?? DEFAULT_MAX_TREE_BYTES;
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

    // Development reads local files directly; no download.
    if (!paths.downloadedKnowledgeBasePath) {
        throw new Error('Knowledge base downloads are disabled in development');
    }

    // Only fetch over https to avoid MITM.
    if (new URL(treeUrl).protocol !== 'https:') {
        throw new Error(`Knowledge base tree URL must use https: ${treeUrl}`);
    }
    if (new URL(rawBaseUrl).protocol !== 'https:') {
        throw new Error(`Knowledge base raw base URL must use https: ${rawBaseUrl}`);
    }

    const targetDir = paths.downloadedKnowledgeBasePath;

    // Step 1: Discover files in knowledge-base via GitHub Git Trees API.
    const treeResponseText = await fetchText(
        treeUrl,
        fetchImpl,
        timeoutMs,
        maxTreeBytes,
        { 'Accept': 'application/vnd.github+json' }
    );

    let parsedTree;
    try {
        parsedTree = JSON.parse(treeResponseText);
    } catch (error) {
        throw new Error(`Knowledge base tree response is damaged or incomplete: ${error.message}`);
    }

    // A recursive tree is cut off past GitHub's size limit and flagged as truncated. A cut
    // list would make the mirror drop articles that still exist, so it is rejected whole.
    if (parsedTree && parsedTree.truncated === true) {
        throw new Error('GitHub returned a truncated repository tree; knowledge base not updated');
    }

    const filesToDownload = extractKbFilesFromTree(parsedTree.tree);

    // Step 2: Download files into a temporary directory NEXT TO targetDir
    // (ensuring same filesystem so fs.renameSync never fails with EXDEV across drives).
    const parentDir = path.dirname(targetDir);
    fs.mkdirSync(parentDir, { recursive: true });
    const tempDir = `${targetDir}.tmp-${process.pid}-${Date.now().toString(36)}`;
    fs.mkdirSync(tempDir, { recursive: true });

    const oldDir = `${targetDir}.old-${process.pid}-${Date.now().toString(36)}`;

    try {
        // Download each file into tempDir.
        for (const relPath of filesToDownload) {
            const fileUrl = `${rawBaseUrl}/${relPath}`;
            const fileText = await fetchText(fileUrl, fetchImpl, timeoutMs, maxFileBytes);
            const destPath = path.join(tempDir, relPath.replace(/\//g, path.sep));
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.writeFileSync(destPath, fileText, 'utf8');
        }

        // Verify all files were written.
        for (const relPath of filesToDownload) {
            const destPath = path.join(tempDir, relPath.replace(/\//g, path.sep));
            if (!fs.existsSync(destPath)) {
                throw new Error(`Downloaded file missing after write: ${relPath}`);
            }
        }

        // Step 3: Compare downloaded files with the current copy on disk.
        if (isContentIdentical(tempDir, targetDir)) {
            // Nothing changed: clean up tempDir and report unchanged.
            fs.rmSync(tempDir, { recursive: true, force: true });
            return { status: 'unchanged' };
        }

        // Step 4: Atomically replace the target directory.
        if (fs.existsSync(targetDir)) {
            fs.renameSync(targetDir, oldDir);
        }
        fs.renameSync(tempDir, targetDir);

        if (fs.existsSync(oldDir)) {
            try {
                fs.rmSync(oldDir, { recursive: true, force: true });
            } catch {
                // If deletion of oldDir fails (e.g. transient file lock), targetDir is already active.
            }
        }

        return { status: 'updated' };
    } catch (error) {
        // Rollback: if targetDir was moved out of the way to oldDir, but tempDir failed
        // to replace it, restore oldDir back to targetDir so the KB is never lost.
        if (fs.existsSync(oldDir) && !fs.existsSync(targetDir)) {
            try {
                fs.renameSync(oldDir, targetDir);
            } catch {
                // Rollback failure logged implicitly by the throw
            }
        }
        throw error;
    } finally {
        // Clean up tempDir if it still exists
        if (fs.existsSync(tempDir)) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }
}

/**
 * Create a checker for the published knowledge base. It has no timer of its own: the app
 * update schedule in updater.js calls checkNow(), and so does the tray menu.
 *
 * @param {object} [options] - Also accepts every option of checkForKbUpdate().
 * @param {Function} [options.onResult] - Called with every check's result; failures
 *   arrive as { status: 'error', error: string }.
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {{checkNow: Function}}
 */
function createKbUpdater(options = {}) {
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
            logger.error('[kb] Knowledge base update callback failed:', error);
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

        running = checkForKbUpdate(checkOptions)
            .then((result) => {
                logger.info(`[kb] Knowledge base check: ${result.status}`);
                return result;
            })
            .catch((error) => {
                logger.warn(`[kb] Knowledge base check failed: ${error.message}`);
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

module.exports = {
    createKbUpdater,
    // Exported for testing only:
    checkForKbUpdate,
    extractKbFilesFromTree,
    listRelativeFiles,
    isContentIdentical,
    getDefaultTreeUrl,
    getDefaultRawBaseUrl
};
