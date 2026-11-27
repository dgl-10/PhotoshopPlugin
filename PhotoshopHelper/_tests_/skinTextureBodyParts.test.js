'use strict';

/**
 * Skin texture by body parts (task31): request checks, the zone rule, the guide and scale gates,
 * the common "Skin" group written by apply (first part creates it, later parts go inside it with
 * skin_group_id), the refusals of the Photoshop script, rollback, and the published tools.
 *
 * The apply tests run the real apply script on the fake Photoshop (skinTextureFakes.js) with the
 * real private binaries; they are skipped with a reason in a checkout that lacks them. The request
 * checks, the zone rule and the tool schemas need no binaries.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const adapter = require('../skin-texture/core-adapter');
const recipeCatalog = require('../skin-texture/recipe-catalog');
const { createAgentService, resolveAgentPaths } = require('../agent');
const { makeHarness, createFakePhotoshop } = require('./skinTextureFakes');
const support = require('./skinTextureAreolasSupport');
const { missingBinaryReason } = require('./skinTextureTestSupport');
const { IN_DEVELOPMENT_CODE } = require('../skin-texture/availability');

const missingCore = missingBinaryReason();
const missingAll = support.missingAllBinariesReason();
const needsCore = { skip: missingCore };
const needsAll = { skip: missingAll };

// An apply waits for its outcome instead of answering "still writing" when the machine is busy.
const PATIENT = { responseBudgetMs: 120_000 };
const BODY_PART_WORDS = ['face', 'neck', 'chest', 'abdomen', 'back', 'buttocks', 'arm', 'hand_dorsal', 'leg', 'foot_dorsal', 'scalp'];
const FACE = Object.freeze({ eyes: [[25, 30], [55, 30]], noseTip: [40, 45], mouth: [[30, 58], [50, 58]], chin: [40, 70] });
const BASE = Object.freeze({ rect: { x: 10, y: 10, width: 64, height: 64 }, px_per_mm: 3 });

// ---- 1. Request checks --------------------------------------------------------------------------

/** Assert that checkRequestShape refuses the arguments with this code. */
function refused(args, code) {
    assert.throws(() => adapter.checkRequestShape({ ...BASE, ...args }), error => {
        assert.equal(error.code, code, error.message);
        return true;
    });
}

test('request: without body_part there is no bodyPart and the key does not mention it', () => {
    const request = adapter.checkRequestShape({ ...BASE });
    assert.equal(request.bodyPart, undefined);
    assert.equal('smallScaleConfirmed' in request, false);
    assert.ok(!request.key.includes('bodyPart'));
});

test('request: body_part enters the key, small_scale_confirmed and a repeated call do not change it', () => {
    const plain = adapter.checkRequestShape({ ...BASE, body_part: 'neck' });
    assert.ok(plain.key.includes('bodyPart'));
    assert.ok(plain.key.includes('neck'));
    assert.deepEqual(plain.bodyPart, { code: 'neck', name: 'Neck' });
    assert.equal(plain.smallScaleConfirmed, false);
    const confirmed = adapter.checkRequestShape({ ...BASE, body_part: 'neck', small_scale_confirmed: true });
    assert.equal(confirmed.key, plain.key, 'the person\'s yes is not part of what is computed');
    assert.equal(confirmed.smallScaleConfirmed, true);
    assert.equal(adapter.checkRequestShape({ ...BASE, body_part: 'neck', small_scale_confirmed: false }).key, plain.key);
    assert.notEqual(adapter.checkRequestShape({ ...BASE, body_part: 'arm' }).key, plain.key);
    assert.notEqual(plain.key, adapter.checkRequestShape({ ...BASE }).key);
});

test('request: every published body part word is accepted', () => {
    for (const word of BODY_PART_WORDS) {
        assert.equal(adapter.checkRequestShape({ ...BASE, body_part: word }).bodyPart.code, word);
    }
});

test('request: part_name and small_scale_confirmed need body_part', () => {
    refused({ part_name: 'Arm L' }, 'INVALID_BODY_PART');
    refused({ small_scale_confirmed: true }, 'INVALID_BODY_PART');
    refused({ small_scale_confirmed: false }, 'INVALID_BODY_PART');
});

test('request: small_scale_confirmed must be a boolean', () => {
    for (const value of ['yes', 1, 0, null, {}]) {
        refused({ body_part: 'neck', small_scale_confirmed: value }, 'INVALID_BODY_PART');
    }
});

test('request: an unknown or non-string body part word is refused', () => {
    refused({ body_part: 'knee' }, 'INVALID_BODY_PART');
    refused({ body_part: '' }, 'INVALID_BODY_PART');
    refused({ body_part: 5 }, 'INVALID_BODY_PART');
    refused({ body_part: ['neck'] }, 'INVALID_BODY_PART');
});

test('request: places that get no texture are refused with NO_TEXTURE_ZONE', () => {
    for (const word of ['palm', 'sole', 'lips', 'eyes', 'genitals', 'areola']) {
        refused({ body_part: word }, 'NO_TEXTURE_ZONE');
    }
    // The refusal explains itself.
    assert.throws(() => adapter.checkRequestShape({ ...BASE, body_part: 'areola' }), error => /fields\.areolas/.test(error.message));
});

