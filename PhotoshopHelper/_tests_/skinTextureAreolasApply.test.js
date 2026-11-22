'use strict';

/**
 * Areolas (task20) end to end through the fake Photoshop with the real private binaries:
 * the structure the apply writes, the cut-out masks, and what happens when something fails.
 * Skipped with a reason in a checkout without the private binaries.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { makeHarness } = require('./skinTextureFakes');
const support = require('./skinTextureAreolasSupport');

const missing = support.missingAllBinariesReason();
if (missing) {
    test('areola end-to-end private binary prerequisite', { skip: missing }, () => {});
    return;
}

const { AREOLA_VARIANTS, twoAreolas, expectedRegion, to16, fromRelief16 } = support;
// Just large enough to hold the areola region (239..559 x 200..308), to keep the skin formulas cheap.
const RECT = { x: 235, y: 195, width: 330, height: 120 };
// An apply waits for its outcome instead of answering "still writing" when the machine is busy.
const PATIENT = { responseBudgetMs: 120_000 };
const FORMULA_GROUP_NAMES = ['Formula 1', 'Formula 2', 'Formula 3'];

/**
 * Start a job, wait until it is ready and return the ready status.
 *
 * @returns {Promise<{ taskId: string, jobId: string, start: object, ready: object }>}
 */
async function computeJob(harness, extra = {}) {
    const taskId = await harness.startTask();
    const start = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'areola-job', rect: RECT, px_per_mm: 4, fields: { areolas: twoAreolas() }, ...extra
    });
    assert.equal(start.isError, false, start.text);
    const ready = await harness.waitForPhase(taskId, start.json.job_id, 'ready');
    return { taskId, jobId: start.json.job_id, start, ready };
}

function applyArgs(taskId, jobId) {
    return { task_id: taskId, job_id: jobId, mask_source: { kind: 'selection' } };
}

/** Child layers by name of a fake group. */
const namesOf = group => group.layers.map(layer => layer.name);

