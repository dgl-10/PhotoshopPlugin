'use strict';

/**
 * Helper's areola path against the SkinBench runner (contract section 10).
 *
 * The recorded data (skinTextureAreolaEquivalenceCases.js) was produced by SkinBench's runWasmVariant
 * on hand-written requests, see docs/points_to_future development/skin_texture/sandbox/task20/
 * make-areola-equivalence.js. The test runs the product path (buildAreolaRequests + computeAreolas in
 * real workers) and compares requests first, so request drift is never mistaken for formula drift,
 * then the exchange headers and the payload checksums of every layer.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const exchange = require('../skin-texture/exchange');
const geometry = require('../skin-texture/areola-geometry');
const { buildAreolaRequests } = require('../skin-texture/areola-request');
const { computeAreolas } = require('../skin-texture/areola-engine');
const { AREOLA_RECIPE, AREOLA_DEFINITIONS, AREOLA_COMPONENTS } = require('../skin-texture/areola-definitions');
const DATA = require('./skinTextureAreolaEquivalenceCases');

/** Only absence of a private binary permits a skip; a modified file reaches the worker and fails. */
function missingAreolaBinaries() {
    const missing = Object.values(AREOLA_DEFINITIONS)
        .filter(definition => !fs.existsSync(path.join(__dirname, '../skin-texture', definition.fileName)))
        .map(definition => definition.fileName);
    return missing.length ? `Private Wasm files missing: ${missing.join(', ')}` : false;
}

// Data guards run without any binary, so a regenerated or edited data file cannot weaken the matrix.
test('recorded areola data matches the pinned variants and covers the required matrix', () => {
    assert.deepEqual(DATA.variants.map(({ id, variant, fileName, sha256 }) => ({ id, variant, fileName, sha256 })),
        Object.values(AREOLA_DEFINITIONS).map(({ id, variant, fileName, sha256 }) => ({ id, variant, fileName, sha256 })));
    const cases = DATA.cases;
    assert.ok(cases.length >= 8, 'at least 8 cases');
    assert.deepEqual([...new Set(cases.map(c => c.pxPerMm))].sort((a, b) => a - b).filter(n => [1.6, 2.7, 4, 8].includes(n)), [1.6, 2.7, 4, 8]);
    const seeds = cases.map(c => c.params.seed);
    assert.ok(seeds.includes(0) && seeds.includes(4294967295));
    for (const azimuth of [0, 135, 315]) assert.ok(cases.some(c => c.params.azimuthDeg === azimuth), `azimuth ${azimuth}`);
    for (const elevation of [20, 45, 80]) assert.ok(cases.some(c => c.params.elevationDeg === elevation), `elevation ${elevation}`);
    assert.ok(cases.some(c => c.areolaStrength === 2.5));
    assert.ok(cases.some(c => c.areolas.length === 2 && c.areolas.some(a => a.areola.angleDeg !== 0)));
    assert.ok(cases.some(c => c.areolas.some(a => a.areola.angleDeg === 28)));
    assert.ok(cases.some(c => c.region.x > 2000 && c.region.y > 1500));
    assert.ok(cases.some(c => c.region.x === 0 || c.region.y === 0), 'a region clipped by the document edge');
    assert.ok(cases.some(c => c.wholeDocumentCrop));
    for (const c of cases) {
        assert.equal(Object.keys(c.request).includes('zone'), false, `${c.id}: no zone`);
        for (const record of c.areolas) {
            assert.ok(record.areola.center && record.areola.radii && record.areola.angleDeg !== undefined, c.id);
            assert.ok(record.nipple && record.nippleRadiusPx !== undefined, c.id);
        }
        assert.deepEqual(Object.keys(c.checksums).sort(), AREOLA_COMPONENTS.map(item => item.componentKey).sort(), c.id);
        // A layer that is all 128 would prove nothing; at least one layer per variant must carry relief.
        for (const definition of Object.values(AREOLA_DEFINITIONS)) {
            const informative = definition.layers.some(layer => {
                const recorded = c.checksums[`${definition.id}_${layer.output}`];
                const flat = exchange.checksums(new Uint8Array(recorded.length).fill(128));
                return recorded.crc32 !== flat.crc32 || recorded.fnv1a !== flat.fnv1a;
            });
            assert.ok(informative, `${c.id}/${definition.id}: every recorded layer is neutral`);
        }
    }
});

test('the region crop loses nothing: whole-document layers cropped equal the sub-rectangle layers', () => {
    const whole = DATA.cases.filter(c => c.wholeDocumentCrop);
    assert.ok(whole.length >= 1);
    for (const c of whole) assert.deepEqual(c.wholeDocumentCrop, c.checksums, c.id);
});

for (const c of DATA.cases) {
    test(`areola ${c.id}: product requests and layers equal the SkinBench runner`, { skip: missingAreolaBinaries() }, async () => {
        const rect = { x: 0, y: 0, width: c.document.width, height: c.document.height };
        const { areolas } = geometry.normalizeAreolas(JSON.parse(JSON.stringify(c.areolas)));
        const params = { seed: c.params.seed, azimuthDeg: c.params.azimuthDeg, elevationDeg: c.params.elevationDeg };
        const built = buildAreolaRequests(areolas, c.document, rect, c.pxPerMm, params, c.areolaStrength);
        // Requests first: a resolver difference must not look like a formula difference.
        assert.deepEqual(built.region.rect, c.region, `${c.id}: region`);
        for (const definition of Object.values(AREOLA_DEFINITIONS)) {
            assert.deepEqual(built.requests[definition.id], c.request, `${c.id}/${definition.id}: request`);
        }

        const meta = { jobId: 'skt-0123456789ab', taskId: 'task-test', recipe_id: AREOLA_RECIPE,
            document: { id: 7, width: c.document.width, height: c.document.height } };
        const result = await computeAreolas({ requests: built.requests, region: built.region, cutout: false }, meta);
        assert.deepEqual(Object.keys(result.files).sort(), Object.keys(c.checksums).sort(), `${c.id}: outputs`);

        for (const definition of Object.values(AREOLA_DEFINITIONS)) {
            for (const layer of definition.layers) {
                const key = `${definition.id}_${layer.output}`;
                const label = `${c.id}: ${key}`;
                const decoded = exchange.decode(result.files[key]);
                assert.deepEqual(decoded.header.rect, c.region, `${label}: header rect`);
                assert.deepEqual(decoded.header.document, { id: 7, width: c.document.width, height: c.document.height }, `${label}: header document`);
                assert.equal(decoded.header.output, key, `${label}: output`);
                assert.equal(decoded.header.formula_id, definition.id, `${label}: formula_id`);
                assert.equal(decoded.header.formula_version, definition.version, `${label}: formula_version`);
                assert.deepEqual(decoded.header.core, { name: definition.variant, version: definition.variantVersion, sha256: definition.sha256 }, `${label}: core identity`);
                assert.equal(c.layers[key], layer.sourceLayerId, `${label}: source layer id`);
                assert.deepEqual(exchange.checksums(decoded.payload), c.checksums[key], `${label}: payload checksums`);
                assert.deepEqual(result.checksums[key], c.checksums[key], `${label}: worker checksums`);
            }
        }
    });
}