test('request: body_part with recipe areola_v1 is refused', () => {
    refused({ body_part: 'chest', recipe: 'areola_v1', fields: { areolas: support.twoAreolas() } }, 'INVALID_BODY_PART');
});

test('request: fields.face belongs to the face only, fields.areolas to the chest only', () => {
    refused({ body_part: 'neck', fields: { face: FACE } }, 'INVALID_FIELDS');
    assert.equal(adapter.checkRequestShape({ ...BASE, body_part: 'face', fields: { face: FACE } }).bodyPart.code, 'face');
    refused({ body_part: 'arm', fields: { areolas: support.twoAreolas() } }, 'INVALID_FIELDS');
    assert.equal(adapter.checkRequestShape({ ...BASE, body_part: 'chest', fields: { areolas: support.twoAreolas() } }).bodyPart.code, 'chest');
});

test('request: part_name is checked and trimmed, the default folder name comes from the body part', () => {
    refused({ body_part: 'arm', part_name: '' }, 'INVALID_BODY_PART');
    refused({ body_part: 'arm', part_name: '   ' }, 'INVALID_BODY_PART');
    refused({ body_part: 'arm', part_name: 'x'.repeat(41) }, 'INVALID_BODY_PART');
    refused({ body_part: 'arm', part_name: 'Arm [L]' }, 'INVALID_BODY_PART');
    refused({ body_part: 'arm', part_name: 'Arm ]' }, 'INVALID_BODY_PART');
    refused({ body_part: 'arm', part_name: 'Arm\nL' }, 'INVALID_BODY_PART');
    refused({ body_part: 'arm', part_name: 7 }, 'INVALID_BODY_PART');
    assert.equal(adapter.checkRequestShape({ ...BASE, body_part: 'arm', part_name: 'x'.repeat(40) }).bodyPart.name, 'x'.repeat(40));
    assert.equal(adapter.checkRequestShape({ ...BASE, body_part: 'arm', part_name: '  Arm L ' }).bodyPart.name, 'Arm L');
    assert.equal(adapter.checkRequestShape({ ...BASE, body_part: 'neck' }).bodyPart.name, 'Neck');
    assert.equal(adapter.checkRequestShape({ ...BASE, body_part: 'face' }).bodyPart.name, 'Face');
    // A part name changes the key: the folder is part of what is written.
    assert.notEqual(adapter.checkRequestShape({ ...BASE, body_part: 'arm', part_name: 'Arm L' }).key,
        adapter.checkRequestShape({ ...BASE, body_part: 'arm', part_name: 'Arm R' }).key);
});

test('request: the word is read without regard to case and surrounding spaces', () => {
    const request = adapter.checkRequestShape({ ...BASE, body_part: ' Neck ' });
    assert.equal(request.bodyPart.code, 'neck');
    assert.equal(request.bodyPart.name, 'Neck');
    const upper = adapter.checkRequestShape({ ...BASE, body_part: 'Neck' });
    assert.equal(upper.bodyPart.code, 'neck');
    assert.equal(upper.key, adapter.checkRequestShape({ ...BASE, body_part: 'neck' }).key);
});

// ---- 2. Zone rule -------------------------------------------------------------------------------

test('zone: the current formulas give "cheek" for every body part', () => {
    for (const formula of Object.values(recipeCatalog.FORMULA_DEFINITIONS)) {
        assert.equal(Array.isArray(formula.zones), false, `${formula.id} does not list zones yet`);
        for (const word of [...BODY_PART_WORDS, null]) {
            assert.equal(recipeCatalog.zoneFor(formula, word), 'cheek', `${formula.id} / ${word}`);
        }
    }
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    for (const id of Object.keys(recipeCatalog.FORMULA_DEFINITIONS)) {
        const plain = recipeCatalog.resolveFormulaParams(id, { width: 100, height: 100 }, rect, 3, {}, null);
        for (const word of BODY_PART_WORDS) {
            const params = recipeCatalog.resolveFormulaParams(id, { width: 100, height: 100 }, rect, 3, {}, null, word);
            assert.equal(params.zone, 'cheek', `${id} / ${word}`);
            assert.deepEqual(params, plain, 'a body part changes nothing the formula receives');
        }
    }
});

test('zone: a formula that lists zones gets the body part only when it is listed', () => {
    const formula = { id: 'future', zones: ['neck'] };
    assert.equal(recipeCatalog.zoneFor(formula, 'neck'), 'neck');
    assert.equal(recipeCatalog.zoneFor(formula, 'arm'), 'cheek');
    assert.equal(recipeCatalog.zoneFor(formula, null), 'cheek');
    assert.equal(recipeCatalog.zoneFor(formula), 'cheek');
    assert.equal(recipeCatalog.zoneFor({ id: 'other', zones: 'neck' }, 'neck'), 'cheek', 'zones must be an array');
});

// ---- Helpers for the lifecycle tests ------------------------------------------------------------

