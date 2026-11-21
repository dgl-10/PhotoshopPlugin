'use strict';

/**
 * ps_skin_texture_find_areolas (task20) through the MCP tool layer with the fake Photoshop: the
 * selection fit on a synthetic mask read at a reduced size, the image search on a synthetic
 * picture, the file the read script leaves in the data folder, and the hand-off to
 * ps_skin_texture_start. Finding needs no private binary; the hand-off test does and is skipped
 * with a reason without them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeHarness } = require('./skinTextureFakes');
const support = require('./skinTextureAreolasSupport');

const FIND = 'ps_skin_texture_find_areolas';
const READ_PREFIX = 'skin-areola-read-';

const readFilesIn = folder => fs.readdirSync(folder).filter(name => name.startsWith(READ_PREFIX));

/**
 * Watch the files the read script writes: what is in the data folder right after the script ran,
 * with the header parsed by hand from the documented layout (independent of Helper's reader).
 *
 * @returns {object[]} Filled after every read script: { name, magic, header, sampleBytes }.
 */
function watchReadFiles(harness) {
    const seen = [];
    harness.fake.state.afterScript = (answer, payload) => {
        if (payload.code.includes('for local areola measurement')) {
            for (const name of readFilesIn(harness.dataFolder)) {
                const bytes = fs.readFileSync(path.join(harness.dataFolder, name));
                const headerLength = bytes.readUInt32LE(8);
                seen.push({ name, magic: bytes.toString('latin1', 0, 8), headerLength,
                    header: JSON.parse(bytes.toString('latin1', 12, 12 + headerLength)), sampleBytes: bytes.length - 12 - headerLength });
            }
        }
        return answer;
    };
    return seen;
}

// ---- Selection ----------------------------------------------------------------------------

const WIDTH = 3600, HEIGHT = 2000;
const SELECTED = [
    { center: [1000, 900], radii: [520, 400], angleDeg: 28, hole: { center: [1040, 870], radius: 90 } },
    { center: [2500, 1000], radii: [480, 420], angleDeg: 0, hole: { center: [2480, 1020], radius: 80 } }
];

function selectionHarness(t, { hasSelection = true, bits = 8 } = {}) {
    const mask = support.ellipseMask(WIDTH, HEIGHT, SELECTED);
    return makeHarness(t, { document: { width: WIDTH, height: HEIGHT, bits, hasSelection, selection: { x: 0, y: 0, width: WIDTH, height: HEIGHT, data: mask } } });
}

/** Assert a found areola against the truth that drew the selection. */
function assertFits(found, truth, label) {
    const record = found.record;
    assert.ok(Math.abs(record.areola.center[0] - truth.center[0]) <= 1, `${label} centre x ${record.areola.center[0]}`);
    assert.ok(Math.abs(record.areola.center[1] - truth.center[1]) <= 1, `${label} centre y ${record.areola.center[1]}`);
    assert.ok(Math.abs(record.areola.radii[0] - truth.radii[0]) <= 1, `${label} rx ${record.areola.radii[0]}`);
    assert.ok(Math.abs(record.areola.radii[1] - truth.radii[1]) <= 1, `${label} ry ${record.areola.radii[1]}`);
    assert.ok(Math.abs(record.areola.angleDeg - truth.angleDeg) <= 0.5, `${label} angle ${record.areola.angleDeg}`);
    // The nipple is the hole of the selected part.
    assert.ok(Math.hypot(record.nipple[0] - truth.hole.center[0], record.nipple[1] - truth.hole.center[1]) <= 1.5, `${label} nipple ${record.nipple}`);
    assert.ok(Math.abs(record.nippleRadiusPx - truth.hole.radius) <= 1.5, `${label} nipple radius ${record.nippleRadiusPx}`);
    assert.equal(found.nipple.found, true);
    assert.equal(found.nipple.source, 'hole in the selection');
    assert.equal(found.confidence.level, 'high');
}

