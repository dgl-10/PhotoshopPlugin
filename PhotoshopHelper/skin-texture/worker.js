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
 * requested outputs with the unchanged formulas core, packs each into the exchange format (so the
 * checksums are computed here too, off the main thread) and transfers the bytes back. It
 * owns no files and no Photoshop state, so being terminated at any moment leaves nothing to
 * clean up; the job manager in the main thread owns everything else.
 *
 * Under task07, this worker executes exclusively the standard recipe ("skin_pair_v1") via
 * computeSkinPairV1 (recipe-worker-engine.js). Any invalid or legacy workerData that does
 * not specify recipe "skin_pair_v1" is rejected immediately with an error.
 *
 * workerData: { recipe: 'skin_pair_v1', formulaParams, params, outputs, meta }
 * Messages to the parent:
 *   { type: 'progress', stage, at }
 *   { type: 'result', files: { [output]: Uint8Array }, checksums, stats, timings, recipe }
 *   { type: 'error', message }
 */

const { parentPort, workerData } = require('node:worker_threads');
const { computeSkinPairV1 } = require('./recipe-worker-engine.js');

function progress(stage) {
    parentPort.postMessage({ type: 'progress', stage, at: Date.now() });
}

try {
    if (!workerData || workerData.recipe !== 'skin_pair_v1') {
        const received = workerData ? workerData.recipe : 'none';
        throw new Error(`Worker only supports recipe "skin_pair_v1", received: ${received}`);
    }
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
} catch (error) {
    parentPort.postMessage({ type: 'error', message: String((error && error.message) || error) });
}
