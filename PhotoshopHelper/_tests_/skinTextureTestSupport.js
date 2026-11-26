'use strict';

/** Shared test plumbing; expected requests and bytes are kept independent of the product resolver. */
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { FORMULA_DEFINITIONS } = require('../skin-texture/formula-definitions');

/**
 * A checkout may omit private binaries. Only absence permits skipping: a present but
 * modified binary must fail integrity checks and must never silently disable coverage.
 */
function missingBinaryReason() {
    const missing = Object.values(FORMULA_DEFINITIONS)
        .filter(formula => !fs.existsSync(path.join(__dirname, '../skin-texture', formula.fileName)))
        .map(formula => formula.fileName);
    return missing.length ? `Private Wasm files missing: ${missing.join(', ')}` : false;
}

/** Run the public product worker and wait for its exit, so tests also catch leaked children. */
function runWorker(formulaParams, rect, document, recipe = 'skin_v2') {
    return new Promise((resolve, reject) => {
        const worker = new Worker(require('../skin-texture/job-manager').WORKER_FILE, {
            workerData: { recipe, formulaParams, outputs: Object.values(FORMULA_DEFINITIONS)
                .flatMap(formula => formula.layers.map(layer => `${formula.id}_${layer.output}`)),
            meta: { jobId: 'skt-0123456789ab', taskId: 'task-test', document: { id: 7, ...document }, rect } }
        });
        let result;
        let failure;
        worker.on('message', message => {
            if (message.type === 'result') result = message;
            if (message.type === 'error') failure = new Error(message.message);
        });
        worker.on('error', reject);
        worker.on('exit', code => {
            if (failure) reject(failure);
            else if (code || !result) reject(new Error(`Product worker exited ${code} without a result`));
            else resolve(result);
        });
    });
}

module.exports = { missingBinaryReason, runWorker };
