'use strict';

/**
 * Active worker computation, exchange format, and adapter request checks for the
 * standard skin texture recipe (task07).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const SkinExchange = require('../skin-texture/exchange.js');
const adapter = require('../skin-texture/core-adapter');
const recipeCatalog = require('../skin-texture/recipe-catalog');
const { WORKER_FILE } = require('../skin-texture/job-manager');

// These tests need formulas.wasm, which is not kept in git. Without it they are skipped
// (a CommonJS module may return early; the tests below are then never registered).
const missingWasmCore = require('../skin-texture/wasm-loader.js').checkWasmCore();
if (missingWasmCore) {
    test('skin texture tests need formulas.wasm', { skip: missingWasmCore }, () => {});
    return;
}

const META = { jobId: 'skt-0123456789ab', taskId: 'task-abc123', core: { version: 'task04-1' } };

/**
 * Run the real worker once for a recipe request.
 *
 * @param {object} formulaParams - Resolved formula parameters { formula_1, formula_2, common }.
 * @param {string[]} outputs - Output keys.
 * @param {object} rect - Document rectangle.
 * @param {string} [recipe] - Recipe name.
 * @returns {Promise<object>} The result message.
 */
function runRecipeWorker(formulaParams, outputs, rect, recipe = 'skin_pair_v1') {
    const doc = formulaParams && formulaParams.formula_1
        ? { id: 1, width: formulaParams.formula_1.width, height: formulaParams.formula_1.height }
        : { id: 1, width: 400, height: 400 };
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_FILE, {
            workerData: {
                recipe,
                formulaParams,
                params: formulaParams,
                outputs,
                meta: { ...META, document: doc, rect }
            }
        });
        worker.on('message', message => {
            if (message.type === 'result') resolve(message);
            if (message.type === 'error') reject(new Error(message.message));
        });
        worker.on('error', reject);
    });
}

/**
 * @param {object} message - Worker result.
 * @param {string} output - Output name.
 * @param {object} rect - Expected rect.
 * @returns {Uint8Array} The decoded gray layer.
 */
function grayFrom(message, output, rect) {
    return SkinExchange.decode(message.files[output], { jobId: META.jobId, output, rect }).payload;
}

test('runtime has no legacy core and the adapter reports the wasm core identity', () => {
    // 1. Runtime skin-texture directory must NOT contain skin-core.js
    const runtimeCorePath = path.join(__dirname, '..', 'skin-texture', 'skin-core.js');
    assert.equal(fs.existsSync(runtimeCorePath), false, 'Runtime skin-core.js must be removed');

    // 2. Adapter reports new formula core identity (.wasm)
    const identity = adapter.getCoreIdentity();
    assert.equal(identity.version, '1.1.0');
    assert.equal(identity.matchesPinned, true);
});

test('real worker computes all 4 outputs for default recipe and matches explicit recipe on small ROI', async () => {
    const rect = { x: 20, y: 20, width: 32, height: 32 };
    const doc = { width: 300, height: 300 };
    const pxPerMm = 4.49;
    const params = { mode: 'lines', seed: 1, azimuthDeg: 315, elevationDeg: 45 };

    const reqDefault = adapter.checkRequestShape({ rect, px_per_mm: pxPerMm, params });
    const reqExplicit = adapter.checkRequestShape({ recipe: 'skin_pair_v1', rect, px_per_mm: pxPerMm, params });

    assert.equal(reqDefault.recipe, 'skin_pair_v1');
    assert.equal(reqDefault.key, reqExplicit.key);

    const normDefault = adapter.normalizeForDocument(reqDefault, doc);
    const normExplicit = adapter.normalizeForDocument(reqExplicit, doc);

    const resultDefault = await runRecipeWorker(normDefault.coreParams, reqDefault.outputs, rect);
    const resultExplicit = await runRecipeWorker(normExplicit.coreParams, reqExplicit.outputs, rect);

    assert.equal(resultDefault.recipe, 'skin_pair_v1');
    assert.deepEqual(Object.keys(resultDefault.files).sort(), [
        'formula_1_furrows', 'formula_1_pores', 'formula_2_furrows', 'formula_2_pores'
    ].sort());

    for (const key of reqDefault.outputs) {
        const grayDef = grayFrom(resultDefault, key, rect);
        const grayExp = grayFrom(resultExplicit, key, rect);
        assert.deepEqual(Buffer.from(grayDef), Buffer.from(grayExp), `Component ${key} matches between default and explicit`);
        assert.equal(grayDef.length, rect.width * rect.height);
        assert.deepEqual(resultDefault.checksums[key], resultExplicit.checksums[key]);
    }
});

