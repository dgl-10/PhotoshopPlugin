'use strict';

/**
 * Disk cache for CLI model lists fetched via the "Refresh Models" prompt.
 *
 * One JSON file per CLI is stored in <userDataPath>/cli-models-cache/.
 * Files older than MAX_AGE_MS are considered stale: readCache() deletes them
 * and returns null so the caller knows it needs to fetch again.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { getConfigPaths } = require('../setup/config-paths');
const { writeFileAtomic } = require('../atomic-write');

/** Cache TTL: 14 days in milliseconds. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Recognised CLI identifiers — mirrors the four CLIs the UI supports. */
const SUPPORTED_CLIS = ['claude', 'codex', 'grok', 'agy'];

/**
 * Absolute path to the cache directory.
 * On packaged/installed builds, resolves to <userData>/cli-models-cache/
 * (%APPDATA%\PhotoshopHelper\cli-models-cache on Windows).
 *
 * @returns {string}
 */
function getCacheDir() {
    const paths = getConfigPaths();
    return paths.cliModelsCachePath || path.join(paths.userDataPath, 'cli-models-cache');
}

/**
 * Ensure the cache directory exists on disk.
 *
 * @returns {string|null} The directory path if created or existing, null on error.
 */
function ensureCacheDir() {
    const dir = getCacheDir();
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return dir;
    } catch {
        return null;
    }
}

/**
 * Absolute path to the cache file for a specific CLI.
 *
 * @param {string} cli
 * @returns {string}
 */
function getCacheFilePath(cli) {
    return path.join(getCacheDir(), `${cli}.json`);
}

/**
 * Read and validate the cache for a CLI.
 *
 * Returns null when:
 * - The file does not exist.
 * - The file is malformed / unreadable.
 * - The file is older than MAX_AGE_MS (file is deleted in that case).
 *
 * @param {string} cli - One of: claude, codex, grok, agy.
 * @returns {{ data: object, fetchedAt: string, ageMs: number } | null}
 */
function readCache(cli) {
    if (!SUPPORTED_CLIS.includes(cli)) return null;

    const filePath = getCacheFilePath(cli);
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
        return null; // File does not exist or is unreadable
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Corrupted file — remove it so next refresh starts clean.
        try { fs.unlinkSync(filePath); } catch { /* best effort */ }
        return null;
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.fetchedAt || !parsed.data) {
        try { fs.unlinkSync(filePath); } catch { /* best effort */ }
        return null;
    }

    const fetchedAt = new Date(parsed.fetchedAt);
    if (isNaN(fetchedAt.getTime())) {
        try { fs.unlinkSync(filePath); } catch { /* best effort */ }
        return null;
    }

    const ageMs = Date.now() - fetchedAt.getTime();
    if (ageMs > MAX_AGE_MS) {
        // Stale — delete and report absence.
        try { fs.unlinkSync(filePath); } catch { /* best effort */ }
        return null;
    }

    return { data: parsed.data, fetchedAt: parsed.fetchedAt, ageMs };
}

/**
 * Write a fresh model list to the cache for a CLI.
 *
 * @param {string} cli  - One of: claude, codex, grok, agy.
 * @param {object} data - Parsed JSON object returned by the CLI.
 * @returns {boolean} True on success, false on any write failure.
 */
function writeCache(cli, data) {
    if (!SUPPORTED_CLIS.includes(cli)) return false;

    const dir = ensureCacheDir();
    if (!dir) return false;

    const payload = {
        cli,
        fetchedAt: new Date().toISOString(),
        data
    };

    try {
        writeFileAtomic(getCacheFilePath(cli), JSON.stringify(payload, null, 2));
        return true;
    } catch {
        return false;
    }
}

/**
 * Delete the cache file for a CLI (e.g. to force a re-fetch).
 *
 * @param {string} cli
 * @returns {boolean} True if the file was deleted or did not exist.
 */
function deleteCache(cli) {
    if (!SUPPORTED_CLIS.includes(cli)) return false;
    try {
        fs.unlinkSync(getCacheFilePath(cli));
        return true;
    } catch {
        return true; // File already absent — that is fine.
    }
}

/**
 * Clean up any expired or corrupted cache files in the directory.
 */
function cleanStaleCache() {
    const dir = getCacheDir();
    try {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            if (file.endsWith('.json')) {
                const cli = file.slice(0, -5);
                readCache(cli); // Automatically deletes expired or corrupt cache
            }
        }
    } catch {
        /* best effort */
    }
}

module.exports = {
    getCacheDir,
    ensureCacheDir,
    cleanStaleCache,
    readCache,
    writeCache,
    deleteCache,
    SUPPORTED_CLIS,
    MAX_AGE_MS
};
