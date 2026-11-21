'use strict';

/**
 * Areolas (task20), the parts that need no private binary: request validation, geometry, and the
 * installed build's refusal of ps_skin_texture_find_areolas. The Photoshop write is in
 * skinTextureAreolasApply.test.js and the measurement tool in skinTextureAreolasFind.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const adapter = require('../skin-texture/core-adapter');
const geometry = require('../skin-texture/areola-geometry');
const { createAgentService, resolveAgentPaths } = require('../agent');
const { createFakePhotoshop } = require('./skinTextureFakes');
const { IN_DEVELOPMENT_CODE, CORE_UNAVAILABLE_CODE } = require('../skin-texture/availability');
const support = require('./skinTextureAreolasSupport');

const BASE = Object.freeze({ rect: { x: 0, y: 0, width: 100, height: 100 }, px_per_mm: 5 });
const GOOD = Object.freeze({ areola: { center: [50, 50], radii: [10, 8], angleDeg: 5 } });
const FACE = Object.freeze({ eyes: [[10, 10], [30, 10]], noseTip: [20, 20], mouth: [[15, 30], [25, 30]], chin: [20, 40] });

/** Assert that a request is refused with a code; returns the error for further checks. */
function refused(extra, code) {
    let error = null;
    try {
        adapter.checkRequestShape({ ...BASE, ...extra });
    } catch (e) {
        error = e;
    }
    assert.ok(error, `expected a refusal with ${code} for ${JSON.stringify(extra)}`);
    assert.equal(error.code, code, error.message);
    return error;
}

// ---- 1. Request validation ----------------------------------------------------------------

test('areola records: invalid ones are refused with INVALID_FIELDS naming the member', () => {
    const record = overrides => ({ areola: { ...GOOD.areola, ...(overrides.areola || {}) }, ...overrides.rest });
    const cases = [
        ['three areolas', { fields: { areolas: [GOOD, GOOD, GOOD] } }, /1 to 2/],
        ['no areolas', { fields: { areolas: [] } }, /1 to 2/],
        ['areolas not an array', { fields: { areolas: GOOD } }, /1 to 2/],
        ['radius below 1 (x)', { fields: { areolas: [record({ areola: { radii: [0.5, 5] } })] } }, /radii/],
        ['radius below 1 (y)', { fields: { areolas: [record({ areola: { radii: [5, 0.99] } })] } }, /radii/],
        ['radius not a number', { fields: { areolas: [record({ areola: { radii: ['5', 5] } })] } }, /radii/],
        ['NaN centre', { fields: { areolas: [record({ areola: { center: [NaN, 2] } })] } }, /center/],
        ['Infinity centre', { fields: { areolas: [record({ areola: { center: [1, Infinity] } })] } }, /center/],
        ['NaN radius', { fields: { areolas: [record({ areola: { radii: [NaN, 5] } })] } }, /radii/],
        ['NaN angle', { fields: { areolas: [record({ areola: { angleDeg: NaN } })] } }, /angleDeg/],
        ['unknown member of the record', { fields: { areolas: [{ ...GOOD, extra: 1 }] } }, /unknown fields: extra/],
        ['unknown member of the outline', { fields: { areolas: [{ areola: { ...GOOD.areola, tilt: 3 } }] } }, /unknown fields: tilt/],
        ['non-finite nipple', { fields: { areolas: [{ ...GOOD, nipple: [1, NaN] }] } }, /nipple/],
        ['nipple radius too small', { fields: { areolas: [{ ...GOOD, nippleRadiusPx: 0.1 }] } }, /nippleRadiusPx/],
        ['record without outline', { fields: { areolas: [{ nipple: [1, 2] }] } }, /areola is required/],
        ['unknown member of fields', { fields: { areolas: [GOOD], tattoo: 1 } }, /unknown fields: tattoo/]
    ];
    for (const [label, extra, pattern] of cases) {
        const error = refused(extra, 'INVALID_FIELDS');
        assert.match(error.message, pattern, label);
    }
});

