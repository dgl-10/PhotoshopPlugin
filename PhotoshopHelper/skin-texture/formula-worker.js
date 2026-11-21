'use strict';

/**
 * One private variant per disposable Node worker.
 * Encode and checksum the result here, then transfer only final exchange buffers. Ending
 * this worker releases its entire Wasm instance, including linear memory high-water marks,
 * before the recipe coordinator is allowed to start the next formula.
 */
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const runtime = require('./wasm-loader');
const { FORMULA_DEFINITIONS, RECIPE_COMPONENTS } = require('./formula-definitions');
const exchange = require('./exchange');
const faceMap = require('./face-map');

try {
    const { formulaId, request, meta } = workerData;
    const formula = FORMULA_DEFINITIONS[formulaId];
    if (!formula) throw new Error(`Unknown formulaId: ${formulaId}`);
    const core = runtime.getWasmCoreIdentity().formulas.find(item => item.formulaId === formulaId);
    // Fable produces the shared map alongside its relief. Other formulas remain
    // consumers of their own requests, including when a future version supports a map.
    const wantsFaceMap = formulaId === 'formula_1' && Boolean(request.fields && request.fields.face);
    const result = runtime.executeWasm(formulaId, wantsFaceMap ? { ...request, includeFaceMap: true } : request);
    const components = RECIPE_COMPONENTS.filter(item => item.formulaId === formulaId);
    if (result.header.layers.length !== components.length) throw new Error(`${formula.fileName}: unexpected layer count.`);
    const files = {}, checksums = {}, layers = {}, transfer = [];
    const encodeStart = performance.now();
    for (const [index, component] of components.entries()) {
        const layer = result.header.layers[index];
        // Pinned pixels and presentation metadata form one contract. Refuse a mismatch
        // rather than putting correct pixels into a differently named or blended layer.
        if (layer.id !== component.sourceLayerId || layer.name !== component.layerName
            || layer.blendMode !== component.blendMode || layer.opacity !== component.opacity) {
            throw new Error(`${formula.fileName}: unexpected metadata for ${component.componentKey}.`);
        }
        parentPort.postMessage({ type: 'progress', stage: `encode ${component.componentKey}`, at: Date.now() });
        const gray = result.layers[layer.id];
        const bytes = exchange.encode({ ...meta, output: component.componentKey,
            formula_id: formulaId, formula_version: formula.version,
            core: { name: core.name, version: core.version, sha256: core.sha256 }
        }, gray);
        files[component.componentKey] = bytes;
        checksums[component.componentKey] = exchange.checksums(gray);
        layers[component.output] = layer.stats;
        transfer.push(bytes.buffer);
    }
    if (wantsFaceMap) {
        // Hand Photoshop the actual numeric map Fable used. Keep render pixels out of the
        // inter-process payload so its size stays bounded even in large documents.
        const numeric = result.faceMap;
        faceMap.decode(numeric, meta.document);
        const bytes = exchange.encodeFaceMap({ ...meta, output: faceMap.OUTPUT,
            formula_id: formulaId, formula_version: formula.version,
            core: { name: core.name, version: core.version, sha256: core.sha256 }
        }, numeric);
        files[faceMap.OUTPUT] = bytes;
        checksums[faceMap.OUTPUT] = { ...exchange.checksums(numeric),
            sha256: createHash('sha256').update(numeric).digest('hex') };
        transfer.push(bytes.buffer);
    }
    parentPort.postMessage({ type: 'result', files, checksums,
        stats: { layers, diagnostics: result.diagnostics }, core,
        timings: { computeMs: result.computeMs, encodeMs: Math.round((performance.now() - encodeStart) * 1000) / 1000 },
        memory: { wasmMemoryBytes: result.wasmMemoryBytes, rssBytes: process.memoryUsage().rss,
            processPeakRssBytes: process.resourceUsage().maxRSS * 1024 }
    }, transfer);
} catch (error) {
    parentPort.postMessage({ type: 'error', message: String(error.message || error) });
} finally {
    parentPort.close();
}