/** A document with a hidden protected group and a Background, Background active. */
function sceneDocument(extra = {}) {
    return {
        width: 400, height: 400, hasSelection: true,
        selection: { x: 20, y: 20, width: 100, height: 100 },
        activeLayerName: 'Background',
        layerTree: [
            { name: 'Protected', kind: 'group', visible: false, opacity: 73, blendMode: 'passThrough',
                children: [{ name: 'Inner', kind: 'pixel', visible: false, opacity: 81 }] },
            { name: 'Background', kind: 'pixel', visible: true, opacity: 100 }
        ],
        ...extra
    };
}

/** Start a task and read the guide in it. */
async function taskWithGuide(harness) {
    const taskId = await harness.startTask();
    const guide = await harness.call('ps_skin_texture_body_parts', { task_id: taskId });
    assert.equal(guide.isError, false, guide.text);
    return taskId;
}

/** Start a job and wait until it is ready; returns its id and ready status. */
async function computeJob(harness, taskId, requestId, extra = {}) {
    const start = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: requestId, ...BASE, ...extra });
    assert.equal(start.isError, false, start.text);
    const ready = await harness.waitForPhase(taskId, start.json.job_id, 'ready');
    return { jobId: start.json.job_id, ready };
}

/** Apply a job from the document selection, with an optional new selection and skin_group_id. */
async function applyJob(harness, taskId, jobId, { selection, skinGroupId } = {}) {
    if (selection) harness.fake.doc.selection = selection;
    const args = { task_id: taskId, job_id: jobId, mask_source: { kind: 'selection' } };
    if (skinGroupId !== undefined) args.skin_group_id = skinGroupId;
    return harness.call('ps_skin_texture_apply', args);
}

const SECOND_RECT = { x: 150, y: 150, width: 64, height: 64 };
const SECOND_SELECTION = { x: 140, y: 140, width: 90, height: 90 };

/** Recursive snapshot of a layer tree keeping only layers whose id is in `known`. */
function snapshotKnown(layers, known) {
    return Array.from(layers || []).filter(layer => known.has(layer.id)).map(layer => ({
        id: layer.id, name: layer.name, kind: layer.kind, visible: layer.visible, opacity: layer.opacity,
        blendMode: String(layer.blendMode), parentId: layer.parent ? layer.parent.id : null,
        hasMask: Boolean(layer.mask), children: snapshotKnown(layer.layers, known)
    }));
}

const idsOf = layers => new Set(support.flattenLayers(layers).map(layer => layer.id));
const namesOf = group => group.layers.map(layer => layer.name);

/** First body part applied: returns { taskId, jobId, skinId } with the first part on the document. */
async function firstPart(harness, extra = {}) {
    const taskId = await taskWithGuide(harness);
    const { jobId } = await computeJob(harness, taskId, 'first', { body_part: 'neck', ...extra });
    const applied = await applyJob(harness, taskId, jobId);
    assert.equal(applied.json.phase, 'applied', applied.text);
    return { taskId, jobId, skinId: applied.json.apply.structure.skinGroup.id, applied };
}

// ---- 3. Guide gate ------------------------------------------------------------------------------

test('guide gate: a body part start is refused until the guide was read, and nothing reaches Photoshop', needsCore, async t => {
    const harness = makeHarness(t, { document: sceneDocument() });
    const { fake } = harness;
    const taskId = await harness.startTask();
    const scriptsBefore = fake.state.scripts.length;
    const refusedStart = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'n1', ...BASE, body_part: 'neck' });
    assert.equal(refusedStart.isError, true);
    assert.equal(refusedStart.json.error.code, 'BODY_PARTS_GUIDE_NOT_READ');
    assert.match(refusedStart.json.error.message, /ps_skin_texture_body_parts/);
    assert.equal(fake.state.scripts.length, scriptsBefore, 'no probe script was sent');
    assert.equal(fake.doc.layers.length, 2);

    // A request without body_part is never gated.
    const plain = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'plain', ...BASE });
    assert.equal(plain.isError, false, plain.text);
    await harness.waitForPhase(taskId, plain.json.job_id, 'ready');
    const scriptsBeforeGuide = fake.state.scripts.length;

    const guide = await harness.call('ps_skin_texture_body_parts', { task_id: taskId });
    assert.equal(guide.isError, false, guide.text);
    assert.ok(guide.json && guide.json.guide_version >= 1);
    assert.ok(guide.json.parts.some(part => part.body_part === 'neck'));
    assert.equal(fake.state.scripts.length, scriptsBeforeGuide, 'reading the guide sends nothing to Photoshop');

    // The same request_id that was refused is now accepted: the refusal used nothing up.
    const accepted = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'n1', ...BASE, body_part: 'neck' });
    assert.equal(accepted.isError, false, accepted.text);
    assert.equal(accepted.json.body_part.body_part, 'neck');
    assert.equal(accepted.json.body_part.folder_name, 'Neck');
    await harness.waitForPhase(taskId, accepted.json.job_id, 'ready');
});

