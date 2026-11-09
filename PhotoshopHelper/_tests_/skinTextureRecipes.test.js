'use strict';

/**
 * Tests for skin texture recipes and fixed formulas (task06).
 *
 * Verifies:
 * 1. Cryptographic integrity of formulas.wasm against PINNED_WASM_SHA256 and absence of legacy JS core.
 * 2. Bit-for-bit mathematical equivalence of Formula 1 (candidate1) and Formula 2 (candidate2)
 *    between formulas.wasm and the task04 benchmark on lines and cells.
 * 3. Validation of recipe contract: recipe parameter, rejection of conflicting outputs,
 *    and rejection of unapproved geometry parameters.
 * 4. Request identity: request_id reflects recipe and parameters.
 * 5. Sequential calculation in worker and status reporting of both formulas without pixel bloat.
 * 6. Ready structure delivery into Photoshop via apply:
 *    - Main group 'Skin' (Pass Through, Opacity 100%, single user mask).
 *    - Subfolder 'Formula 2' (Pass Through, Opacity 100%, visible).
 *    - Subfolder 'Formula 1' (Pass Through, Opacity 100%, hidden).
 *    - Layers 'Pores' and 'Microrelief' (Linear Light, Opacity 50%, Fill 100%).
 * 7. Mask source handling:
 *    - Active selection ({ kind: "selection" }).
 *    - Layer mask ({ kind: "layer_mask", layer_id: <id> }).
 *    - Pre-creation checks: refusal before creating any layers if mask source is missing/invalid.
 * 8. Idempotency: repeated apply returns previous outcome without creating duplicate objects.
 * 9. Rollback: failure during assembly rolls back only newly created objects.
 * 10. Backward compatibility: calls without recipe work unchanged with the original core.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../skin-texture/core-adapter');
const recipeCatalog = require('../skin-texture/recipe-catalog');
const wasmLoader = require('../skin-texture/wasm-loader.js');
const { makeHarness } = require('./skinTextureFakes');

// These tests need formulas.wasm, which is not kept in git. Without it they are skipped
// (a CommonJS module may return early; the tests below are then never registered).
const missingWasmCore = wasmLoader.checkWasmCore();
if (missingWasmCore) {
    test('skin texture tests need formulas.wasm', { skip: missingWasmCore }, () => {});
    return;
}

const TASK04_BENCHMARK_FILE = path.resolve(__dirname, '../../../PhotoshopDaDHelperPreRelease/docs/points_to_future development/skin_texture/sandbox/task04/skin-core-task04.js');

test('formulas core is present and matches pinned wasm identity', () => {
    const identity = recipeCatalog.getFormulasCoreIdentity();
    assert.equal(identity.name, 'formulas_rust_v1');
    assert.equal(identity.sha256, recipeCatalog.PINNED_WASM_SHA256);
    assert.equal(identity.version, '1.1.0');
    assert.equal(identity.matchesPinned, true);
    assert.equal(fs.existsSync(recipeCatalog.WASM_CORE_FILE), true);
    assert.equal(fs.existsSync(path.join(__dirname, '../skin-texture/skin-core-formulas.js')), false, 'legacy JS core must not exist');
});

test('bit-for-bit mathematical equality with task04 benchmark on lines and cells', t => {
    if (!fs.existsSync(TASK04_BENCHMARK_FILE)) {
        t.skip('Task04 benchmark file not present in environment');
        return;
    }
    const benchmarkCore = require(TASK04_BENCHMARK_FILE);
    const wasmInstance = wasmLoader.createWasmInstance();

    const cases = [
        { width: 300, height: 300, rect: { x: 50, y: 50, width: 64, height: 64 }, pxPerMm: 4.49, mode: 'lines', seed: 1 },
        { width: 300, height: 300, rect: { x: 20, y: 20, width: 64, height: 64 }, pxPerMm: 6.0, mode: 'cells', seed: 42 }
    ];

    for (const testCase of cases) {
        const azimuth = testCase.azimuthDeg !== undefined ? testCase.azimuthDeg : 225;
        const elevation = testCase.elevationDeg !== undefined ? testCase.elevationDeg : 45;

        // Formula 1 (candidate1)
        const benchF1Params = benchmarkCore.presetParams('candidate1', testCase);
        const benchF1 = benchmarkCore.render(benchF1Params);
        const wasmRes1 = wasmLoader.executeWasm({
            width: testCase.rect.width,
            height: testCase.rect.height,
            document: { width: testCase.width, height: testCase.height },
            rect: testCase.rect,
            pxPerMm: testCase.pxPerMm,
            seed: testCase.seed,
            lighting: { azimuthDeg: azimuth, elevationDeg: elevation },
            zone: 'cheek',
            params: { mode: testCase.mode, seed: testCase.seed, azimuthDeg: azimuth, elevationDeg: elevation },
            presets: ['candidate1'],
            outputs: ['pores', 'furrows']
        }, wasmInstance);

        assert.deepEqual(wasmRes1.layers.formula_1_pores, benchF1.layers.pores, 'Formula 1 pores mismatch');
        assert.deepEqual(wasmRes1.layers.formula_1_furrows, benchF1.layers.furrows, 'Formula 1 furrows mismatch');

        // Formula 2 (candidate2)
        const benchF2Params = benchmarkCore.presetParams('candidate2', testCase);
        const benchF2 = benchmarkCore.render(benchF2Params);
        const wasmRes2 = wasmLoader.executeWasm({
            width: testCase.rect.width,
            height: testCase.rect.height,
            document: { width: testCase.width, height: testCase.height },
            rect: testCase.rect,
            pxPerMm: testCase.pxPerMm,
            seed: testCase.seed,
            lighting: { azimuthDeg: azimuth, elevationDeg: elevation },
            zone: 'cheek',
            params: { mode: testCase.mode, seed: testCase.seed, azimuthDeg: azimuth, elevationDeg: elevation },
            presets: ['candidate2'],
            outputs: ['pores', 'furrows']
        }, wasmInstance);

        assert.deepEqual(wasmRes2.layers.formula_2_pores, benchF2.layers.pores, 'Formula 2 pores mismatch');
        assert.deepEqual(wasmRes2.layers.formula_2_furrows, benchF2.layers.furrows, 'Formula 2 furrows mismatch');
    }
});

test('recipe skin_pair_v1 rejects conflicting outputs and unauthorized parameters', () => {
    // Conflicting outputs rejected
    assert.throws(
        () => adapter.checkRequestShape({
            recipe: 'skin_pair_v1',
            request_id: 'req-1',
            rect: { x: 0, y: 0, width: 100, height: 100 },
            px_per_mm: 5,
            outputs: ['main']
        }),
        error => error.code === 'INVALID_OUTPUTS'
    );

    // Unknown parameter rejected
    assert.throws(
        () => adapter.checkRequestShape({
            recipe: 'skin_pair_v1',
            request_id: 'req-1',
            rect: { x: 0, y: 0, width: 100, height: 100 },
            px_per_mm: 5,
            params: { relief: 2.5 }
        }),
        error => error.code === 'INVALID_PARAMS'
    );

    // Unsupported recipe rejected
    assert.throws(
        () => adapter.checkRequestShape({
            recipe: 'unknown_recipe',
            request_id: 'req-1',
            rect: { x: 0, y: 0, width: 100, height: 100 },
            px_per_mm: 5
        }),
        error => error.code === 'INVALID_RECIPE'
    );

    // Valid parameters accepted
    const valid = adapter.checkRequestShape({
        recipe: 'skin_pair_v1',
        request_id: 'req-1',
        rect: { x: 0, y: 0, width: 100, height: 100 },
        px_per_mm: 5,
        params: { mode: 'lines', seed: 7, azimuthDeg: 315, elevationDeg: 45 }
    });
    assert.equal(valid.recipe, 'skin_pair_v1');
    assert.equal(valid.outputs.length, 4);
    assert.ok(valid.key.includes('skin_pair_v1'));
});

test('recipe skin_pair_v1 end-to-end with selection mask source', async t => {
    const harness = makeHarness(t, {
        document: {
            width: 800,
            height: 800,
            hasSelection: true,
            selection: { x: 100, y: 100, width: 120, height: 120 }
        }
    });

    const taskId = await harness.startTask();

    // Start recipe job
    const startAns = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'recipe-test-1',
        recipe: 'skin_pair_v1',
        rect: { x: 100, y: 100, width: 120, height: 120 },
        px_per_mm: 4.49,
        params: { mode: 'lines', seed: 1, azimuthDeg: 315, elevationDeg: 45 }
    });
    assert.equal(startAns.isError, false, startAns.text);
    const jobId = startAns.json.job_id;
    assert.equal(startAns.json.recipe_id, 'skin_pair_v1');
    assert.ok(startAns.json.formulas.formula_1);
    assert.ok(startAns.json.formulas.formula_2);

    // Wait for ready
    const readyStatus = await harness.waitForPhase(taskId, jobId, 'ready');
    assert.equal(readyStatus.phase, 'ready');
    assert.equal(readyStatus.recipe_id, 'skin_pair_v1');
    assert.ok(readyStatus.result.checksums.formula_1_pores);
    assert.ok(readyStatus.result.checksums.formula_1_furrows);
    assert.ok(readyStatus.result.checksums.formula_2_pores);
    assert.ok(readyStatus.result.checksums.formula_2_furrows);

    // Verify before apply that no layers were added to the document
    assert.equal(harness.fake.doc.layers.length, 1); // Background only

    // Apply with selection mask source
    const applyAns = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'selection' }
    });
    assert.equal(applyAns.isError, false, applyAns.text);
    assert.equal(applyAns.json.phase, 'applied');
    assert.equal(applyAns.json.apply.state, 'applied');

    const structure = applyAns.json.apply.structure;
    assert.ok(structure, 'Expected structure in apply result');
    assert.equal(structure.mainGroup.hasUserMask, true);
    assert.equal(structure.subgroups.length, 2);

    const f2Group = structure.subgroups.find(g => g.name === 'Formula 2');
    const f1Group = structure.subgroups.find(g => g.name === 'Formula 1');
    assert.ok(f2Group);
    assert.ok(f1Group);
    assert.equal(f2Group.visible, true);
    assert.equal(f1Group.visible, false);

    // Verify DOM stacking hierarchy and order:
    // Main Skin group must have Formula 2 on top (index 0) and Formula 1 below (index 1)
    const docSkinGroup = harness.fake.findLayerById(structure.mainGroup.id);
    assert.ok(docSkinGroup, 'Skin group must exist in document');
    assert.equal(docSkinGroup.layers[0].name, 'Formula 2');
    assert.equal(docSkinGroup.layers[1].name, 'Formula 1');

    // Within each formula, Pores must be on top (index 0) and Microrelief below (index 1)
    const docF2Group = harness.fake.findLayerById(f2Group.id);
    assert.equal(docF2Group.layers[0].name, 'Pores');
    assert.equal(docF2Group.layers[1].name, 'Microrelief');

    const docF1Group = harness.fake.findLayerById(f1Group.id);
    assert.equal(docF1Group.layers[0].name, 'Pores');
    assert.equal(docF1Group.layers[1].name, 'Microrelief');

    assert.equal(applyAns.json.apply.layers.length, 4);
    for (const layer of applyAns.json.apply.layers) {
        const docLayer = harness.fake.findLayerById(layer.id);
        assert.ok(docLayer, `Layer ${layer.id} must exist in document`);
        assert.equal(docLayer.blendMode, 'linearLight');
        assert.equal(docLayer.opacity, 50);
        assert.equal(docLayer.fillOpacity, 100);
        assert.deepEqual(layer.bounds, { left: 100, top: 100, right: 220, bottom: 220 });
    }

    // Repeated apply without mask_source returns existing outcome without error or duplicate layers
    const layerCountBeforeRepeat = harness.fake.doc.layers.length;
    const repeatAnsNoMask = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId
    });
    assert.equal(repeatAnsNoMask.isError, false, repeatAnsNoMask.text);
    assert.equal(repeatAnsNoMask.json.phase, 'applied');
    assert.equal(repeatAnsNoMask.json.apply.state, 'applied');
    assert.equal(harness.fake.doc.layers.length, layerCountBeforeRepeat);

    // Repeated apply with mask_source also returns existing outcome without duplicate layers
    const repeatAns = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'selection' }
    });
    assert.equal(repeatAns.isError, false);
    assert.equal(repeatAns.json.phase, 'applied');
    assert.equal(harness.fake.doc.layers.length, layerCountBeforeRepeat);
});

test('recipe skin_pair_v1 end-to-end with layer_mask source', async t => {
    const harness = makeHarness(t, {
        document: {
            width: 600,
            height: 600
        }
    });

    // Create a source layer with a user mask
    const sourceLayer = await harness.fake.doc.createPixelLayer({ name: 'Face Mask Layer' });
    await harness.fake.app.documents[0].createPixelLayer; // ensure ready
    sourceLayer.hasUserMask = true;
    sourceLayer.mask = {
        width: 100,
        height: 100,
        bounds: { left: 50, top: 50, right: 150, bottom: 150 },
        data: new Uint8Array(100 * 100).fill(200)
    };

    const taskId = await harness.startTask();

    const startAns = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'recipe-test-layer-mask',
        recipe: 'skin_pair_v1',
        rect: { x: 50, y: 50, width: 100, height: 100 },
        px_per_mm: 4.0
    });
    assert.equal(startAns.isError, false, startAns.text);
    const jobId = startAns.json.job_id;

    await harness.waitForPhase(taskId, jobId, 'ready');

    const applyAns = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'layer_mask', layer_id: sourceLayer.id }
    });
    assert.equal(applyAns.isError, false, applyAns.text);
    assert.equal(applyAns.json.phase, 'applied');

    const structure = applyAns.json.apply.structure;
    assert.equal(structure.mainGroup.hasUserMask, true);
    assert.equal(structure.mainGroup.mask.source.kind, 'layer_mask');
    assert.equal(structure.mainGroup.mask.source.layer_id, sourceLayer.id);
});

test('recipe skin_pair_v1 enforces mask_source requirements and pre-creation refusals', async t => {
    const harness = makeHarness(t, {
        document: {
            width: 500,
            height: 500,
            hasSelection: false
        }
    });

    const taskId = await harness.startTask();

    const startAns = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'recipe-mask-checks',
        recipe: 'skin_pair_v1',
        rect: { x: 50, y: 50, width: 80, height: 80 },
        px_per_mm: 4.0
    });
    const jobId = startAns.json.job_id;
    await harness.waitForPhase(taskId, jobId, 'ready');

    // Missing mask_source throws MASK_SOURCE_REQUIRED
    const noMaskSrc = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId
    });
    assert.equal(noMaskSrc.isError, true);
    assert.equal(noMaskSrc.json.error.code, 'MASK_SOURCE_REQUIRED');

    // Missing selection in document refuses with NO_SELECTION before creating any layers
    const selRefusal = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'selection' }
    });
    assert.equal(selRefusal.isError, true);
    assert.equal(selRefusal.json.apply.code, 'NO_SELECTION');
    assert.equal(selRefusal.json.apply.retryable, true);
    assert.equal(selRefusal.json.phase, 'ready'); // Job stays in ready phase
    assert.equal(harness.fake.doc.layers.length, 1); // Document remains untouched

    // Non-existent layer_mask ID refuses with LAYER_NOT_FOUND before creating any layers
    const layerRefusal = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'layer_mask', layer_id: 9999 }
    });
    assert.equal(layerRefusal.isError, true);
    assert.equal(layerRefusal.json.apply.code, 'LAYER_NOT_FOUND');
    assert.equal(layerRefusal.json.apply.retryable, true);
    assert.equal(layerRefusal.json.phase, 'ready'); // Job stays in ready phase
    assert.equal(harness.fake.doc.layers.length, 1);

    // After resolving the mask issue (e.g. selection is created), retrying apply on the same job succeeds
    harness.fake.doc.hasSelection = true;
    harness.fake.doc.selection = { x: 50, y: 50, width: 80, height: 80 };
    const retryApply = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'selection' }
    });
    assert.equal(retryApply.isError, false, retryApply.text);
    assert.equal(retryApply.json.phase, 'applied');
    assert.equal(retryApply.json.apply.state, 'applied');
});

test('default contract: calls without recipe run skin_pair_v1 by default and reject legacy outputs', async t => {
    const harness = makeHarness(t, {
        document: {
            width: 400,
            height: 400,
            hasSelection: true,
            selection: { x: 10, y: 10, width: 50, height: 50 }
        }
    });

    const taskId = await harness.startTask();

    // Passing legacy outputs is refused
    const refusedOutputs = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'legacy-outputs-refused',
        rect: { x: 10, y: 10, width: 50, height: 50 },
        px_per_mm: 5.0,
        outputs: ['main']
    });
    assert.equal(refusedOutputs.isError, true);
    assert.equal(refusedOutputs.json.error.code, 'INVALID_OUTPUTS');

    // Standard start with NO recipe defaults to skin_pair_v1
    const startAns = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'standard-default-1',
        rect: { x: 10, y: 10, width: 50, height: 50 },
        px_per_mm: 5.0
    });
    assert.equal(startAns.isError, false, startAns.text);
    assert.equal(startAns.json.recipe_id, 'skin_pair_v1');
    assert.equal(startAns.json.core.sha256, recipeCatalog.PINNED_WASM_SHA256);
    assert.ok(startAns.json.formulas.formula_1);
    assert.ok(startAns.json.formulas.formula_2);

    const jobId = startAns.json.job_id;
    await harness.waitForPhase(taskId, jobId, 'ready');

    // Applying without mask_source is refused
    const noMaskAns = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId
    });
    assert.equal(noMaskAns.isError, true);
    assert.equal(noMaskAns.json.error.code, 'MASK_SOURCE_REQUIRED');

    // Applying with mask_source writes standard Skin group
    const applyAns = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'selection' }
    });
    assert.equal(applyAns.isError, false, applyAns.text);
    assert.equal(applyAns.json.phase, 'applied');
    assert.equal(applyAns.json.apply.structure.mainGroup.name.startsWith('Skin'), true);
    assert.equal(applyAns.json.apply.layers.length, 4);

    // Idempotency: repeating start with identical arguments returns the same job
    const repeatAns = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'standard-default-1',
        rect: { x: 10, y: 10, width: 50, height: 50 },
        px_per_mm: 5.0
    });
    assert.equal(repeatAns.isError, false);
    assert.equal(repeatAns.json.job_id, jobId);
    assert.equal(repeatAns.json.repeated_request, true);

    // Repeating start with explicit recipe: 'skin_pair_v1' and same request_id also normalizes to same job
    const repeatExplicit = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'standard-default-1',
        recipe: 'skin_pair_v1',
        rect: { x: 10, y: 10, width: 50, height: 50 },
        px_per_mm: 5.0
    });
    assert.equal(repeatExplicit.isError, false);
    assert.equal(repeatExplicit.json.job_id, jobId);
    assert.equal(repeatExplicit.json.repeated_request, true);
});

test('R1: source layer mask properties (missing mask, disabled, non-100 density, non-zero feather) are refused via batchPlay before creating layers', async t => {
    const harness = makeHarness(t, { document: { width: 500, height: 500 } });
    const sourceLayer = await harness.fake.doc.createPixelLayer({ name: 'Source Mask' });
    sourceLayer.mask = { width: 80, height: 80, bounds: { left: 40, top: 40, right: 120, bottom: 120 }, data: new Uint8Array(6400).fill(255) };
    sourceLayer.layerMaskDensity = 100;
    sourceLayer.layerMaskFeather = 0;
    sourceLayer._userMaskEnabled = true;

    const taskId = await harness.startTask();
    const startAns = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'r1-mask-props-1',
        recipe: 'skin_pair_v1',
        rect: { x: 40, y: 40, width: 80, height: 80 },
        px_per_mm: 4.0
    });
    const jobId = startAns.json.job_id;
    await harness.waitForPhase(taskId, jobId, 'ready');

    // 1. Missing mask (layer has no mask) -> NO_LAYER_MASK
    const savedMask = sourceLayer.mask;
    sourceLayer.mask = null;
    const noMaskAns = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'layer_mask', layer_id: sourceLayer.id }
    });
    assert.equal(noMaskAns.isError, true);
    assert.equal(noMaskAns.json.apply.code, 'NO_LAYER_MASK');
    assert.equal(noMaskAns.json.apply.retryable, true);
    assert.equal(noMaskAns.json.phase, 'ready');
    assert.equal(harness.fake.doc.layers.length, 2);

    // 2. Disabled mask -> UNSUPPORTED_MASK_PROPERTIES
    sourceLayer.mask = savedMask;
    sourceLayer._userMaskEnabled = false;
    const disabledAns = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'layer_mask', layer_id: sourceLayer.id }
    });
    assert.equal(disabledAns.isError, true);
    assert.equal(disabledAns.json.apply.code, 'UNSUPPORTED_MASK_PROPERTIES');
    assert.equal(disabledAns.json.apply.retryable, true);
    assert.equal(disabledAns.json.phase, 'ready');
    assert.equal(harness.fake.doc.layers.length, 2);

    // 3. layerMaskDensity = 50 -> UNSUPPORTED_MASK_PROPERTIES
    sourceLayer._userMaskEnabled = true;
    sourceLayer.layerMaskDensity = 50;
    const densityAns = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'layer_mask', layer_id: sourceLayer.id }
    });
    assert.equal(densityAns.isError, true);
    assert.equal(densityAns.json.apply.code, 'UNSUPPORTED_MASK_PROPERTIES');
    assert.equal(densityAns.json.apply.retryable, true);
    assert.equal(densityAns.json.phase, 'ready');

    // 4. layerMaskFeather = 5 -> UNSUPPORTED_MASK_PROPERTIES
    sourceLayer.layerMaskDensity = 100;
    sourceLayer.layerMaskFeather = 5;
    const featherAns = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'layer_mask', layer_id: sourceLayer.id }
    });
    assert.equal(featherAns.isError, true);
    assert.equal(featherAns.json.apply.code, 'UNSUPPORTED_MASK_PROPERTIES');
    assert.equal(featherAns.json.apply.retryable, true);
    assert.equal(featherAns.json.phase, 'ready');

    // 5. Fixed to standard: apply succeeds on the same job
    sourceLayer.layerMaskFeather = 0;
    const okAns = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'layer_mask', layer_id: sourceLayer.id }
    });
    assert.equal(okAns.isError, false, okAns.text);
    assert.equal(okAns.json.phase, 'applied');
    assert.equal(okAns.json.apply.structure.mainGroup.hasUserMask, true);
});

test('R1: post-write mask verification failures trigger clean rollback without leaving layers', async t => {
    const harness = makeHarness(t, {
        document: {
            width: 400,
            height: 400,
            hasSelection: true,
            selection: { x: 20, y: 20, width: 50, height: 50 }
        }
    });

    const taskId = await harness.startTask();
    const layersBefore = harness.fake.doc.layers.length;

    // Subtest A: silent failure of putLayerMask
    const start1 = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'r1-post-verify-silent',
        recipe: 'skin_pair_v1',
        rect: { x: 20, y: 20, width: 50, height: 50 },
        px_per_mm: 4.0
    });
    await harness.waitForPhase(taskId, start1.json.job_id, 'ready');

    harness.fake.state.silentFailPutLayerMask = true;
    const ans1 = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: start1.json.job_id,
        mask_source: { kind: 'selection' }
    });
    harness.fake.state.silentFailPutLayerMask = false;
    assert.equal(ans1.isError, true);
    // The hidden (black) mask already exists, so a silent write leaves it black and the byte check catches it.
    assert.equal(ans1.json.apply.code, 'MASK_DATA_MISMATCH');
    assert.equal(harness.fake.doc.layers.length, layersBefore);

    // Subtest B: corrupted mask bounds
    const start2 = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'r1-post-verify-bounds',
        recipe: 'skin_pair_v1',
        rect: { x: 20, y: 20, width: 50, height: 50 },
        px_per_mm: 4.0
    });
    await harness.waitForPhase(taskId, start2.json.job_id, 'ready');

    harness.fake.state.corruptVerifiedMaskBounds = true;
    const ans2 = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: start2.json.job_id,
        mask_source: { kind: 'selection' }
    });
    harness.fake.state.corruptVerifiedMaskBounds = false;
    assert.equal(ans2.isError, true);
    assert.equal(ans2.json.apply.code, 'MASK_BOUNDS_MISMATCH');
    assert.equal(harness.fake.doc.layers.length, layersBefore);

    // Subtest C: empty mask data
    const start3 = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'r1-post-verify-empty',
        recipe: 'skin_pair_v1',
        rect: { x: 20, y: 20, width: 50, height: 50 },
        px_per_mm: 4.0
    });
    await harness.waitForPhase(taskId, start3.json.job_id, 'ready');

    harness.fake.state.corruptVerifiedMaskEmptyData = true;
    const ans3 = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: start3.json.job_id,
        mask_source: { kind: 'selection' }
    });
    harness.fake.state.corruptVerifiedMaskEmptyData = false;
    assert.equal(ans3.isError, true);
    assert.equal(ans3.json.apply.code, 'MASK_EMPTY_DATA');
    assert.equal(harness.fake.doc.layers.length, layersBefore);

    // Subtest D: mismatched mask pixel data
    const start4 = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'r1-post-verify-data-mismatch',
        recipe: 'skin_pair_v1',
        rect: { x: 20, y: 20, width: 50, height: 50 },
        px_per_mm: 4.0
    });
    await harness.waitForPhase(taskId, start4.json.job_id, 'ready');

    harness.fake.state.corruptVerifiedMaskData = true;
    const ans4 = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: start4.json.job_id,
        mask_source: { kind: 'selection' }
    });
    harness.fake.state.corruptVerifiedMaskData = false;
    assert.equal(ans4.isError, true);
    assert.equal(ans4.json.apply.code, 'MASK_DATA_MISMATCH');
    assert.equal(harness.fake.doc.layers.length, layersBefore);

    // Subtest E: unexpected mask on child subgroup
    const start5 = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'r1-post-verify-child-mask',
        recipe: 'skin_pair_v1',
        rect: { x: 20, y: 20, width: 50, height: 50 },
        px_per_mm: 4.0
    });
    await harness.waitForPhase(taskId, start5.json.job_id, 'ready');

    harness.fake.state.unexpectedChildMask = true;
    const ans5 = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: start5.json.job_id,
        mask_source: { kind: 'selection' }
    });
    harness.fake.state.unexpectedChildMask = false;
    assert.equal(ans5.isError, true);
    assert.equal(ans5.json.apply.code, 'CHILD_MASK_UNEXPECTED');
    assert.equal(harness.fake.doc.layers.length, layersBefore);
});

test('R2: individual component header mismatches and swapped components are rejected before layer creation', async t => {
    const X = require('../skin-texture/exchange');

    async function runWithTamperedHeader(tampers, expectedMsgPart) {
        const harness = makeHarness(t, {
            document: {
                width: 400,
                height: 400,
                hasSelection: true,
                selection: { x: 10, y: 10, width: 40, height: 40 }
            }
        });
        harness.fake.state.beforeScript = async payload => {
            if (!payload.code.includes('Skin texture: write recipe')) return;
            const name = harness.ownFiles().find(n => n.endsWith('-formula_2_pores.sktx'));
            const file = path.join(harness.dataFolder, name);
            const decoded = X.decode(new Uint8Array(fs.readFileSync(file)));
            fs.writeFileSync(file, X.encode({
                ...decoded.header,
                ...tampers
            }, decoded.payload));
        };
        const taskId = await harness.startTask();
        const startAns = await harness.call('ps_skin_texture_start', {
            task_id: taskId,
            request_id: 'r2-tamp-' + Math.random().toString(36).slice(2, 7),
            recipe: 'skin_pair_v1',
            rect: { x: 10, y: 10, width: 40, height: 40 },
            px_per_mm: 4.0
        });
        await harness.waitForPhase(taskId, startAns.json.job_id, 'ready');
        const layersBefore = harness.fake.doc.layers.length;
        const applyAns = await harness.call('ps_skin_texture_apply', {
            task_id: taskId,
            job_id: startAns.json.job_id,
            mask_source: { kind: 'selection' }
        });
        assert.equal(applyAns.isError, true);
        assert.equal(applyAns.json.apply.code, 'COMPONENT_HEADER_MISMATCH');
        assert.ok(applyAns.json.error.message.includes(expectedMsgPart), `Expected message to include "${expectedMsgPart}", got "${applyAns.json.error.message}"`);
        assert.equal(harness.fake.doc.layers.length, layersBefore);
    }

    // 1. recipe_id mismatch alone
    await runWithTamperedHeader({ recipe_id: 'wrong_recipe' }, 'recipe_id');

    // 2. formula_id mismatch alone
    await runWithTamperedHeader({ formula_id: 'formula_99' }, 'formula_id');

    // 3. formula_version mismatch alone
    await runWithTamperedHeader({ formula_version: 999 }, 'formula_version');

    // 4. core identity mismatch alone
    await runWithTamperedHeader({ core: { version: 'fake', sha256: '0'.repeat(64) } }, 'core identity mismatch');

    // 5. Actually swapped component files on disk
    {
        const harness = makeHarness(t, {
            document: {
                width: 400,
                height: 400,
                hasSelection: true,
                selection: { x: 10, y: 10, width: 40, height: 40 }
            }
        });
        harness.fake.state.beforeScript = async payload => {
            if (!payload.code.includes('Skin texture: write recipe')) return;
            const f1PoresName = harness.ownFiles().find(n => n.endsWith('-formula_1_pores.sktx'));
            const f2PoresName = harness.ownFiles().find(n => n.endsWith('-formula_2_pores.sktx'));
            const f1File = path.join(harness.dataFolder, f1PoresName);
            const f2File = path.join(harness.dataFolder, f2PoresName);
            const f1Bytes = fs.readFileSync(f1File);
            const f2Bytes = fs.readFileSync(f2File);
            // Actually swap component files on disk
            fs.writeFileSync(f1File, f2Bytes);
            fs.writeFileSync(f2File, f1Bytes);
        };
        const taskId = await harness.startTask();
        const startAns = await harness.call('ps_skin_texture_start', {
            task_id: taskId,
            request_id: 'r2-swap-1',
            recipe: 'skin_pair_v1',
            rect: { x: 10, y: 10, width: 40, height: 40 },
            px_per_mm: 4.0
        });
        await harness.waitForPhase(taskId, startAns.json.job_id, 'ready');
        const layersBefore = harness.fake.doc.layers.length;
        const applyAns = await harness.call('ps_skin_texture_apply', {
            task_id: taskId,
            job_id: startAns.json.job_id,
            mask_source: { kind: 'selection' }
        });
        assert.equal(applyAns.isError, true);
        assert.equal(applyAns.json.apply.code, 'EXCHANGE_WRONG_JOB');
        assert.equal(harness.fake.doc.layers.length, layersBefore);
    }
});

test('R3: next_step messages for ready and applied skin_pair_v1 include Undo and idempotency guidance', async t => {
    const harness = makeHarness(t, {
        document: {
            width: 400,
            height: 400,
            hasSelection: true,
            selection: { x: 10, y: 10, width: 40, height: 40 }
        }
    });

    const taskId = await harness.startTask();

    // 1. Ready phase next_step guidance specifies mask_source
    const rStart = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'r3-recipe-step',
        rect: { x: 10, y: 10, width: 40, height: 40 },
        px_per_mm: 4.0
    });
    const readyStatus = await harness.waitForPhase(taskId, rStart.json.job_id, 'ready');
    assert.ok(readyStatus.next_step.includes('mask_source'));
    assert.ok(readyStatus.next_step.includes('Skin group'));

    // 2. Applied phase next_step guidance describes ready assembly, History step and idempotency
    const rApply = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: rStart.json.job_id,
        mask_source: { kind: 'selection' }
    });
    assert.equal(rApply.json.phase, 'applied');
    const nextStep = rApply.json.next_step;
    assert.ok(nextStep.includes('Skin texture recipe applied'));
    assert.ok(nextStep.includes('Formula 2 (active) and Formula 1 (hidden)'));
    assert.ok(nextStep.includes('50% Linear Light component layers'));
    assert.ok(nextStep.includes('Written to the document as a single Photoshop History step; undo removes it completely'));
    assert.ok(nextStep.includes('Calling ps_skin_texture_apply again will not write a second time'));
    assert.ok(nextStep.includes('Adjust visibility, layer opacities, or mask as needed using the returned layer IDs'));
});

test('R4: skin_pair_v1 procedural computation via worker matches pinned checksums', async t => {
    const harness = makeHarness(t, {
        document: {
            width: 720,
            height: 1280
        }
    });

    const taskId = await harness.startTask();
    const startAns = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'r4-pinned-checksums',
        recipe: 'skin_pair_v1',
        rect: { x: 450, y: 565, width: 120, height: 120 },
        px_per_mm: 4.49
    });
    assert.equal(startAns.isError, false);
    const jobId = startAns.json.job_id;

    const readyJob = await harness.waitForPhase(taskId, jobId, 'ready');
    assert.equal(readyJob.phase, 'ready');

    const checksums = readyJob.result.checksums;
    assert.deepEqual(checksums.formula_1_pores, {
        length: 14400,
        crc32: '3de02e1d',
        fnv1a: 'eda30b9f'
    });
    assert.deepEqual(checksums.formula_1_furrows, {
        length: 14400,
        crc32: 'ab36d61d',
        fnv1a: 'ea5ccac5'
    });
    assert.deepEqual(checksums.formula_2_pores, {
        length: 14400,
        crc32: 'f51381a6',
        fnv1a: 'c5b8eda6'
    });
    assert.deepEqual(checksums.formula_2_furrows, {
        length: 14400,
        crc32: 'aa39c9c5',
        fnv1a: '87e7abc6'
    });
});

test('R4: unknown outcome keeps all 4 exchange files for grace period, then cleans them up', async t => {
    const harness = makeHarness(t, {
        limits: {
            applyStartDeadlineMs: 20,
            fileGraceMs: 50,
            sweepIntervalMs: 20
        },
        document: {
            width: 400,
            height: 400,
            hasSelection: true,
            selection: { x: 10, y: 10, width: 40, height: 40 }
        }
    });

    const taskId = await harness.startTask();
    const startAns = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'r4-unknown-outcome-1',
        recipe: 'skin_pair_v1',
        rect: { x: 10, y: 10, width: 40, height: 40 },
        px_per_mm: 4.0
    });
    const jobId = startAns.json.job_id;
    await harness.waitForPhase(taskId, jobId, 'ready');

    // Simulate transport failure during apply causing unknown outcome
    harness.fake.state.afterScript = () => {
        throw new Error('transport disconnected mid-flight');
    };

    const applyAns = await harness.call('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: jobId,
        mask_source: { kind: 'selection' }
    });
    assert.equal(applyAns.isError, true);
    assert.equal(applyAns.json.phase, 'apply_unknown');

    // 1. Immediately during grace period, all 4 component files exist on disk
    let files = harness.ownFiles().filter(f => f.includes(jobId));
    assert.equal(files.length, 4, 'All 4 component exchange files must be preserved during grace period');

    // 2. Wait past deadline + fileGraceMs
    await new Promise(r => setTimeout(r, 120));

    // Calling status triggers periodic sweep
    await harness.call('ps_skin_texture_status', { task_id: taskId, job_id: jobId });

    files = harness.ownFiles().filter(f => f.includes(jobId));
    assert.equal(files.length, 0, 'Exchange files must be cleaned up once grace period has elapsed');
});

test('R4: cancelling job while computing terminates worker cleanly and leaves no files', async t => {
    const harness = makeHarness(t, { document: { width: 500, height: 500 } });
    const taskId = await harness.startTask();
    const startAns = await harness.call('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'r4-cancel-clean-1',
        recipe: 'skin_pair_v1',
        rect: { x: 10, y: 10, width: 350, height: 350 },
        px_per_mm: 4.0
    });
    const jobId = startAns.json.job_id;

    // Cancel while computing
    const cancelAns = await harness.call('ps_skin_texture_cancel', { task_id: taskId, job_id: jobId });
    assert.equal(cancelAns.isError, false);

    const finalStatus = await harness.waitForPhase(taskId, jobId, 'cancelled');
    assert.equal(finalStatus.phase, 'cancelled');
    assert.equal(harness.ownFiles().filter(f => f.includes(jobId)).length, 0);
});

test('R4: finish task or AI line pause before sending apply script stops write with no document changes', async t => {
    const harness = makeHarness(t, {
        document: {
            width: 400,
            height: 400,
            hasSelection: true,
            selection: { x: 10, y: 10, width: 40, height: 40 }
        }
    });
    const { holdPublish } = require('./skinTextureFakes');

    // Case 1: finish task while write is still preparing
    {
        const hold = holdPublish({ when: 'after', holdCall: 1 });
        t.after(() => hold.restore());
        const taskId = await harness.startTask();
        const startAns = await harness.call('ps_skin_texture_start', {
            task_id: taskId,
            request_id: 'r4-stop-finish-1',
            recipe: 'skin_pair_v1',
            rect: { x: 10, y: 10, width: 40, height: 40 },
            px_per_mm: 4.0
        });
        const jobId = startAns.json.job_id;
        await harness.waitForPhase(taskId, jobId, 'ready');

        const layersBefore = harness.fake.doc.layers.length;
        const putPixelsBefore = harness.fake.state.putPixelsCalls || 0;

        const applyPromise = harness.call('ps_skin_texture_apply', {
            task_id: taskId,
            job_id: jobId,
            mask_source: { kind: 'selection' }
        });

        await hold.reached;
        await harness.tools.call('ps_finish_task', { task_id: taskId });
        hold.release();

        const applyAns = await applyPromise;
        assert.equal(applyAns.isError, true);
        assert.equal(harness.fake.doc.layers.length, layersBefore);
        assert.equal(harness.fake.state.putPixelsCalls || 0, putPixelsBefore);
        assert.equal(harness.ownFiles().filter(f => f.includes(jobId)).length, 0);
    }

    // Case 2: AI line pause (channel closed) while write is preparing
    {
        const hold = holdPublish({ when: 'after', holdCall: 1 });
        t.after(() => hold.restore());
        const taskId = await harness.startTask();
        const startAns = await harness.call('ps_skin_texture_start', {
            task_id: taskId,
            request_id: 'r4-stop-pause-1',
            recipe: 'skin_pair_v1',
            rect: { x: 10, y: 10, width: 40, height: 40 },
            px_per_mm: 4.0
        });
        const jobId = startAns.json.job_id;
        await harness.waitForPhase(taskId, jobId, 'ready');

        const layersBefore = harness.fake.doc.layers.length;

        const applyPromise = harness.call('ps_skin_texture_apply', {
            task_id: taskId,
            job_id: jobId,
            mask_source: { kind: 'selection' }
        });

        await hold.reached;
        harness.fake.state.connected = false;
        hold.release();

        const applyAns = await applyPromise;
        assert.equal(applyAns.isError, true);
        assert.equal(harness.fake.doc.layers.length, layersBefore);
        assert.equal(harness.ownFiles().filter(f => f.includes(jobId)).length, 0);
    }
});

test('R1: where the texture rect lies outside the selection, the Skin mask must be black there', async t => {
    for (const c of [
        { knob: null, code: null },
        { knob: 'skipMaskInit', code: 'MASK_OUTSIDE_NOT_HIDDEN' },
        { knob: 'failMaskInit', code: 'MASK_INIT_FAILED' }
    ]) {
        // The selection (30..50) is smaller than the texture rect (20..60).
        const harness = makeHarness(t, { document: { width: 200, height: 200, hasSelection: true, selection: { x: 30, y: 30, width: 20, height: 20 } } });
        if (c.knob) harness.fake.state[c.knob] = true;
        const taskId = await harness.startTask();
        const start = await harness.call('ps_skin_texture_start', {
            task_id: taskId, request_id: 'r1-outside-' + (c.knob || 'ok'), recipe: 'skin_pair_v1',
            rect: { x: 20, y: 20, width: 40, height: 40 }, px_per_mm: 4.0
        });
        await harness.waitForPhase(taskId, start.json.job_id, 'ready');
        const layersBefore = harness.fake.doc.layers.length;
        const ans = await harness.call('ps_skin_texture_apply', { task_id: taskId, job_id: start.json.job_id, mask_source: { kind: 'selection' } });
        if (!c.code) {
            assert.equal(ans.json.phase, 'applied', ans.text);
            continue;
        }
        assert.equal(ans.json.apply.code, c.code, ans.text);
        assert.equal(ans.json.apply.state, 'not_applied');
        assert.equal(harness.fake.doc.layers.length, layersBefore);
    }
});
