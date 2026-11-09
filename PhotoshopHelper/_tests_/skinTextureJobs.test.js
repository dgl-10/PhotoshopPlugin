'use strict';

/**
 * The life cycle of a skin texture job through the real MCP tool layer: start, status,
 * apply, cancel, the task frame, retries, lost answers and the write itself. Photoshop is
 * the fake in skinTextureFakes.js, which runs the real scripts Helper builds.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { computeSkinPairV1 } = require('../skin-texture/recipe-worker-engine.js');
const recipeCatalog = require('../skin-texture/recipe-catalog');
const wasmLoader = require('../skin-texture/wasm-loader.js');
const SkinExchange = require('../skin-texture/exchange.js');
const exchangeFiles = require('../skin-texture/exchange-files');
const { DEFAULT_OPTIONS } = require('../skin-texture/job-manager');
const { makeHarness: makeRawHarness, holdPublish } = require('./skinTextureFakes');

// These tests need formulas.wasm, which is not kept in git. Without it they are skipped
// (a CommonJS module may return early; the tests below are then never registered).
const missingWasmCore = wasmLoader.checkWasmCore();
if (missingWasmCore) {
    test('skin texture tests need formulas.wasm', { skip: missingWasmCore }, () => {});
    return;
}

function makeHarness(context, options) {
    const h = makeRawHarness(context, options);
    const origCall = h.call;
    h.call = (name, args) => {
        if (name === 'ps_skin_texture_apply' && args && args.mask_source === undefined) {
            args = { mask_source: { kind: 'selection' }, ...args };
        }
        return origCall(name, args);
    };
    return h;
}

const RECT = { x: 30, y: 20, width: 64, height: 48 };

/**
 * @param {string} taskId - Task id.
 * @param {object} [extra] - Overrides.
 * @returns {object} Arguments of ps_skin_texture_start.
 */
function startArgs(taskId, extra = {}) {
    return { task_id: taskId, request_id: 'r1', rect: RECT, px_per_mm: 6, params: { seed: 2 }, ...extra };
}

/**
 * Workers that do nothing until the test says so.
 *
 * @returns {{factory: Function, created: object[], finish: Function}}
 */
function heldWorkers() {
    const created = [];
    const factory = workerData => {
        const worker = new EventEmitter();
        worker.workerData = workerData;
        worker.terminated = false;
        worker.terminate = async () => {
            worker.terminated = true;
            worker.emit('exit', 1);
            return 1;
        };
        created.push(worker);
        return worker;
    };
    // Compute what the real worker would send, and send it.
    const finish = worker => {
        const result = computeSkinPairV1(worker.workerData, () => {});
        worker.emit('message', {
            type: 'result',
            files: result.files,
            checksums: result.checksums,
            stats: result.stats,
            timings: result.timings,
            recipe: 'skin_pair_v1'
        });
    };
    return { factory, created, finish };
}

/**
 * @param {object} h - Harness.
 * @returns {object[]} Apply scripts sent to the fake plugin.
 */
function applyScripts(h) {
    return h.fake.state.scripts.filter(record => record.kind === 'apply');
}

/**
 * @param {object} h - Harness.
 * @returns {object[]} Layers of the task document that the skin texture created.
 */
function textureLayers(h) {
    return h.fake.doc.layers.filter(layer => layer.name.startsWith('Skin'));
}

/**
 * Start a job and wait until it is ready.
 *
 * @param {object} h - Harness.
 * @param {string} taskId - Task id.
 * @param {object} [extra] - Start argument overrides.
 * @returns {Promise<object>} The ready status.
 */
async function readyJob(h, taskId, extra) {
    const started = await h.call('ps_skin_texture_start', startArgs(taskId, extra));
    assert.equal(started.isError, false, started.text);
    return h.waitForPhase(taskId, started.json.job_id, 'ready');
}

test('a full cycle: quick start, background computation, one exact write', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();

    const t0 = Date.now();
    const started = await h.call('ps_skin_texture_start', startArgs(taskId));
    assert.ok(Date.now() - t0 < 2000, 'start answers without waiting for the computation');
    assert.equal(started.isError, false, started.text);
    assert.match(started.json.job_id, /^skt-[0-9a-f]{12}$/);
    assert.ok(['checking_document', 'computing', 'ready'].includes(started.json.phase));
    assert.equal(started.json.recipe_id, 'skin_pair_v1');
    assert.deepEqual(started.json.outputs, ['formula_2_pores', 'formula_2_furrows', 'formula_1_pores', 'formula_1_furrows']);

    const ready = await h.waitForPhase(taskId, started.json.job_id, 'ready');
    assert.equal(applyScripts(h).length, 0, 'a finished computation writes nothing by itself');
    assert.equal(textureLayers(h).length, 0);
    assert.equal(ready.recipe_id, 'skin_pair_v1');
    assert.equal(ready.core.matches_pinned, true);
    assert.ok(ready.formulas.formula_1);
    assert.ok(ready.formulas.formula_2);
    assert.ok(Array.isArray(ready.diagnostics.notes));
    assert.equal(ready.document.color_profile, 'sRGB IEC61966-2.1');
    assert.ok(!/base64|"data"/.test(JSON.stringify(ready)), 'no pixels in the answer');

    const applied = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id, mask_source: { kind: 'selection' } });
    assert.equal(applied.isError, false, applied.text);
    assert.equal(applied.json.phase, 'applied');
    assert.equal(applied.json.apply.layers.length, 4);
    assert.ok(applied.json.apply.structure);
    assert.equal(applied.json.apply.structure.mainGroup.name.startsWith('Skin'), true);
    assert.equal(applied.json.apply.structure.subgroups.length, 2);

    // The pixels are the formulas core's own, exactly over the rect, opaque and gray.
    const wasmInstance = wasmLoader.createWasmInstance();
    const commonReq = {
        width: RECT.width,
        height: RECT.height,
        document: { width: 600, height: 400 },
        rect: RECT,
        pxPerMm: 6,
        seed: 2,
        lighting: { azimuthDeg: 315, elevationDeg: 45 },
        zone: 'cheek',
        params: { mode: 'lines', seed: 2, azimuthDeg: 315, elevationDeg: 45 },
        outputs: ['pores', 'furrows']
    };
    const res1 = wasmLoader.executeWasm({ ...commonReq, presets: ['candidate1'] }, wasmInstance);
    const res2 = wasmLoader.executeWasm({ ...commonReq, presets: ['candidate2'] }, wasmInstance);
    const expectedOutputs = {
        formula_1: { pores: res1.layers.formula_1_pores, furrows: res1.layers.formula_1_furrows },
        formula_2: { pores: res2.layers.formula_2_pores, furrows: res2.layers.formula_2_furrows }
    };

    // Walk the document's real layer tree instead of trusting the script's own report. Both
    // formula groups hold layers named "Pores" and "Microrelief", so only the group a layer
    // actually sits in tells which formula the person sees; a script that put Formula 1
    // pixels into the visible "Formula 2" group must fail here.
    const formulaOfGroup = {
        'Formula 2': { formulaId: 'formula_2', visible: true },
        'Formula 1': { formulaId: 'formula_1', visible: false }
    };
    const outputOfLayer = { Pores: 'pores', Microrelief: 'furrows' };
    const skinGroup = h.fake.doc.layers.find(layer => layer.kind === 'group' && layer.name === `Skin [${ready.job_id}]`);
    assert.ok(skinGroup, 'the Skin group is in the task document');
    assert.deepEqual(skinGroup.layers.map(group => group.name), ['Formula 2', 'Formula 1']);
    const treeLayerIds = [];
    for (const group of skinGroup.layers) {
        const formula = formulaOfGroup[group.name];
        assert.equal(group.visible, formula.visible, `${group.name} visibility`);
        assert.deepEqual(group.layers.map(layer => layer.name), ['Pores', 'Microrelief'], group.name);
        for (const layer of group.layers) {
            const label = `${group.name} / ${layer.name}`;
            assert.deepEqual(layer.bounds, { left: RECT.x, top: RECT.y, right: RECT.x + RECT.width, bottom: RECT.y + RECT.height }, label);
            assert.equal(layer.blendMode, 'linearLight', label);
            assert.equal(layer.opacity, 50, label);
            assert.equal(layer.fillOpacity, 100, label);
            assert.equal(layer.pixels.colorProfile, 'sRGB IEC61966-2.1', 'tagged with the document profile');
            assert.equal(layer.pixels.replace, true);
            const data = layer.pixels.data;
            for (let i = 0; i < data.length; i += 4) {
                assert.ok(data[i] === data[i + 1] && data[i + 1] === data[i + 2] && data[i + 3] === 255, label);
            }
            const expectedGray = expectedOutputs[formula.formulaId][outputOfLayer[layer.name]];
            assert.deepEqual(Buffer.from(h.fake.grayOf(layer)), Buffer.from(expectedGray), label);
            treeLayerIds.push(layer.id);
        }
    }
    // The answer names exactly the layers that are in the tree.
    const byId = (a, b) => a - b;
    assert.deepEqual(applied.json.apply.layers.map(layer => layer.id).sort(byId), treeLayerIds.sort(byId));
    assert.deepEqual(h.fake.state.historySteps, [`Agent: skin texture ${ready.job_id}: recipe skin_pair_v1`]);
    assert.equal(h.fake.state.imageDataDisposed, h.fake.state.imageDataCreated, 'all images are disposed');
    assert.equal(h.fake.state.nestedModalCalls, 0, 'no nested executeAsModal');

    // Wait for exchange files cleanup
    let own = h.ownFiles();
    for (let i = 0; i < 20 && own.length > 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        own = h.ownFiles();
    }
    assert.deepEqual(own, [], 'own exchange files are removed after a write');
    assert.ok(fs.existsSync(path.join(h.dataFolder, 'photoshop-helper.json')), 'the pairing file is untouched');

    // Repeating apply reports the same write and sends nothing.
    const again = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.deepEqual(again.json.apply.layers.map(l => l.id), applied.json.apply.layers.map(l => l.id));
    assert.equal(applyScripts(h).length, 1);

    // After the person's Undo the layers are gone; apply still does not write them again.
    h.fake.doc.layers = h.fake.doc.layers.filter(layer => !layer.name.startsWith('Skin'));
    const afterUndo = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(afterUndo.json.phase, 'applied');
    assert.equal(applyScripts(h).length, 1);
    assert.equal(textureLayers(h).length, 0);
});