test('guide gate: a new task needs the guide again', needsCore, async t => {
    const harness = makeHarness(t, { document: sceneDocument() });
    const first = await taskWithGuide(harness);
    const { jobId } = await computeJob(harness, first, 'a', { body_part: 'neck' });
    await harness.call('ps_skin_texture_cancel', { task_id: first, job_id: jobId });
    await harness.tools.call('ps_finish_task', { task_id: first, summary: 'done' });

    const second = await harness.startTask();
    assert.notEqual(second, first);
    const refusedStart = await harness.call('ps_skin_texture_start', { task_id: second, request_id: 'b', ...BASE, body_part: 'neck' });
    assert.equal(refusedStart.isError, true);
    assert.equal(refusedStart.json.error.code, 'BODY_PARTS_GUIDE_NOT_READ');
    await harness.call('ps_skin_texture_body_parts', { task_id: second });
    const accepted = await harness.call('ps_skin_texture_start', { task_id: second, request_id: 'b', ...BASE, body_part: 'neck' });
    assert.equal(accepted.isError, false, accepted.text);
    await harness.waitForPhase(second, accepted.json.job_id, 'ready');
});

// ---- 4. Small scale ----------------------------------------------------------------------------

test('small scale: 1 px/mm is refused without confirmation, computed with it, 2 px/mm needs none', needsCore, async t => {
    const harness = makeHarness(t, { document: sceneDocument() });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);
    const scriptsBefore = fake.state.scripts.length;
    const args = { task_id: taskId, request_id: 'small', ...BASE, px_per_mm: 1, body_part: 'neck' };

    const refusedStart = await harness.call('ps_skin_texture_start', args);
    assert.equal(refusedStart.isError, true);
    assert.equal(refusedStart.json.error.code, 'SMALL_SCALE_NOT_CONFIRMED');
    assert.match(refusedStart.json.error.message, /small_scale_confirmed: true/);
    assert.equal(fake.state.scripts.length, scriptsBefore, 'nothing was sent to Photoshop');
    assert.equal(harness.ownFiles().length, 0);

    const refusedFalse = await harness.call('ps_skin_texture_start', { ...args, small_scale_confirmed: false });
    assert.equal(refusedFalse.json.error.code, 'SMALL_SCALE_NOT_CONFIRMED');

    // The same request_id with the person's yes computes: the refusal did not use the id up.
    const confirmed = await harness.call('ps_skin_texture_start', { ...args, small_scale_confirmed: true });
    assert.equal(confirmed.isError, false, confirmed.text);
    const ready = await harness.waitForPhase(taskId, confirmed.json.job_id, 'ready');
    assert.equal(ready.body_part.small_scale_confirmed, true);

    // Exactly 2 px/mm is not below the limit.
    const edge = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'edge', ...BASE, px_per_mm: 2, body_part: 'neck', part_name: 'Neck 2' });
    assert.equal(edge.isError, false, edge.text);
    const edgeReady = await harness.waitForPhase(taskId, edge.json.job_id, 'ready');
    assert.equal(edgeReady.body_part.small_scale_confirmed, undefined);

    // Just below 2 is refused.
    const below = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'below', ...BASE, px_per_mm: 1.99, body_part: 'neck', part_name: 'Neck 3' });
    assert.equal(below.json.error.code, 'SMALL_SCALE_NOT_CONFIRMED');
});

test('small scale: a request without body_part at 1 px/mm still computes', needsCore, async t => {
    const harness = makeHarness(t, { document: sceneDocument() });
    const taskId = await harness.startTask();
    const start = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'plain', ...BASE, px_per_mm: 1 });
    assert.equal(start.isError, false, start.text);
    const ready = await harness.waitForPhase(taskId, start.json.job_id, 'ready');
    assert.equal(ready.body_part, undefined, 'a request without body_part has no body part view');
});

// ---- 5. Full flow ------------------------------------------------------------------------------

