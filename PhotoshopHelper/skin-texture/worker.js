'use strict';

/**
 * The skin texture computation, in a Node worker thread of Helper.
 *
 * Why a worker: the full core takes tens of seconds on large areas (task02: 54 s for 4096 x
 * 4096 "lines" in Node). Run in Helper's main thread it would stop Helper's own timers,
 * including the WebSocket heartbeat to the plugin, and every other MCP call. A worker thread
 * runs in Helper's own Electron/Node, so nobody needs a Node installation of their own. The
 * choice of computing in Helper rather than inside Photoshop is explained next to it, at the
 * top of job-manager.js.
 *
 * This file may use Node only: no Electron API is reachable or needed here. It computes the
 * requested outputs with the unchanged core, packs each into the exchange format (so the
 * checksums are computed here too, off the main thread) and transfers the bytes back. It
 * owns no files and no Photoshop state, so being terminated at any moment leaves nothing to
 * clean up; the job manager in the main thread owns everything else.
 *
 * workerData: { params, outputs, meta }
 *   params  - the core's resolved parameters (document size, rect, scale, ...)
 *   outputs - subset of ['main', 'pores', 'furrows'], in that order
 *   meta    - the exchange header fields shared by all outputs
 * Messages to the parent:
 *   { type: 'progress', stage, at }
 *   { type: 'result', files: { [output]: Uint8Array }, checksums, stats, timings }
 *   { type: 'error', message }
 */

const { parentPort, workerData } = require('node:worker_threads');

const SkinTexture = require('./skin-core.js');
const SkinExchange = require('./exchange.js');
const { computeSkinPairV1 } = require('./recipe-worker-engine.js');

const now = () => performance.now();
const round = value => Math.round(value * 1000) / 1000;

/**
 * @param {string} stage - What the worker is doing now.
 */
function progress(stage) {
    parentPort.postMessage({ type: 'progress', stage, at: Date.now() });
}

try {
    if (workerData && workerData.recipe === 'skin_pair_v1') {
        const result = computeSkinPairV1(workerData, progress);
        parentPort.postMessage(
            {
                type: 'result',
                files: result.files,
                checksums: result.checksums,
                stats: result.stats,
                timings: result.timings,
                recipe: 'skin_pair_v1'
            },
            result.transfer
        );
    } else {
        const { params, outputs, meta } = workerData;
        const timings = {};

        progress('prepare');
        let t = now();
        const state = SkinTexture.prepare(params);
        timings.prepareMs = round(now() - t);

        progress('heights');
        t = now();
        SkinTexture.buildHeights(state);
        timings.heightsMs = round(now() - t);

        // shade() and finish() overwrite the shared buffers completely for each layer, so any
        // subset of outputs, in any order, gives the same bytes as the core's own render().
        const files = {};
        const checksums = {};
        const transfer = [];
        for (const output of outputs) {
            progress(`shade ${output}`);
            t = now();
            SkinTexture.shade(state, output);
            const gray = SkinTexture.finish(state, output);
            timings[`${output}Ms`] = round(now() - t);

            t = now();
            const bytes = SkinExchange.encode({ ...meta, output }, gray);
            timings[`${output}EncodeMs`] = round(now() - t);
            files[output] = bytes;
            checksums[output] = SkinExchange.checksums(gray);
            transfer.push(bytes.buffer);
        }

        parentPort.postMessage({ type: 'result', files, checksums, stats: state.stats, timings }, transfer);
    }
} catch (error) {
    parentPort.postMessage({ type: 'error', message: String((error && error.message) || error) });
}