test('repeated and simultaneous starts share one job; a reused key with other arguments is refused', async context => {
    const workers = heldWorkers();
    const h = makeHarness(context, { createWorker: workers.factory });
    const taskId = await h.startTask();

    const [a, b] = await Promise.all([
        h.call('ps_skin_texture_start', startArgs(taskId)),
        h.call('ps_skin_texture_start', startArgs(taskId))
    ]);
    assert.equal(a.json.job_id, b.json.job_id);
    assert.equal(h.fake.state.scripts.filter(s => s.kind === 'probe').length, 1);
    assert.equal(workers.created.length, 1);

    const repeat = await h.call('ps_skin_texture_start', startArgs(taskId));
    assert.equal(repeat.json.job_id, a.json.job_id);
    assert.equal(repeat.json.repeated_request, true);

    const conflict = await h.call('ps_skin_texture_start', startArgs(taskId, { px_per_mm: 7 }));
    assert.equal(conflict.isError, true);
    assert.equal(conflict.json.error.code, 'REQUEST_ID_CONFLICT');

    const busy = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'r2' }));
    assert.equal(busy.isError, true);
    assert.equal(busy.json.error.code, 'SLOT_BUSY');
    assert.equal(workers.created.length, 1, 'no second computation');
});

test('simultaneous applies send one write', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    const answers = await Promise.all([1, 2, 3].map(() => h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id })));
    assert.equal(applyScripts(h).length, 1);
    assert.equal(textureLayers(h).length, 1);
    for (const answer of answers) assert.equal(answer.json.phase, 'applied');
});

test('bad requests and foreign ids are refused before anything reaches Photoshop', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    for (const args of [
        startArgs(taskId, { rect: { x: 0, y: 0, width: 0, height: 5 } }),
        startArgs(taskId, { px_per_mm: Infinity }),
        startArgs(taskId, { params: { elevationDeg: Number.NaN } }),
        startArgs(taskId, { params: { width: 9000 } }),
        startArgs(taskId, { request_id: '' }),
        startArgs(taskId, { outputs: ['height'] })
    ]) {
        const answer = await h.call('ps_skin_texture_start', args);
        assert.equal(answer.isError, true, JSON.stringify(args));
    }
    assert.equal(h.fake.state.scripts.length, 0);

    const otherTask = await h.call('ps_skin_texture_start', startArgs('task-ffffff'));
    assert.equal(otherTask.isError, true);
    assert.match(otherTask.text, /There is no task task-ffffff/);

    const unknownJob = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: 'skt-000000000000' });
    assert.equal(unknownJob.json.error.code, 'JOB_UNKNOWN');

    // A rect outside the document can only be known after Photoshop reported the size.
    const outside = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'far', rect: { x: 580, y: 0, width: 64, height: 48 } }));
    const failed = await h.waitForPhase(taskId, outside.json.job_id, 'failed');
    assert.equal(failed.error.code, 'RECT_OUTSIDE_DOCUMENT');
    assert.equal(applyScripts(h).length, 0);
    assert.equal(h.fake.doc.layers.length, 1);
});

for (const [label, document, code] of [
    ['CMYK', { mode: 'CMYKColorMode' }, 'UNSUPPORTED_MODE'],
    ['32-bit', { bits: 32 }, 'UNSUPPORTED_DEPTH'],
    ['16-bit without a profile', { bits: 16, profileType: 'none' }, 'UNSUPPORTED_PROFILE']
]) {
    test(`a ${label} document is refused before a layer exists`, async context => {
        const h = makeHarness(context, { document });
        const taskId = await h.startTask();
        const started = await h.call('ps_skin_texture_start', startArgs(taskId));
        const failed = await h.waitForPhase(taskId, started.json.job_id, 'failed');
        assert.equal(failed.error.code, code);
        assert.equal(applyScripts(h).length, 0);
        assert.equal(h.fake.doc.layers.length, 1);
    });
}