for (const componentSize of [8, 16]) {
    test(`selection: two ellipses with holes, one rotated 28 degrees, read at a reduced size (${componentSize}-bit samples)`, async t => {
        const harness = selectionHarness(t);
        harness.fake.state.selectionComponentSize = componentSize;
        const seen = watchReadFiles(harness);
        const taskId = await harness.startTask();
        const layersBefore = harness.fake.doc.layers.length;

        const answer = await harness.call(FIND, { task_id: taskId, source: 'selection' });
        assert.equal(answer.isError, false, answer.text);
        const found = answer.json;
        assert.equal(found.source, 'selection');
        assert.equal(found.areolas.length, 2);
        assertFits(found.areolas[0], SELECTED[0], 'areola 1');
        assertFits(found.areolas[1], SELECTED[1], 'areola 2');
        assert.equal(found.recommendation, 'apply');

        // The selection (about 2476 pixels wide) was read at 2048 pixels, not at full size.
        assert.deepEqual(found.read_area, { left: 504, top: 471, right: 2980, bottom: 1420 });
        assert.equal(found.read_size.width, 2048);
        assert.ok(found.read_size.height < 2048 && found.read_size.height > 700);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].magic, 'SKAR0001');
        assert.equal(seen[0].header.kind, 'selection');
        assert.equal(seen[0].header.componentSize, componentSize);
        assert.equal(seen[0].header.width, 2048);
        assert.equal(seen[0].sampleBytes, seen[0].header.width * seen[0].header.height * (componentSize / 8));
        assert.deepEqual(seen[0].header.sourceBounds, found.read_area);

        // Numbers only: nothing but measurements and hints reach the agent, and the document is unchanged.
        assert.equal(JSON.stringify(found).includes('SKAR0001'), false);
        assert.equal(harness.fake.doc.layers.length, layersBefore);
        assert.equal(harness.fake.state.historySteps.length, 0, 'a read changes nothing in the document');
        assert.deepEqual(readFilesIn(harness.dataFolder), [], 'the read file is deleted after the call');

        // What the agent gets is ready for ps_skin_texture_start.
        assert.deepEqual(found.fields.areolas, found.areolas.map(item => item.record));
        assert.equal(found.sources.geometry.kind, 'given');
        assert.equal(found.sources.nipple.kind, 'given');
        assert.equal(found.sources.scale.kind, 'estimated');
        assert.equal(found.sources.light.kind, 'default');
        assert.equal(found.light.azimuthDeg, 315);
        const expectedScale = (2 * (520 + 480) / 2) / 40;
        assert.ok(Math.abs(found.scale.px_per_mm - expectedScale) < 0.5, String(found.scale.px_per_mm));
        assert.equal(found.scale.kind, 'estimated');
    });
}

test('selection: no selection is refused with NO_SELECTION, nothing is left behind', async t => {
    const harness = selectionHarness(t, { hasSelection: false });
    const taskId = await harness.startTask();
    const answer = await harness.call(FIND, { task_id: taskId, source: 'selection' });
    assert.equal(answer.isError, true, answer.text);
    assert.equal(answer.json.error.code, 'NO_SELECTION');
    assert.deepEqual(readFilesIn(harness.dataFolder), []);
    assert.equal(harness.fake.state.historySteps.length, 0);
});

test('selection: stray specks are ignored and said so; one part without a hole is found without a nipple', async t => {
    const mask = support.ellipseMask(1200, 800, [
        { center: [600, 400], radii: [200, 150], angleDeg: -35 },
        { center: [100, 100], radii: [3, 3], angleDeg: 0 }
    ]);
    const harness = makeHarness(t, { document: { width: 1200, height: 800, selection: { x: 0, y: 0, width: 1200, height: 800, data: mask } } });
    const taskId = await harness.startTask();
    const answer = await harness.call(FIND, { task_id: taskId, source: 'selection' });
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.json.areolas.length, 1);
    assert.match(answer.json.notes.join(' '), /ignored as stray/);
    const found = answer.json.areolas[0];
    assert.ok(Math.abs(found.record.areola.angleDeg - (-35)) <= 0.5);
    assert.equal(found.nipple.found, false);
    assert.deepEqual(found.record.nipple, found.record.areola.center);
    assert.equal(answer.json.sources.nipple.kind, 'default');
    assert.match(answer.json.next_step, /hide the nipple layers/);
});

test('selection: an empty selection (no bounds) is refused with NO_SELECTION', async t => {
    const harness = makeHarness(t, { document: { width: 600, height: 400, selection: { x: 0, y: 0, width: 600, height: 400, data: new Uint8Array(600 * 400) } } });
    const taskId = await harness.startTask();
    const answer = await harness.call(FIND, { task_id: taskId, source: 'selection' });
    // Photoshop reports no bounds for an empty selection, so the read refuses before any pixel is read.
    assert.equal(answer.isError, true, answer.text);
    assert.equal(answer.json.error.code, 'NO_SELECTION');
});

// ---- Image --------------------------------------------------------------------------------

const PICTURE = { width: 1200, height: 900, center: [600, 450], radii: [160, 110], angleDeg: 25, nipple: [612, 440], nippleRadius: 30, lightAzimuthDeg: 315 };