test('areola request: strength, recipe and sources are validated', () => {
    refused({ params: { areolaStrength: 2 } }, 'INVALID_PARAMS');
    refused({ params: { areolaStrength: 2 }, fields: { face: FACE } }, 'INVALID_PARAMS');
    for (const bad of [-1, 21, NaN, '1', null]) {
        refused({ fields: { areolas: [GOOD] }, params: { areolaStrength: bad } }, 'INVALID_PARAMS');
    }
    refused({ recipe: 'areola_three_v1' }, 'INVALID_FIELDS');
    refused({ recipe: 'areola_three_v1', fields: { face: FACE } }, 'INVALID_FIELDS');
    const withFace = refused({ recipe: 'areola_three_v1', fields: { face: FACE, areolas: [GOOD] } }, 'INVALID_FIELDS');
    assert.match(withFace.message, /fields\.face/);
    refused({ fields: { areolas: [GOOD] }, sources: { geometry: { kind: 'guess' } } }, 'INVALID_SOURCES');
    refused({ fields: { areolas: [GOOD] }, sources: { geometry: { kind: 'given', note: 'x'.repeat(301) } } }, 'INVALID_SOURCES');
    refused({ fields: { areolas: [GOOD] }, sources: { geometry: { kind: 'given', extra: 1 } } }, 'INVALID_SOURCES');
    refused({ fields: { areolas: [GOOD] }, sources: { colour: { kind: 'given' } } }, 'INVALID_SOURCES');
    refused({ fields: { areolas: [GOOD] }, sources: [] }, 'INVALID_SOURCES');
    refused({ fields: { areolas: [GOOD] }, sources: 'measured' }, 'INVALID_SOURCES');
});

test('areola request: accepted values are canonical and carry the areola groups before the skin groups', () => {
    const request = adapter.checkRequestShape({ ...BASE, fields: { areolas: [{ areola: { center: [50, 50], radii: [10, 8] } }] } });
    assert.equal(request.areolaStrength, 1, 'the default strength is the variants\' own');
    // The record is filled in explicitly, so all three variants receive the same nipple.
    assert.deepEqual(request.fields.areolas, [{ areola: { center: [50, 50], radii: [10, 8], angleDeg: 0 }, nipple: [50, 50], nippleRadiusPx: 3 }]);
    assert.deepEqual(request.outputs, [
        'areola_fable_nipple', 'areola_fable_tubercles', 'areola_fable_skin',
        'areola_astra_nipple', 'areola_astra_tubercles', 'areola_astra_skin',
        'areola_gemini_nipple', 'areola_gemini_tubercles', 'areola_gemini_skin',
        'formula_1_pores', 'formula_1_unevenness', 'formula_2_dermis', 'formula_3_pores', 'formula_3_furrows',
        'areola_cutout'
    ]);
    const only = adapter.checkRequestShape({ ...BASE, recipe: 'areola_three_v1', fields: { areolas: [GOOD] }, params: { areolaStrength: 20 } });
    assert.equal(only.areolaStrength, 20);
    assert.equal(only.outputs.length, 9, 'areolas only: no skin components and no cut-out');
    assert.ok(only.outputs.every(key => key.startsWith('areola_') && key !== 'areola_cutout'));
    // The key is independent of the order of members in the agent's JSON.
    const reordered = { areola: { angleDeg: 5, radii: [10, 8], center: [50, 50] } };
    const a = adapter.checkRequestShape({ ...BASE, fields: { areolas: [GOOD] } });
    const b = adapter.checkRequestShape({ ...BASE, fields: { areolas: [reordered] } });
    assert.equal(a.key, b.key);
    // Different strength, a different request.
    const c = adapter.checkRequestShape({ ...BASE, fields: { areolas: [GOOD] }, params: { areolaStrength: 2 } });
    assert.notEqual(a.key, c.key);
});