for (const bits of [8, 16]) {
    test(`default recipe with two areolas on a ${bits}-bit document: groups, layers, bounds, cut-out masks, one history step`, async t => {
        const harness = makeHarness(t, { limits: PATIENT, document: { width: 800, height: 600, bits } });
        const { fake } = harness;
        const exchangeFiles = support.captureExchangeFiles(fake, harness.dataFolder);
        const records = twoAreolas();
        const region = expectedRegion(records.map(r => ({ ...r })), { width: 800, height: 600 });

        const { taskId, jobId, start, ready } = await computeJob(harness);

        // Status before the apply: what computed the areolas, where, and where the parameters came from.
        assert.equal(start.json.recipe_id, 'skin_three_v2');
        assert.equal(ready.areolas.strength, 1);
        assert.deepEqual(ready.areolas.region, region);
        assert.equal(ready.areolas.general_skin_cut_out, true);
        assert.equal(ready.areolas.records.length, 2);
        assert.deepEqual(ready.areolas.records[0].areola, records[0].areola);
        assert.deepEqual(ready.areolas.records[0].nipple, [302, 251]);
        assert.deepEqual(ready.areolas.records[1].nipple, [500, 260], 'a missing nipple is filled in explicitly, with the centre');
        assert.equal(ready.areolas.variants.length, 3);
        for (const [i, expected] of AREOLA_VARIANTS.entries()) {
            const variant = ready.areolas.variants[i];
            assert.equal(variant.id, expected.id);
            assert.equal(variant.label, expected.label);
            assert.equal(variant.group, expected.group);
            assert.equal(variant.visible, expected.visible);
            assert.equal(variant.variant, expected.variant);
            assert.equal(variant.variant_version, '1.0.0');
            assert.deepEqual(variant.layers, expected.layers);
            const disk = support.sha256OfFile(expected.fileName);
            assert.equal(variant.sha256, disk, 'pinned SHA-256 is the one of the file on disk');
            assert.equal(variant.computed_sha256, disk, 'the computation reports the same SHA-256');
            assert.match(variant.sha256, /^[0-9a-f]{64}$/);
            assert.equal(variant.transition.length, 2, 'one reported transition band per areola');
            for (const band of variant.transition) assert.ok(band.innerScale > 0 && band.outerScale > band.innerScale);
        }
        assert.equal(ready.sources.light.kind, 'default', 'light left out is reported as the default');
        assert.equal(ready.sources.geometry, undefined, 'nothing is claimed that the agent did not say');
        assert.deepEqual(ready.outputs.slice(0, 3), ['areola_fable_nipple', 'areola_fable_tubercles', 'areola_fable_skin']);
        assert.equal(ready.outputs[ready.outputs.length - 1], 'areola_cutout');
        assert.equal(fake.doc.layers.length, 1, 'nothing is written before apply');

        const layersBefore = support.snapshotLayerTree(fake.doc.layers);
        const applied = await harness.call('ps_skin_texture_apply', applyArgs(taskId, jobId));
        assert.equal(applied.isError, false, applied.text);
        assert.equal(applied.json.phase, 'applied');
        assert.equal(applied.json.apply.code, 'APPLIED');

        // One undo step.
        assert.equal(fake.state.historySteps.length, 1, JSON.stringify(fake.state.historySteps));
        assert.match(fake.state.historySteps[0], /with areolas/);

        // Structure, in the Layers panel order.
        const root = fake.findLayerByName(`Skin [${jobId}]`);
        assert.ok(root, 'the outer group is "Skin [marker]"');
        assert.equal(fake.doc.layers.filter(layer => layer.id === root.id).length, 1);
        assert.deepEqual(namesOf(root), [...AREOLA_VARIANTS.map(v => v.group), ...FORMULA_GROUP_NAMES]);
        assert.deepEqual(root.layers.map(group => group.visible), [true, false, false, true, false, false]);
        assert.ok(root.layers.every(group => group.kind === 'group'));
        assert.equal(root.layerSectionExpanded, true, 'outer Skin group stays expanded');
        assert.ok(root.layers.every(group => group.layerSectionExpanded === false), 'all areola and skin formula folders start collapsed');
        for (const variant of AREOLA_VARIANTS) {
            const group = fake.findLayerByName(variant.group);
            assert.deepEqual(namesOf(group), variant.layers, `${variant.group} layers`);
            for (const layer of group.layers) {
                assert.equal(layer.blendMode, 'linearLight');
                assert.equal(layer.opacity, 50);
                assert.equal(layer.fillOpacity, 100);
                assert.deepEqual(layer.bounds, { left: region.x, top: region.y, right: region.x + region.width, bottom: region.y + region.height },
                    `${variant.group} / ${layer.name} covers the areola region only`);
                assert.equal(layer.mask, null, 'no mask on an areola layer');
            }
            assert.equal(group.mask, null, 'no mask on an areola group');
        }
        for (const groupName of FORMULA_GROUP_NAMES) {
            const group = root.layers.find(item => item.name === groupName);
            assert.ok(group.layers.length >= 1);
            for (const layer of group.layers) {
                assert.deepEqual(layer.bounds, { left: RECT.x, top: RECT.y, right: RECT.x + RECT.width, bottom: RECT.y + RECT.height },
                    `${groupName} / ${layer.name} covers the job rect`);
                assert.equal(layer.mask, null, 'no mask on a skin layer');
            }
        }

        // The common mask is on the outer group; the cut-out is on exactly the three formula groups.
        assert.ok(root.mask, 'Skin keeps the common mask from mask_source');
        const withMask = support.flattenLayers(fake.doc.layers).filter(layer => layer.mask && layer.id !== root.id);
        assert.deepEqual(withMask.map(layer => layer.name).sort(), [...FORMULA_GROUP_NAMES].sort());

        // The cut-out bytes in the document are the ones Helper computed (the exchange payload).
        const cutout = exchangeFiles.get('areola_cutout');
        assert.ok(cutout, 'the cut-out travelled in an exchange file');
        assert.deepEqual(cutout.header.rect, region);
        assert.equal(cutout.payload.length, region.width * region.height);
        assert.ok(cutout.payload.some(v => v === 0) && cutout.payload.some(v => v === 255) && cutout.payload.some(v => v > 0 && v < 255),
            'the cut-out has removed, kept and soft values');
        for (const groupName of FORMULA_GROUP_NAMES) {
            const mask = root.layers.find(item => item.name === groupName).mask;
            assert.deepEqual(mask.bounds, { left: region.x, top: region.y, right: region.x + region.width, bottom: region.y + region.height });
            assert.equal(mask.outside, 255, 'white outside the region');
            assert.equal(mask.data.length, cutout.payload.length);
            for (let i = 0; i < mask.data.length; i++) {
                const wanted = bits === 16 ? to16(cutout.payload[i]) : cutout.payload[i];
                if (mask.data[i] !== wanted) assert.fail(`${groupName} mask byte ${i}: ${mask.data[i]} instead of ${wanted}`);
            }
        }

        // The areola layers carry the computed variants (gray of the exchange payload).
        for (const variant of AREOLA_VARIANTS) {
            const group = fake.findLayerByName(variant.group);
            for (const [i, layer] of group.layers.entries()) {
                const exchange = exchangeFiles.get(variant.outputs[i]);
                assert.ok(exchange, variant.outputs[i]);
                // The red channel of the written RGBA samples (fake.grayOf would truncate 16-bit values).
                const pixels = layer.pixels;
                assert.equal(pixels.data.length, exchange.payload.length * 4);
                assert.equal(pixels.componentSize, bits);
                for (let k = 0; k < exchange.payload.length; k++) {
                    const got = bits === 16 ? fromRelief16(pixels.data[k * 4]) : pixels.data[k * 4];
                    if (got !== exchange.payload[k]) assert.fail(`${variant.outputs[i]} byte ${k}: ${got} instead of ${exchange.payload[k]}`);
                }
                assert.ok(exchange.payload.some(v => v !== 128), `${variant.outputs[i]} draws something`);
            }
        }

        // What the apply reports.
        const structure = applied.json.apply.structure;
        assert.equal(structure.subgroups.length, 6);
        assert.equal(structure.cutout.groups.length, 3);
        assert.equal(applied.json.apply.layers.length, 14);
        assert.match(applied.json.next_step, /"Areola Formula 1" \(visible\), "Areola Formula 2" \(hidden\), "Areola Formula 3" \(hidden\)/);

        // The old scene is untouched: the Background is where it was, and nothing else was added at root.
        const after = support.snapshotLayerTree(fake.doc.layers).filter(layer => layer.id !== root.id);
        assert.deepEqual(after, layersBefore);

        // A repeated apply writes nothing again.
        const again = await harness.call('ps_skin_texture_apply', applyArgs(taskId, jobId));
        assert.equal(again.json.phase, 'applied');
        assert.equal(fake.state.historySteps.length, 1);
        assert.equal(fake.doc.layers.length, 2);
    });
}