test('a 16-bit document gets the verified 16-bit mapping with its own profile', async context => {
    const h = makeHarness(context, { document: { bits: 16, profileType: 'custom', profileName: 'ProPhoto RGB' } });
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    const applied = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(applied.json.phase, 'applied', applied.text);
    const firstLayerMeta = applied.json.apply.structure.subgroups[0].layers[0];
    const layer = h.fake.findLayerById(firstLayerMeta.id);
    assert.equal(layer.pixels.componentSize, 16);
    assert.equal(layer.pixels.colorProfile, 'ProPhoto RGB');
    assert.equal(layer.pixels.fullRange, false);
    const wasmRes = wasmLoader.executeWasm({
        width: RECT.width,
        height: RECT.height,
        document: { width: 600, height: 400 },
        rect: RECT,
        pxPerMm: 6,
        seed: 2,
        lighting: { azimuthDeg: 315, elevationDeg: 45 },
        zone: 'cheek',
        params: { mode: 'lines', seed: 2, azimuthDeg: 315, elevationDeg: 45 },
        presets: [firstLayerMeta.formulaId === 'formula_1' ? 'candidate1' : 'candidate2'],
        outputs: [firstLayerMeta.output]
    });
    const gray = wasmRes.layers[firstLayerMeta.formulaId + '_' + firstLayerMeta.output];
    for (let i = 0; i < gray.length; i++) {
        assert.equal(layer.pixels.data[i * 4], Math.round(gray[i] * 32768 / 255));
        assert.equal(layer.pixels.data[i * 4 + 3], 32768);
    }
});

test('an unmanaged 8-bit document gets untagged data', async context => {
    const h = makeHarness(context, { document: { profileType: 'none' } });
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    assert.equal(ready.document.color_profile, 'none (not colour managed)');
    const applied = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    const layer = h.fake.findLayerById(applied.json.apply.layers[0].id);
    assert.equal(layer.pixels.colorProfile, '');
});

test('the computation runs off the main thread; calls stay short', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    let last = Date.now();
    let worstGap = 0;
    const timer = setInterval(() => {
        const t = Date.now();
        worstGap = Math.max(worstGap, t - last);
        last = t;
    }, 10);
    context.after(() => clearInterval(timer));

    const started = await h.call('ps_skin_texture_start', startArgs(taskId, { rect: { x: 0, y: 0, width: 512, height: 384 }, params: { mode: 'cells' } }));
    let statusCalls = 0;
    let slowestStatus = 0;
    let computeMs = 0;
    for (;;) {
        const t = Date.now();
        const answer = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: started.json.job_id });
        slowestStatus = Math.max(slowestStatus, Date.now() - t);
        statusCalls += 1;
        if (answer.json.phase !== 'computing' && answer.json.phase !== 'checking_document') {
            assert.equal(answer.json.phase, 'ready', answer.text);
            computeMs = answer.json.times.compute_ms;
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 15));
    }
    clearInterval(timer);
    // The thresholds are relative to the computation, so a busy test machine does not make
    // this fail: computed in the main thread, the stall would be the whole computation.
    assert.ok(computeMs > 500, `the computation is long enough to show a stall (${computeMs} ms)`);
    assert.ok(statusCalls > 3, 'status was answered while the worker computed');
    assert.ok(slowestStatus < Math.min(500, computeMs / 4), `status took ${slowestStatus} ms of ${computeMs}`);
    // Worker start-up and the transfer of the result are the only main-thread work.
    assert.ok(worstGap < Math.min(1000, computeMs / 4), `the main thread stalled for ${worstGap} ms of ${computeMs}`);
});

test('a long computation never holds a call; cancel stops it and is safe to repeat', async context => {
    const workers = heldWorkers();
    const h = makeHarness(context, { createWorker: workers.factory, limits: { responseBudgetMs: 150 } });
    const taskId = await h.startTask();
    const t0 = Date.now();
    const started = await h.call('ps_skin_texture_start', startArgs(taskId));
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(started.json.phase, 'computing');

    const t1 = Date.now();
    const status = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: started.json.job_id });
    assert.ok(Date.now() - t1 < 100);
    assert.equal(status.json.phase, 'computing');

    const notReady = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: started.json.job_id });
    assert.equal(notReady.isError, true);
    assert.equal(notReady.json.refused.code, 'NOT_READY_COMPUTING');

    const cancelled = await h.call('ps_skin_texture_cancel', { task_id: taskId, job_id: started.json.job_id });
    assert.equal(cancelled.json.phase, 'cancelled');
    assert.equal(workers.created[0].terminated, true);
    const again = await h.call('ps_skin_texture_cancel', { task_id: taskId, job_id: started.json.job_id });
    assert.equal(again.json.phase, 'cancelled');
    assert.match(again.json.cancel, /Nothing to cancel/);

    // A late result from the stopped worker is ignored.
    workers.finish(workers.created[0]);
    const after = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: started.json.job_id });
    assert.equal(after.json.refused.code, 'NOT_READY_CANCELLED');
    assert.equal(applyScripts(h).length, 0);

    // The slot is free again.
    const next = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'r2' }));
    assert.equal(next.isError, false, next.text);
});

test('ending the task stops the computation and discards the result; status still reads it', async context => {
    const workers = heldWorkers();
    const h = makeHarness(context, { createWorker: workers.factory });
    const taskId = await h.startTask();
    const started = await h.call('ps_skin_texture_start', startArgs(taskId));
    await h.tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    assert.equal(workers.created[0].terminated, true);

    const status = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: started.json.job_id });
    assert.equal(status.json.phase, 'discarded');
    assert.equal(status.json.error.code, 'TASK_ENDED');
    const apply = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: started.json.job_id });
    assert.equal(apply.isError, true);
    assert.match(apply.text, /no longer running/);
});

test('an abandoned task expires and takes its ready result with it', async context => {
    let clock = 1_000_000;
    const h = makeHarness(context, { taskOptions: { now: () => clock, idleTimeoutMs: 60_000 } });
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    clock += 61_000;
    h.jobs._sweep();
    const status = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: ready.job_id });
    assert.equal(status.json.phase, 'discarded');
    assert.equal(status.json.result.held_in_memory, false);
});

test('a failing or vanishing worker fails the job', async context => {
    const workers = heldWorkers();
    const h = makeHarness(context, { createWorker: workers.factory });
    const taskId = await h.startTask();
    const first = await h.call('ps_skin_texture_start', startArgs(taskId));
    workers.created[0].emit('message', { type: 'error', message: 'Pore placement is too large' });
    const failed = await h.waitForPhase(taskId, first.json.job_id, 'failed');
    assert.equal(failed.error.code, 'COMPUTE_FAILED');
    assert.match(failed.error.message, /Pore placement/);

    const second = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'r2' }));
    workers.created[1].emit('exit', 1);
    const gone = await h.waitForPhase(taskId, second.json.job_id, 'failed');
    assert.match(gone.error.message, /without a result/);
});