test('a request without areolas yields exactly the old key, outputs and parameters', () => {
    const plain = adapter.checkRequestShape({ ...BASE, params: { seed: 7, azimuthDeg: 200, elevationDeg: 30 } });
    // Transcribed by hand from the task15 contract, not produced by the code under test.
    assert.equal(plain.key, '{"recipe":"skin_three_v2","rect":{"x":0,"y":0,"width":100,"height":100},"pxPerMm":5,'
        + '"params":{"seed":7,"azimuthDeg":200,"elevationDeg":30},"fields":null}');
    assert.deepEqual(plain.outputs, ['formula_1_pores', 'formula_1_unevenness', 'formula_2_dermis', 'formula_3_pores', 'formula_3_furrows']);
    assert.deepEqual(plain.params, { seed: 7, azimuthDeg: 200, elevationDeg: 30 });
    assert.equal(plain.fields, null);
    assert.equal(plain.recipe, 'skin_three_v2');
    assert.equal('areolaStrength' in plain, false, 'no areolaStrength member');
    assert.equal(plain.layout.areolas, false);
    assert.equal(plain.layout.cutout, false);
    assert.equal(plain.layout.components.length, 5);
    assert.doesNotMatch(plain.key, /areola|sources/i);

    const withFace = adapter.checkRequestShape({ ...BASE, fields: { face: FACE } });
    assert.equal(withFace.key, '{"recipe":"skin_three_v2","rect":{"x":0,"y":0,"width":100,"height":100},"pxPerMm":5,'
        + '"params":{"seed":1,"azimuthDeg":315,"elevationDeg":45},'
        + '"fields":{"face":{"eyes":[[10,10],[30,10]],"noseTip":[20,20],"mouth":[[15,30],[25,30]],"chin":[20,40]}}}');
    assert.deepEqual(Object.keys(withFace.fields), ['face']);
    assert.equal(withFace.outputs.length, 5);

    // Naming the origin of a parameter is the only thing that adds a member to the key.
    const named = adapter.checkRequestShape({ ...BASE, sources: { scale: { kind: 'given' } } });
    assert.match(named.key, /"sources"/);
    assert.equal(named.outputs.length, 5);

    // A face together with areolas keeps the face members exactly as without areolas.
    const both = adapter.checkRequestShape({ ...BASE, fields: { face: FACE, areolas: [GOOD] } });
    assert.deepEqual(both.fields.face, withFace.fields.face);
    assert.equal(both.recipe, 'skin_three_v2');
});

// ---- 2. Geometry --------------------------------------------------------------------------

test('areolaRegion: an areola cut by the rect is refused with a rect that contains it, which is then accepted', () => {
    const doc = { width: 300, height: 300 };
    const record = geometry.normalizeAreolas([{ areola: { center: [150, 150], radii: [20, 20] } }]).areolas;
    const tooSmall = { x: 90, y: 90, width: 120, height: 120 };
    // 1.5 outline scales plus the 2 pixel margin: 150 +- 32 = 118..182 fits the 90..210 rect.
    assert.doesNotThrow(() => geometry.areolaRegion(record, doc, tooSmall));
    const cut = { x: 100, y: 100, width: 50, height: 120 };
    let error = null;
    try { geometry.areolaRegion(record, doc, cut); } catch (e) { error = e; }
    assert.ok(error instanceof geometry.AreolaGeometryError);
    assert.equal(error.code, 'AREOLA_OUTSIDE_RECT');
    assert.match(error.message, /fields\.areolas\[0\]/);
    const suggested = JSON.parse(error.message.match(/for example (\{[^}]*\})/)[1]);
    // The suggestion must contain the areola with its band (118..182) and must itself be accepted.
    assert.ok(suggested.x <= 118 && suggested.y <= 118 && suggested.x + suggested.width >= 182 && suggested.y + suggested.height >= 182, JSON.stringify(suggested));
    assert.doesNotThrow(() => geometry.areolaRegion(record, doc, suggested));
});