test('areola_three_v1: an "Areolas" root with the three areola groups only, no formula groups, no cut-out', async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: { width: 800, height: 600 } });
    const { fake } = harness;
    const exchangeFiles = support.captureExchangeFiles(fake, harness.dataFolder);
    const sources = { geometry: { kind: 'measured', note: 'by Helper' }, scale: { kind: 'estimated' } };
    const { taskId, jobId, start, ready } = await computeJob(harness, {
        recipe: 'areola_three_v1', params: { areolaStrength: 3 }, sources
    });
    assert.equal(start.json.recipe_id, 'areola_three_v1');
    assert.equal(ready.areolas.strength, 3);
    assert.equal(ready.areolas.general_skin_cut_out, false);
    assert.equal(ready.outputs.length, 9);
    assert.ok(!ready.formulas, 'no skin formula is computed or listed');
    assert.deepEqual(ready.sources, { ...sources, light: { kind: 'default', note: 'Helper default: azimuth 315, elevation 45' } });
    assert.equal(ready.sources.light.kind, 'default');
    assert.deepEqual(ready.areolas.variants.map(v => v.sha256), AREOLA_VARIANTS.map(v => support.sha256OfFile(v.fileName)));

    const applied = await harness.call('ps_skin_texture_apply', applyArgs(taskId, jobId));
    assert.equal(applied.isError, false, applied.text);
    assert.equal(applied.json.phase, 'applied');
    const root = fake.findLayerByName(`Areolas [${jobId}]`);
    assert.ok(root, 'the outer group is "Areolas [marker]"');
    assert.equal(fake.findLayerByName(`Skin [${jobId}]`), null);
    assert.deepEqual(namesOf(root), AREOLA_VARIANTS.map(v => v.group));
    assert.deepEqual(root.layers.map(group => group.visible), [true, false, false]);
    assert.equal(root.layerSectionExpanded, true, 'outer Areolas group stays expanded');
    assert.ok(root.layers.every(group => group.layerSectionExpanded === false), 'all areola folders start collapsed');
    for (const name of FORMULA_GROUP_NAMES) assert.equal(fake.findLayerByName(name), null, `${name} must not exist`);
    const region = expectedRegion(twoAreolas(), { width: 800, height: 600 });
    for (const variant of AREOLA_VARIANTS) {
        const group = fake.findLayerByName(variant.group);
        assert.deepEqual(namesOf(group), variant.layers);
        for (const layer of group.layers) {
            assert.deepEqual(layer.bounds, { left: region.x, top: region.y, right: region.x + region.width, bottom: region.y + region.height });
        }
    }
    // Only the common mask on the outer group; no cut-out anywhere.
    const masked = support.flattenLayers(fake.doc.layers).filter(layer => layer.mask).map(layer => layer.name);
    assert.deepEqual(masked, [root.name]);
    assert.equal(exchangeFiles.has('areola_cutout'), false);
    assert.equal(exchangeFiles.size, 9);
    assert.equal(fake.state.historySteps.length, 1);
    assert.ok(!applied.json.apply.structure.cutout, 'no cut-out is reported');
});