function imageHarness(t) {
    // A patient response budget: the hand-off test applies and must not get "still writing" on a busy machine.
    const harness = makeHarness(t, { limits: { responseBudgetMs: 120_000 }, document: { width: PICTURE.width, height: PICTURE.height } });
    harness.fake.state.documentPixels = support.areolaPicture(PICTURE);
    return harness;
}

function assertImageFit(found) {
    const R = PICTURE.radii[0];
    const record = found.record;
    assert.ok(Math.hypot(record.areola.center[0] - PICTURE.center[0], record.areola.center[1] - PICTURE.center[1]) <= 0.02 * R,
        `centre ${record.areola.center}`);
    assert.ok(Math.abs(record.areola.radii[0] - PICTURE.radii[0]) <= 0.03 * PICTURE.radii[0], `rx ${record.areola.radii[0]}`);
    assert.ok(Math.abs(record.areola.radii[1] - PICTURE.radii[1]) <= 0.03 * PICTURE.radii[1], `ry ${record.areola.radii[1]}`);
    assert.ok(Math.abs(record.areola.angleDeg - PICTURE.angleDeg) <= 3, `angle ${record.areola.angleDeg}`);
    assert.equal(found.nipple.found, true);
    assert.ok(Math.hypot(record.nipple[0] - PICTURE.nipple[0], record.nipple[1] - PICTURE.nipple[1]) <= 3, `nipple ${record.nipple}`);
    assert.ok(Math.abs(record.nippleRadiusPx - PICTURE.nippleRadius) <= 4, `nipple radius ${record.nippleRadiusPx}`);
}

test('image: a clean picture with hints, the file is written, read and deleted, and the answer holds numbers only', async t => {
    const harness = imageHarness(t);
    const seen = watchReadFiles(harness);
    const taskId = await harness.startTask();
    const answer = await harness.call(FIND, { task_id: taskId, source: 'image', hints: [{ center: [590, 460], radius: 140 }] });
    assert.equal(answer.isError, false, answer.text);
    const found = answer.json;
    assert.equal(found.areolas.length, 1);
    assertImageFit(found.areolas[0]);
    assert.equal(found.areolas[0].hinted, true);
    assert.equal(found.areolas[0].confidence.level, 'high');
    assert.equal(found.recommendation, 'apply');
    assert.equal(found.sources.geometry.kind, 'measured');
    assert.match(found.sources.geometry.note, /hints/);
    assert.equal(found.sources.nipple.kind, 'measured');
    assert.equal(found.sources.scale.kind, 'estimated');
    assert.ok(['default', 'estimated'].includes(found.sources.light.kind));
    assert.ok(found.scale.px_per_mm > 0);

    // The area read is around the hint, as 8-bit RGB, inside the document.
    assert.equal(harness.fake.state.getPixelsCalls, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].header.kind, 'image');
    assert.equal(seen[0].header.components, 3);
    assert.equal(seen[0].header.componentSize, 8);
    assert.ok(found.read_area.left >= 0 && found.read_area.top >= 0 && found.read_area.right <= PICTURE.width && found.read_area.bottom <= PICTURE.height);
    assert.ok(found.read_area.right - found.read_area.left < PICTURE.width, 'only the neighbourhood of the hint was read');
    assert.equal(seen[0].sampleBytes, seen[0].header.width * seen[0].header.height * 3);
    assert.deepEqual(readFilesIn(harness.dataFolder), [], 'the read file is deleted after the call');
    assert.equal(harness.fake.state.historySteps.length, 0);
    assert.equal(harness.fake.doc.layers.length, 1);
});

test('image: without hints the same picture is found, but the answer is never "apply"', async t => {
    const harness = imageHarness(t);
    const taskId = await harness.startTask();
    const answer = await harness.call(FIND, { task_id: taskId, source: 'image' });
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.json.areolas.length, 1);
    assertImageFit(answer.json.areolas[0]);
    assert.equal(answer.json.areolas[0].hinted, false);
    assert.equal(answer.json.recommendation, 'apply_then_check');
    assert.match(answer.json.next_step, /without hints/);
    assert.deepEqual(answer.json.read_area, { left: 0, top: 0, right: PICTURE.width, bottom: PICTURE.height });
    assert.match(answer.json.sources.geometry.note, /without hints/);
});

test('image: a picture without an areola finds nothing and asks for a selection', async t => {
    const harness = makeHarness(t, { document: { width: 600, height: 400 } });
    harness.fake.state.documentPixels = { width: 600, height: 400, data: new Uint8Array(600 * 400 * 3).fill(0).map((_, i) => [200, 150, 130][i % 3]) };
    const taskId = await harness.startTask();
    const answer = await harness.call(FIND, { task_id: taskId, source: 'image', hints: [{ center: [300, 200], radius: 60 }] });
    assert.equal(answer.isError, false, answer.text);
    assert.deepEqual(answer.json.areolas, []);
    assert.equal(answer.json.recommendation, 'ask_for_selection');
    assert.equal(answer.json.fields, undefined, 'nothing to hand to ps_skin_texture_start');
    assert.equal(answer.json.sources, undefined);
    assert.match(answer.json.next_step, /Elliptical Marquee/);
    assert.deepEqual(readFilesIn(harness.dataFolder), []);
});