test('flow: the first part creates Skin with its folder, the second goes inside the same Skin', needsCore, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: sceneDocument() });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);

    const first = await computeJob(harness, taskId, 'neck', { body_part: 'neck' });
    // What the agent sees before the write.
    assert.equal(first.ready.body_part.body_part, 'neck');
    assert.equal(first.ready.body_part.folder_name, 'Neck');
    assert.deepEqual(first.ready.body_part.formula_zones, { formula_1: 'cheek', formula_2: 'cheek' });
    assert.ok(first.ready.body_part.note, 'the note says the formulas do not tell body parts apart');
    assert.match(first.ready.next_step, /body part folder "Neck"/);
    assert.match(first.ready.next_step, /skin_group_id/);
    assert.equal(fake.doc.layers.length, 2, 'nothing is written before apply');

    const applied = await applyJob(harness, taskId, first.jobId);
    assert.equal(applied.isError, false, applied.text);
    assert.equal(applied.json.phase, 'applied');
    assert.equal(applied.json.apply.code, 'APPLIED');
    const { structure } = applied.json.apply;
    assert.equal(structure.skinGroup.name, 'Skin seed 1');
    assert.equal(structure.skinGroup.created, true);
    assert.ok(Number.isInteger(structure.skinGroup.id));
    assert.equal(structure.mainGroup.name, `Neck [${first.jobId}] seed 1`);
    assert.match(applied.json.next_step, new RegExp(`skin_group_id: ${structure.skinGroup.id}\\b`));

    // The common group: at the top of the document, no mask, Pass Through, opacity 100.
    const skin = fake.findLayerById(structure.skinGroup.id);
    assert.equal(fake.doc.layers[0], skin, 'Skin is at the top of the document');
    assert.equal(skin.name, 'Skin seed 1');
    assert.equal(skin.kind, 'group');
    assert.equal(skin.mask, null, 'Skin has no mask of its own');
    assert.equal(skin.blendMode, 'passThrough');
    assert.equal(skin.opacity, 100);
    assert.equal(skin.visible, true);
    assert.equal(skin.layers.length, 1);
    // The part folder holds the mask and the two formula groups.
    const folder = skin.layers[0];
    assert.equal(folder.id, structure.mainGroup.id);
    assert.equal(folder.name, `Neck [${first.jobId}] seed 1`);
    assert.ok(folder.mask, 'the part folder has the mask');
    assert.deepEqual(namesOf(folder), ['Formula 1', 'Formula 2']);
    assert.deepEqual(folder.layers.map(group => group.visible), [true, false]);
    assert.equal(fake.state.historySteps.length, 1, 'one undo step');
    // Nothing else in the document carries a mask.
    assert.deepEqual(support.flattenLayers(fake.doc.layers).filter(layer => layer.mask).map(layer => layer.name), [folder.name]);

    // Second part into the same Skin, with a rect and a selection outside the first part.
    const before = snapshotKnown(fake.doc.layers, idsOf(fake.doc.layers));
    const known = idsOf(fake.doc.layers);
    const originals = support.flattenLayers(fake.doc.layers);
    const second = await computeJob(harness, taskId, 'arm', { body_part: 'arm', part_name: 'Arm L', rect: SECOND_RECT });
    assert.equal(second.ready.body_part.folder_name, 'Arm L');
    const appliedTwo = await applyJob(harness, taskId, second.jobId, { selection: SECOND_SELECTION, skinGroupId: structure.skinGroup.id });
    assert.equal(appliedTwo.isError, false, appliedTwo.text);
    assert.equal(appliedTwo.json.phase, 'applied');
    assert.equal(appliedTwo.json.apply.code, 'APPLIED', appliedTwo.text);
    assert.equal(appliedTwo.json.apply.skin_group_id, structure.skinGroup.id);
    const twoStructure = appliedTwo.json.apply.structure;
    assert.equal(twoStructure.skinGroup.id, structure.skinGroup.id);
    assert.equal(twoStructure.skinGroup.created, false);
    assert.equal(twoStructure.mainGroup.name, `Arm L [${second.jobId}] seed 1`);

    assert.equal(fake.doc.layers.filter(layer => layer.name === 'Skin seed 1').length, 1, 'still one Skin group');
    assert.equal(fake.doc.layers[0], skin);
    assert.equal(skin.layers.length, 2);
    assert.equal(skin.layers[0].name, `Arm L [${second.jobId}] seed 1`, 'the new folder is the top child of Skin');
    assert.equal(skin.layers[1], folder, 'the first folder is untouched below it');
    assert.ok(skin.layers[0].mask, 'the new folder has its own mask');
    assert.deepEqual(namesOf(skin.layers[0]), ['Formula 1', 'Formula 2']);
    assert.equal(skin.mask, null, 'Skin still has no mask');
    assert.equal(fake.state.historySteps.length, 2);

    // Pre-existing layers are exactly as they were.
    assert.deepEqual(snapshotKnown(fake.doc.layers, known), before);
    for (const layer of originals) assert.ok(support.flattenLayers(fake.doc.layers).includes(layer), `${layer.name} is the same object`);
    assert.notEqual(appliedTwo.json.apply.code, 'EXISTING_LAYERS_CHANGED');
});

// ---- 6. skin_group_id errors -------------------------------------------------------------------

test('skin_group_id: not found, then the same job applied again with the right id succeeds', needsCore, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: sceneDocument() });
    const { fake } = harness;
    const { taskId, skinId } = await firstPart(harness);
    const second = await computeJob(harness, taskId, 'arm', { body_part: 'arm', rect: SECOND_RECT });
    const known = idsOf(fake.doc.layers);
    const before = snapshotKnown(fake.doc.layers, known);

    const missing = await applyJob(harness, taskId, second.jobId, { selection: SECOND_SELECTION, skinGroupId: 999999 });
    assert.equal(missing.isError, true);
    assert.equal(missing.json.apply.state, 'not_applied');
    assert.equal(missing.json.apply.code, 'SKIN_GROUP_NOT_FOUND');
    assert.equal(missing.json.apply.retryable, true);
    assert.equal(missing.json.phase, 'ready', 'the job stays ready');
    assert.deepEqual(snapshotKnown(fake.doc.layers, idsOf(fake.doc.layers)), before, 'nothing was written');
    assert.equal(idsOf(fake.doc.layers).size, known.size, 'no layer was created');

    const retry = await applyJob(harness, taskId, second.jobId, { skinGroupId: skinId });
    assert.equal(retry.isError, false, retry.text);
    assert.equal(retry.json.phase, 'applied');
    assert.equal(retry.json.apply.structure.skinGroup.id, skinId);
    assert.equal(retry.json.apply.structure.skinGroup.created, false);
    assert.equal(fake.findLayerById(skinId).layers.length, 2);
});