test('areolas partly outside the document are computed and written inside the document', async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: { width: 300, height: 300 } });
    const taskId = await harness.startTask();
    const start = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'edge', recipe: 'areola_three_v1', px_per_mm: 4,
        rect: { x: 0, y: 0, width: 300, height: 300 },
        fields: { areolas: [{ areola: { center: [8, 150], radii: [30, 22], angleDeg: 0 }, nipple: [14, 150], nippleRadiusPx: 7 }] }
    });
    assert.equal(start.isError, false, start.text);
    const ready = await harness.waitForPhase(taskId, start.json.job_id, 'ready');
    // The box 8 +- 45 + 2 is cut by the left document edge, not by a rect.
    // Half-extents 45 x 33 (1.5 scales) plus the 2 pixel margin: x 0..55 (cut by the edge), y 115..185.
    assert.deepEqual(ready.areolas.region, { x: 0, y: 115, width: 55, height: 70 });
    const applied = await harness.call('ps_skin_texture_apply', applyArgs(taskId, start.json.job_id));
    assert.equal(applied.isError, false, applied.text);
    for (const layer of applied.json.apply.layers) {
        assert.ok(layer.bounds.left >= 0 && layer.bounds.right <= 300);
        assert.equal(layer.bounds.left, 0);
    }
});

test('an areola cut by the rect, or outside the document, is refused at start with a code and nothing is computed', async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: { width: 800, height: 600 } });
    const taskId = await harness.startTask();
    const cut = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'cut', px_per_mm: 4, rect: { x: 280, y: 200, width: 100, height: 100 },
        fields: { areolas: twoAreolas().slice(0, 1) }
    });
    assert.equal(cut.isError, true);
    assert.equal(cut.json.error.code, 'AREOLA_OUTSIDE_RECT');
    assert.match(cut.json.error.message, /for example \{/);
    const gone = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'gone', px_per_mm: 4, rect: RECT,
        fields: { areolas: [{ areola: { center: [5000, 5000], radii: [30, 20] } }] }
    });
    assert.equal(gone.isError, true);
    assert.equal(gone.json.error.code, 'AREOLA_OUTSIDE_DOCUMENT');
    assert.equal(harness.fake.doc.layers.length, 1);
    assert.equal(harness.fake.state.historySteps.length, 0);
});

// ---- Failure behaviour --------------------------------------------------------------------

/**
 * Replace fs.readFileSync for the private areola binary of one variant for the rest of a test.
 * The patch lives in the main thread only (workers are not affected) and is always undone; the
 * file on disk is never touched.
 */
function patchBinary(t, fileName, replacement) {
    const original = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => {
        if (require('node:path').basename(String(file)) === fileName) return replacement();
        return original.call(fs, file, ...rest);
    };
    t.after(() => { fs.readFileSync = original; });
    return () => { fs.readFileSync = original; };
}

test('a missing areola binary refuses only the request with areolas, naming variant and file; a plain request still works', async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: { width: 800, height: 600 } });
    const { fake } = harness;
    const restore = patchBinary(t, 'gemini4_areola.wasm', () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    const taskId = await harness.startTask();
    const scriptsBefore = fake.state.scripts.length;

    const refused = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'with-areolas', rect: RECT, px_per_mm: 4, fields: { areolas: twoAreolas() }
    });
    assert.equal(refused.isError, true, refused.text);
    assert.equal(refused.json.error.code, 'AREOLA_CORE_UNAVAILABLE');
    assert.match(refused.json.error.message, /Gemini/);
    assert.ok(refused.json.error.message.includes('gemini4_areola.wasm'), refused.json.error.message);
    assert.match(refused.json.error.message, /Nothing was computed/);
    assert.equal(fake.state.scripts.length, scriptsBefore, 'no script was sent to Photoshop');
    assert.equal(harness.ownFiles().length, 0, 'no exchange file');
    // The same refusal for the areolas-only recipe.
    const only = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'only-areolas', recipe: 'areola_three_v1', rect: RECT, px_per_mm: 4, fields: { areolas: twoAreolas() }
    });
    assert.equal(only.json.error.code, 'AREOLA_CORE_UNAVAILABLE');
    assert.equal(fake.state.scripts.length, scriptsBefore);

    // The skin recipe without areolas still works with the same harness while the binary is gone.
    const plain = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'plain', rect: { x: 20, y: 20, width: 60, height: 50 }, px_per_mm: 4
    });
    assert.equal(plain.isError, false, plain.text);
    const ready = await harness.waitForPhase(taskId, plain.json.job_id, 'ready');
    assert.equal(ready.areolas, undefined, 'a plain job says nothing about areolas');
    const applied = await harness.call('ps_skin_texture_apply', applyArgs(taskId, plain.json.job_id));
    assert.equal(applied.isError, false, applied.text);
    assert.equal(applied.json.phase, 'applied');
    assert.deepEqual(namesOf(fake.findLayerByName(`Skin [${plain.json.job_id}]`)), FORMULA_GROUP_NAMES);
    restore();
});