test('find: bad arguments are refused before anything is read', async t => {
    const harness = imageHarness(t);
    const taskId = await harness.startTask();
    const scriptsBefore = harness.fake.state.scripts.length;
    const bad = [
        { source: 'photo' },
        { source: 'selection', hints: [{ center: [1, 2] }] },
        { source: 'image', hints: [] },
        { source: 'image', hints: [{ center: [1, 2] }, { center: [3, 4] }, { center: [5, 6] }] },
        { source: 'image', hints: [{ center: [1] }] },
        { source: 'image', hints: [{ center: [1, 2], radius: 2 }] },
        { source: 'image', hints: [{ center: [1, 2], colour: 'pink' }] },
        { source: 'image', area: { x: 0, y: 0, width: 4, height: 100 } },
        { source: 'image', area: { x: 0.5, y: 0, width: 40, height: 100 } }
    ];
    for (const args of bad) {
        const answer = await harness.call(FIND, { task_id: taskId, ...args });
        assert.equal(answer.isError, true, JSON.stringify(args));
        assert.ok(answer.json && answer.json.error && answer.json.error.code, JSON.stringify(args) + answer.text);
    }
    assert.equal(harness.fake.state.scripts.length, scriptsBefore, 'no script was sent for a refused request');
});

test('find: a read file that Photoshop wrote wrongly is refused with READ_FAILED and still deleted', async t => {
    const harness = imageHarness(t);
    harness.fake.state.afterScript = (answer, payload) => {
        if (payload.code.includes('for local areola measurement')) {
            const [name] = readFilesIn(harness.dataFolder);
            const file = path.join(harness.dataFolder, name);
            fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 500));
        }
        return answer;
    };
    const taskId = await harness.startTask();
    const answer = await harness.call(FIND, { task_id: taskId, source: 'image', hints: [{ center: [590, 460], radius: 140 }] });
    assert.equal(answer.isError, true, answer.text);
    assert.equal(answer.json.error.code, 'READ_FAILED');
    assert.match(answer.json.error.message, /Nothing was changed/);
    assert.deepEqual(readFilesIn(harness.dataFolder), [], 'a broken file is removed as well');
});

// ---- Hand-off to ps_skin_texture_start -----------------------------------------------------

const missingBinaries = support.missingAreolaBinaryReason();

test('find -> start -> apply: fields and sources from the image search are used as they are', { skip: missingBinaries }, async t => {
    const harness = imageHarness(t);
    const taskId = await harness.startTask();
    const found = await harness.call(FIND, { task_id: taskId, source: 'image', hints: [{ center: [590, 460], radius: 140 }] });
    assert.equal(found.isError, false, found.text);
    const { fields, sources, scale } = found.json;
    assert.ok(fields && fields.areolas.length === 1);

    const start = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'from-find', recipe: 'areola_three_v1',
        rect: { x: 300, y: 200, width: 600, height: 500 }, px_per_mm: scale.px_per_mm, fields, sources
    });
    assert.equal(start.isError, false, start.text);
    const ready = await harness.waitForPhase(taskId, start.json.job_id, 'ready');
    // The job repeats what the search said about where the parameters came from.
    assert.equal(ready.sources.geometry.kind, 'measured');
    assert.equal(ready.sources.nipple.kind, 'measured');
    assert.equal(ready.sources.scale.kind, 'estimated');
    assert.deepEqual(ready.areolas.records, fields.areolas);
    const applied = await harness.call('ps_skin_texture_apply', {
        task_id: taskId, job_id: start.json.job_id, mask_source: { kind: 'selection' }
    });
    assert.equal(applied.isError, false, applied.text);
    assert.equal(applied.json.phase, 'applied');
    const root = harness.fake.findLayerByName(`Areolas [${start.json.job_id}]`);
    assert.ok(root);
    assert.deepEqual(root.layers.map(group => group.name), support.AREOLA_VARIANTS.map(v => v.group));
    // The areola layers cover the areola that was found (its centre lies inside their bounds).
    const bounds = harness.fake.findLayerByName('Nipple').bounds;
    assert.ok(bounds.left <= 600 && bounds.right >= 600 && bounds.top <= 450 && bounds.bottom >= 450);
});
