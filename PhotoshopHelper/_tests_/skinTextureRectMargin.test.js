'use strict';

/**
 * The margin Helper adds around the rect of a body part job (task31): margin = max(ceil(40 mm x
 * px_per_mm), 32 px) on every side, clipped to the document, reduced (never the agent's rect) when
 * the widened rect would pass the rect limits. widenRect is tested directly; the rest runs the
 * real apply script on the fake Photoshop with the real private binaries (skipped with a reason
 * in a checkout without them).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bodyPartJob = require('../skin-texture/body-part-job');
const { createAgentService, resolveAgentPaths } = require('../agent');
const { makeHarness, createFakePhotoshop } = require('./skinTextureFakes');
const support = require('./skinTextureAreolasSupport');
const { missingBinaryReason } = require('./skinTextureTestSupport');

const needsCore = { skip: missingBinaryReason() };
const needsAll = { skip: support.missingAllBinariesReason() };
const PATIENT = { responseBudgetMs: 120_000 };
const DEFAULTS = Object.freeze({ marginMm: 40, minMarginPx: 32 });
// The same limits the product states: 4096 x 4096 pixels and 8192 per side.
const MAX_PIXELS = 4096 * 4096;
const MAX_SIDE = 8192;

// ---- widenRect, directly -----------------------------------------------------------------------

function widened(rect, pxPerMm, document, options = DEFAULTS, bodyPart = { code: 'neck', name: 'Neck' }) {
    const request = { bodyPart, rect: { ...rect }, pxPerMm };
    bodyPartJob.widenRect(request, document, options);
    return request;
}

test('widenRect: margin is 40 mm at the scale, at least 32 px, on every side', () => {
    const doc = { width: 3000, height: 3000 };
    const rect = { x: 1000, y: 1000, width: 100, height: 80 };
    for (const [pxPerMm, margin] of [[1.05, 42], [0.5, 32], [3, 120], [0.8, 32], [10, 400]]) {
        const request = widened(rect, pxPerMm, doc);
        assert.deepEqual(request.rect, { x: 1000 - margin, y: 1000 - margin, width: 100 + 2 * margin, height: 80 + 2 * margin }, `${pxPerMm} px/mm`);
        assert.deepEqual(request.requestedRect, rect);
        assert.deepEqual(request.rectMargin, { wanted_px: margin, used_px: margin, mm: 40, min_px: 32, reduced: false }, `${pxPerMm} px/mm`);
    }
});

test('widenRect: a margin that is not a whole pixel is rounded up', () => {
    // 40 x 1.234 = 49.36 and 40 x 1.25 = 50 exactly.
    const odd = widened({ x: 500, y: 500, width: 10, height: 10 }, 1.234, { width: 2000, height: 2000 });
    assert.equal(odd.rectMargin.used_px, 50);
    assert.deepEqual(odd.rect, { x: 450, y: 450, width: 110, height: 110 });
    assert.equal(widened({ x: 500, y: 500, width: 10, height: 10 }, 1.25, { width: 2000, height: 2000 }).rectMargin.used_px, 50);
});

test('widenRect: the widened rect is clipped to the document at every edge', () => {
    const doc = { width: 400, height: 300 };
    // Near the left and top edges: the margin of 120 cannot go below zero.
    const topLeft = widened({ x: 20, y: 30, width: 50, height: 40 }, 3, doc);
    assert.deepEqual(topLeft.rect, { x: 0, y: 0, width: 20 + 50 + 120, height: 30 + 40 + 120 });
    // Near the right and bottom edges.
    const bottomRight = widened({ x: 330, y: 250, width: 60, height: 40 }, 3, doc);
    assert.deepEqual(bottomRight.rect, { x: 330 - 120, y: 250 - 120, width: 400 - (330 - 120), height: 300 - (250 - 120) });
    // The margin figures are the wanted ones, not the clipped ones.
    assert.equal(bottomRight.rectMargin.used_px, 120);
    assert.equal(bottomRight.rectMargin.reduced, false, 'clipping by the document is not a reduction');
    // A rect that already fills the document stays as it is.
    const whole = widened({ x: 0, y: 0, width: 400, height: 300 }, 3, doc);
    assert.deepEqual(whole.rect, { x: 0, y: 0, width: 400, height: 300 });
});

test('widenRect: past 4096 x 4096 the margin is reduced, never the agent\'s rect', () => {
    const doc = { width: 6000, height: 6000 };
    const rect = { x: 1000, y: 1000, width: 4000, height: 4000 };
    const request = widened(rect, 3, doc);
    // 4000 + 2m <= 4096 gives m <= 48.
    assert.equal(request.rectMargin.wanted_px, 120);
    assert.equal(request.rectMargin.used_px, 48);
    assert.equal(request.rectMargin.reduced, true);
    assert.deepEqual(request.rect, { x: 952, y: 952, width: 4096, height: 4096 });
    assert.ok(request.rect.width * request.rect.height <= MAX_PIXELS);
    assert.deepEqual(request.requestedRect, rect, 'the agent\'s rect is kept as asked');
    // The agent's rect lies inside the widened one.
    assert.ok(request.rect.x <= rect.x && request.rect.y <= rect.y);
    assert.ok(request.rect.x + request.rect.width >= rect.x + rect.width && request.rect.y + request.rect.height >= rect.y + rect.height);
});

test('widenRect: a rect already at the limit gets no margin and says it was reduced', () => {
    const rect = { x: 100, y: 100, width: 4096, height: 4096 };
    const request = widened(rect, 3, { width: 6000, height: 6000 });
    assert.deepEqual(request.rect, rect);
    assert.equal(request.rectMargin.used_px, 0);
    assert.equal(request.rectMargin.wanted_px, 120);
    assert.equal(request.rectMargin.reduced, true);
});

test('widenRect: the limit of 8192 per side holds for a long thin rect', () => {
    const doc = { width: 9000, height: 2000 };
    const rect = { x: 500, y: 500, width: 8000, height: 100 };
    const request = widened(rect, 3, doc);
    // 8000 + 2m <= 8192 gives m <= 96; the pixel count is far below the limit.
    assert.equal(request.rectMargin.used_px, 96);
    assert.equal(request.rectMargin.reduced, true);
    assert.deepEqual(request.rect, { x: 404, y: 404, width: 8192, height: 292 });
    assert.ok(request.rect.width <= MAX_SIDE && request.rect.height <= MAX_SIDE);
    assert.ok(request.rect.width * request.rect.height <= MAX_PIXELS);
});

test('widenRect: called twice it widens only once', () => {
    const doc = { width: 1200, height: 1200 };
    const request = widened({ x: 500, y: 500, width: 64, height: 64 }, 3, doc);
    const once = JSON.parse(JSON.stringify(request));
    bodyPartJob.widenRect(request, doc, DEFAULTS);
    assert.deepEqual(JSON.parse(JSON.stringify(request)), once);
    // A retried probe that finds the document in another size widens from the agent's rect again.
    bodyPartJob.widenRect(request, { width: 600, height: 600 }, DEFAULTS);
    assert.deepEqual(request.requestedRect, { x: 500, y: 500, width: 64, height: 64 });
    assert.deepEqual(request.rect, { x: 380, y: 380, width: 220, height: 220 });
});

test('widenRect: without body_part nothing changes, and a rect outside the document is not widened', () => {
    const plain = widened({ x: 10, y: 10, width: 64, height: 64 }, 3, { width: 400, height: 400 }, DEFAULTS, null);
    assert.deepEqual(plain.rect, { x: 10, y: 10, width: 64, height: 64 });
    assert.equal(plain.requestedRect, undefined);
    assert.equal(plain.rectMargin, undefined);
    const outside = widened({ x: 380, y: 10, width: 64, height: 64 }, 3, { width: 400, height: 400 });
    assert.deepEqual(outside.rect, { x: 380, y: 10, width: 64, height: 64 }, 'normalizeForDocument refuses it as before');
    assert.equal(outside.rectMargin, undefined);
});

// ---- Lifecycle ---------------------------------------------------------------------------------

function documentSpec(extra = {}) {
    return {
        width: 1200, height: 1200, hasSelection: true, selection: { x: 520, y: 520, width: 40, height: 40 }, activeLayerName: 'Background',
        layerTree: [{ name: 'Background', kind: 'pixel', visible: true, opacity: 100 }],
        ...extra
    };
}

async function taskWithGuide(harness) {
    const taskId = await harness.startTask();
    const guide = await harness.call('ps_skin_texture_body_parts', { task_id: taskId });
    assert.equal(guide.isError, false, guide.text);
    return taskId;
}

async function computeJob(harness, taskId, requestId, args) {
    const start = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: requestId, ...args });
    assert.equal(start.isError, false, start.text);
    const ready = await harness.waitForPhase(taskId, start.json.job_id, 'ready');
    return { jobId: start.json.job_id, ready, start: start.json };
}

async function applyJob(harness, taskId, jobId, selection) {
    if (selection) harness.fake.doc.selection = selection;
    return harness.call('ps_skin_texture_apply', { task_id: taskId, job_id: jobId, mask_source: { kind: 'selection' } });
}

/** Bounds of the four texture layers inside the formula groups of a part folder or root group. */
function textureBounds(folder) {
    return folder.layers.flatMap(group => group.layers.map(layer => layer.bounds));
}