test('areolaRegion: refuses an areola outside the document, accepts one partly outside', () => {
    const doc = { width: 200, height: 200 };
    const whole = { x: 0, y: 0, width: 200, height: 200 };
    const gone = geometry.normalizeAreolas([{ areola: { center: [-1000, -1000], radii: [10, 10] } }]).areolas;
    assert.throws(() => geometry.areolaRegion(gone, doc, whole), error => error.code === 'AREOLA_OUTSIDE_DOCUMENT' && /fields\.areolas\[0\]/.test(error.message));
    const second = geometry.normalizeAreolas([{ areola: { center: [100, 100], radii: [10, 10] } }, { areola: { center: [5000, 100], radii: [10, 10] } }]).areolas;
    assert.throws(() => geometry.areolaRegion(second, doc, whole), error => error.code === 'AREOLA_OUTSIDE_DOCUMENT' && /areolas\[1\]/.test(error.message));

    // Centre (5, 5), radii 20: the band reaches 5 + 30 + 2 = 37 to the right and below, and the
    // document edge cuts the rest: the region is the document corner.
    const corner = geometry.normalizeAreolas([{ areola: { center: [5, 5], radii: [20, 20] } }]).areolas;
    const region = geometry.areolaRegion(corner, doc, whole);
    assert.deepEqual(region.rect, { x: 0, y: 0, width: 37, height: 37 });
    // The same areola with a rect that starts inside the document is cut by the rect, not by the edge.
    assert.throws(() => geometry.areolaRegion(corner, doc, { x: 2, y: 2, width: 100, height: 100 }), error => error.code === 'AREOLA_OUTSIDE_RECT');
});

test('areolaRegion: the region is the union of the boxes, in document pixels', () => {
    const doc = { width: 800, height: 600 };
    const records = geometry.normalizeAreolas(support.twoAreolas()).areolas;
    const region = geometry.areolaRegion(records, doc, { x: 0, y: 0, width: 800, height: 600 });
    assert.deepEqual(region.rect, support.expectedRegion(records, doc));
    assert.equal(region.boxes.length, 2);
    for (const [i, record] of records.entries()) assert.deepEqual(region.boxes[i], support.expectedRegion([record], doc));
});

/** Rho of a pixel centre, computed here from the definition of the outline scale. */
function rhoOf(record, x, y) {
    const { center, radii, angleDeg } = record.areola;
    const t = angleDeg * Math.PI / 180;
    const dx = x + 0.5 - center[0], dy = y + 0.5 - center[1];
    return Math.hypot((dx * Math.cos(t) + dy * Math.sin(t)) / radii[0], (-dx * Math.sin(t) + dy * Math.cos(t)) / radii[1]);
}

const smoothstep = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

test('buildCutout: 255 beyond every band, 0 inside every inner scale, monotonic along a ray', () => {
    const record = geometry.normalizeAreolas([{ areola: { center: [60.5, 50.5], radii: [20, 12], angleDeg: 30 } }]).areolas;
    const bands = [[{ innerScale: 0.88, outerScale: 1.06 }], [{ innerScale: 0.8, outerScale: 1.12 }]];
    const rect = geometry.areolaRegion(record, { width: 200, height: 200 }, { x: 0, y: 0, width: 200, height: 200 }).rect;
    const mask = geometry.buildCutout(record, bands, rect);
    assert.equal(mask.length, rect.width * rect.height);
    let zeros = 0, whites = 0;
    for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
            const rho = rhoOf(record[0], rect.x + x, rect.y + y);
            const value = mask[y * rect.width + x];
            if (rho >= 1.12) { assert.equal(value, 255, `rho ${rho} must keep the general texture`); whites++; }
            if (rho <= 0.8) { assert.equal(value, 0, `rho ${rho} must remove the general texture`); zeros++; }
            assert.ok(value >= 0 && value <= 255);
        }
    }
    assert.ok(zeros > 100 && whites > 100, 'the test region must contain both extremes');

    // A ray along the first half-axis of an axis-aligned areola: rho is exact on pixel centres.
    const flat = geometry.normalizeAreolas([{ areola: { center: [60.5, 50.5], radii: [20, 12], angleDeg: 0 } }]).areolas;
    const flatRect = { x: 0, y: 0, width: 100, height: 100 };
    const flatMask = geometry.buildCutout(flat, bands, flatRect);
    let previous = -1, sawTransition = false;
    for (let x = 60; x < 100; x++) {
        const value = flatMask[50 * flatRect.width + x];
        assert.ok(value >= previous, `value ${value} at x=${x} fell below ${previous}`);
        if (value > 0 && value < 255) sawTransition = true;
        previous = value;
    }
    assert.ok(sawTransition, 'the band must fade, not jump');
    assert.equal(flatMask[50 * flatRect.width + 60], 0);
    assert.equal(flatMask[50 * flatRect.width + 99], 255);
    // The same along the other half-axis (down), where a band of the same scales is narrower in pixels.
    previous = -1;
    for (let y = 50; y < 100; y++) {
        const value = flatMask[y * flatRect.width + 60];
        assert.ok(value >= previous);
        previous = value;
    }
});

