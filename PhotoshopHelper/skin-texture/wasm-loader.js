'use strict';

/**
 * WebAssembly loader and runtime interface for skin texture formula core.
 *
 * Loads formulas.wasm compiled from Rust (formulas_rust_v1).
 * Verifies cryptographic integrity against PINNED_WASM_SHA256 upon load.
 * Provides synchronous WebAssembly execution for worker threads and
 * parameter resolution for recipe catalog.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const WASM_CORE_FILE = path.join(__dirname, 'formulas.wasm');
const PINNED_WASM_SHA256 = '39b9809b0ad6cb26f467afea4e7eab6c7b86630810a36261b108ff66f6a243ba';
const WASM_CORE_NAME = 'formulas_rust_v1';
const WASM_CORE_VERSION = '1.1.0';

let cachedModule = null;
let cachedIdentity = null;
let threadLocalInstance = null;

/**
 * Verify cryptographic checksum of wasm bytes.
 *
 * @param {Buffer} bytes
 * @returns {string} SHA-256 hex string
 */
function verifyWasmBytes(bytes) {
    const rawSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (rawSha256 !== PINNED_WASM_SHA256) {
        throw new Error(
            `Wasm core integrity check failed for ${WASM_CORE_FILE}. ` +
            `Expected SHA-256 ${PINNED_WASM_SHA256}, got ${rawSha256}`
        );
    }
    return rawSha256;
}

/**
 * Check that formulas.wasm is in place and is the pinned build, without compiling it.
 * The file is not kept in git, so a fresh checkout has none.
 *
 * @returns {string|null} What is wrong, in words for the log and the agent; null when usable.
 */
function checkWasmCore() {
    if (!fs.existsSync(WASM_CORE_FILE)) {
        return `Skin texture core not found: ${WASM_CORE_FILE}. `
            + 'This file is not kept in git; put the built formulas.wasm there.';
    }
    const rawSha256 = crypto.createHash('sha256').update(fs.readFileSync(WASM_CORE_FILE)).digest('hex');
    if (rawSha256 !== PINNED_WASM_SHA256) {
        return `Skin texture core ${WASM_CORE_FILE} is not the expected build: SHA-256 ${rawSha256}, `
            + `expected ${PINNED_WASM_SHA256}. Put the matching formulas.wasm there.`;
    }
    return null;
}

/**
 * Retrieve cryptographic identity of the wasm core.
 *
 * @returns {{name: string, fileName: string, version: string, sha256: string, matchesPinned: boolean, rawSha256: string}}
 */
function getWasmCoreIdentity() {
    if (!cachedIdentity) {
        if (!fs.existsSync(WASM_CORE_FILE)) {
            throw new Error(`Wasm core file not found: ${WASM_CORE_FILE}`);
        }
        const bytes = fs.readFileSync(WASM_CORE_FILE);
        const rawSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        const matchesPinned = rawSha256 === PINNED_WASM_SHA256;
        cachedIdentity = {
            name: WASM_CORE_NAME,
            fileName: path.basename(WASM_CORE_FILE),
            version: WASM_CORE_VERSION,
            sha256: matchesPinned ? PINNED_WASM_SHA256 : rawSha256,
            rawSha256,
            matchesPinned
        };
    }
    return cachedIdentity;
}

/**
 * Compile and cache the WebAssembly module after integrity verification.
 *
 * @returns {WebAssembly.Module}
 */
function loadWasmModule() {
    if (!cachedModule) {
        if (!fs.existsSync(WASM_CORE_FILE)) {
            throw new Error(`Wasm core file not found: ${WASM_CORE_FILE}`);
        }
        const bytes = fs.readFileSync(WASM_CORE_FILE);
        verifyWasmBytes(bytes);
        cachedModule = new WebAssembly.Module(bytes);
    }
    return cachedModule;
}

/**
 * Instantiate a new WebAssembly instance with empty imports.
 *
 * @returns {{instance: WebAssembly.Instance, exports: object}}
 */
function createWasmInstance() {
    const module = loadWasmModule();
    const instance = new WebAssembly.Instance(module, {});
    const exports = instance.exports;
    if (!exports.skinbench_compute || !exports.skinbench_alloc || !exports.skinbench_dealloc || !exports.skinbench_response_ptr) {
        throw new Error(`Wasm module does not export required SkinBench ABI functions`);
    }
    return { instance, exports };
}

/**
 * Get or create a thread-local WebAssembly instance for fast repeated operations.
 *
 * @returns {{instance: WebAssembly.Instance, exports: object}}
 */
function getThreadLocalInstance() {
    if (!threadLocalInstance) {
        threadLocalInstance = createWasmInstance();
    }
    return threadLocalInstance;
}