test('dispose stops workers and removes own files', async context => {
    const workers = heldWorkers();
    const h = makeHarness(context, { createWorker: workers.factory });
    const taskId = await h.startTask();
    await h.call('ps_skin_texture_start', startArgs(taskId));
    fs.writeFileSync(path.join(h.dataFolder, exchangeFiles.fileNameFor('skt-aaaaaaaaaaaa', 1, 'main')), 'x');
    await h.jobs.dispose();
    assert.equal(workers.created[0].terminated, true);
    const late = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'late' }));
    assert.equal(late.json.error.code, 'SHUTTING_DOWN');
});

test('results and records are bounded', async context => {
    let clock = Date.now();
    const h = makeHarness(context, { now: () => clock, limits: { maxReadyResults: 1, maxJobsPerTask: 3, resultTtlMs: 60_000 } });
    const taskId = await h.startTask();
    const first = await readyJob(h, taskId, { request_id: 'a' });
    const second = await readyJob(h, taskId, { request_id: 'b' });
    const firstNow = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: first.job_id });
    assert.equal(firstNow.json.phase, 'discarded');
    assert.equal(firstNow.json.error.code, 'RESULT_REPLACED');

    clock += 61_000;
    const expired = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: second.job_id });
    assert.equal(expired.json.phase, 'discarded');
    assert.equal(expired.json.error.code, 'RESULT_EXPIRED');

    // Old finished records make room for new ones.
    await readyJob(h, taskId, { request_id: 'c' });
    await h.call('ps_skin_texture_cancel', { task_id: taskId, job_id: (await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'd' }))).json.job_id });
    const gone = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: first.job_id });
    assert.equal(gone.json.error.code, 'JOB_UNKNOWN');
});

test('a paused line refuses apply but not status or cancel; after resume the write goes through', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    h.fake.state.connected = false;
    h.tasks.suspend({ reason: 'the "FromPS / ToPS AI" line was turned off', reasonCode: 'ai-line-off' });

    const refused = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /paused/);
    const status = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: ready.job_id });
    assert.equal(status.json.phase, 'ready');
    assert.equal(applyScripts(h).length, 0, 'nothing is written while paused, nor on reconnect');

    h.fake.state.connected = true;
    h.tasks.resume({ reason: 'same runtime' });
    assert.equal(applyScripts(h).length, 0);
    const applied = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(applied.json.phase, 'applied', applied.text);
});

test('a new plugin runtime invalidates the result for writing', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const first = await readyJob(h, taskId, { request_id: 'a' });
    h.fake.state.runtimeId = 'uxp-runtime-2';
    const refused = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: first.job_id });
    assert.equal(refused.isError, true);
    assert.equal(refused.json.phase, 'invalidated');
    assert.equal(refused.json.error.code, 'RUNTIME_CHANGED');
    assert.equal(applyScripts(h).length, 0);

    // The service's reaction to a runtime restart (requiresRebind) invalidates at once.
    const second = await readyJob(h, taskId, { request_id: 'b' });
    h.tasks.suspend({ reason: 'the Photoshop plugin runtime restarted', requiresRebind: true, runtimeId: 'uxp-runtime-3' });
    const status = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: second.job_id });
    assert.equal(status.json.phase, 'invalidated');
});

test('a document closed before apply is not written to, and the task closes', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    h.fake.state.closed = true;
    const answer = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(answer.isError, true);
    assert.equal(answer.json.apply.state, 'not_applied');
    assert.equal(answer.json.apply.code, 'DOCUMENT_CLOSED');
    assert.equal(h.tasks.getCurrent(), null, 'the task was closed, as for every other tool');
});

for (const [label, change] of [
    ['size', doc => { doc.width = 601; }],
    ['colour profile', doc => { doc.colorProfileName = 'Adobe RGB (1998)'; doc.colorProfileType = 'custom'; }],
    ['depth', doc => { doc.bitsPerChannel = 'bitDepth16'; }]
]) {
    test(`a change of the document's ${label} after start stops the write`, async context => {
        const h = makeHarness(context);
        const taskId = await h.startTask();
        const ready = await readyJob(h, taskId);
        change(h.fake.doc);
        const answer = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
        assert.equal(answer.json.phase, 'invalidated', answer.text);
        assert.equal(answer.json.error.code, 'STALE_DOCUMENT');
        assert.equal(textureLayers(h).length, 0);
        assert.equal(h.fake.state.historySteps.length, 0);
    });
}

test('the write goes to the task document even when the person looks at another one', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    h.fake.app.activeDocument = h.fake.other;
    await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(textureLayers(h).length, 1);
    assert.equal(h.fake.other.layers.length, 1, 'the other document is untouched');
});

test('a busy Photoshop writes nothing, and a later apply writes once', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    h.fake.state.busy = true;
    const busy = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(busy.isError, true);
    assert.equal(busy.json.phase, 'ready');
    assert.equal(busy.json.apply.code, 'PHOTOSHOP_BUSY');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(h.ownFiles(), []);

    h.fake.state.busy = false;
    const applied = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(applied.json.phase, 'applied');
    assert.equal(applied.json.apply.attempt, 2);
    assert.equal(textureLayers(h).length, 1);
});

test('an open interactive dialog keeps start and apply from reaching Photoshop', async context => {
    const h = makeHarness(context, { dialogWaitMs: 30 });
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    let release;
    h.fake.state.beforeScript = payload => (payload.interactive || payload.code.includes('dialog-opened'))
        ? new Promise(resolve => { release = resolve; })
        : undefined;
    const dialog = await h.tools.call('ps_execute_script', { task_id: taskId, code: '/* dialog-opened */ return 1;', history_name: 'liquify', interactive: true });
    assert.match(dialog.content[0].text, /still working/);
    const before = h.fake.state.scripts.length;

    const apply = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(apply.isError, true);
    assert.match(apply.text, /ps_wait_for_dialog/);
    const start = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'r2' }));
    assert.equal(start.isError, true);
    assert.match(start.text, /ps_wait_for_dialog/);
    assert.equal(h.fake.state.scripts.length, before);
    h.fake.state.beforeScript = null;
    release();
});

test('a delayed answer: apply returns within its budget, status follows the write, no second write', async context => {
    const h = makeHarness(context, { limits: { responseBudgetMs: 100 } });
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    let release;
    h.fake.state.beforeScript = (payload, record) => (record.kind === 'apply' ? new Promise(resolve => { release = resolve; }) : undefined);

    const t0 = Date.now();
    const pending = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(pending.isError, false);
    assert.equal(pending.json.phase, 'applying');

    const cancel = await h.call('ps_skin_texture_cancel', { task_id: taskId, job_id: ready.job_id });
    assert.equal(cancel.json.phase, 'applying');
    assert.match(cancel.json.cancel, /cannot take it back/);

    const again = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(again.json.phase, 'applying');
    assert.equal(applyScripts(h).length, 1);

    release();
    const done = await h.waitForPhase(taskId, ready.job_id, 'applied');
    assert.equal(done.apply.layers.length, 4);
    await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(applyScripts(h).length, 1);
    assert.equal(textureLayers(h).length, 1);
});

