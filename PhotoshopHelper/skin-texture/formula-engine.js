'use strict';

/**
 * Recipe coordinator: exactly one formula worker is alive at a time.
 * It uses Node only, so the same path runs in Electron's Node and in regression tests.
 * Files already encoded by earlier formulas stay in this coordinator while temporary
 * maps and Wasm memory are owned exclusively by each short-lived child worker.
 */
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { DEFAULT_RECIPE, FORMULA_DEFINITIONS } = require('./formula-definitions');
const { AREOLA_RECIPE } = require('./areola-definitions');
const { computeAreolas } = require('./areola-engine');

/** Wait for one result, then wait for worker termination before releasing the next slot. */
async function computeFormula(formulaId, request, meta, postProgress) {
    const worker = new Worker(path.join(__dirname, 'formula-worker.js'), { workerData: { formulaId, request, meta } });
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
                if (!answered) reject(new Error(`${formulaId}: worker exited (${code}) without a result.`));
            });
        });
    } finally {
        // Awaiting terminate's exit promise makes memory release an execution boundary,
        // instead of relying on nondeterministic garbage collection of Wasm instances.
        await worker.terminate();
    }
}

/** Run both formulas sequentially and gather their final transferable buffers. */
async function computeSkinRecipe(workerData, postProgress = () => {}) {
    if (workerData.recipe !== DEFAULT_RECIPE && workerData.recipe !== AREOLA_RECIPE) throw new Error(`Unsupported recipe: ${workerData.recipe}`);
    const files = {}, checksums = {}, stats = {}, timings = {}, cores = {}, memory = {};
    const transfer = [];
    // task20: areolas first. They take seconds, so a failing areola request is reported before
    // minutes of skin computation; the skin formulas below are unchanged.
    if (workerData.areola) {
        const areola = await computeAreolas(workerData.areola, workerData.meta, postProgress);
        Object.assign(files, areola.files);
        Object.assign(checksums, areola.checksums);
        Object.assign(stats, areola.stats);
        Object.assign(timings, areola.timings);
        Object.assign(cores, areola.cores);
        Object.assign(memory, areola.memory);
        transfer.push(...areola.transfer);
    }
    if (workerData.recipe === AREOLA_RECIPE) return { files, checksums, stats, timings, cores, memory, transfer };
    for (const formula of Object.values(FORMULA_DEFINITIONS)) {
        const request = workerData.formulaParams[formula.id];
        if (!request) throw new Error(`Missing request for ${formula.id}`);
        postProgress(`compute ${formula.id}`);
        const started = performance.now();
        const result = await computeFormula(formula.id, request, workerData.meta, postProgress);
        Object.assign(files, result.files);
        Object.assign(checksums, result.checksums);
        stats[formula.id] = result.stats;
        cores[formula.id] = result.core;
        memory[formula.id] = result.memory;
        timings[`${formula.id}_compute_ms`] = result.timings.computeMs;
        timings[`${formula.id}_encode_ms`] = result.timings.encodeMs;
        timings[`${formula.id}_total_ms`] = Math.round((performance.now() - started) * 1000) / 1000;
        for (const bytes of Object.values(result.files)) transfer.push(bytes.buffer);
    }
    return { files, checksums, stats, timings, cores, memory, transfer };
}

module.exports = { computeSkinRecipe };
