'use strict';

/** Product worker equivalence against independent SkinBench requests and pinned checksums. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loader = require('../skin-texture/wasm-loader');
const adapter = require('../skin-texture/core-adapter');
const exchange = require('../skin-texture/exchange');
const faceMap = require('../skin-texture/face-map');
const { FORMULA_DEFINITIONS } = require('../skin-texture/formula-definitions');
const { missingBinaryReason, runWorker } = require('./skinTextureTestSupport');
const { FORMULAS, CASES, independentRequest } = require('./skinTextureEquivalenceCases');
const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'skin-v2-checksums.json');
const BENCH_ROOT = process.env.SKINBENCH_ROOT || path.resolve(__dirname, '../../../SkinBench');
const RUNNER_FILE = path.join(BENCH_ROOT, 'variants', 'runner.js');

// Integrity tests run even in a fresh checkout, where the private files are absent.
for (const formula of FORMULAS) {
    test(`${formula.fileName}: altered bytes fail with filename and pinned digest`, () => {
        assert.throws(() => loader.verifyWasmBytes(Buffer.from('altered private build'), formula.id), error =>
            error.message.includes(formula.fileName) && error.message.includes(FORMULA_DEFINITIONS[formula.id].sha256));
    });
}

test('private formulas stay outside Git and the installer', () => {
    const root = path.resolve(__dirname, '../..');
    const tracked = execFileSync('git', ['ls-files', '*.wasm'], { cwd: root, encoding: 'utf8' });
    assert.equal(tracked.trim(), '', 'no private binary is tracked');
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\*\.wasm\s*$/m);
    assert.ok(require('../package.json').build.files.includes('!skin-texture/*.wasm'));
});

test('pinned face fixtures exercise changed bytes across both formulas', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
    // This runs without binaries or SkinBench and prevents replacing the matrix with
    // neutral or duplicate samples that would no longer detect face-routing regressions.
    for (const scale of [1.6, 2.7, 4, 8]) {
        const uniform = fixture.cases.find(record => record.config.id === `scale_${scale}_uniform`);
        const face = fixture.cases.find(record => record.config.id === `scale_${scale}_face`);
        for (const formula of FORMULAS) for (const output of Object.keys(formula.layers)) {
            assert.notDeepEqual(face.checksums[output], uniform.checksums[output], output);
        }
    }
});

test('both local cores report pinned provenance', { skip: missingBinaryReason() }, () => {
    const identity = loader.getWasmCoreIdentity();
    assert.equal(identity.name, 'skin_v2');
    assert.equal(identity.version, '2.0.0');
    assert.equal(identity.matchesPinned, true);
    assert.match(identity.sha256, /^[a-f0-9]{64}$/);
    assert.equal(identity.formulas.length, 2);
    for (const formula of FORMULAS) {
        const actual = identity.formulas.find(core => core.formulaId === formula.id);
        assert.equal(actual.name, formula.variant);
        assert.equal(actual.version, formula.version);
        assert.equal(actual.fileName, formula.fileName);
        // The historical fixture identifies the binary that produced its frozen layer
        // bytes. The currently installed binary has its own production integrity pin.
        const expected = FORMULA_DEFINITIONS[formula.id].sha256;
        assert.equal(actual.sha256, expected);
        assert.equal(actual.rawSha256, expected);
        assert.equal(actual.matchesPinned, true);
    }
});

// This fixture test has no SkinBench dependency. Only absent product binaries permit a skip;
// present corrupt binaries must reach the product loader and fail instead of hiding coverage.
test('worker matches pinned SkinBench CRC/FNV at four scales, offsets, seeds and face paths', { skip: missingBinaryReason() }, async () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
    assert.deepEqual(fixture.formulas, FORMULAS);
    assert.deepEqual(fixture.cases.map(record => record.config), CASES);
    for (const config of CASES) {
        const checked = adapter.checkRequestShape({ rect: config.rect, px_per_mm: config.pxPerMm, params: config.params, ...(config.fields ? { fields: config.fields } : {}) });
        const normalized = adapter.normalizeForDocument(checked, config.document);
        // Compare requests before bytes so resolver drift cannot masquerade as formula drift.
        for (const formula of FORMULAS) assert.deepEqual(normalized.coreParams[formula.id], independentRequest(config, formula.id));
        const actual = await runWorker(normalized.coreParams, config.rect, config.document);
        const pinned = fixture.cases.find(record => record.config.id === config.id);
        if (config.fields && config.fields.face) {
            const decoded = exchange.decode(actual.files[faceMap.OUTPUT], { faceMap: true, document: config.document });
            assert.ok(faceMap.decode(decoded.payload, config.document));
            assert.match(actual.checksums[faceMap.OUTPUT].sha256, /^[a-f\d]{64}$/);
        } else {
            assert.equal(actual.files[faceMap.OUTPUT], undefined);
        }
        for (const formula of FORMULAS) for (const output of Object.keys(formula.layers)) {
            const decoded = exchange.decode(actual.files[output]);
            assert.deepEqual(exchange.checksums(decoded.payload), pinned.checksums[output], `${config.id}: ${output}`);
            assert.deepEqual(actual.checksums[output], pinned.checksums[output]);
        }
    }
});

// A read-only external runner is an additional oracle, while the pinned test above remains
// usable on machines with only Helper and its private development assets.
test('actual product worker bytes equal SkinBench runVariant on independent requests', { skip: missingBinaryReason() || (!fs.existsSync(RUNNER_FILE) && `SkinBench runner missing: ${RUNNER_FILE}`) }, async () => {
    const { runVariant } = require(RUNNER_FILE);
    for (const config of CASES) {
        const checked = adapter.checkRequestShape({ rect: config.rect, px_per_mm: config.pxPerMm, params: config.params, ...(config.fields ? { fields: config.fields } : {}) });
        const normalized = adapter.normalizeForDocument(checked, config.document);
        const actual = await runWorker(normalized.coreParams, config.rect, config.document);
        for (const formula of FORMULAS) {
            const expected = await runVariant(path.join(BENCH_ROOT, 'variants', formula.variant), independentRequest(config, formula.id));
            assert.equal(expected.layers.length, Object.keys(formula.layers).length);
            for (const [output, sourceId] of Object.entries(formula.layers)) {
                const reference = expected.layers.find(layer => layer.id === sourceId);
                assert.ok(reference, sourceId);
                const decoded = exchange.decode(actual.files[output]);
                assert.deepEqual(Buffer.from(decoded.payload), Buffer.from(reference.data), `${config.id}: ${output} actual bytes`);
            }
        }
    }
});

// task25: verify SkinBench face-map/examples.json (front and turn, full and offset rect, with and without points)
// through Helper's real adapter + worker against SkinBench v2 variants and v1 backward compatibility.
const EXAMPLES_FILE = path.join(BENCH_ROOT, 'face-map', 'examples.json');
test('examples.json frontal and turn match SkinBench v2, v1 without points, and exact Face Map SHA-256', {
    skip: missingBinaryReason() || (!fs.existsSync(RUNNER_FILE) && `SkinBench runner missing: ${RUNNER_FILE}`)
        || (!fs.existsSync(EXAMPLES_FILE) && `SkinBench examples missing: ${EXAMPLES_FILE}`)
}, async () => {
    const { runVariant } = require(RUNNER_FILE);
    const examples = JSON.parse(fs.readFileSync(EXAMPLES_FILE, 'utf8'));
    const expectedMapSha = {
        front: '55bf0393e5658405241134eef9b3e6202f200b40276e4c6221bba501ff124bfa',
        turn: 'efc9dddf9dbe0dc7e4b43739eee60a5b5c7bd77b9b6933aa2f9d1914b8532570'
    };
    const v1Dirs = {
        formula_2: path.join(BENCH_ROOT, 'variants', 'gemini4_stratum_v1')
    };
    const offsetRect = { x: 120, y: 127, width: 163, height: 181 };

    for (const [poseName, example] of Object.entries(examples)) {
        const rects = [
            { label: 'full', rect: { x: 0, y: 0, ...example.document } },
            { label: 'offset', rect: offsetRect }
        ];
        for (const { label, rect } of rects) {
            for (const withFace of [true, false]) {
                const args = {
                    rect,
                    px_per_mm: example.pxPerMm,
                    params: { seed: example.seed, azimuthDeg: example.azimuthDeg, elevationDeg: example.elevationDeg },
                    ...(withFace ? { fields: { face: example.face } } : {})
                };
                const checked = adapter.checkRequestShape(args);
                const normalized = adapter.normalizeForDocument(checked, example.document);
                const actual = await runWorker(normalized.coreParams, rect, example.document);
                const tag = `${poseName}/${label}/${withFace ? 'face' : 'uniform'}`;

                if (withFace) {
                    assert.equal(actual.checksums[faceMap.OUTPUT].sha256, expectedMapSha[poseName], `${tag} Face Map SHA-256`);
                } else {
                    assert.equal(actual.files[faceMap.OUTPUT], undefined, `${tag} must omit Face Map`);
                }

                for (const formula of FORMULAS) {
                    const req = {
                        width: rect.width, height: rect.height,
                        document: example.document, rect, pxPerMm: example.pxPerMm,
                        seed: example.seed,
                        lighting: { azimuthDeg: example.azimuthDeg, elevationDeg: example.elevationDeg },
                        zone: 'cheek',
                        ...(withFace ? { fields: { face: example.face } } : {})
                    };
                    const expectedV2 = await runVariant(path.join(BENCH_ROOT, 'variants', formula.variant), req);
                    for (const [output, sourceId] of Object.entries(formula.layers)) {
                        const refV2 = expectedV2.layers.find(layer => layer.id === sourceId);
                        assert.ok(refV2, `${tag} ${sourceId}`);
                        const decoded = exchange.decode(actual.files[output]);
                        assert.deepEqual(Buffer.from(decoded.payload), Buffer.from(refV2.data), `${tag} ${output} v2 bytes`);
                    }
                    if (!withFace && v1Dirs[formula.id]) {
                        const expectedV1 = await runVariant(v1Dirs[formula.id], req);
                        for (const [output, sourceId] of Object.entries(formula.layers)) {
                            const refV1 = expectedV1.layers.find(layer => layer.id === sourceId);
                            assert.ok(refV1, `${tag} v1 ${sourceId}`);
                            const decoded = exchange.decode(actual.files[output]);
                            assert.deepEqual(Buffer.from(decoded.payload), Buffer.from(refV1.data), `${tag} ${output} v1 compatibility bytes`);
                        }
                    }
                }
            }
        }
    }
});
