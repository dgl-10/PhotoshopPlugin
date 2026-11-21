'use strict';

/**
 * Disposable worker for the image search of areola-detect-image.js (task20), so a second of
 * measurement on a large grid never blocks Helper's main thread (MCP, plugin channel).
 */
const { parentPort, workerData } = require('node:worker_threads');
const { detectInImage } = require('./areola-detect-image');
const { measureGiven } = require('./areola-detect-given');

try {
    const { samples, width, height, channels, map, hints, given } = workerData;
    const started = performance.now();
    // "given": the outlines come from the person's selection; only the nipple and light are measured.
    const result = given
        ? measureGiven(new Uint8Array(samples), width, height, channels, map, given)
        : detectInImage(new Uint8Array(samples), width, height, channels, map, { hints });
    result.analysisMs = Math.round(performance.now() - started);
    parentPort.postMessage({ type: 'result', result });
} catch (error) {
    parentPort.postMessage({ type: 'error', message: String(error.message || error) });
} finally {
    parentPort.close();
}