test('skin_group_id: an id that is not a group is refused and the job stays ready', needsCore, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: sceneDocument() });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);
    const { jobId } = await computeJob(harness, taskId, 'neck', { body_part: 'neck' });
    const background = fake.findLayerByName('Background');
    const known = idsOf(fake.doc.layers);
    const before = snapshotKnown(fake.doc.layers, known);
    const answer = await applyJob(harness, taskId, jobId, { skinGroupId: background.id });
    assert.equal(answer.isError, true);
    assert.equal(answer.json.apply.code, 'SKIN_GROUP_NOT_A_GROUP');
    assert.equal(answer.json.apply.state, 'not_applied');
    assert.equal(answer.json.apply.retryable, true);
    assert.equal(answer.json.phase, 'ready');
    assert.deepEqual(snapshotKnown(fake.doc.layers, idsOf(fake.doc.layers)), before);
    assert.equal(idsOf(fake.doc.layers).size, known.size);
    // Without the wrong id the first part still creates its own Skin.
    const ok = await applyJob(harness, taskId, jobId);
    assert.equal(ok.json.phase, 'applied', ok.text);
    assert.equal(ok.json.apply.structure.skinGroup.created, true);
});

test('skin_group_id: an old-style root Skin with its own mask is refused', needsCore, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: sceneDocument() });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);
    // A job without body_part writes the old "Skin [job id]" root group, which carries the mask.
    const old = await computeJob(harness, taskId, 'old');
    const oldApplied = await applyJob(harness, taskId, old.jobId);
    assert.equal(oldApplied.json.phase, 'applied', oldApplied.text);
    const oldRoot = fake.findLayerByName(`Skin [${old.jobId}] seed 1`);
    assert.ok(oldRoot && oldRoot.mask, 'the old-style root group has a mask');
    assert.equal(oldApplied.json.apply.structure.skinGroup, undefined, 'a job without body_part reports no skinGroup');

    const part = await computeJob(harness, taskId, 'neck', { body_part: 'neck', rect: SECOND_RECT });
    const known = idsOf(fake.doc.layers);
    const before = snapshotKnown(fake.doc.layers, known);
    const answer = await applyJob(harness, taskId, part.jobId, { selection: SECOND_SELECTION, skinGroupId: oldRoot.id });
    assert.equal(answer.isError, true);
    assert.equal(answer.json.apply.code, 'SKIN_GROUP_HAS_MASK');
    assert.equal(answer.json.apply.state, 'not_applied');
    assert.equal(answer.json.apply.retryable, true);
    assert.equal(answer.json.phase, 'ready');
    assert.deepEqual(snapshotKnown(fake.doc.layers, idsOf(fake.doc.layers)), before);
    assert.equal(idsOf(fake.doc.layers).size, known.size);
});

test('skin_group_id: a non-integer id, and an id on a job started without body_part, are refused by the tool', needsCore, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: sceneDocument() });
    const { fake } = harness;
    const { taskId, skinId } = await firstPart(harness);
    const part = await computeJob(harness, taskId, 'arm', { body_part: 'arm', rect: SECOND_RECT });
    const plain = await computeJob(harness, taskId, 'plain', { rect: { x: 300, y: 300, width: 64, height: 64 } });
    const scripts = fake.state.scripts.length;
    const known = idsOf(fake.doc.layers);

    for (const bad of ['5', 1.5, '', true]) {
        const answer = await applyJob(harness, taskId, part.jobId, { skinGroupId: bad });
        assert.equal(answer.isError, true, String(bad));
        assert.equal(answer.json.error.code, 'INVALID_SKIN_GROUP', String(bad));
    }
    const onPlain = await applyJob(harness, taskId, plain.jobId, { skinGroupId: skinId });
    assert.equal(onPlain.isError, true);
    assert.equal(onPlain.json.error.code, 'INVALID_SKIN_GROUP');
    assert.match(onPlain.json.error.message, /without body_part/);
    assert.equal(fake.state.scripts.length, scripts, 'nothing was sent to Photoshop');
    assert.equal(idsOf(fake.doc.layers).size, known.size);

    // Both jobs are still ready and can be written afterwards.
    const statusPart = await harness.call('ps_skin_texture_status', { task_id: taskId, job_id: part.jobId });
    assert.equal(statusPart.json.phase, 'ready');
    const statusPlain = await harness.call('ps_skin_texture_status', { task_id: taskId, job_id: plain.jobId });
    assert.equal(statusPlain.json.phase, 'ready');
    const okPlain = await applyJob(harness, taskId, plain.jobId, { selection: { x: 290, y: 290, width: 90, height: 90 } });
    assert.equal(okPlain.json.phase, 'applied', okPlain.text);
});

// ---- 7. Areola-only job into the common Skin ---------------------------------------------------

