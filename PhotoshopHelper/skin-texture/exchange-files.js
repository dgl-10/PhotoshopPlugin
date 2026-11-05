'use strict';

/**
 * Exchange files in the running plugin's data folder: naming, publishing, removal and the
 * clean-up of orphans.
 *
 * The folder is the one the plugin itself reported from
 * require('uxp').storage.localFileSystem.getDataFolder() in a script run through the task's
 * channel. It is never guessed from a scan of PluginsStorage, and the pairing file that also
 * lives there is never touched: every operation here is limited to names that match
 * OWN_NAME, which only this module produces.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const SkinExchange = require('./exchange.js');

// skin-texture-v1-<job id>-a<attempt>-<output>.sktx, with ".partial" while being written.
// The job id is "skt-" and 12 hex digits (job-manager.js).
const OWN_NAME = /^skin-texture-v1-skt-[0-9a-f]{12}-a[0-9]{1,3}-(main|pores|furrows)\.sktx(\.partial)?$/;

/**
 * @param {string} jobId - Job id.
 * @param {number} attempt - Apply attempt number.
 * @param {string} output - Output layer name.
 * @returns {string} The final file name.
 */
function fileNameFor(jobId, attempt, output) {
    const name = `skin-texture-v1-${jobId}-a${attempt}-${output}.sktx`;
    if (!OWN_NAME.test(name)) throw new Error(`Refusing a non-conforming exchange file name: ${name}`);
    return name;
}

/**
 * @param {string} folder - Data folder.
 * @param {string} name - One of our names.
 * @returns {string} Absolute path, proven to be directly inside the folder.
 */
function ownPath(folder, name) {
    if (!OWN_NAME.test(name)) throw new Error(`Not a skin texture exchange file name: ${name}`);
    const root = path.resolve(folder);
    const full = path.resolve(root, name);
    if (path.dirname(full) !== root) throw new Error(`Exchange file path escapes the data folder: ${name}`);
    return full;
}

/**
 * Check the data folder path the plugin reported.
 *
 * @param {*} nativePath - Path from getDataFolder().nativePath.
 * @returns {string} The normalised absolute path.
 * @throws {Error} When it is not an existing absolute directory.
 */
function checkDataFolder(nativePath) {
    if (typeof nativePath !== 'string' || !nativePath || !path.isAbsolute(nativePath)) {
        throw new Error('The plugin did not report an absolute data folder path.');
    }
    const resolved = path.resolve(nativePath);
    let stat;
    try {
        stat = fs.statSync(resolved);
    } catch (error) {
        throw new Error(`The plugin's data folder cannot be read from Helper: ${error.message}`);
    }
    if (!stat.isDirectory()) throw new Error('The plugin\'s data folder is not a folder.');
    return resolved;
}

/**
 * Write a file under a temporary name, flush it to disk, then give it its final name. The
 * plugin opens final names only, so it never reads a half-written file. Neither name may
 * exist beforehand: a name is never reused.
 *
 * @param {string} folder - Data folder.
 * @param {string} name - Final file name.
 * @param {Uint8Array} bytes - File contents.
 * @returns {Promise<{name: string, bytes: number, ms: number}>}
 */
async function publish(folder, name, bytes) {
    const started = performance.now();
    const target = ownPath(folder, name);
    const partial = ownPath(folder, `${name}.partial`);
    if (fs.existsSync(target)) throw new Error(`Exchange file already exists: ${name}`);
    const handle = await fsp.open(partial, 'wx');
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await fsp.rename(partial, target);
    } catch (error) {
        await fsp.rm(partial, { force: true });
        throw error;
    }
    return { name, bytes: bytes.length, ms: Math.round(performance.now() - started) };
}

/**
 * Remove our own files (and their temporary names). Missing files are fine.
 *
 * @param {string} folder - Data folder.
 * @param {string[]} names - Final names.
 * @param {object} [options]
 * @param {boolean} [options.sync] - Remove synchronously (used while Helper quits).
 * @returns {Promise<string[]>|string[]} Names that could not be removed.
 */
function removeOwn(folder, names, { sync = false } = {}) {
    const failed = [];
    const targets = [];
    for (const name of names) {
        targets.push(name, `${name}.partial`);
    }
    if (sync) {
        for (const name of targets) {
            try {
                fs.rmSync(ownPath(folder, name), { force: true });
            } catch {
                failed.push(name);
            }
        }
        return failed;
    }
    return Promise.all(targets.map(async name => {
        try {
            await fsp.rm(ownPath(folder, name), { force: true });
        } catch {
            failed.push(name);
        }
    })).then(() => failed);
}

/**
 * Remove exchange files left behind by an earlier Helper run (a crash, a quit while a write
 * was still in flight). A file is removed only when it is provably ours: its name matches
 * OWN_NAME, no live job of this run knows it, it is older than minAgeMs (a write of an
 * earlier run that was still in flight has long finished reading it by then), and a final
 * file also starts with our magic. Nothing is ever resumed from such a file.
 *
 * @param {string} folder - Data folder.
 * @param {object} options
 * @param {Set<string>} options.liveNames - Names that belong to live jobs.
 * @param {number} options.minAgeMs - Minimum age by modification time.
 * @param {() => number} [options.now] - Clock.
 * @returns {Promise<{removed: string[], kept: string[]}>}
 */
async function sweepOrphans(folder, { liveNames, minAgeMs, now = Date.now }) {
    const removed = [];
    const kept = [];
    let entries;
    try {
        entries = await fsp.readdir(folder);
    } catch {
        return { removed, kept };
    }
    for (const name of entries) {
        if (!OWN_NAME.test(name)) continue;
        const finalName = name.replace(/\.partial$/, '');
        if (liveNames.has(finalName)) { kept.push(name); continue; }
        const full = ownPath(folder, name);
        try {
            const stat = await fsp.stat(full);
            if (!stat.isFile() || now() - stat.mtimeMs < minAgeMs) { kept.push(name); continue; }
            if (!name.endsWith('.partial')) {
                const handle = await fsp.open(full, 'r');
                let magic;
                try {
                    const buffer = Buffer.alloc(8);
                    await handle.read(buffer, 0, 8, 0);
                    magic = buffer.toString('latin1');
                } finally {
                    await handle.close();
                }
                if (magic !== SkinExchange.magic) { kept.push(name); continue; }
            }
            await fsp.rm(full, { force: true });
            removed.push(name);
        } catch {
            kept.push(name);
        }
    }
    return { removed, kept };
}

module.exports = {
    OWN_NAME,
    fileNameFor,
    ownPath,
    checkDataFolder,
    publish,
    removeOwn,
    sweepOrphans
};