test('a rect gives exactly the same pixels as that area of the whole document (seamless tiling)', async () => {
    // Both formulas and both modes (lines, cells) must guarantee seamless tiling:
    // rendering an ROI produces the identical pixel slice of the whole document rendering.
    const doc = { width: 170, height: 130 };
    const rect = { x: 41, y: 33, width: 57, height: 46 };
    const pxPerMm = 6;
    const seed = 2;

    for (const mode of ['lines', 'cells']) {
        const wholeParams = {
            formula_1: recipeCatalog.resolveFormulaParams('formula_1', doc, { x: 0, y: 0, width: doc.width, height: doc.height }, pxPerMm, { mode, seed }),
            formula_2: recipeCatalog.resolveFormulaParams('formula_2', doc, { x: 0, y: 0, width: doc.width, height: doc.height }, pxPerMm, { mode, seed })
        };
        const partParams = {
            formula_1: recipeCatalog.resolveFormulaParams('formula_1', doc, rect, pxPerMm, { mode, seed }),
            formula_2: recipeCatalog.resolveFormulaParams('formula_2', doc, rect, pxPerMm, { mode, seed })
        };

        const outputs = ['formula_1_pores', 'formula_1_furrows', 'formula_2_pores', 'formula_2_furrows'];
        const [wholeResult, partResult] = await Promise.all([
            runRecipeWorker(wholeParams, outputs, { x: 0, y: 0, width: doc.width, height: doc.height }),
            runRecipeWorker(partParams, outputs, rect)
        ]);

        for (const output of outputs) {
            const wholeGray = grayFrom(wholeResult, output, { x: 0, y: 0, width: doc.width, height: doc.height });
            const partGray = grayFrom(partResult, output, rect);
            for (let y = 0; y < rect.height; y++) {
                const wholeRow = wholeGray.subarray((rect.y + y) * doc.width + rect.x, (rect.y + y) * doc.width + rect.x + rect.width);
                const partRow = partGray.subarray(y * rect.width, (y + 1) * rect.width);
                assert.deepEqual(Buffer.from(partRow), Buffer.from(wholeRow), `mode ${mode}, output ${output}, row ${y}`);
            }
        }
    }
});

test('worker rejects invalid workerData and does not fall back to task01', async () => {
    await assert.rejects(
        () => new Promise((resolve, reject) => {
            const worker = new Worker(WORKER_FILE, {
                workerData: {
                    recipe: 'unsupported_recipe',
                    params: {},
                    outputs: ['main'],
                    meta: META
                }
            });
            worker.on('message', m => {
                if (m.type === 'error') reject(new Error(m.message));
                else resolve(m);
            });
            worker.on('error', reject);
        }),
        /Worker only supports recipe "skin_pair_v1"/
    );
});