test('a different areola binary is refused by its SHA-256, and no other variant takes its place', async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: { width: 800, height: 600 } });
    const { fake } = harness;
    patchBinary(t, 'fable_areola.wasm', () => Buffer.from('an altered private build'));
    const taskId = await harness.startTask();
    const refused = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'altered', rect: RECT, px_per_mm: 4, fields: { areolas: twoAreolas() }
    });
    assert.equal(refused.isError, true, refused.text);
    assert.equal(refused.json.error.code, 'AREOLA_CORE_UNAVAILABLE');
    assert.match(refused.json.error.message, /Fable/);
    assert.match(refused.json.error.message, /fable_areola\.wasm/);
    assert.match(refused.json.error.message, /SHA-256/i);
    assert.match(refused.json.error.message, /ab076519d68e83631322db439fefce090701aa95785bf784e8625fb9d372a864/, 'the pinned hash is named');
    assert.equal(fake.state.scripts.length, 0);
    assert.equal(fake.doc.layers.length, 1);
});

for (const historyAvailable of [false, true]) {
    test(`a failing cut-out mask write rolls the whole apply back (${historyAvailable ? 'Photoshop history' : 'delete created layers'})`, async t => {
        const harness = makeHarness(t, {
            limits: PATIENT,
            document: {
                width: 800, height: 600, historyAvailable, activeLayerName: 'Base 2',
                layerTree: [
                    { name: 'Group 29 - Protected', kind: 'group', visible: false, opacity: 73, blendMode: 'passThrough', children: [
                        { name: 'Base 2', kind: 'pixel', visible: false, opacity: 81 },
                        { name: 'Protected Paint', kind: 'pixel', visible: true, opacity: 64 }
                    ] },
                    { name: 'Background', kind: 'pixel', visible: true, opacity: 100 }
                ]
            }
        });
        const { fake } = harness;
        const originals = support.flattenLayers(fake.doc.layers);
        const sceneBefore = support.snapshotLayerTree(fake.doc.layers);
        const { taskId, jobId } = await computeJob(harness);

        // The common mask is call 1 and the cut-outs are calls 2, 3 and 4: fail the second cut-out.
        fake.state.failPutLayerMaskOnLayerName = 'Formula 2';
        const failed = await harness.call('ps_skin_texture_apply', applyArgs(taskId, jobId));
        fake.state.failPutLayerMaskOnLayerName = null;
        assert.equal(failed.isError, true, failed.text);
        assert.notEqual(failed.json.phase, 'applied');
        assert.equal(failed.json.phase, 'failed');
        assert.notEqual(failed.json.apply && failed.json.apply.state, 'applied');
        assert.match(JSON.stringify(failed.json), /simulated failure on Formula 2/);

        // No new layer remains, and every old layer is the same object with the same properties.
        const now = support.flattenLayers(fake.doc.layers);
        assert.equal(now.length, originals.length, `layers left: ${now.map(l => l.name).join(', ')}`);
        for (const layer of originals) assert.ok(now.includes(layer), `${layer.name} must still be the same object`);
        assert.deepEqual(support.snapshotLayerTree(fake.doc.layers), sceneBefore);
        assert.equal(fake.findLayerByName(`Skin [${jobId}]`), null);
        for (const variant of AREOLA_VARIANTS) assert.equal(fake.findLayerByName(variant.group), null);
        for (const name of FORMULA_GROUP_NAMES) assert.equal(fake.findLayerByName(name), null);

        // The job is not reported as applied and does not claim a write.
        const status = await harness.call('ps_skin_texture_status', { task_id: taskId, job_id: jobId });
        assert.notEqual(status.json.phase, 'applied');
        assert.ok(!(status.json.apply && status.json.apply.layers), 'no layer ids are reported');
    });
}
