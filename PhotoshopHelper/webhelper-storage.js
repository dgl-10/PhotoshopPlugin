'use strict';

/**
 * On-disk layout and public URLs for WebHelper's temp root (`ps_webhelper_tasks`).
 *
 * Task uploads and generated results live in two stable folders. The HTTP file
 * endpoint exposes them as `/api/webhelper/file/tasks/...` and
 * `/api/webhelper/file/generated/...`. CLI working files are not served from here;
 * that scratch directory is owned by the CLI image provider.
 */

const fs = require('node:fs');
const path = require('node:path');

const WEBHELPER_TASKS_DIRNAME = '_WH_Tasks';
const WEBHELPER_GENERATED_DIRNAME = '_WH_Generated';
const WEBHELPER_FILE_URL_PREFIX = '/api/webhelper/file/';

/** URL path segment -> directory name inside the temp root. */
const WEBHELPER_FILE_AREAS = {
    tasks: WEBHELPER_TASKS_DIRNAME,
    generated: WEBHELPER_GENERATED_DIRNAME
};

/**
 * Confirm that a resolved path is strictly inside a directory.
 *
 * A string prefix check is not enough: `C:\\temp` is a prefix of `C:\\temp-other`.
 *
 * @param {string} parent - Allowed directory.
 * @param {string} candidate - Candidate path.
 * @returns {boolean} True when candidate is a path inside parent.
 */
function isPathInsideDirectory(parent, candidate) {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative !== ''
        && !relative.startsWith('..')
        && !path.isAbsolute(relative);
}

/**
 * Create one public file area and return its absolute directory.
 *
 * @param {string} tempRoot - WebHelper temp root.
 * @param {'tasks'|'generated'} area - Public area name.
 * @returns {string} Absolute directory.
 */
function ensureWebhelperArea(tempRoot, area) {
    const dirname = WEBHELPER_FILE_AREAS[area];
    if (!dirname) {
        throw new Error(`Unknown WebHelper file area: ${area}`);
    }
    const directory = path.join(tempRoot, dirname);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

/**
 * Build the public URL for a file stored in a WebHelper area.
 *
 * @param {'tasks'|'generated'} area - Public area name.
 * @param {string} filename - Single path segment, already including the extension.
 * @returns {string} URL served by `/api/webhelper/file/`.
 */
function webhelperFileUrl(area, filename) {
    if (!WEBHELPER_FILE_AREAS[area]) {
        throw new Error(`Unknown WebHelper file area: ${area}`);
    }
    if (typeof filename !== 'string'
        || filename.length === 0
        || filename.includes('/')
        || filename.includes('\\')
        || filename === '.'
        || filename === '..') {
        throw new Error(`Unsafe WebHelper filename: ${filename}`);
    }
    return `${WEBHELPER_FILE_URL_PREFIX}${area}/${filename}`;
}

/**
 * Resolve a WebHelper file URL, or the path relative to that URL, to a local file.
 *
 * Accepted shapes:
 * - `/api/webhelper/file/tasks/<filename>` and `tasks/<filename>`
 * - `/api/webhelper/file/generated/<filename>` and `generated/<filename>`
 * - `/api/webhelper/file/<filename>` and `<filename>` for a file left in the temp root
 *
 * Anything that leaves those locations, including the CLI scratch directory, is rejected.
 *
 * @param {string} tempRoot - WebHelper temp root.
 * @param {string} relativeOrUrl - Public URL or the path that follows `/api/webhelper/file/`.
 * @returns {string|null} Absolute file path, or null when the value is not allowed.
 */
function resolveWebhelperFile(tempRoot, relativeOrUrl) {
    if (typeof relativeOrUrl !== 'string' || relativeOrUrl.length === 0) return null;

    let relative = relativeOrUrl;
    if (relative.startsWith(WEBHELPER_FILE_URL_PREFIX)) {
        relative = relative.slice(WEBHELPER_FILE_URL_PREFIX.length);
    }
    relative = relative.replace(/\\/g, '/').replace(/^\/+/, '');
    if (relative.length === 0 || relative.includes('\0')) return null;

    const parts = relative.split('/');
    if (parts.some(part => part === '' || part === '.' || part === '..')) return null;

    if (parts.length === 1) {
        const absolute = path.resolve(tempRoot, parts[0]);
        return isPathInsideDirectory(tempRoot, absolute) ? absolute : null;
    }

    if (parts.length === 2 && WEBHELPER_FILE_AREAS[parts[0]]) {
        const areaDir = path.resolve(tempRoot, WEBHELPER_FILE_AREAS[parts[0]]);
        const absolute = path.resolve(areaDir, parts[1]);
        return isPathInsideDirectory(areaDir, absolute) ? absolute : null;
    }

    return null;
}

/**
 * Delete files under the temp root that are older than maxAgeMs, then drop empty directories.
 *
 * The walk visits every subdirectory. A directory is removed only after its old files are
 * gone and nothing remains, so a fresh file keeps its parent even when neighboring files expire.
 * The temp root itself is never removed. Symbolic links are deleted by their own age and are
 * not followed.
 *
 * @param {string} rootDir - WebHelper temp root.
 * @param {number} maxAgeMs - Maximum age to keep.
 * @param {number} [now=Date.now()] - Clock value used for the age comparison.
 */
function cleanupOldWebhelperFiles(rootDir, maxAgeMs, now = Date.now()) {
    if (!rootDir || !fs.existsSync(rootDir)) return;

    const walk = directory => {
        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            let stats;
            try {
                stats = fs.lstatSync(entryPath);
            } catch {
                continue;
            }

            if (stats.isSymbolicLink()) {
                if (now - stats.mtimeMs > maxAgeMs) {
                    try { fs.unlinkSync(entryPath); } catch { /* already gone */ }
                }
                continue;
            }

            if (stats.isDirectory()) {
                walk(entryPath);
                continue;
            }

            if (stats.isFile() && now - stats.mtimeMs > maxAgeMs) {
                try { fs.rmSync(entryPath, { force: true }); } catch { /* already gone */ }
            }
        }

        if (path.resolve(directory) === path.resolve(rootDir)) return;
        try {
            if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
        } catch { /* a concurrent writer may have added a file */ }
    };

    walk(rootDir);
}

module.exports = {
    WEBHELPER_GENERATED_DIRNAME,
    ensureWebhelperArea,
    webhelperFileUrl,
    resolveWebhelperFile,
    cleanupOldWebhelperFiles,
    // Exported solely for testing purposes
    WEBHELPER_TASKS_DIRNAME,
    WEBHELPER_FILE_URL_PREFIX,
    WEBHELPER_FILE_AREAS
};