test('the exchange file round-trips and refuses every kind of damage', () => {
    const rect = { x: 3, y: 4, width: 20, height: 10 };
    const gray = new Uint8Array(200).map((_, i) => (i * 37) & 255);
    const meta = { jobId: 'skt-0123456789ab', taskId: 'task-1', output: 'formula_2_pores', document: { id: 5, width: 50, height: 40 }, rect };
    const bytes = SkinExchange.encode(meta, gray);
    const expect = { jobId: meta.jobId, taskId: 'task-1', output: 'formula_2_pores', documentId: 5, document: { width: 50, height: 40 }, rect };
    assert.deepEqual(Buffer.from(SkinExchange.decode(bytes, expect).payload), Buffer.from(gray));

    const cases = {
        EXCHANGE_TRUNCATED: bytes.slice(0, bytes.length - 1),
        EXCHANGE_EXTRA_BYTES: (() => { const b = new Uint8Array(bytes.length + 1); b.set(bytes); return b; })(),
        EXCHANGE_BAD_MAGIC: (() => { const b = bytes.slice(); b[0] = 0x41; return b; })(),
        EXCHANGE_PAYLOAD_CRC: (() => { const b = bytes.slice(); b[b.length - 20] ^= 1; return b; })(),
        EXCHANGE_NO_TRAILER: (() => { const b = bytes.slice(); b[b.length - 16] = 0x41; return b; })()
    };
    for (const [code, damaged] of Object.entries(cases)) {
        assert.throws(() => SkinExchange.decode(damaged, expect), new RegExp(`^Error: ${code}`), code);
    }
    const headerChanged = bytes.slice();
    headerChanged[20] = headerChanged[20] === 0x31 ? 0x32 : 0x31;
    assert.throws(() => SkinExchange.decode(headerChanged, expect), /EXCHANGE_(HEADER_CRC|BAD_HEADER|LENGTH|HEADER_FIELD|WRONG|PAYLOAD)/);

    for (const [key, value, code] of [
        ['jobId', 'skt-ffffffffffff', 'EXCHANGE_WRONG_JOB'],
        ['taskId', 'task-2', 'EXCHANGE_WRONG_JOB'],
        ['output', 'formula_1_pores', 'EXCHANGE_WRONG_JOB'],
        ['documentId', 6, 'EXCHANGE_WRONG_DOCUMENT'],
        ['document', { width: 51, height: 40 }, 'EXCHANGE_WRONG_DOCUMENT'],
        ['rect', { ...rect, x: 4 }, 'EXCHANGE_WRONG_RECT']
    ]) {
        assert.throws(() => SkinExchange.decode(bytes, { ...expect, [key]: value }), new RegExp(code), key);
    }
    const source = fs.readFileSync(path.join(__dirname, '..', 'skin-texture', 'exchange.js'), 'utf8');
    assert.ok([...source].every(char => char.charCodeAt(0) < 128));
});

test('gray maps to RGBA 8 and to the verified 16-bit range for every value', () => {
    const gray = new Uint8Array(256).map((_, i) => i);
    const rgba8 = SkinExchange.grayToRgba8(gray);
    const rgba16 = SkinExchange.grayToRgba16(gray);
    for (let v = 0; v < 256; v++) {
        assert.deepEqual(Array.from(rgba8.subarray(v * 4, v * 4 + 4)), [v, v, v, 255]);
        const w = Math.round(v * 32768 / 255);
        assert.deepEqual(Array.from(rgba16.subarray(v * 4, v * 4 + 4)), [w, w, w, 32768]);
        assert.equal(SkinExchange.from16(w), v);
    }
    assert.equal(SkinExchange.to16(128), 16448, 'the value task02 read back from 16-bit documents');
});

