'use strict';

/**
 * One private areola variant per disposable Node worker (task20), the same way formula-worker.js
 * runs one skin formula. The variant is computed on the shared sub-rectangle around the areolas;
 * its answer is checked against the pinned presentation and against contract section 10 before
 * anything is encoded:
 * - layer ids, names, blend mode and opacity exactly as pinned in areola-definitions.js;
 * - one transition band per areola, inside the region Helper computes;
 * - every byte outside the bands exactly 128, so the layer can be written at the size of the
 *   region without a seam and without cutting anything the variant drew.
 * Ending this worker releases the Wasm instance before the next variant starts.
 */
const { parentPort, workerData } = require('node:worker_threads');
const runtime = require('./wasm-loader');
const { AREOLA_DEFINITIONS, AREOLA_COMPONENTS } = require('./areola-definitions');
const geometry = require('./areola-geometry');
const { areolaCoreIdentity } = require('./areola-cores');
const exchange = require('./exchange');

/**
 * Keep the variant's diagnostics readable in a job status: long arrays (per-element listings)
 * are replaced by their length. Scalars and short arrays such as points stay as they are.
 */
function compact(value, depth = 0) {
    if (Array.isArray(value)) return value.length > 16 ? { length: value.length } : value.map(item => compact(item, depth + 1));
    if (value && typeof value === 'object' && depth < 6) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item, depth + 1)]));
    }
    return value;
}

try {
    const { variantId, request, meta } = workerData;
    const definition = AREOLA_DEFINITIONS[variantId];
    if (!definition) throw new Error(`Unknown areola variant: ${variantId}`);
    const core = areolaCoreIdentity(variantId);
    const result = runtime.executeWasm(variantId, request);
    const components = AREOLA_COMPONENTS.filter(item => item.formulaId === variantId);
    if (result.header.layers.length !== components.length) throw new Error(`${definition.fileName}: unexpected layer count.`);
    const diagnostics = result.diagnostics && result.diagnostics.areola;
    const reported = diagnostics && Array.isArray(diagnostics.areolas)
        ? diagnostics.areolas.map(item => item && item.transition) : null;
    const bands = geometry.checkTransitions(reported, request.fields.areolas.length, definition.fileName);

    const files = {}, checksums = {}, layers = {}, transfer = [];
    const encodeStart = performance.now();
    for (const [index, component] of components.entries()) {
        const layer = result.header.layers[index];
        if (layer.id !== component.sourceLayerId || layer.name !== component.layerName
            || layer.blendMode !== component.blendMode || layer.opacity !== component.opacity) {
            throw new Error(`${definition.fileName}: unexpected metadata for ${component.componentKey}.`);
        }
        const gray = result.layers[layer.id];
        const violation = geometry.findNeutralViolation(gray, request.rect, request.fields.areolas, bands);
        if (violation) throw new Error(`${definition.fileName}: layer ${layer.id} has ${violation}; contract section 10 promises 128 there. Nothing was cut.`);
        parentPort.postMessage({ type: 'progress', stage: `encode ${component.componentKey}`, at: Date.now() });
        const bytes = exchange.encode({ ...meta, rect: request.rect, output: component.componentKey,
            formula_id: variantId, formula_version: definition.version,
            core: { name: core.name, version: core.version, sha256: core.sha256 }
        }, gray);
        files[component.componentKey] = bytes;
        checksums[component.componentKey] = exchange.checksums(gray);
        layers[component.output] = layer.stats;
        transfer.push(bytes.buffer);
    }
    parentPort.postMessage({ type: 'result', files, checksums, bands,
        stats: { layers, diagnostics: compact(diagnostics || {}) }, core,
        timings: { computeMs: result.computeMs, encodeMs: Math.round((performance.now() - encodeStart) * 1000) / 1000 },
        memory: { wasmMemoryBytes: result.wasmMemoryBytes, rssBytes: process.memoryUsage().rss,
            processPeakRssBytes: process.resourceUsage().maxRSS * 1024 }
    }, transfer);
} catch (error) {
    parentPort.postMessage({ type: 'error', message: String(error.message || error) });
} finally {
    parentPort.close();
}