const boxOf = r => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });

for (const [pxPerMm, margin] of [[1.05, 42], [0.5, 32], [3, 120]]) {
    test(`margin ${margin} px at ${pxPerMm} px/mm: the view, the computation and the layer bounds use the widened rect`, needsCore, async t => {
        const harness = makeHarness(t, { limits: PATIENT, document: documentSpec() });
        const { fake } = harness;
        const taskId = await taskWithGuide(harness);
        const requested = { x: 500, y: 500, width: 64, height: 64 };
        const expected = { x: 500 - margin, y: 500 - margin, width: 64 + 2 * margin, height: 64 + 2 * margin };
        // Below 2 px/mm a body part needs the person's yes.
        const extra = pxPerMm < 2 ? { small_scale_confirmed: true } : {};
        const job = await computeJob(harness, taskId, 'm', { rect: requested, px_per_mm: pxPerMm, body_part: 'neck', ...extra });
        assert.deepEqual(job.start.rect, expected, 'the answer to start shows the widened rect');
        assert.deepEqual(job.ready.rect, expected);
        assert.deepEqual(job.ready.body_part.requested_rect, requested);
        assert.deepEqual(job.ready.body_part.rect_margin, { wanted_px: margin, used_px: margin, mm: 40, min_px: 32, reduced: false });
        assert.equal(job.ready.body_part.rect_margin_note, undefined);

        const applied = await applyJob(harness, taskId, job.jobId);
        assert.equal(applied.isError, false, applied.text);
        assert.equal(applied.json.phase, 'applied');
        assert.deepEqual(applied.json.rect, expected);
        const folder = fake.findLayerById(applied.json.apply.structure.mainGroup.id);
        const bounds = textureBounds(folder);
        assert.equal(bounds.length, 4);
        for (const b of bounds) assert.deepEqual(b, boxOf(expected));
        // The same reading from what the apply answer reports for each layer.
        for (const layer of applied.json.apply.layers) {
            if (layer.bounds) assert.deepEqual(layer.bounds, boxOf(expected));
        }
    });
}