test('requests are checked and normalized: default recipe skin_pair_v1, outputs and old params refused', () => {
    const good = { rect: { x: 0, y: 0, width: 100, height: 80 }, px_per_mm: 5 };
    const checked = adapter.checkRequestShape(good);
    assert.equal(checked.recipe, 'skin_pair_v1');
    assert.equal(checked.outputs.length, 4);

    const refused = [
        [{ ...good, rect: undefined }, 'INVALID_RECT'],
        [{ ...good, rect: { x: 0, y: 0, width: 10.5, height: 10 } }, 'INVALID_RECT'],
        [{ ...good, rect: { x: -1, y: 0, width: 10, height: 10 } }, 'INVALID_RECT'],
        [{ ...good, rect: { x: 0, y: 0, width: 10, height: 10, z: 1 } }, 'INVALID_RECT'],
        [{ ...good, rect: { x: 0, y: 0, width: 5000, height: 4000 } }, 'RECT_TOO_LARGE'],
        [{ ...good, px_per_mm: undefined }, 'INVALID_SCALE'],
        [{ ...good, px_per_mm: 0 }, 'INVALID_SCALE'],
        [{ ...good, px_per_mm: Infinity }, 'INVALID_SCALE'],
        [{ ...good, px_per_mm: Number.NaN }, 'INVALID_SCALE'],
        [{ ...good, recipe: 'skin_task01' }, 'INVALID_RECIPE'],
        [{ ...good, outputs: ['main'] }, 'INVALID_OUTPUTS'],
        [{ ...good, outputs: [] }, 'INVALID_OUTPUTS'],
        [{ ...good, params: { relief: 2.5 } }, 'INVALID_PARAMS'],
        [{ ...good, params: { pores: true } }, 'INVALID_PARAMS'],
        [{ ...good, params: { furrows: false } }, 'INVALID_PARAMS'],
        [{ ...good, params: { width: 4000 } }, 'INVALID_PARAMS'],
        [{ ...good, params: { rect: { x: 0 } } }, 'INVALID_PARAMS'],
        [{ ...good, params: { pxPerMm: 9 } }, 'INVALID_PARAMS'],
        [{ ...good, params: { elevationDeg: Infinity } }, 'INVALID_PARAMS'],
        [{ ...good, params: { elevationDeg: '45' } }, 'INVALID_PARAMS'],
        [{ ...good, params: { elevationDeg: 2 } }, 'INVALID_PARAMS'],
        [{ ...good, params: { mode: 'hexagons' } }, 'INVALID_PARAMS'],
        [{ ...good, params: { seed: 1.5 } }, 'INVALID_PARAMS'],
        [{ ...good, params: [] }, 'INVALID_PARAMS']
    ];
    for (const [args, code] of refused) {
        assert.throws(() => adapter.checkRequestShape(args), error => error.code === code, JSON.stringify(args));
    }
});

test('the document size is checked once Photoshop has reported it', () => {
    const request = adapter.checkRequestShape({ rect: { x: 50, y: 50, width: 100, height: 100 }, px_per_mm: 6 });
    assert.throws(() => adapter.normalizeForDocument(request, { width: 120, height: 400 }), error => error.code === 'RECT_OUTSIDE_DOCUMENT');
    const ok = adapter.normalizeForDocument(request, { width: 400, height: 400 });
    assert.equal(ok.coreParams.formula_1.width, 400);
    assert.equal(ok.coreParams.formula_2.width, 400);
    assert.deepEqual(ok.coreParams.formula_1.rect, request.rect);

    // At an extreme scale the neutralising blur needs a margin the core would refuse.
    const huge = adapter.checkRequestShape({ rect: { x: 0, y: 0, width: 4096, height: 4096 }, px_per_mm: 1000 });
    assert.throws(() => adapter.normalizeForDocument(huge, { width: 8000, height: 8000 }), error => error.code === 'WORK_AREA_TOO_LARGE');
});

test('the visibility notes say what a small scale suppressed', () => {
    const p = recipeCatalog.resolveFormulaParams('formula_1', { width: 120, height: 120 }, { x: 0, y: 0, width: 120, height: 120 }, 2.5, {});
    const stats = {
        suppressed: { primary: 0, secondary: 0, roughness: [0, 0, 0] },
        pores: { counts: [10, 20], visible: [5, 10] },
        layers: { pores: { min: 120, max: 136 }, furrows: { min: 127, max: 129 } }
    };
    const notes = adapter.visibilityNotes(p, stats, ['pores', 'furrows']);
    assert.ok(notes.some(line => /primary furrows.*not drawn/.test(line)), notes.join('\n'));
    assert.ok(notes.some(line => /px_per_mm/.test(line)));
});
