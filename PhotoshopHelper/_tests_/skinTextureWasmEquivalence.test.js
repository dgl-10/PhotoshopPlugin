'use strict';

/**
 * Tests for WebAssembly formula core equivalence and integrity (task12).
 *
 * Verifies:
 * 1. Cryptographic integrity of formulas.wasm against PINNED_WASM_SHA256.
 * 2. Clear rejection when .wasm is corrupted or mismatched.
 * 3. Verification against pre-recorded golden component checksums from fixtures/wasm-golden-checksums.json
 *    ensuring Stage 2 reproducibility after the legacy JS core is removed.
 * 4. Confirmation that the legacy JS formulas core (skin-core-formulas.js) has been completely removed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wasmLoader = require('../skin-texture/wasm-loader.js');
const recipeCatalog = require('../skin-texture/recipe-catalog.js');
const SkinExchange = require('../skin-texture/exchange.js');

// These tests need formulas.wasm, which is not kept in git. Without it they are skipped
// (a CommonJS module may return early; the tests below are then never registered).
const missingWasmCore = wasmLoader.checkWasmCore();
if (missingWasmCore) {
    test('skin texture tests need formulas.wasm', { skip: missingWasmCore }, () => {});
    return;
}

const GOLDEN_CHECKSUMS_FILE = path.join(__dirname, 'fixtures', 'wasm-golden-checksums.json');

test('formulas.wasm is present and matches pinned SHA-256', () => {
    const identity = wasmLoader.getWasmCoreIdentity();
    assert.equal(identity.name, 'formulas_rust_v1');
    assert.equal(identity.version, '1.1.0');
    assert.equal(identity.fileName, 'formulas.wasm');
    assert.equal(identity.sha256, wasmLoader.PINNED_WASM_SHA256);
    assert.equal(identity.matchesPinned, true);
    assert.equal(recipeCatalog.getFormulasCoreIdentity().sha256, wasmLoader.PINNED_WASM_SHA256);

    // Verify legacy JS core is removed
    const legacyJsPath = path.join(__dirname, '../skin-texture/skin-core-formulas.js');
    assert.equal(fs.existsSync(legacyJsPath), false, 'legacy skin-core-formulas.js must be removed in Stage 2');
});

test('corrupted or mismatched wasm file is rejected with a clear error', () => {
    const fakeBytes = Buffer.from('not a valid wasm file or altered bytes');
    assert.throws(
        () => wasmLoader.verifyWasmBytes(fakeBytes),
        error => error.message.includes('Wasm core integrity check failed') &&
                 error.message.includes(wasmLoader.PINNED_WASM_SHA256)
    );
});

test('bit-for-bit mathematical equivalence of parameters and layers across golden test matrix', () => {
    assert.ok(fs.existsSync(GOLDEN_CHECKSUMS_FILE), 'Golden checksums fixture must exist');
    const goldenData = JSON.parse(fs.readFileSync(GOLDEN_CHECKSUMS_FILE, 'utf8'));

    const wasmInstance = wasmLoader.createWasmInstance();

    for (const [caseId, caseRecord] of Object.entries(goldenData)) {
        const c = caseRecord.config;
        const commonParams = { mode: c.mode, seed: c.seed, azimuthDeg: c.azimuthDeg, elevationDeg: c.elevationDeg };

        // 1. Parameter resolution equivalence via wasm
        const wasmP1 = wasmLoader.resolveFormulaParams('formula_1', c.doc, c.rect, c.pxPerMm, commonParams);
        const wasmP2 = wasmLoader.resolveFormulaParams('formula_2', c.doc, c.rect, c.pxPerMm, commonParams);
        assert.ok(wasmP1 && wasmP2, `Parameters must resolve successfully for ${caseId}`);

        // 2. Wasm layer computation
        const wasmRes = wasmLoader.executeWasm({
            width: c.rect.width,
            height: c.rect.height,
            document: c.doc,
            rect: c.rect,
            pxPerMm: c.pxPerMm,
            seed: c.seed,
            lighting: { azimuthDeg: c.azimuthDeg, elevationDeg: c.elevationDeg },
            zone: 'cheek',
            params: commonParams,
            presets: ['candidate1', 'candidate2'],
            outputs: ['pores', 'furrows']
        }, wasmInstance);

        const layers = {
            formula_1_pores: wasmRes.layers.formula_1_pores,
            formula_1_furrows: wasmRes.layers.formula_1_furrows,
            formula_2_pores: wasmRes.layers.formula_2_pores,
            formula_2_furrows: wasmRes.layers.formula_2_furrows
        };

        // 3. Verification against recorded golden checksums
        for (const [compKey, grayData] of Object.entries(layers)) {
            const currentChecksums = SkinExchange.checksums(grayData);
            const expectedChecksums = caseRecord.checksums[compKey];
            assert.deepEqual(
                currentChecksums,
                expectedChecksums,
                `Checksum mismatch for ${compKey} in ${caseId}`
            );
        }
    }
});
