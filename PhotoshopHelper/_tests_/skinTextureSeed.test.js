'use strict';

/**
 * The seed of skin texture jobs (task31): a seed left out is chosen by Helper once per task (or
 * fixed by the defaultSeed option), an explicit params.seed wins, the seed is written into the
 * names of the groups an apply writes, and a part placed into an existing group is refused as
 * SEED_MISMATCH when the group's name carries another seed (seed_change_confirmed waives that).
 *
 * The lifecycle tests run the real apply script on the fake Photoshop with the real private
 * binaries and are skipped with a reason in a checkout without them.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentService, resolveAgentPaths } = require('../agent');
const { makeHarness, createFakePhotoshop } = require('./skinTextureFakes');
const support = require('./skinTextureAreolasSupport');
const { missingBinaryReason } = require('./skinTextureTestSupport');

const needsCore = { skip: missingBinaryReason() };
const needsAll = { skip: support.missingAllBinariesReason() };

const PATIENT = { responseBudgetMs: 120_000 };
const BASE = Object.freeze({ rect: { x: 10, y: 10, width: 64, height: 64 }, px_per_mm: 3 });
const SECOND_RECT = { x: 150, y: 150, width: 64, height: 64 };
const THIRD_RECT = { x: 250, y: 250, width: 64, height: 64 };
const SELECTION_1 = { x: 20, y: 20, width: 100, height: 100 };
const SELECTION_2 = { x: 140, y: 140, width: 90, height: 90 };
const SELECTION_3 = { x: 240, y: 240, width: 90, height: 90 };

function sceneDocument(extra = {}) {
    return {
        width: 400, height: 400, hasSelection: true, selection: SELECTION_1, activeLayerName: 'Background',
        layerTree: [
            { name: 'Protected', kind: 'group', visible: false, opacity: 73, blendMode: 'passThrough',
                children: [{ name: 'Inner', kind: 'pixel', visible: false, opacity: 81 }] },
            { name: 'Background', kind: 'pixel', visible: true, opacity: 100 }
        ],
        ...extra
    };
}

async function taskWithGuide(harness) {
    const taskId = await harness.startTask();
    const guide = await harness.call('ps_skin_texture_body_parts', { task_id: taskId });
    assert.equal(guide.isError, false, guide.text);
    return taskId;
}

async function computeJob(harness, taskId, requestId, extra = {}) {
    const start = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: requestId, ...BASE, ...extra });
    assert.equal(start.isError, false, start.text);
    const ready = await harness.waitForPhase(taskId, start.json.job_id, 'ready');
    return { jobId: start.json.job_id, ready };
}

async function applyJob(harness, taskId, jobId, { selection, skinGroupId, seedChangeConfirmed } = {}) {
    if (selection) harness.fake.doc.selection = selection;
    const args = { task_id: taskId, job_id: jobId, mask_source: { kind: 'selection' } };
    if (skinGroupId !== undefined) args.skin_group_id = skinGroupId;
    if (seedChangeConfirmed !== undefined) args.seed_change_confirmed = seedChangeConfirmed;
    return harness.call('ps_skin_texture_apply', args);
}

function snapshotKnown(layers, known) {
    return Array.from(layers || []).filter(layer => known.has(layer.id)).map(layer => ({
        id: layer.id, name: layer.name, kind: layer.kind, visible: layer.visible, opacity: layer.opacity,
        blendMode: String(layer.blendMode), parentId: layer.parent ? layer.parent.id : null,
        hasMask: Boolean(layer.mask), children: snapshotKnown(layer.layers, known)
    }));
}
const idsOf = layers => new Set(support.flattenLayers(layers).map(layer => layer.id));

// ---- Where the seed comes from -----------------------------------------------------------------

test('seed: left out, one random seed per task shared by every start; an explicit seed wins', needsCore, async t => {
    const harness = makeHarness(t, { limits: { defaultSeed: null }, document: sceneDocument() });
    const taskId = await harness.startTask();
    const first = await computeJob(harness, taskId, 'a');
    const second = await computeJob(harness, taskId, 'b', { rect: SECOND_RECT });
    const seed = first.ready.recipe_params.seed;
    assert.ok(Number.isInteger(seed) && seed >= 1 && seed <= 999999, `seed ${seed}`);
    assert.equal(second.ready.recipe_params.seed, seed, 'every start of the task shares the seed');
    assert.equal(first.ready.seed_source, 'chosen by Helper for this task');
    assert.equal(second.ready.seed_source, 'chosen by Helper for this task');

    const explicit = await computeJob(harness, taskId, 'c', { rect: THIRD_RECT, params: { seed: 424242 } });
    assert.equal(explicit.ready.recipe_params.seed, 424242);
    assert.equal(explicit.ready.seed_source, 'request');
    // An explicit seed does not change the task's own seed.
    const later = await computeJob(harness, taskId, 'd', { rect: { x: 300, y: 10, width: 64, height: 64 } });
    assert.equal(later.ready.recipe_params.seed, seed);
    // Even seed 0 is explicit.
    const zero = await computeJob(harness, taskId, 'e', { rect: { x: 300, y: 100, width: 64, height: 64 }, params: { seed: 0 } });
    assert.equal(zero.ready.recipe_params.seed, 0);
    assert.equal(zero.ready.seed_source, 'request');
});

test('seed: tasks draw their own seeds (several tasks do not all share one)', needsCore, async t => {
    const harness = makeHarness(t, { limits: { defaultSeed: null }, document: sceneDocument() });
    const seeds = [];
    for (let i = 0; i < 6; i++) {
        const taskId = await harness.startTask();
        const start = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'r', ...BASE });
        assert.equal(start.isError, false, start.text);
        assert.ok(Number.isInteger(start.json.recipe_params.seed));
        assert.ok(start.json.recipe_params.seed >= 1 && start.json.recipe_params.seed <= 999999);
        seeds.push(start.json.recipe_params.seed);
        await harness.call('ps_skin_texture_cancel', { task_id: taskId, job_id: start.json.job_id });
        await harness.tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    }
    assert.ok(new Set(seeds).size > 1, `all six tasks got the same seed: ${seeds}`);
});

test('seed: the same request_id with the same arguments and no seed returns the same job', needsCore, async t => {
    const harness = makeHarness(t, { limits: { defaultSeed: null }, document: sceneDocument() });
    const taskId = await harness.startTask();
    const first = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'same', ...BASE });
    assert.equal(first.isError, false, first.text);
    const again = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'same', ...BASE });
    assert.equal(again.isError, false, again.text);
    assert.equal(again.json.job_id, first.json.job_id);
    assert.equal(again.json.repeated_request, true);
    assert.equal(again.json.recipe_params.seed, first.json.recipe_params.seed);
    await harness.waitForPhase(taskId, first.json.job_id, 'ready');
    // Spelling out the seed Helper chose is the same effective request.
    const spelled = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'same', ...BASE, params: { seed: first.json.recipe_params.seed } });
    assert.equal(spelled.isError, false, spelled.text);
    assert.equal(spelled.json.job_id, first.json.job_id, 'the same effective arguments give the same job');
});

test('seed: the defaultSeed option fixes the seed of every task', needsCore, async t => {
    const harness = makeHarness(t, { limits: { defaultSeed: 7 }, document: sceneDocument() });
    for (let i = 0; i < 2; i++) {
        const taskId = await harness.startTask();
        const start = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'r', ...BASE });
        assert.equal(start.isError, false, start.text);
        assert.equal(start.json.recipe_params.seed, 7);
        assert.equal(start.json.seed_source, 'chosen by Helper for this task');
        await harness.call('ps_skin_texture_cancel', { task_id: taskId, job_id: start.json.job_id });
        await harness.tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    }
});

// ---- Names -------------------------------------------------------------------------------------

test('seed names: common Skin, part folder and old-style root carry the seed', needsCore, async t => {
    const harness = makeHarness(t, { limits: { ...PATIENT, defaultSeed: null }, document: sceneDocument() });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);
    const part = await computeJob(harness, taskId, 'neck', { body_part: 'neck' });
    const seed = part.ready.recipe_params.seed;
    const applied = await applyJob(harness, taskId, part.jobId);
    assert.equal(applied.json.phase, 'applied', applied.text);
    const { structure } = applied.json.apply;
    assert.equal(structure.skinGroup.name, `Skin seed ${seed}`);
    assert.equal(structure.mainGroup.name, `Neck [${part.jobId}] seed ${seed}`);
    assert.equal(fake.findLayerById(structure.skinGroup.id).name, `Skin seed ${seed}`);
    assert.equal(fake.findLayerById(structure.mainGroup.id).name, `Neck [${part.jobId}] seed ${seed}`);
    assert.match(applied.json.next_step, new RegExp(`keep seed ${seed}\\b`));

    // A job without body_part writes the old-style root with the marker and the seed.
    const old = await computeJob(harness, taskId, 'old', { rect: SECOND_RECT });
    assert.equal(old.ready.recipe_params.seed, seed);
    const oldApplied = await applyJob(harness, taskId, old.jobId, { selection: SELECTION_2 });
    assert.equal(oldApplied.json.phase, 'applied', oldApplied.text);
    assert.equal(oldApplied.json.apply.structure.mainGroup.name, `Skin [${old.jobId}] seed ${seed}`);
    assert.ok(fake.findLayerByName(`Skin [${old.jobId}] seed ${seed}`));
    assert.equal(fake.findLayerByName(`Skin [${old.jobId}]`), null, 'the name does not stop at the marker');

    // An explicit seed shows in the names of its own part.
    const explicit = await computeJob(harness, taskId, 'arm', { body_part: 'arm', part_name: 'Arm L', rect: THIRD_RECT, params: { seed: 31 } });
    const explicitApplied = await applyJob(harness, taskId, explicit.jobId, {
        selection: SELECTION_3, skinGroupId: structure.skinGroup.id, seedChangeConfirmed: true
    });
    assert.equal(explicitApplied.json.phase, 'applied', explicitApplied.text);
    assert.equal(explicitApplied.json.apply.structure.mainGroup.name, `Arm L [${explicit.jobId}] seed 31`);
});

// ---- SEED_MISMATCH -----------------------------------------------------------------------------

test('SEED_MISMATCH: another seed into a Skin with a seed is refused; seed_change_confirmed lets it through', needsCore, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: sceneDocument() });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);
    const first = await computeJob(harness, taskId, 'neck', { body_part: 'neck' });
    const firstApplied = await applyJob(harness, taskId, first.jobId);
    assert.equal(firstApplied.json.phase, 'applied', firstApplied.text);
    const skinId = firstApplied.json.apply.structure.skinGroup.id;
    assert.equal(fake.findLayerById(skinId).name, 'Skin seed 1');

    const other = await computeJob(harness, taskId, 'arm', { body_part: 'arm', rect: SECOND_RECT, params: { seed: 2 } });
    const known = idsOf(fake.doc.layers);
    const before = snapshotKnown(fake.doc.layers, known);
    const stepsBefore = fake.state.historySteps.length;
    const refused = await applyJob(harness, taskId, other.jobId, { selection: SELECTION_2, skinGroupId: skinId });
    assert.equal(refused.isError, true);
    assert.equal(refused.json.apply.state, 'not_applied');
    assert.equal(refused.json.apply.code, 'SEED_MISMATCH');
    assert.equal(refused.json.apply.retryable, true);
    assert.equal(refused.json.phase, 'ready', 'the job stays ready');
    assert.match(refused.json.apply.message, /seed 1/);
    assert.match(refused.json.apply.message, /seed 2/);
    assert.equal(refused.json.apply.seed_change_confirmed, undefined);
    assert.deepEqual(snapshotKnown(fake.doc.layers, idsOf(fake.doc.layers)), before, 'nothing changed');
    assert.equal(idsOf(fake.doc.layers).size, known.size, 'no layer was created');
    assert.equal(fake.state.historySteps.length, stepsBefore, 'no undo step was made');

    // The same job again, with the person's yes.
    const confirmed = await applyJob(harness, taskId, other.jobId, { skinGroupId: skinId, seedChangeConfirmed: true });
    assert.equal(confirmed.isError, false, confirmed.text);
    assert.equal(confirmed.json.phase, 'applied');
    assert.equal(confirmed.json.apply.seed_change_confirmed, true);
    const skin = fake.findLayerById(skinId);
    assert.equal(skin.name, 'Skin seed 1', 'the common group keeps its seed');
    assert.equal(skin.layers.length, 2);
    assert.equal(skin.layers[0].name, `Arms [${other.jobId}] seed 2`, 'the folder carries its own seed');
    assert.equal(confirmed.json.apply.structure.mainGroup.name, `Arms [${other.jobId}] seed 2`);

    // A part whose seed matches passes without the flag, whether it was left out or spelled out.
    const same = await computeJob(harness, taskId, 'leg', { body_part: 'leg', rect: THIRD_RECT, params: { seed: 1 } });
    const sameApplied = await applyJob(harness, taskId, same.jobId, { selection: SELECTION_3, skinGroupId: skinId });
    assert.equal(sameApplied.isError, false, sameApplied.text);
    assert.equal(sameApplied.json.phase, 'applied');
    assert.equal(sameApplied.json.apply.seed_change_confirmed, undefined);
    assert.equal(skin.layers.length, 3);
});

test('SEED_MISMATCH: a target group whose name has no seed is not checked', needsCore, async t => {
    const harness = makeHarness(t, {
        limits: PATIENT,
        document: sceneDocument({
            layerTree: [
                { name: 'My skin', kind: 'group', visible: true, opacity: 100, blendMode: 'passThrough', children: [] },
                // "seed" glued to a word is not a seed marker.
                { name: 'Reseed 5 and Xseed 9', kind: 'group', visible: true, opacity: 100, blendMode: 'passThrough', children: [] },
                { name: 'Background', kind: 'pixel', visible: true, opacity: 100 }
            ]
        })
    });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);
    for (const [index, name] of ['My skin', 'Reseed 5 and Xseed 9'].entries()) {
        const group = fake.findLayerByName(name);
        assert.ok(group && !group.mask);
        const rect = [BASE.rect, SECOND_RECT][index];
        const job = await computeJob(harness, taskId, `p${index}`, { body_part: 'arm', rect, params: { seed: 3 + index } });
        const applied = await applyJob(harness, taskId, job.jobId, { selection: [SELECTION_1, SELECTION_2][index], skinGroupId: group.id });
        assert.equal(applied.isError, false, applied.text);
        assert.equal(applied.json.phase, 'applied');
        assert.equal(group.layers[0].name, `Arms [${job.jobId}] seed ${3 + index}`);
        assert.equal(group.name, name, 'the group is not renamed');
    }
});

test('SEED_MISMATCH: an areola_v1 job with another seed into a Skin with a seed is refused', needsAll, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: sceneDocument({ width: 800, height: 600 }) });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);
    const first = await computeJob(harness, taskId, 'neck', { body_part: 'neck' });
    const firstApplied = await applyJob(harness, taskId, first.jobId);
    const skinId = firstApplied.json.apply.structure.skinGroup.id;

    const region = { x: 235, y: 195, width: 330, height: 120 };
    const start = await harness.call('ps_skin_texture_start', {
        task_id: taskId, request_id: 'areolas', recipe: 'areola_v1', rect: region, px_per_mm: 4,
        params: { seed: 9 }, fields: { areolas: support.twoAreolas() }
    });
    assert.equal(start.isError, false, start.text);
    await harness.waitForPhase(taskId, start.json.job_id, 'ready');
    const known = idsOf(fake.doc.layers);
    const before = snapshotKnown(fake.doc.layers, known);
    const refused = await applyJob(harness, taskId, start.json.job_id, { selection: region, skinGroupId: skinId });
    assert.equal(refused.isError, true);
    assert.equal(refused.json.apply.code, 'SEED_MISMATCH');
    assert.equal(refused.json.apply.state, 'not_applied');
    assert.equal(refused.json.apply.retryable, true);
    assert.equal(refused.json.phase, 'ready');
    assert.deepEqual(snapshotKnown(fake.doc.layers, idsOf(fake.doc.layers)), before);

    const confirmed = await applyJob(harness, taskId, start.json.job_id, { skinGroupId: skinId, seedChangeConfirmed: true });
    assert.equal(confirmed.json.phase, 'applied', confirmed.text);
    assert.equal(confirmed.json.apply.structure.mainGroup.name, `Areolas [${start.json.job_id}] seed 9`);
});

test('seed_change_confirmed: a non-boolean value is refused by the tool', needsCore, async t => {
    const harness = makeHarness(t, { limits: PATIENT, document: sceneDocument() });
    const { fake } = harness;
    const taskId = await taskWithGuide(harness);
    const job = await computeJob(harness, taskId, 'neck', { body_part: 'neck' });
    const scripts = fake.state.scripts.length;
    for (const bad of ['yes', 1, 0, 'true', {}]) {
        const answer = await applyJob(harness, taskId, job.jobId, { seedChangeConfirmed: bad });
        assert.equal(answer.isError, true, String(bad));
        assert.equal(answer.json.error.code, 'INVALID_SEED_CHANGE', String(bad));
    }
    assert.equal(fake.state.scripts.length, scripts, 'nothing was sent to Photoshop');
    const status = await harness.call('ps_skin_texture_status', { task_id: taskId, job_id: job.jobId });
    assert.equal(status.json.phase, 'ready');
    // false is a valid value and changes nothing.
    const applied = await applyJob(harness, taskId, job.jobId, { seedChangeConfirmed: false });
    assert.equal(applied.json.phase, 'applied', applied.text);
    assert.equal(applied.json.apply.seed_change_confirmed, undefined);
});

// ---- Published texts ---------------------------------------------------------------------------

function makeService(context) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-seed-'));
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
    context.after(async () => {
        await service.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return service;
}

test('tools/list: apply takes a boolean seed_change_confirmed, the texts explain the seed', needsCore, context => {
    const tools = makeService(context).tools.list();
    const apply = tools.find(tool => tool.name === 'ps_skin_texture_apply');
    assert.equal(apply.inputSchema.properties.seed_change_confirmed.type, 'boolean');
    assert.ok(!apply.inputSchema.required.includes('seed_change_confirmed'));
    assert.match(apply.description, /SEED_MISMATCH/);
    assert.match(apply.description, /seed_change_confirmed/);

    const start = tools.find(tool => tool.name === 'ps_skin_texture_start');
    assert.match(start.description, /random seed once per task/);
    assert.match(start.description, /never make one up/);
    assert.match(start.inputSchema.properties.params.description, /random seed chosen once per task/);
    assert.equal(start.inputSchema.properties.params.properties.seed.type, 'integer');
});

test('guide: the seed section is there', needsCore, async t => {
    const harness = makeHarness(t, { document: sceneDocument() });
    const taskId = await harness.startTask();
    const guide = await harness.call('ps_skin_texture_body_parts', { task_id: taskId });
    assert.ok(guide.json.guide_version >= 2);
    assert.ok(Array.isArray(guide.json.seed) && guide.json.seed.length > 0);
    assert.match(guide.json.seed.join(' '), /seed_change_confirmed/);
});
