'use strict';

/**
 * The skin texture tools when this Helper run must not compute textures
 * (skin-texture/availability.js):
 * - the installed build (inDevelopment): the tools stay published exactly as they are, every
 *   call answers that the feature is in development, formulas.wasm is never looked for;
 * - a development run without a usable formulas.wasm: Helper starts, logs the reason, and
 *   the tools answer with it.
 * None of this needs formulas.wasm, so these tests also run in a fresh checkout.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentService, resolveAgentPaths } = require('../agent');
const { createFakePhotoshop } = require('./skinTextureFakes');
const { IN_DEVELOPMENT_CODE, CORE_UNAVAILABLE_CODE } = require('../skin-texture/availability');

const SKIN_TOOLS = ['ps_skin_texture_start', 'ps_skin_texture_status', 'ps_skin_texture_apply', 'ps_skin_texture_cancel'];
const isWasmFile = file => String(file).endsWith('formulas.wasm');

/**
 * @param {import('node:test').TestContext} context - Test context (clean-up).
 * @param {object} skinTexture - The skinTexture option of createAgentService.
 * @param {object} [logger] - Logger for the service.
 * @returns {object} Service, fake Photoshop and a call helper.
 */
function makeService(context, skinTexture, logger = { info() {}, warn() {}, error() {} }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-indev-'));
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

/**
 * Replace fs functions for the duration of one test.
 *
 * @param {import('node:test').TestContext} context - Test context (restores on clean-up).
 * @param {object} replacements - { name: (original) => replacement }.
 */
function patchFs(context, replacements) {
    for (const [name, make] of Object.entries(replacements)) {
        const original = fs[name];
        fs[name] = make(original);
        context.after(() => { fs[name] = original; });
    }
}

/**
 * Call all four tools once with valid-looking arguments.
 *
 * @param {Function} call - The service call helper.
 * @param {string} taskId - Running task.
 * @returns {Promise<object[]>} The four answers.
 */
async function callAllSkinTools(call, taskId) {
    const jobArgs = { task_id: taskId, job_id: 'skt-0123456789ab' };
    return [
        await call('ps_skin_texture_start', {
            task_id: taskId, request_id: 'cheek-1', rect: { x: 10, y: 10, width: 40, height: 30 }, px_per_mm: 5
        }),
        await call('ps_skin_texture_status', jobArgs),
        await call('ps_skin_texture_apply', { ...jobArgs, mask_source: { kind: 'selection' } }),
        await call('ps_skin_texture_cancel', jobArgs)
    ];
}

test('installed build: the four tools are published exactly as in a development run and formulas.wasm is never looked for', context => {
    const wasmLookups = [];
    patchFs(context, {
        existsSync: original => (file, ...rest) => {
            if (isWasmFile(file)) wasmLookups.push(file);
            return original.call(fs, file, ...rest);
        },
        readFileSync: original => (file, ...rest) => {
            if (isWasmFile(file)) wasmLookups.push(file);
            return original.call(fs, file, ...rest);
        }
    });
    const installed = makeService(context, { inDevelopment: true }).service.tools.list();
    assert.deepEqual(wasmLookups, [], 'the installed build must not look for formulas.wasm');

    const development = makeService(context, {}).service.tools.list();
    for (const name of SKIN_TOOLS) {
        const published = installed.find(tool => tool.name === name);
        assert.ok(published, `${name} is published`);
        assert.deepEqual(published, development.find(tool => tool.name === name), `${name} is unchanged`);
    }
    assert.deepEqual(installed.map(tool => tool.name), development.map(tool => tool.name));
});

test('installed build: every skin texture call answers "in development" and the document is untouched', async context => {
    const { fake, call } = makeService(context, { inDevelopment: true });
    const started = await call('ps_start_task', { intent: 'add skin texture' });
    const taskId = started.text.match(/(task-[a-f0-9]+)/)[1];
    const scriptsBefore = fake.state.scripts.length;
    const layersBefore = fake.doc.layers.length;

    for (const answer of await callAllSkinTools(call, taskId)) {
        assert.equal(answer.isError, true, answer.text);
        assert.equal(answer.json.error.code, IN_DEVELOPMENT_CODE);
        assert.match(answer.json.error.message, /still in development/);
        assert.match(answer.json.error.message, /Do not call the ps_skin_texture_ tools again/);
    }
    assert.equal(fake.state.scripts.length, scriptsBefore, 'no script reached Photoshop');
    assert.equal(fake.doc.layers.length, layersBefore, 'no layer was created');
});

test('development run without formulas.wasm: Helper starts, logs the reason and the tools refuse with it', async context => {
    patchFs(context, {
        existsSync: original => (file, ...rest) => (isWasmFile(file) ? false : original.call(fs, file, ...rest))
    });
    const errors = [];
    const { service, call } = makeService(context, {}, { info() {}, warn() {}, error(text) { errors.push(text); } });

    assert.equal(errors.length, 1, 'one error at start');
    assert.match(errors[0], /Skin texture core not found: .*formulas\.wasm/);
    assert.match(errors[0], /not kept in git/);
    const names = service.tools.list().map(tool => tool.name);
    for (const name of SKIN_TOOLS) assert.ok(names.includes(name), `${name} is still published`);

    const started = await call('ps_start_task', { intent: 'add skin texture' });
    const taskId = started.text.match(/(task-[a-f0-9]+)/)[1];
    for (const answer of await callAllSkinTools(call, taskId)) {
        assert.equal(answer.isError, true, answer.text);
        assert.equal(answer.json.error.code, CORE_UNAVAILABLE_CODE);
        assert.match(answer.json.error.message, /Skin texture core not found/);
    }
});

test('development run with another formulas.wasm build: the log names both hashes', context => {
    patchFs(context, {
        existsSync: original => (file, ...rest) => (isWasmFile(file) ? true : original.call(fs, file, ...rest)),
        readFileSync: original => (file, ...rest) => (isWasmFile(file)
            ? Buffer.from('not the pinned build')
            : original.call(fs, file, ...rest))
    });
    const errors = [];
    makeService(context, {}, { info() {}, warn() {}, error(text) { errors.push(text); } });

    assert.equal(errors.length, 1, 'one error at start');
    assert.match(errors[0], /is not the expected build: SHA-256 [0-9a-f]{64}, expected [0-9a-f]{64}/);
});
