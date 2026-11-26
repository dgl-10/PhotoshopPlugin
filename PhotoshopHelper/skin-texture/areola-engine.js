'use strict';

/**
 * Areola part of the recipe coordinator (task20). Runs inside the background recipe worker
 * (worker.js) before the skin formulas: it is fast (seconds), so a broken areola request fails
 * before minutes of skin computation are spent.
 *
 * The two variants run one after another, each in its own disposable worker, on the same
 * request. When the job also computes the general skin, the coordinator then builds the soft
 * cut-out mask from the two reported transition bands (areola-geometry.js buildCutout) and
 * encodes it in the same exchange format as the layers.
 */
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { AREOLA_DEFINITIONS, CUTOUT_OUTPUT } = require('./areola-definitions');
const geometry = require('./areola-geometry');
const exchange = require('./exchange');

/** Version of Helper's own cut-out construction; it travels in the exchange header. */
const CUTOUT_VERSION = 1;

/** Wait for one variant's result, then for its worker to end, before the next one starts. */
async function computeVariant(variantId, request, meta, postProgress) {
    const worker = new Worker(path.join(__dirname, 'areola-worker.js'), { workerData: { variantId, request, meta } });
    try {
        return await new Promise((resolve, reject) => {
            let answered = false;
            worker.on('message', message => {
                if (!message || answered) return;
                if (message.type === 'progress') postProgress(message.stage);
                if (message.type === 'result') { answered = true; resolve(message); }
                if (message.type === 'error') { answered = true; reject(new Error(message.message)); }
            });
            worker.once('error', reject);
            worker.once('exit', code => {
                if (!answered) reject(new Error(`${variantId}: worker exited (${code}) without a result.`));
            });
        });
    } finally {
        await worker.terminate();
    }
}

/**
 * Compute the two areola variants and, when asked, the cut-out.
 *
 * @param {{requests: object, region: object, cutout: boolean}} areola - From the request adapter.
 * @param {object} meta - Exchange identity of the job (jobId, taskId, document, recipe_id).
 * @param {Function} postProgress
 * @returns {Promise<object>} files, checksums, stats, timings, cores, memory, bands, transfer.
 */
async function computeAreolas(areola, meta, postProgress = () => {}) {
    const files = {}, checksums = {}, stats = {}, timings = {}, cores = {}, memory = {}, bands = {};
    const transfer = [];
    for (const definition of Object.values(AREOLA_DEFINITIONS)) {
        const request = areola.requests[definition.id];
        if (!request) throw new Error(`Missing request for ${definition.id}`);
        postProgress(`compute ${definition.id}`);
        const started = performance.now();
        let result;
        try {
            result = await computeVariant(definition.id, request, meta, postProgress);
        } catch (error) {
            // Name the comparison the author knows, so the failing variant is clear.
            throw new Error(`Areola variant ${definition.label} (${definition.variant} ${definition.variantVersion}): ${error.message}`);
        }
        Object.assign(files, result.files);
        Object.assign(checksums, result.checksums);
        stats[definition.id] = result.stats;
        cores[definition.id] = result.core;
        memory[definition.id] = result.memory;
        bands[definition.id] = result.bands;
        timings[`${definition.id}_compute_ms`] = result.timings.computeMs;
        timings[`${definition.id}_encode_ms`] = result.timings.encodeMs;
        timings[`${definition.id}_total_ms`] = Math.round((performance.now() - started) * 1000) / 1000;
        for (const bytes of Object.values(result.files)) transfer.push(bytes.buffer);
    }
    if (areola.cutout) {
        postProgress(`compute ${CUTOUT_OUTPUT}`);
        const started = performance.now();
        const records = Object.values(areola.requests)[0].fields.areolas;
        const mask = geometry.buildCutout(records, Object.values(bands), areola.region.rect);
        const bytes = exchange.encode({ ...meta, rect: areola.region.rect, output: CUTOUT_OUTPUT,
            formula_id: CUTOUT_OUTPUT, formula_version: CUTOUT_VERSION, bands }, mask);
        files[CUTOUT_OUTPUT] = bytes;
        checksums[CUTOUT_OUTPUT] = exchange.checksums(mask);
        timings[`${CUTOUT_OUTPUT}_ms`] = Math.round((performance.now() - started) * 1000) / 1000;
        transfer.push(bytes.buffer);
    }
    return { files, checksums, stats, timings, cores, memory, bands, transfer };
}

module.exports = { computeAreolas, CUTOUT_VERSION };
