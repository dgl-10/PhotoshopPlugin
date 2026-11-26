'use strict';

/**
 * Background recipe entry point owned by the job manager.
 * This worker owns no files or Photoshop state. Its child workers run sequentially;
 * terminating this coordinator also terminates its child worker's Node environment.
 * Only encoded exchange buffers are transferred back to Helper's main thread.
 */
const { parentPort, workerData } = require('node:worker_threads');
const { DEFAULT_RECIPE } = require('./formula-definitions');
const { AREOLA_RECIPE } = require('./areola-definitions');
const { computeSkinRecipe } = require('./recipe-worker-engine');

/** Keep long calculations observable without blocking the parent event loop. */
function progress(stage) {
    parentPort.postMessage({ type: 'progress', stage, at: Date.now() });
}

(async () => {
    try {
        if (!workerData || (workerData.recipe !== DEFAULT_RECIPE && workerData.recipe !== AREOLA_RECIPE)) {
            throw new Error(`Worker only supports recipes "${DEFAULT_RECIPE}" and "${AREOLA_RECIPE}", received: ${workerData && workerData.recipe}`);
        }
        const result = await computeSkinRecipe(workerData, progress);
        parentPort.postMessage({ type: 'result', files: result.files, checksums: result.checksums,
            stats: result.stats, timings: result.timings, cores: result.cores, memory: result.memory,
            recipe: workerData.recipe }, result.transfer);
    } catch (error) {
        parentPort.postMessage({ type: 'error', message: String(error.message || error) });
    } finally {
        parentPort.close();
    }
})();