test('a lost answer leaves the outcome unknown, never repeats the write, and cleans up later', async context => {
    const h = makeHarness(context, { limits: { applyStartDeadlineMs: 20, fileGraceMs: 0 } });
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    h.fake.state.afterScript = (answer, payload, record) => {
        if (record.kind === 'apply') throw new Error('Photoshop did not answer within 120 seconds. The connection to the FromPS / ToPS plugin is down.');
        return answer;
    };
    const answer = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(answer.json.phase, 'apply_unknown');
    assert.equal(answer.isError, true);
    assert.match(answer.json.next_step, new RegExp(`\\[${ready.job_id}\\]`));
    assert.equal(textureLayers(h).length, 1, 'the write did happen in this case');

    const again = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(again.json.phase, 'apply_unknown');
    assert.equal(applyScripts(h).length, 1);
    const cancel = await h.call('ps_skin_texture_cancel', { task_id: taskId, job_id: ready.job_id });
    assert.match(cancel.json.cancel, /unknown/);

    assert.equal(h.ownFiles().length, 4, 'files stay while a late script could still read them');
    await new Promise(resolve => setTimeout(resolve, 40));
    h.jobs._sweep();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(h.ownFiles(), []);
});

test('a write that reaches Photoshop after its deadline changes nothing and may be sent again', async context => {
    const h = makeHarness(context, { limits: { applyStartDeadlineMs: -1000 } });
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    const late = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(late.json.apply.code, 'APPLY_EXPIRED');
    assert.equal(late.json.phase, 'ready');
    assert.equal(textureLayers(h).length, 0);
    assert.equal(h.fake.state.historySteps.length, 0);
});

for (const [label, tamper, code] of [
    ['truncated', file => { const b = fs.readFileSync(file); fs.writeFileSync(file, b.subarray(0, b.length - 10)); }, 'EXCHANGE_TRUNCATED'],
    ['changed', file => { const b = fs.readFileSync(file); b[b.length - 30] ^= 255; fs.writeFileSync(file, b); }, 'EXCHANGE_PAYLOAD_CRC'],
    ['foreign', file => {
        const gray = new Uint8Array(RECT.width * RECT.height).fill(128);
        fs.writeFileSync(file, SkinExchange.encode({ jobId: 'skt-bbbbbbbbbbbb', taskId: 'x', output: 'main', document: { id: 7, width: 600, height: 400 }, rect: RECT }, gray));
    }, 'EXCHANGE_WRONG_JOB'],
    ['missing', file => fs.rmSync(file), 'EXCHANGE_READ_FAILED']
]) {
    test(`a ${label} exchange file is refused before a layer exists`, async context => {
        const h = makeHarness(context);
        const taskId = await h.startTask();
        const ready = await readyJob(h, taskId);
        h.fake.state.beforeScript = (payload, record) => {
            if (record.kind !== 'apply') return;
            for (const name of h.ownFiles()) tamper(path.join(h.dataFolder, name));
        };
        const answer = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
        assert.equal(answer.json.phase, 'failed', answer.text);
        assert.equal(answer.json.error.code, code);
        assert.equal(h.fake.doc.layers.length, 1);
        assert.equal(h.fake.state.historySteps.length, 0);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.deepEqual(h.ownFiles(), []);
    });
}

test('a failure on the second layer removes only this write\'s own layers', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    h.fake.state.failPutPixelsOnCall = 2;
    const answer = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(answer.isError, true);
    assert.equal(answer.json.phase, 'failed', answer.text);
    assert.match(answer.json.error.message, /deleted again/);
    assert.deepEqual(h.fake.doc.layers.map(layer => layer.name), ['Background']);
    assert.equal(h.fake.state.imageDataDisposed, h.fake.state.imageDataCreated, 'all images are disposed');
});

test('when its own layers cannot be removed the outcome is reported as unknown, with their ids', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    h.fake.state.failPutPixelsOnCall = 2;
    h.fake.state.failAllDeletes = true;
    const answer = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(answer.json.phase, 'apply_unknown');
    assert.equal(answer.json.apply.leftover_layer_ids.length, 2);
});

test('a failure before the first layer changes nothing', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    h.fake.state.failCreateImageDataOnCall = 1;
    const answer = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(answer.json.phase, 'failed');
    assert.equal(h.fake.doc.layers.length, 1);
    assert.equal(h.fake.state.historySteps.length, 0);
});

test('only provably own orphans are removed from the data folder', async context => {
    const h = makeHarness(context);
    const folder = h.dataFolder;
    const own = exchangeFiles.fileNameFor('skt-cccccccccccc', 1, 'main');
    const ownNoMagic = exchangeFiles.fileNameFor('skt-dddddddddddd', 1, 'pores');
    const recent = exchangeFiles.fileNameFor('skt-eeeeeeeeeeee', 1, 'main');
    const live = exchangeFiles.fileNameFor('skt-ffffffffffff', 1, 'main');
    const gray = new Uint8Array(4).fill(128);
    const encoded = SkinExchange.encode({ jobId: 'skt-cccccccccccc', taskId: 't', output: 'main', document: { id: 1, width: 2, height: 2 }, rect: { x: 0, y: 0, width: 2, height: 2 } }, gray);
    fs.writeFileSync(path.join(folder, own), encoded);
    fs.writeFileSync(path.join(folder, `${own}.partial`), 'half');
    fs.writeFileSync(path.join(folder, ownNoMagic), 'not ours after all');
    fs.writeFileSync(path.join(folder, recent), encoded);
    fs.writeFileSync(path.join(folder, live), encoded);
    fs.writeFileSync(path.join(folder, 'skin-texture-notes.txt'), 'someone else');
    const old = (Date.now() - 3_600_000) / 1000;
    for (const name of [own, `${own}.partial`, ownNoMagic, live]) fs.utimesSync(path.join(folder, name), old, old);

    const report = await exchangeFiles.sweepOrphans(folder, { liveNames: new Set([live]), minAgeMs: 15 * 60_000 });
    assert.deepEqual(report.removed.sort(), [own, `${own}.partial`].sort());
    for (const name of [ownNoMagic, recent, live, 'skin-texture-notes.txt', 'photoshop-helper.json']) {
        assert.ok(fs.existsSync(path.join(folder, name)), `${name} is kept`);
    }
    assert.throws(() => exchangeFiles.ownPath(folder, '..\\photoshop-helper.json'));
    assert.throws(() => exchangeFiles.fileNameFor('../x', 1, 'main'));
});

// ── task03.10: the findings R1-R3 of the task03 lead review ────────────────────────
//
// R1: a request_id must stay used after its job record is dropped.
// R2: preparing the exchange file is not sending the write; whatever happens before the
//     send stops it, and after the send nothing claims "cancelled" or sends again.
// R3: files of a write with an unknown outcome outlive Helper's quit until their safe time.

/**
 * @param {object} h - Harness.
 * @returns {object[]} Read-only document probes sent to the fake plugin.
 */
function probeScripts(h) {
    return h.fake.state.scripts.filter(record => record.kind === 'probe');
}

/**
 * Start a job on held workers, let its worker finish at once, and wait until it is ready.
 *
 * @param {object} h - Harness.
 * @param {object} workers - heldWorkers().
 * @param {string} taskId - Task id.
 * @param {object} [extra] - Start argument overrides.
 * @returns {Promise<object>} The ready status.
 */