test('buildCutout: values follow the definition 255 * (1 - weight) at sampled pixels', () => {
    const record = geometry.normalizeAreolas([{ areola: { center: [60.5, 50.5], radii: [20, 20], angleDeg: 0 } }]).areolas;
    const band = { innerScale: 0.9, outerScale: 1.1 };
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    const mask = geometry.buildCutout(record, [[band]], rect);
    for (const x of [70, 76, 78, 79, 80, 81, 82, 84, 90]) {
        const rho = rhoOf(record[0], x, 50);
        const weight = 1 - smoothstep((rho - band.innerScale) / (band.outerScale - band.innerScale));
        assert.equal(mask[50 * rect.width + x], Math.round(255 * (1 - weight)), `x=${x} rho=${rho}`);
    }
});

test('buildCutout: with several variants and areolas the mask follows the larger weight', () => {
    const records = geometry.normalizeAreolas([
        { areola: { center: [40.5, 40.5], radii: [15, 15], angleDeg: 0 } },
        { areola: { center: [100.5, 50.5], radii: [18, 12], angleDeg: 40 } }
    ]).areolas;
    const narrow = [{ innerScale: 0.5, outerScale: 0.7 }, { innerScale: 0.5, outerScale: 0.7 }];
    const wide = [{ innerScale: 0.9, outerScale: 1.1 }, { innerScale: 0.9, outerScale: 1.1 }];
    const rect = { x: 0, y: 0, width: 150, height: 100 };
    const maskNarrow = geometry.buildCutout(records, [narrow], rect);
    const maskWide = geometry.buildCutout(records, [wide], rect);
    const maskBoth = geometry.buildCutout(records, [narrow, wide], rect);
    for (let i = 0; i < maskBoth.length; i++) assert.equal(maskBoth[i], Math.min(maskNarrow[i], maskWide[i]), `pixel ${i}`);
    // At rho 0.8 only the wide variant still removes the texture, and the combined mask removes it.
    const at = (mask, x, y) => mask[y * rect.width + x];
    const x = 40 + 12;
    assert.ok(Math.abs(rhoOf(records[0], x, 40) - 0.8) < 0.05);
    assert.equal(at(maskNarrow, x, 40), 255);
    assert.equal(at(maskWide, x, 40), 0);
    assert.equal(at(maskBoth, x, 40), 0);
    // Each areola contributes its own band: the combined mask is the minimum of the single-areola masks.
    const first = geometry.buildCutout([records[0]], [[wide[0]]], rect);
    const second = geometry.buildCutout([records[1]], [[wide[1]]], rect);
    const both = geometry.buildCutout(records, [wide], rect);
    for (let i = 0; i < both.length; i++) assert.equal(both[i], Math.min(first[i], second[i]));
});

test('checkTransitions refuses bands the computed region cannot hold, and findNeutralViolation finds a stray byte', () => {
    assert.throws(() => geometry.checkTransitions(null, 1, 'v'), /one transition per areola/);
    assert.throws(() => geometry.checkTransitions([{ innerScale: 1, outerScale: 0.9 }], 1, 'v'), /invalid transition band/);
    assert.throws(() => geometry.checkTransitions([{ innerScale: 0.9, outerScale: 1.46 }], 1, 'v'), /beyond the 1.5 outline scales/);
    const bands = geometry.checkTransitions([{ innerScale: 0.9, outerScale: 1.1 }], 1, 'v');
    const record = geometry.normalizeAreolas([{ areola: { center: [30.5, 30.5], radii: [10, 10] } }]).areolas;
    const rect = { x: 0, y: 0, width: 61, height: 61 };
    const gray = new Uint8Array(61 * 61).fill(128);
    assert.equal(geometry.findNeutralViolation(gray, rect, record, bands), null);
    gray[0] = 129;
    assert.match(geometry.findNeutralViolation(gray, rect, record, bands), /byte 129 at document pixel 0,0/);
    gray[0] = 128;
    gray[30 * 61 + 30] = 200;
    assert.equal(geometry.findNeutralViolation(gray, rect, record, bands), null, 'inside the band a value other than 128 is fine');
});