test('margin: clipped by the document edges, layers cover the clipped rect', needsCore, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: documentSpec({ width: 500, height: 400, selection: { x: 10, y: 10, width: 60, height: 60 } }) });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);
    // Left/top: the margin of 120 px is cut at 0.
    const topLeft = await computeJob(harness, taskId, 'tl', { rect: { x: 20, y: 30, width: 64, height: 64 }, px_per_mm: 3, body_part: 'neck' });
    assert.deepEqual(topLeft.ready.rect, { x: 0, y: 0, width: 20 + 64 + 120, height: 30 + 64 + 120 });
    assert.equal(topLeft.ready.body_part.rect_margin.reduced, false);
    const tlApplied = await applyJob(harness, taskId, topLeft.jobId);
    assert.equal(tlApplied.json.phase, 'applied', tlApplied.text);
    for (const b of textureBounds(fake.findLayerById(tlApplied.json.apply.structure.mainGroup.id))) {
        assert.deepEqual(b, { left: 0, top: 0, right: 204, bottom: 214 });
    }
    // Right/bottom.
    const rect = { x: 420, y: 320, width: 70, height: 70 };
    const bottomRight = await computeJob(harness, taskId, 'br', { rect, px_per_mm: 3, body_part: 'arm' });
    assert.deepEqual(bottomRight.ready.rect, { x: 300, y: 200, width: 200, height: 200 });
    const brApplied = await applyJob(harness, taskId, bottomRight.jobId, { x: 410, y: 310, width: 80, height: 80 });
    assert.equal(brApplied.json.phase, 'applied', brApplied.text);
    for (const b of textureBounds(fake.findLayerById(brApplied.json.apply.structure.mainGroup.id))) {
        assert.deepEqual(b, { left: 300, top: 200, right: 500, bottom: 400 });
    }
});