async function readyHeld(h, workers, taskId, extra) {
    const started = await h.call('ps_skin_texture_start', startArgs(taskId, extra));
    assert.equal(started.isError, false, started.text);
    await h.waitForPhase(taskId, started.json.job_id, 'computing');
    workers.finish(workers.created.find(worker => worker.workerData.meta.jobId === started.json.job_id));
    return h.waitForPhase(taskId, started.json.job_id, 'ready');
}

/**
 * Start a request and cancel it while it computes.
 *
 * @returns {Promise<string>} Its job id.
 */
async function startAndCancel(h, taskId, requestId) {
    const started = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: requestId }));
    assert.equal(started.isError, false, started.text);
    const cancelled = await h.call('ps_skin_texture_cancel', { task_id: taskId, job_id: started.json.job_id });
    assert.equal(cancelled.json.phase, 'cancelled', cancelled.text);
    return started.json.job_id;
}

/**
 * Call apply with the file publication held, and wait until the hand-over is held.
 *
 * @returns {Promise<{hold: object, pending: Promise<object>}>}
 */
async function applyHeld(context, h, taskId, jobId, holdOptions) {
    const hold = holdPublish(holdOptions);
    context.after(() => hold.restore());
    const pending = h.call('ps_skin_texture_apply', { task_id: taskId, job_id: jobId });
    await hold.reached;
    return { hold, pending };
}

/** Let fire-and-forget file removals finish. */
function settled() {
    return new Promise(resolve => setTimeout(resolve, 50));
}

/**
 * @param {object} h - Harness.
 * @param {string} name - A file name.
 * @param {number} [timeoutMs] - Longest wait.
 * @returns {Promise<boolean>} Whether the file disappeared from the data folder in time.
 */
async function fileGone(h, name, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!fs.existsSync(path.join(h.dataFolder, name))) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
}

/**
 * Make the fake transport lose the answer of every apply script (the write did run).
 *
 * @param {object} h - Harness.
 */
function loseApplyAnswers(h) {
    h.fake.state.afterScript = (answer, payload, record) => {
        if (record.kind === 'apply') throw new Error('Simulated lost transport answer');
        return answer;
    };
}

test('R1: after 12 more requests the first request_id is still used: no second computation or layer, also after Undo', async context => {
    const workers = heldWorkers();
    const h = makeHarness(context, { createWorker: workers.factory });
    assert.equal(h.jobs.options.maxJobsPerTask, 12, 'the real default limit of the lead review');
    const taskId = await h.startTask();
    const first = await readyHeld(h, workers, taskId, { request_id: 'first' });
    const applied = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: first.job_id });
    assert.equal(applied.json.phase, 'applied', applied.text);
    const layerIds = applied.json.apply.layers.map(layer => layer.id);
    for (let i = 1; i <= 12; i++) await startAndCancel(h, taskId, `filler-${i}`);
    const workersBefore = workers.created.length;
    const probesBefore = probeScripts(h).length;

    // The record of "first" has been dropped to keep memory bounded...
    const gone = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: first.job_id });
    assert.equal(gone.json.error.code, 'JOB_UNKNOWN');
    assert.match(gone.json.error.message, /no longer kept/);
    assert.equal(gone.json.error.details.phase, 'applied');
    assert.deepEqual(gone.json.error.details.layer_ids, layerIds);

    // ...but its key did not become new again.
    const repeat = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'first' }));
    assert.equal(repeat.isError, true);
    assert.equal(repeat.json.error.code, 'REQUEST_ALREADY_USED', repeat.text);
    assert.equal(repeat.json.error.details.job_id, first.job_id);
    assert.equal(repeat.json.error.details.phase, 'applied');
    assert.deepEqual(repeat.json.error.details.layer_ids, layerIds);
    const conflict = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'first', px_per_mm: 7 }));
    assert.equal(conflict.json.error.code, 'REQUEST_ID_CONFLICT');
    assert.equal(conflict.json.error.details.job_id, first.job_id);

    // The person undoes the write; an apply of the old job still writes nothing.
    h.fake.doc.layers = h.fake.doc.layers.filter(layer => !layer.name.startsWith('Skin'));
    const afterUndo = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: first.job_id });
    assert.equal(afterUndo.isError, true);
    assert.equal(afterUndo.json.error.code, 'JOB_UNKNOWN');

    assert.equal(workers.created.length, workersBefore, 'no second computation');
    assert.equal(probeScripts(h).length, probesBefore, 'the repeats sent nothing to Photoshop');
    assert.equal(applyScripts(h).length, 1, 'one write in all');
    assert.equal(textureLayers(h).length, 0, 'no layer came back after Undo');
});

test('R1 on a small limit: expired, cancelled and applied requests stay used after their records are dropped', async context => {
    const workers = heldWorkers();
    let clock = Date.now();
    const h = makeHarness(context, { createWorker: workers.factory, now: () => clock, limits: { maxJobsPerTask: 3, resultTtlMs: 60_000 } });
    const taskId = await h.startTask();
    const expired = await readyHeld(h, workers, taskId, { request_id: 'a' });
    clock += 61_000;
    const expiredNow = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: expired.job_id });
    assert.equal(expiredNow.json.error.code, 'RESULT_EXPIRED');
    await startAndCancel(h, taskId, 'b');
    const written = await readyHeld(h, workers, taskId, { request_id: 'c' });
    assert.equal((await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: written.job_id })).json.phase, 'applied');
    // Three more requests push the records of a, b and c out.
    for (const requestId of ['d', 'e', 'f']) await startAndCancel(h, taskId, requestId);
    const workersBefore = workers.created.length;

    for (const [requestId, phase] of [['a', 'discarded'], ['b', 'cancelled'], ['c', 'applied']]) {
        const again = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: requestId }));
        assert.equal(again.json.error.code, 'REQUEST_ALREADY_USED', again.text);
        assert.equal(again.json.error.details.phase, phase, requestId);
        const other = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: requestId, params: { seed: 9 } }));
        assert.equal(other.json.error.code, 'REQUEST_ID_CONFLICT', requestId);
    }
    assert.equal(workers.created.length, workersBefore, 'no computation for a used key');
    assert.equal(applyScripts(h).length, 1);
    assert.equal(textureLayers(h).length, 1);
});

test('R1: a task accepts a bounded number of request_ids; known ones still answer', async context => {
    const workers = heldWorkers();
    const h = makeHarness(context, { createWorker: workers.factory, limits: { maxJobsPerTask: 2, maxRequestsPerTask: 3 } });
    assert.equal(DEFAULT_OPTIONS.maxRequestsPerTask, 100);
    const taskId = await h.startTask();
    await startAndCancel(h, taskId, 'r1');
    await startAndCancel(h, taskId, 'r2');
    const third = await startAndCancel(h, taskId, 'r3');
    const created = workers.created.length;

    const refused = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'r4' }));
    assert.equal(refused.isError, true);
    assert.equal(refused.json.error.code, 'REQUEST_LIMIT_REACHED');
    assert.match(refused.json.error.message, /start a new task/);

    const kept = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'r3' }));
    assert.equal(kept.json.job_id, third);
    assert.equal(kept.json.repeated_request, true);
    const dropped = await h.call('ps_skin_texture_start', startArgs(taskId, { request_id: 'r1' }));
    assert.equal(dropped.json.error.code, 'REQUEST_ALREADY_USED');
    assert.equal(workers.created.length, created, 'nothing was computed for these');
});