// ---- 6. Installed build -------------------------------------------------------------------

const FIND_TOOL = 'ps_skin_texture_find_areolas';

function makeService(context, skinTexture, logger = { info() {}, warn() {}, error() {} }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-areola-indev-'));
    const dataFolder = path.join(root, 'PluginData');
    fs.mkdirSync(dataFolder);
    const fake = createFakePhotoshop({ dataFolder });
    const service = createAgentService({
        getBridge: () => fake.bridge,
        paths: resolveAgentPaths({ resourcesPath: root, userDataPath: root, downloadedKnowledgeBasePath: null }),
        isJournalEnabled: () => false,
        logger,
        skinTexture
    });
    context.after(async () => {
        await service.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
    async function call(name, args) {
        const result = await service.tools.call(name, args);
        const text = result.content[0].text;
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { result, text, json, isError: Boolean(result.isError) };
    }
    return { service, fake, call };
}

test('installed build: ps_skin_texture_find_areolas is published like in a development run and refuses with "in development"', async context => {
    const installed = makeService(context, { inDevelopment: true });
    const development = makeService(context, {});
    const published = installed.service.tools.list().find(tool => tool.name === FIND_TOOL);
    assert.ok(published, `${FIND_TOOL} is published in the installed build`);
    assert.deepEqual(published, development.service.tools.list().find(tool => tool.name === FIND_TOOL));

    const started = await installed.call('ps_start_task', { intent: 'find areolas' });
    const taskId = started.text.match(/(task-[a-f0-9]+)/)[1];
    const scriptsBefore = installed.fake.state.scripts.length;
    const layersBefore = installed.fake.doc.layers.length;
    for (const args of [
        { task_id: taskId, source: 'selection' },
        { task_id: taskId, source: 'image', hints: [{ center: [100, 100], radius: 30 }] },
        { task_id: taskId }
    ]) {
        const answer = await installed.call(FIND_TOOL, args);
        assert.equal(answer.isError, true, answer.text);
        assert.equal(answer.json.error.code, IN_DEVELOPMENT_CODE);
        assert.match(answer.json.error.message, /still in development/);
        assert.match(answer.json.error.message, /Do not call the ps_skin_texture_ tools again/);
    }
    assert.equal(installed.fake.state.scripts.length, scriptsBefore, 'no script reached Photoshop');
    assert.equal(installed.fake.doc.layers.length, layersBefore, 'no layer was created');
});

test('development run without a usable private skin binary: ps_skin_texture_find_areolas refuses with the reason', async context => {
    const original = fs.readFileSync;
    const target = file => path.basename(String(file)) === 'fable_flecks2.wasm';
    fs.readFileSync = (file, ...rest) => {
        if (target(file)) throw Object.assign(new Error('private binary missing'), { code: 'ENOENT' });
        return original.call(fs, file, ...rest);
    };
    let service;
    try {
        service = makeService(context, {});
    } finally {
        fs.readFileSync = original;
    }
    const started = await service.call('ps_start_task', { intent: 'find areolas' });
    const taskId = started.text.match(/(task-[a-f0-9]+)/)[1];
    const answer = await service.call(FIND_TOOL, { task_id: taskId, source: 'selection' });
    assert.equal(answer.isError, true, answer.text);
    assert.equal(answer.json.error.code, CORE_UNAVAILABLE_CODE);
    assert.ok(answer.json.error.message.includes('fable_flecks2.wasm'), answer.text);
    assert.equal(service.fake.state.scripts.length, 0);
});
