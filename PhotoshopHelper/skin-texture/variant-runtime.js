'use strict';

/**
 * Strict host for the private, import-free SkinBench binaries.
 * Each computation gets a fresh instance in a disposable worker. Only compiled code is
 * cached here; Wasm linear memory and response buffers never escape that worker.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_RECIPE, FORMULA_DEFINITIONS } = require('./formula-definitions');
const modules = new Map();

/** Resolve the pinned asset for a known product formula. */
function definition(formulaId) {
    const formula = FORMULA_DEFINITIONS[formulaId];
    if (!formula) throw new Error(`Unknown formulaId: ${formulaId}`);
    return formula;
}

/** Verify bytes before either reporting an identity or compiling executable code. */
function verifyWasmBytes(bytes, formulaId) {
    const formula = definition(formulaId);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== formula.sha256) {
        throw new Error(`Skin texture core ${formula.fileName} failed integrity check: expected SHA-256 ${formula.sha256}, got ${actual}.`);
    }
    return actual;
}

/** Missing assets are expected in public checkouts; never substitute another formula. */
function readVerified(formulaId) {
    const formula = definition(formulaId);
    const file = path.join(__dirname, formula.fileName);
    let bytes;
    try {
        bytes = fs.readFileSync(file);
    } catch (error) {
        throw new Error(`Skin texture core ${file} is unavailable (${error.code || error.message}). Put the matching private ${formula.fileName} there; it is not kept in git.`);
    }
    verifyWasmBytes(bytes, formulaId);
    return bytes;
}

/** Check all assets without allocating Wasm memory or running a formula. */
function checkWasmCore() {
    try {
        for (const id of Object.keys(FORMULA_DEFINITIONS)) readVerified(id);
        return null;
    } catch (error) {
        return error.message;
    }
}

/** Return verified per-formula provenance, plus a digest identifying the complete recipe. */
function getWasmCoreIdentity() {
    const formulas = Object.values(FORMULA_DEFINITIONS).map(formula => {
        readVerified(formula.id);
        return {
            formulaId: formula.id, name: formula.variant, fileName: formula.fileName,
            version: formula.variantVersion, sha256: formula.sha256,
            rawSha256: formula.sha256, matchesPinned: true
        };
    });
    const sha256 = crypto.createHash('sha256').update(JSON.stringify(formulas)).digest('hex');
    return { name: DEFAULT_RECIPE, version: '2.0.0', sha256, matchesPinned: true, formulas };
}

/** Reverify the disk asset even if its compiled module was already cached in this thread. */
function loadWasmModule(formulaId) {
    const bytes = readVerified(formulaId);
    if (!modules.has(formulaId)) {
        const module = new WebAssembly.Module(bytes);
        if (WebAssembly.Module.imports(module).length) {
            throw new Error(`${definition(formulaId).fileName}: host imports are not allowed.`);
        }
        modules.set(formulaId, module);
    }
    return modules.get(formulaId);
}

/** Validate the complete contract ABI, including response length and exported memory. */
function createWasmInstance(formulaId) {
    const instance = new WebAssembly.Instance(loadWasmModule(formulaId), {});
    const exports = instance.exports;
    const functions = ['skinbench_alloc', 'skinbench_dealloc', 'skinbench_compute', 'skinbench_response_ptr', 'skinbench_response_len'];
    if (!(exports.memory instanceof WebAssembly.Memory) || functions.some(key => typeof exports[key] !== 'function')) {
        throw new Error(`${definition(formulaId).fileName}: required SkinBench ABI exports are missing.`);
    }
    return { instance, exports };
}

/**
 * Execute contract JSON and copy validated grayscale planes out of Wasm memory.
 * Allocation and compute may grow memory, invalidating prior JS views; create each view
 * only after the call that can grow it. No view into Wasm is returned to a caller.
 */
function executeWasm(formulaId, request, targetInstance = null) {
    const fileName = definition(formulaId).fileName;
    const { exports } = targetInstance || createWasmInstance(formulaId);
    const input = Buffer.from(JSON.stringify(request), 'utf8');
    const ptr = exports.skinbench_alloc(input.length);
    if (!ptr) throw new Error(`${fileName}: Wasm request allocation failed.`);
    try {
        new Uint8Array(exports.memory.buffer).set(input, ptr);
        const started = performance.now();
        const code = exports.skinbench_compute(ptr, input.length);
        const computeMs = Math.round((performance.now() - started) * 1000) / 1000;
        const responsePtr = exports.skinbench_response_ptr();
        const responseLen = exports.skinbench_response_len();
        const memory = exports.memory.buffer;
        if (responseLen < 4 || responsePtr < 0 || responsePtr + responseLen > memory.byteLength) {
            throw new Error(`${fileName}: invalid Wasm response bounds (code ${code}).`);
        }
        const bytes = new Uint8Array(memory, responsePtr, responseLen);
        const headerLen = new DataView(memory, responsePtr, responseLen).getUint32(0, true);
        if (headerLen > responseLen - 4) throw new Error(`${fileName}: invalid Wasm response header length.`);
        const header = JSON.parse(Buffer.from(bytes.subarray(4, 4 + headerLen)).toString('utf8'));
        if (code !== 0 || header.status !== 'ok') {
            throw new Error(`${fileName}: ${header.errorMessage || `skinbench_compute failed with code ${code}`}`);
        }
        if (!Array.isArray(header.layers)) throw new Error(`${fileName}: missing response layers.`);
        const layers = {};
        const payloadStart = 4 + headerLen;
        for (const layer of header.layers) {
            if (typeof layer.id !== 'string' || Object.hasOwn(layers, layer.id)
                || !Number.isInteger(layer.byteOffset) || layer.byteOffset < 0
                || layer.byteLength !== request.width * request.height
                || payloadStart + layer.byteOffset + layer.byteLength > responseLen) {
                throw new Error(`${fileName}: invalid response layer bounds or identifier.`);
            }
            layers[layer.id] = bytes.slice(payloadStart + layer.byteOffset, payloadStart + layer.byteOffset + layer.byteLength);
        }
        return { status: header.status, header, layers, diagnostics: header.diagnostics || {}, computeMs,
            wasmMemoryBytes: memory.byteLength };
    } finally {
        exports.skinbench_dealloc(ptr, input.length);
    }
}

module.exports = { verifyWasmBytes, checkWasmCore, getWasmCoreIdentity, loadWasmModule, createWasmInstance, executeWasm };