for (const when of ['after', 'before']) {
    test(`R2: cancel while the file is being prepared (held ${when} it is on disk) stops the write before it is sent`, async context => {
        const h = makeHarness(context);
        const taskId = await h.startTask();
        const ready = await readyJob(h, taskId);
        const { hold, pending } = await applyHeld(context, h, taskId, ready.job_id, { when });
        assert.equal(applyScripts(h).length, 0);
        const during = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: ready.job_id });
        assert.equal(during.json.phase, 'preparing_write');
        assert.equal(during.json.can_cancel_without_change, true);
        assert.equal(during.json.apply.sent, false);

        // The cancel is registered as soon as the call is made; the file hand-over then ends.
        const cancelling = h.call('ps_skin_texture_cancel', { task_id: taskId, job_id: ready.job_id });
        hold.release();
        const cancelled = await cancelling;
        const outcome = await pending;
        assert.equal(cancelled.json.phase, 'cancelled', cancelled.text);
        assert.match(cancelled.json.cancel, /before the write was sent/);
        assert.doesNotMatch(cancelled.json.cancel, /already sent/);
        assert.equal(outcome.json.phase, 'cancelled', outcome.text);
        assert.equal(outcome.json.apply.sent, false);
        assert.equal(applyScripts(h).length, 0, 'nothing was sent');
        assert.equal(textureLayers(h).length, 0);
        assert.deepEqual(h.fake.state.historySteps, []);
        await settled();
        assert.deepEqual(h.ownFiles(), [], 'no file is left behind, not even one written late');

        const again = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
        assert.equal(again.json.refused.code, 'NOT_READY_CANCELLED');
        assert.equal(applyScripts(h).length, 0);
    });
}

for (const [label, end, code] of [
    ['ps_finish_task', (h, taskId) => h.tools.call('ps_finish_task', { task_id: taskId, summary: 'done' }), 'TASK_ENDED'],
    ['Abort task', h => h.tasks.abort('stopped by the user'), 'TASK_ENDED'],
    ['Helper quitting (dispose)', h => { h.disposing = h.jobs.dispose(); }, 'HELPER_QUIT']
]) {
    test(`R2: ${label} while the file is being prepared: nothing is sent, no layer, no file`, async context => {
        const h = makeHarness(context);
        const taskId = await h.startTask();
        const ready = await readyJob(h, taskId);
        const { hold, pending } = await applyHeld(context, h, taskId, ready.job_id);
        await end(h, taskId);
        hold.release();
        await pending;
        if (h.disposing) await h.disposing;
        const status = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: ready.job_id });
        assert.equal(status.json.phase, 'discarded', status.text);
        assert.equal(status.json.error.code, code);
        assert.equal(status.json.apply.sent, false);
        assert.equal(applyScripts(h).length, 0, 'nothing was sent');
        assert.equal(textureLayers(h).length, 0);
        await settled();
        assert.deepEqual(h.ownFiles(), []);
    });
}

test('R2: a task that expires while the file is being prepared sends nothing', async context => {
    let clock = 1_000_000;
    const h = makeHarness(context, { taskOptions: { now: () => clock, idleTimeoutMs: 60_000 } });
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    const { hold, pending } = await applyHeld(context, h, taskId, ready.job_id);
    clock += 61_000;
    hold.release();
    await pending;
    assert.equal(h.tasks.getCurrent(), null, 'the task expired');
    const status = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: ready.job_id });
    assert.equal(status.json.phase, 'discarded', status.text);
    assert.equal(status.json.error.code, 'TASK_ENDED');
    assert.equal(applyScripts(h).length, 0);
    assert.equal(textureLayers(h).length, 0);
    await settled();
    assert.deepEqual(h.ownFiles(), []);
});

test('R2: a pause while the file is being prepared stops the write; the line coming back sends nothing; an explicit apply writes once', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    const { hold, pending } = await applyHeld(context, h, taskId, ready.job_id);
    h.fake.state.connected = false;
    h.tasks.suspend({ reason: 'the "FromPS / ToPS AI" line was turned off', reasonCode: 'ai-line-off' });
    h.fake.state.connected = true;
    h.tasks.resume({ reason: 'the FromPS / ToPS AI line reconnected in the same plugin runtime' });
    hold.release();
    const outcome = await pending;
    assert.equal(outcome.isError, true);
    assert.equal(outcome.json.phase, 'ready', outcome.text);
    assert.equal(outcome.json.apply.state, 'not_applied');
    assert.equal(outcome.json.apply.code, 'PAUSED_BEFORE_SEND');
    assert.equal(outcome.json.apply.sent, false);
    await settled();
    assert.equal(applyScripts(h).length, 0, 'the line coming back sent nothing by itself');
    assert.deepEqual(h.ownFiles(), []);

    hold.restore();
    const applied = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(applied.json.phase, 'applied', applied.text);
    assert.equal(applied.json.apply.attempt, 2);
    assert.equal(applyScripts(h).length, 1);
    assert.equal(textureLayers(h).length, 1);
});

test('R2: a line still paused when the file is ready: nothing is sent, and apply waits for the line', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    const { hold, pending } = await applyHeld(context, h, taskId, ready.job_id);
    h.fake.state.connected = false;
    h.tasks.suspend({ reason: 'the "FromPS / ToPS AI" line was turned off', reasonCode: 'ai-line-off' });
    hold.release();
    const outcome = await pending;
    assert.equal(outcome.json.apply.code, 'PAUSED_BEFORE_SEND', outcome.text);
    const refused = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /paused/);
    assert.equal(applyScripts(h).length, 0);
});

for (const [label, change] of [
    ['a runtime restart reported by the plugin (requiresRebind)', h => {
        h.fake.state.runtimeId = 'uxp-runtime-2';
        h.tasks.suspend({ reason: 'the Photoshop plugin runtime restarted', requiresRebind: true, runtimeId: 'uxp-runtime-2' });
    }],
    ['another runtime id on the channel, without any event', h => { h.fake.state.runtimeId = 'uxp-runtime-2'; }]
]) {
    test(`R2: ${label} while the file is being prepared invalidates the result before it is sent`, async context => {
        // The fake keeps its document across a runtime change, unlike a real new UXP runtime.
        // What this checks is that the manager refuses before the transport, not how
        // Photoshop would behave.
        const h = makeHarness(context);
        const taskId = await h.startTask();
        const ready = await readyJob(h, taskId);
        const { hold, pending } = await applyHeld(context, h, taskId, ready.job_id);
        change(h);
        hold.release();
        await pending;
        const status = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: ready.job_id });
        assert.equal(status.json.phase, 'invalidated', status.text);
        assert.equal(status.json.error.code, 'RUNTIME_CHANGED');
        assert.equal(status.json.apply.sent, false);
        assert.equal(applyScripts(h).length, 0, 'nothing was sent');
        assert.equal(textureLayers(h).length, 0);
        await settled();
        assert.deepEqual(h.ownFiles(), []);
    });
}

