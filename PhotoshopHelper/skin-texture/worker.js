'use strict';

/**
 * Background recipe entry point owned by the job manager.
 * This worker owns no files or Photoshop state. Its child workers run sequentially;
 * terminating this coordinator also terminates its child worker's Node environment.
 * Only encoded exchange buffers are transferred back to Helper's main thread.
 */
const { parentPort, workerData } = require('node:worker_threads');
const { DEFAULT_RECIPE } = require('./formula-definitions');
const { computeSkinThreeV2 } = require('./recipe-worker-engine');

/** Keep long calculations observable without blocking the parent event loop. */
function progress(stage) {
    parentPort.postMessage({ type: 'progress', stage, at: Date.now() });
}

(async () => {
    try {
        if (!workerData || workerData.recipe !== DEFAULT_RECIPE) {
            throw new Error(`Worker only supports recipe "${DEFAULT_RECIPE}", received: ${workerData && workerData.recipe}`);
        }
        const result = await computeSkinThreeV2(workerData, progress);
        parentPort.postMessage({ type: 'result', files: result.files, checksums: result.checksums,
            stats: result.stats, timings: result.timings, cores: result.cores, memory: result.memory,
            recipe: DEFAULT_RECIPE }, result.transfer);
    } catch (error) {
        parentPort.postMessage({ type: 'error', message: String(error.message || error) });
    } finally {
        parentPort.close();
    }
})();