/**
 * Execute request using skinbench ABI on the given instance.
 *
 * @param {object} request - SkinBench VariantRequest
 * @param {object} [targetInstance] - Optional instance; defaults to thread-local instance
 * @returns {{status: string, header: object, layers: object, diagnostics: object, computeMs: number}}
 */
function executeWasm(request, targetInstance = null) {
    const wasm = targetInstance || getThreadLocalInstance();
    const { exports } = wasm;

    const reqJson = JSON.stringify(request);
    const reqBytes = Buffer.from(reqJson, 'utf8');

    const reqPtr = exports.skinbench_alloc(reqBytes.length);
    if (!reqPtr) {
        throw new Error(`Wasm allocation failed for ${reqBytes.length} bytes`);
    }

    try {
        const memory = new Uint8Array(exports.memory.buffer);
        memory.set(reqBytes, reqPtr);

        const t0 = performance.now();
        const retCode = exports.skinbench_compute(reqPtr, reqBytes.length);
        const computeMs = Math.round((performance.now() - t0) * 1000) / 1000;

        if (retCode !== 0) {
            throw new Error(`skinbench_compute failed with code: ${retCode}`);
        }

        const resPtr = exports.skinbench_response_ptr();
        const resLen = exports.skinbench_response_len();
        if (resLen < 4) {
            throw new Error(`Invalid Wasm response length: ${resLen}`);
        }

        const resBytes = new Uint8Array(exports.memory.buffer, resPtr, resLen);
        const view = new DataView(exports.memory.buffer, resPtr, resLen);
        const headerLen = view.getUint32(0, true);
        if (4 + headerLen > resLen) {
            throw new Error(`Corrupted Wasm response: headerLen ${headerLen} exceeds ${resLen}`);
        }

        const headerJsonBytes = resBytes.subarray(4, 4 + headerLen);
        const header = JSON.parse(Buffer.from(headerJsonBytes).toString('utf8'));

        if (header.status === 'error') {
            throw new Error(header.errorMessage || 'Wasm calculation returned an error');
        }

        const rawPayloadOffset = 4 + headerLen;
        const layers = {};
        if (Array.isArray(header.layers)) {
            for (const layer of header.layers) {
                const start = rawPayloadOffset + layer.byteOffset;
                const end = start + layer.byteLength;
                layers[layer.id] = new Uint8Array(resBytes.slice(start, end));
            }
        }

        return {
            status: header.status || 'ok',
            header,
            layers,
            diagnostics: header.diagnostics || {},
            computeMs
        };
    } finally {
        exports.skinbench_dealloc(reqPtr, reqBytes.length);
    }
}

const PRESET_MAPPING = Object.freeze({
    formula_1: 'candidate1',
    formula_2: 'candidate2'
});

/**
 * Resolve formula parameters via .wasm kernel.
 *
 * @param {string} formulaId - 'formula_1' or 'formula_2'
 * @param {{width: number, height: number}} document
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @param {number} pxPerMm
 * @param {object} commonParams - User-provided recipe params (mode, seed, azimuthDeg, elevationDeg)
 * @returns {object} Fully resolved core parameters for the procedural formula
 */
function resolveFormulaParams(formulaId, document, rect, pxPerMm, commonParams = {}) {
    const preset = PRESET_MAPPING[formulaId];
    if (!preset) {
        throw new Error(`Unknown formulaId: ${formulaId}`);
    }

    const request = {
        width: rect.width,
        height: rect.height,
        document: { width: document.width, height: document.height },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        pxPerMm,
        seed: commonParams.seed !== undefined ? commonParams.seed : 1,
        lighting: {
            azimuthDeg: commonParams.azimuthDeg !== undefined ? commonParams.azimuthDeg : 315,
            elevationDeg: commonParams.elevationDeg !== undefined ? commonParams.elevationDeg : 45
        },
        zone: 'cheek',
        params: {
            mode: commonParams.mode || 'lines',
            ...commonParams
        },
        presets: [preset],
        outputs: []
    };

    const result = executeWasm(request);
    const diag = result.diagnostics && result.diagnostics[formulaId];
    if (!diag || !diag.params) {
        throw new Error(`Wasm failed to resolve parameters for ${formulaId}`);
    }

    return diag.params;
}

module.exports = {
    WASM_CORE_FILE,
    PINNED_WASM_SHA256,
    WASM_CORE_NAME,
    WASM_CORE_VERSION,
    verifyWasmBytes,
    checkWasmCore,
    getWasmCoreIdentity,
    loadWasmModule,
    createWasmInstance,
    executeWasm,
    resolveFormulaParams
};
