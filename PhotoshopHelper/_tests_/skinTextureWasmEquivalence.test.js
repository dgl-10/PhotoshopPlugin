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
const { missingBinaryReason, runWorker } = require('./skinTextureTestSupport');
const { FORMULAS, CASES, independentRequest } = require('./skinTextureEquivalenceCases');
const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'skin-three-v2-checksums.json');
const BENCH_ROOT = process.env.SKINBENCH_ROOT || path.resolve(__dirname, '../../../SkinBench');
const RUNNER_FILE = path.join(BENCH_ROOT, 'variants', 'runner.js');

// Integrity tests run even in a fresh checkout, where the private files are absent.
for (const formula of FORMULAS) {
    test(`${formula.fileName}: altered bytes fail with filename and pinned digest`, () => {
        assert.throws(() => loader.verifyWasmBytes(Buffer.from('altered private build'), formula.id), error =>
            error.message.includes(formula.fileName) && error.message.includes(formula.sha256));
    });
}

test('private formulas stay outside Git and the installer', () => {
    const root = path.resolve(__dirname, '../..');
    const tracked = execFileSync('git', ['ls-files', '*.wasm'], { cwd: root, encoding: 'utf8' });
    assert.equal(tracked.trim(), '', 'no private binary is tracked');
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\*\.wasm\s*$/m);
    assert.ok(require('../package.json').build.files.includes('!skin-texture/*.wasm'));
});

test('pinned face fixtures exercise changed Formula 1 bytes and unchanged other variants', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
    // This runs without binaries or SkinBench and prevents replacing the matrix with
    // neutral or duplicate samples that would no longer detect face-routing regressions.
    for (const scale of [1.6, 2.7, 4, 8]) {
        const uniform = fixture.cases.find(record => record.config.id === `scale_${scale}_uniform`);
        const face = fixture.cases.find(record => record.config.id === `scale_${scale}_face`);
        for (const formula of FORMULAS) for (const output of Object.keys(formula.layers)) {
            if (formula.id === 'formula_1') assert.notDeepEqual(face.checksums[output], uniform.checksums[output], output);
            else assert.deepEqual(face.checksums[output], uniform.checksums[output], output);
        }
    }
});

test('all three local cores report pinned provenance', { skip: missingBinaryReason() }, () => {
    const identity = loader.getWasmCoreIdentity();
    assert.equal(identity.name, 'skin_three_v2');
    assert.equal(identity.version, '2.0.0');
    assert.equal(identity.matchesPinned, true);
    assert.match(identity.sha256, /^[a-f0-9]{64}$/);
    assert.equal(identity.formulas.length, 3);
    for (const formula of FORMULAS) {
        const actual = identity.formulas.find(core => core.formulaId === formula.id);
        assert.equal(actual.name, formula.variant);
        assert.equal(actual.version, formula.version);
        assert.equal(actual.fileName, formula.fileName);
        assert.equal(actual.sha256, formula.sha256);
        assert.equal(actual.rawSha256, formula.sha256);
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