test('R2: an interactive dialog opened while the file is being prepared stops the write; a later apply writes once', async context => {
    const h = makeHarness(context, { dialogWaitMs: 30 });
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    const { hold, pending } = await applyHeld(context, h, taskId, ready.job_id);
    let closeDialog;
    h.fake.state.beforeScript = payload => (payload.interactive ? new Promise(resolve => { closeDialog = resolve; }) : undefined);
    const dialog = await h.tools.call('ps_execute_script', { task_id: taskId, code: 'return 1;', history_name: 'liquify', interactive: true });
    assert.match(dialog.content[0].text, /still working/);
    hold.release();
    const outcome = await pending;
    assert.equal(outcome.json.phase, 'ready', outcome.text);
    assert.equal(outcome.json.apply.code, 'DIALOG_PENDING');
    assert.equal(outcome.json.apply.sent, false);
    assert.equal(applyScripts(h).length, 0, 'nothing was sent while the dialog was open');

    h.fake.state.beforeScript = null;
    closeDialog();
    const waited = await h.tools.call('ps_wait_for_dialog', { task_id: taskId });
    assert.match(waited.content[0].text, /Returned: 1/);
    hold.restore();
    const applied = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(applied.json.phase, 'applied', applied.text);
    assert.equal(applyScripts(h).length, 1);
    assert.equal(textureLayers(h).length, 1);
});

test('R2: simultaneous applies during preparation share one attempt and one write', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    const hold = holdPublish();
    context.after(() => hold.restore());
    const pending = [1, 2, 3].map(() => h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id }));
    await hold.reached;
    hold.release();
    for (const answer of await Promise.all(pending)) assert.equal(answer.json.phase, 'applied', answer.text);
    assert.equal(hold.calls, 4, 'four file hand-overs');
    assert.equal(applyScripts(h).length, 1);
    assert.equal(textureLayers(h).length, 1);
});

test('across the send: once the write was sent, cancel, repeats and the end of the task never claim "cancelled" or send again', async context => {
    assert.equal(DEFAULT_OPTIONS.responseBudgetMs, 15_000, 'the response budget is still 15 s');
    const h = makeHarness(context, { limits: { responseBudgetMs: 100 } });
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    let release;
    h.fake.state.beforeScript = (payload, record) => (record.kind === 'apply' ? new Promise(resolve => { release = resolve; }) : undefined);

    const pending = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(pending.json.phase, 'applying');
    assert.equal(pending.json.can_cancel_without_change, false);
    assert.equal(pending.json.apply.sent, true);
    const cancel = await h.call('ps_skin_texture_cancel', { task_id: taskId, job_id: ready.job_id });
    assert.equal(cancel.json.phase, 'applying');
    assert.match(cancel.json.cancel, /already sent/);
    assert.equal(cancel.json.can_cancel_without_change, false);
    assert.equal(cancel.json.apply.cancel_requested, true);
    const again = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(again.json.phase, 'applying');
    assert.equal(applyScripts(h).length, 1);

    // The person aborts the task while Photoshop is still writing: the write is not
    // reported as unwritten, and its real outcome still arrives in status.
    h.tasks.abort('stopped by the user');
    release();
    const done = await h.waitForPhase(taskId, ready.job_id, 'applied');
    assert.equal(done.apply.layers.length, 4);
    assert.equal(applyScripts(h).length, 1);
    assert.equal(textureLayers(h).length, 1);
});

test('across the send: a lost answer stays unknown; cancel does not turn it into "cancelled"', async context => {
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    loseApplyAnswers(h);
    const unknown = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(unknown.json.phase, 'apply_unknown');
    const cancel = await h.call('ps_skin_texture_cancel', { task_id: taskId, job_id: ready.job_id });
    assert.equal(cancel.json.phase, 'apply_unknown');
    assert.equal(cancel.json.can_cancel_without_change, false);
    assert.match(cancel.json.cancel, /unknown/);
    await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(applyScripts(h).length, 1, 'no second write');
});

test('R3: on quit, files of a write with an unknown outcome stay until deadline plus grace; the next run removes only its own orphans', async context => {
    assert.ok(DEFAULT_OPTIONS.orphanMinAgeMs >= DEFAULT_OPTIONS.applyStartDeadlineMs + DEFAULT_OPTIONS.fileGraceMs,
        'a later run never treats a still protected file as an orphan');
    const h = makeHarness(context);
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    loseApplyAnswers(h);
    const unknown = await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id });
    assert.equal(unknown.json.phase, 'apply_unknown');
    const files = h.ownFiles();
    assert.equal(files.length, 4);

    await h.jobs.dispose();
    await settled();
    assert.deepEqual(h.ownFiles(), files, 'not removed before deadline plus grace');
    const status = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: ready.job_id });
    assert.equal(status.json.result.held_in_memory, false, 'the pixels are released all the same');

    // The next Helper run over the same data folder, 10 minutes later: still too young.
    const soon = makeHarness(context, { dataFolder: h.dataFolder, now: () => Date.now() + 10 * 60_000 });
    await readyJob(soon, await soon.startTask());
    await settled();
    assert.deepEqual(h.ownFiles(), files, 'kept: younger than the orphan age');

    // A run 20 minutes after the write: now it is an orphan, and only it goes.
    const later = makeHarness(context, { dataFolder: h.dataFolder, now: () => Date.now() + 20 * 60_000 });
    await readyJob(later, await later.startTask());
    assert.equal(await fileGone(h, files[0]), true, 'removed as an orphan');
    assert.ok(fs.existsSync(path.join(h.dataFolder, 'photoshop-helper.json')), 'the pairing file is untouched');
    assert.equal(applyScripts(later).length, 0, 'nothing is resumed from a left file');
});

test('R3: the same holds when only the delayed-removal list still knows the files (job record dropped)', async context => {
    const workers = heldWorkers();
    const h = makeHarness(context, { createWorker: workers.factory, limits: { maxJobsPerTask: 2 } });
    const taskId = await h.startTask();
    const ready = await readyHeld(h, workers, taskId, { request_id: 'u' });
    loseApplyAnswers(h);
    assert.equal((await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id })).json.phase, 'apply_unknown');
    await startAndCancel(h, taskId, 'x');
    await startAndCancel(h, taskId, 'y');
    const gone = await h.call('ps_skin_texture_status', { task_id: taskId, job_id: ready.job_id });
    assert.equal(gone.json.error.code, 'JOB_UNKNOWN', 'the record of the unknown write was dropped');
    assert.equal(gone.json.error.details.phase, 'apply_unknown');
    const files = h.ownFiles();
    assert.equal(files.length, 4);
    await h.jobs.dispose();
    await settled();
    assert.deepEqual(h.ownFiles(), files);
});

test('R3: once deadline plus grace has passed, quitting removes those files', async context => {
    const h = makeHarness(context, { limits: { applyStartDeadlineMs: 20, fileGraceMs: 0 } });
    const taskId = await h.startTask();
    const ready = await readyJob(h, taskId);
    loseApplyAnswers(h);
    assert.equal((await h.call('ps_skin_texture_apply', { task_id: taskId, job_id: ready.job_id })).json.phase, 'apply_unknown');
    assert.equal(h.ownFiles().length, 4);
    await new Promise(resolve => setTimeout(resolve, 40));
    await h.jobs.dispose();
    assert.deepEqual(h.ownFiles(), []);
});