test('areola_v1 job with skin_group_id: the "Areolas" folder goes into the common Skin', needsAll, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: sceneDocument({ width: 800, height: 600 }) });
    const { fake } = harness;
    const { taskId, skinId } = await firstPart(harness);
    const region = { x: 235, y: 195, width: 330, height: 120 };

    const start = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'areolas', recipe: 'areola_v1', rect: region, px_per_mm: 4, fields: { areolas: support.twoAreolas() }
    });
    assert.equal(start.isError, false, start.text);
    const ready = await harness.waitForPhase(taskId, start.json.job_id, 'ready');
    assert.equal(ready.body_part, undefined);
    assert.match(ready.next_step, /skin_group_id/);

    const known = idsOf(fake.doc.layers);
    const before = snapshotKnown(fake.doc.layers, known);
    const applied = await applyJob(harness, taskId, start.json.job_id, {
        selection: { x: 235, y: 195, width: 330, height: 120 }, skinGroupId: skinId
    });
    assert.equal(applied.isError, false, applied.text);
    assert.equal(applied.json.phase, 'applied');
    const { structure } = applied.json.apply;
    assert.equal(structure.skinGroup.id, skinId);
    assert.equal(structure.skinGroup.created, false);
    assert.equal(structure.mainGroup.name, `Areolas [${start.json.job_id}] seed 1`);
    const skin = fake.findLayerById(skinId);
    assert.equal(skin.layers.length, 2);
    assert.equal(skin.layers[0].id, structure.mainGroup.id, 'the Areolas folder is the top child of Skin');
    assert.equal(skin.layers[0].name, `Areolas [${start.json.job_id}] seed 1`);
    assert.deepEqual(namesOf(skin.layers[0]), support.AREOLA_VARIANTS.map(variant => variant.group));
    assert.ok(skin.layers[0].mask, 'the Areolas folder has its own mask');
    assert.equal(skin.mask, null);
    assert.equal(fake.doc.layers.filter(layer => layer.name === 'Skin seed 1').length, 1);
    assert.deepEqual(snapshotKnown(fake.doc.layers, known), before, 'what was there before is unchanged');
    assert.equal(applied.json.apply.skin_group_id, skinId);
});

// ---- 8. Face map -------------------------------------------------------------------------------

test('face with fields.face: the hidden Face Map layer is the first child of the face folder', needsCore, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: sceneDocument() });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);
    const { jobId } = await computeJob(harness, taskId, 'face', { body_part: 'face', fields: { face: FACE } });
    const applied = await applyJob(harness, taskId, jobId);
    assert.equal(applied.json.phase, 'applied', applied.text);
    const { structure } = applied.json.apply;
    assert.equal(structure.mainGroup.name, `Face [${jobId}] seed 1`);
    assert.equal(structure.skinGroup.created, true);
    const folder = fake.findLayerById(structure.mainGroup.id);
    const map = fake.findLayerById(structure.faceMap.id);
    assert.equal(folder.layers[0], map, 'the Face Map is the first child of the folder');
    assert.deepEqual(namesOf(folder), ['Face Map', 'Formula 1', 'Formula 2']);
    assert.equal(map.visible, false);
    assert.equal(map.name, 'Face Map');
    assert.ok(folder.mask);
    const skin = fake.findLayerById(structure.skinGroup.id);
    assert.equal(skin.layers[0], folder);
});

// ---- 9. Same pixels with and without body_part -------------------------------------------------

test('a body part job computes exactly the same results as the same request without body_part', needsCore, async t => {
    const harness = makeHarness(t, { document: sceneDocument() });
    const taskId = await taskWithGuide(harness);
    const params = { seed: 17, azimuthDeg: 300, elevationDeg: 40 };
    // A body part job computes the rect widened by its margin (3 px/mm: 120 px, clipped to the
    // 400 x 400 document), so the request without body_part is given that rect explicitly.
    const widened = { x: 0, y: 0, width: 194, height: 194 };
    const withPart = await computeJob(harness, taskId, 'part', { params, body_part: 'neck' });
    assert.deepEqual(withPart.ready.rect, widened);
    const plain = await computeJob(harness, taskId, 'plain', { params, rect: widened });
    const armJob = await computeJob(harness, taskId, 'arm', { params, body_part: 'arm' });
    assert.ok(Object.keys(plain.ready.result.checksums).length > 0);
    assert.deepEqual(withPart.ready.result.checksums, plain.ready.result.checksums);
    assert.deepEqual(armJob.ready.result.checksums, plain.ready.result.checksums);
    assert.equal(withPart.ready.result.bytes, plain.ready.result.bytes);
    // Formulas received the zone "cheek" for the body part job as well.
    for (const job of [withPart, armJob]) {
        assert.deepEqual(job.ready.body_part.formula_zones, { formula_1: 'cheek', formula_2: 'cheek' });
    }
});

// ---- 10. Published tools -----------------------------------------------------------------------