test('margin: the limits override the defaults', needsCore, async t => {
    const harness = makeHarness(t, { limits: { ...PATIENT, bodyRectMarginMm: 10, bodyRectMinMarginPx: 5 }, document: documentSpec() });
    const taskId = await taskWithGuide(harness);
    const requested = { x: 500, y: 500, width: 64, height: 64 };
    const job = await computeJob(harness, taskId, 'o', { rect: requested, px_per_mm: 3, body_part: 'neck' });
    assert.deepEqual(job.ready.body_part.rect_margin, { wanted_px: 30, used_px: 30, mm: 10, min_px: 5, reduced: false });
    assert.deepEqual(job.ready.rect, { x: 470, y: 470, width: 124, height: 124 });
    // The minimum only counts when the millimetres give less.
    const small = await computeJob(harness, taskId, 'o2', { rect: { x: 100, y: 100, width: 64, height: 64 }, px_per_mm: 2, body_part: 'neck', part_name: 'Neck 2' });
    assert.equal(small.ready.body_part.rect_margin.used_px, 20);
    // 10 mm x 0.25 px/mm = 2.5, so the 5 px minimum applies.
    const tiny = await computeJob(harness, taskId, 'o3', { rect: { x: 700, y: 700, width: 64, height: 64 }, px_per_mm: 0.25, body_part: 'neck', part_name: 'Neck 3', small_scale_confirmed: true });
    assert.equal(tiny.ready.body_part.rect_margin.used_px, 5);
    assert.deepEqual(tiny.ready.rect, { x: 695, y: 695, width: 74, height: 74 });
});

test('margin: a job without body_part is not widened', needsCore, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: documentSpec() });
    const { fake } = harness;
    const taskId = await harness.startTask();
    const requested = { x: 500, y: 500, width: 64, height: 64 };
    const job = await computeJob(harness, taskId, 'plain', { rect: requested, px_per_mm: 3 });
    assert.deepEqual(job.ready.rect, requested);
    assert.equal(job.ready.body_part, undefined);
    assert.equal(JSON.stringify(job.ready).includes('requested_rect'), false);
    assert.equal(JSON.stringify(job.ready).includes('rect_margin'), false);
    const applied = await applyJob(harness, taskId, job.jobId);
    assert.equal(applied.json.phase, 'applied', applied.text);
    for (const b of textureBounds(fake.findLayerById(applied.json.apply.structure.mainGroup.id))) assert.deepEqual(b, boxOf(requested));
});

test('margin: the mask stays black over the margin outside the selection and the write succeeds', needsCore, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: documentSpec() });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);
    const requested = { x: 500, y: 500, width: 64, height: 64 };
    const job = await computeJob(harness, taskId, 'mask', { rect: requested, px_per_mm: 3, body_part: 'neck' });
    // The selection is the agent's rect only: the whole margin lies outside it.
    const applied = await applyJob(harness, taskId, job.jobId, requested);
    assert.equal(applied.isError, false, applied.text);
    assert.equal(applied.json.phase, 'applied');
    assert.notEqual(applied.json.apply.code, 'MASK_OUTSIDE_NOT_HIDDEN');
    const folder = fake.findLayerById(applied.json.apply.structure.mainGroup.id);
    assert.ok(folder.mask);
    const m = folder.mask;
    const at = (x, y) => {
        const b = m.bounds;
        const inPatch = b && x >= b.left && x < b.right && y >= b.top && y < b.bottom;
        if (!inPatch) return m.outside === undefined ? 255 : m.outside;
        return m.data ? m.data[(y - b.top) * (b.right - b.left) + (x - b.left)] : 255;
    };
    assert.equal(at(530, 530), 255, 'inside the selection the mask is open');
    for (const [x, y] of [[400, 400], [460, 530], [530, 470], [570, 570], [680, 680], [381, 381]]) {
        assert.equal(at(x, y), 0, `the margin at ${x},${y} is black`);
    }
});

test('margin: the idempotency key uses the agent\'s rect', needsCore, async t => {
    const harness = makeHarness(t, { document: documentSpec() });
    const taskId = await taskWithGuide(harness);
    const args = { rect: { x: 500, y: 500, width: 64, height: 64 }, px_per_mm: 3, body_part: 'neck' };
    const first = await computeJob(harness, taskId, 'same', args);
    const again = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'same', ...args });
    assert.equal(again.isError, false, again.text);
    assert.equal(again.json.job_id, first.jobId);
    assert.equal(again.json.repeated_request, true);
    // The widened rect given as the agent's own rect is another request.
    const other = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'same', ...args, rect: first.ready.rect });
    assert.equal(other.isError, true);
    assert.equal(other.json.error.code, 'REQUEST_ID_CONFLICT');
});

test('margin: a reduced margin is reported with a note', needsCore, async t => {
    const harness = makeHarness(t, { limits: { ...PATIENT, bodyRectMarginMm: 40 }, document: documentSpec({ width: 4300, height: 4300 }) });
    const taskId = await taskWithGuide(harness);
    // The widened rect would be 4000 + 240 = 4240 per side, past 4096: the margin shrinks, the rect does not.
    // Computing 4096 x 4096 pixels twice is slow, so only the answer to start is looked at, then the job is cancelled.
    const start = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'big', rect: { x: 100, y: 100, width: 4000, height: 4000 }, px_per_mm: 3, body_part: 'back'
    });
    assert.equal(start.isError, false, start.text);
    assert.deepEqual(start.json.body_part.requested_rect, { x: 100, y: 100, width: 4000, height: 4000 });
    assert.deepEqual(start.json.body_part.rect_margin, { wanted_px: 120, used_px: 48, mm: 40, min_px: 32, reduced: true });
    assert.match(start.json.body_part.rect_margin_note, /120/);
    assert.match(start.json.body_part.rect_margin_note, /48/);
    assert.deepEqual(start.json.rect, { x: 52, y: 52, width: 4096, height: 4096 });
    await harness.call('ps_skin_texture_cancel', { task_id: taskId, job_id: start.json.job_id });
});

test('margin: a chest with an areola band that sticks out of the agent\'s rect (observed behaviour)', needsAll, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: { width: 800, height: 600 } });
    const taskId = await taskWithGuide(harness);
    const one = [support.twoAreolas()[0]];
    // The areola band (about 300 +- 62, 250 +- 47) sticks out of this rect on every side.
    const rect = { x: 280, y: 230, width: 40, height: 40 };
    const plain = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'plain', rect, px_per_mm: 4, fields: { areolas: one }
    });
    const chest = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'chest', rect, px_per_mm: 4, body_part: 'chest', fields: { areolas: one }
    });
    assert.equal(plain.json.error.code, 'AREOLA_OUTSIDE_RECT', 'without body_part the band outside the rect is refused as before');
    assert.equal(chest.isError, false, chest.text);
    assert.deepEqual(chest.json.body_part.requested_rect, rect);
    const ready = await harness.waitForPhase(taskId, chest.json.job_id, 'ready');
    // 40 mm x 4 px/mm = 160 px on every side.
    assert.deepEqual(ready.rect, { x: 120, y: 70, width: 360, height: 360 });
});

// ---- Published texts ---------------------------------------------------------------------------

test('start description names the margin; the guide is version 3 or more', needsCore, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-margin-'));
    const dataFolder = path.join(root, 'PluginData');
    fs.mkdirSync(dataFolder);
    const fake = createFakePhotoshop({ dataFolder });
    const service = createAgentService({
        getBridge: () => fake.bridge,
        paths: resolveAgentPaths({ resourcesPath: root, userDataPath: root, downloadedKnowledgeBasePath: null }),
        isJournalEnabled: () => false,
        logger: { info() {}, warn() {}, error() {} },
        skinTexture: {}
    });
    t.after(async () => {
        await service.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const tools = service.tools.list();
    const start = tools.find(tool => tool.name === 'ps_skin_texture_start');
    assert.match(start.description, /40 mm/);
    assert.match(start.description, /32 px/);
    const status = tools.find(tool => tool.name === 'ps_skin_texture_status');
    assert.match(status.description, /requested_rect/);
    assert.match(status.description, /rect_margin/);

    const started = await service.tools.call('ps_start_task', { intent: 'add skin texture' });
    const taskId = started.content[0].text.match(/(task-[a-f0-9]+)/)[1];
    const guide = JSON.parse((await service.tools.call('ps_skin_texture_body_parts', { task_id: taskId })).content[0].text);
    assert.ok(guide.guide_version >= 3);
    assert.match(guide.folders.join(' '), /Do not add a margin of your own/);
});