/** Helper's agent service over a fake plugin, the way the MCP router sees it. */
function makeService(context, skinTexture) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-bodyparts-'));
    const dataFolder = path.join(root, 'PluginData');
    fs.mkdirSync(dataFolder);
    const fake = createFakePhotoshop({ dataFolder });
    const service = createAgentService({
        getBridge: () => fake.bridge,
        paths: resolveAgentPaths({ resourcesPath: root, userDataPath: root, downloadedKnowledgeBasePath: null }),
        isJournalEnabled: () => false,
        logger: { info() {}, warn() {}, error() {} },
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

test('tools/list: the guide tool, the body_part enum, skin_group_id and the start description', needsCore, context => {
    const { service } = makeService(context, {});
    const tools = service.tools.list();
    const guide = tools.find(tool => tool.name === 'ps_skin_texture_body_parts');
    assert.ok(guide, 'ps_skin_texture_body_parts is published');
    assert.ok(guide.inputSchema.required.includes('task_id'));
    assert.ok(guide.description.length > 100);

    const start = tools.find(tool => tool.name === 'ps_skin_texture_start');
    const bodyPart = start.inputSchema.properties.body_part;
    assert.equal(bodyPart.type, 'string');
    assert.ok(bodyPart.enum.includes('neck'));
    assert.ok(!bodyPart.enum.includes('palm'));
    assert.equal(start.inputSchema.properties.part_name.type, 'string');
    assert.equal(start.inputSchema.properties.small_scale_confirmed.type, 'boolean');
    assert.deepEqual(start.inputSchema.required, ['task_id', 'request_id', 'rect', 'px_per_mm'], 'body_part stays optional');
    assert.match(start.description, /ps_skin_texture_body_parts/);

    const apply = tools.find(tool => tool.name === 'ps_skin_texture_apply');
    assert.equal(apply.inputSchema.properties.skin_group_id.type, 'integer');
    assert.ok(!apply.inputSchema.required.includes('skin_group_id'));
    assert.match(apply.description, /skin_group_id/);
});

test('installed build: ps_skin_texture_body_parts answers "in development" like the other skin tools', async context => {
    const { service, fake, call } = makeService(context, { inDevelopment: true });
    assert.ok(service.tools.list().some(tool => tool.name === 'ps_skin_texture_body_parts'), 'the tool is still published');
    const started = await call('ps_start_task', { intent: 'add skin texture' });
    const taskId = started.text.match(/(task-[a-f0-9]+)/)[1];
    const scriptsBefore = fake.state.scripts.length;
    const answer = await call('ps_skin_texture_body_parts', { task_id: taskId });
    assert.equal(answer.isError, true, answer.text);
    assert.equal(answer.json.error.code, IN_DEVELOPMENT_CODE);
    assert.equal(answer.json.error.code, 'FEATURE_IN_DEVELOPMENT');
    assert.equal(fake.state.scripts.length, scriptsBefore);
    // A body part start is refused with the same code, not with the guide gate.
    const start = await call('ps_skin_texture_start', { task_id: taskId, request_id: 'x', ...BASE, body_part: 'neck' });
    assert.equal(start.json.error.code, 'FEATURE_IN_DEVELOPMENT');
});

// ---- 11. Rollback ------------------------------------------------------------------------------

for (const historyAvailable of [false, true]) {
    test(`rollback: a failing second part leaves the existing Skin and its first folder intact (${historyAvailable ? 'Photoshop history' : 'delete created layers'})`, needsCore, async t => {
        const harness = makeHarness(t, { limits: PATIENT, document: sceneDocument({ historyAvailable }) });
        const { fake } = harness;
        const { taskId, skinId } = await firstPart(harness);
        const skin = fake.findLayerById(skinId);
        const firstFolder = skin.layers[0];
        const originals = support.flattenLayers(fake.doc.layers);
        const known = idsOf(fake.doc.layers);
        const before = snapshotKnown(fake.doc.layers, known);
        const firstMaskData = firstFolder.mask.data ? firstFolder.mask.data.slice() : null;

        const second = await computeJob(harness, taskId, 'arm', { body_part: 'arm', rect: SECOND_RECT });
        fake.state.failMaskInit = true;
        const scriptsBefore = fake.state.scripts.filter(record => record.kind === 'apply').length;
        const answer = await applyJob(harness, taskId, second.jobId, { selection: SECOND_SELECTION, skinGroupId: skinId });
        assert.equal(fake.state.scripts.filter(record => record.kind === 'apply').length, scriptsBefore + 1, 'the write reached Photoshop');
        assert.equal(answer.isError, true, answer.text);
        assert.equal(answer.json.apply.state, 'not_applied', answer.text);
        assert.equal(answer.json.apply.code, 'MASK_INIT_FAILED', answer.text);

        // The old content is as it was, and no folder of the failed part is left.
        assert.equal(idsOf(fake.doc.layers).size, known.size, 'no layer of the failed write is left');
        assert.deepEqual(snapshotKnown(fake.doc.layers, known), before);
        assert.equal(skin.layers.length, 1);
        assert.equal(skin.layers[0], firstFolder);
        assert.equal(fake.doc.layers.filter(layer => layer.name === 'Skin seed 1').length, 1);
        assert.ok(!support.flattenLayers(fake.doc.layers).some(layer => layer.name.startsWith('Arms ') || layer.name.includes(second.jobId)));
        for (const layer of originals) assert.ok(support.flattenLayers(fake.doc.layers).includes(layer), `${layer.name} is the same object`);
        assert.ok(firstFolder.mask, 'the first folder keeps its mask');
        assert.deepEqual(firstFolder.mask.data ? firstFolder.mask.data.slice() : null, firstMaskData);
        assert.equal(skin.mask, null);
    });
}
