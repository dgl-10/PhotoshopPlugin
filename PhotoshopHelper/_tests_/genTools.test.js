'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const express = require('express');

const { createGenerationTools, MAX_STATUS_WAIT_MS } = require('../agent/gen-tools');
const { combineTools } = require('../agent/combine-tools');
const {
    LOCAL_API_PREFIX,
    createLocalGenerationRouter,
    createLocalGenerationService
} = require('../localGenerationApi');

const DOCS_DIR = path.join(os.tmpdir(), 'helper-docs');

const PROVIDERS = [
    {
        id: 'gpt_image_2_openai',
        name: 'GPT Image 2',
        generation_modes: ['t2i', 'i2i'],
        mask_handling: { supported: true, required: false, type: 'x', field_name: 'mask' },
        max_reference_images: 15,
        single_image_per_request: false,
        parameters: [{ name: 'prompt', type: 'string', alias: 'prompt', default: '' }]
    },
    {
        id: 'edit_only',
        name: 'Edit only',
        generation_modes: ['i2i'],
        max_reference_images: 0,
        single_image_per_request: true,
        parameters: []
    }
];

/**
 * @param {object} [overrides] - Replacement service pieces.
 * @returns {object} Tools plus the calls the fakes recorded.
 */
function makeTools(overrides = {}) {
    const seen = { accepted: [], waited: [] };
    const service = {
        accept: overrides.accept || (async body => {
            seen.accepted.push(body);
            return { generationId: 'generation_1', status: 'queued', statusUrl: '/api/local/v1/generations/generation_1' };
        }),
        waitForCompletion: overrides.waitForCompletion || (async (id, ms) => {
            seen.waited.push({ id, ms });
            return { generationId: id, status: 'completed', outputPaths: ['C:\\out\\a.png'], error: null, statusUrl: `/x/${id}` };
        })
    };
    const tools = createGenerationTools({
        service,
        listProviders: async () => PROVIDERS,
        docsDir: DOCS_DIR
    });
    return { tools, seen };
}

/**
 * @param {object} result - MCP tool result.
 * @returns {string} Its text.
 */
function textOf(result) {
    return result.content[0].text;
}

test('the generation tools all carry the gen_ prefix and point to both documents', () => {
    const { tools } = makeTools();
    const list = tools.list();

    assert.deepEqual(list.map(tool => tool.name), [
        'gen_list_providers', 'gen_get_provider', 'gen_start', 'gen_get_status'
    ]);
    for (const tool of list) {
        assert.ok(tool.inputSchema && tool.description);
    }

    const start = list.find(tool => tool.name === 'gen_start');
    assert.ok(start.description.includes(path.join(DOCS_DIR, 'Local_Generation_API.md')));
    assert.ok(start.description.includes(path.join(DOCS_DIR, 'Providers_Configuration_Guide.md')));
    assert.match(start.description, /every `parameters\[\]\.name`/);
});

test('gen_list_providers is short and can filter by mode', async () => {
    const { tools } = makeTools();

    const all = JSON.parse(textOf(await tools.call('gen_list_providers', {})));
    assert.deepEqual(all.providers.map(p => p.id), ['gpt_image_2_openai', 'edit_only']);
    assert.equal(all.providers[0].parameters, undefined, 'parameters belong to gen_get_provider');
    assert.deepEqual(all.providers[0].mask_handling, { supported: true, required: false });

    const t2i = JSON.parse(textOf(await tools.call('gen_list_providers', { mode: 't2i' })));
    assert.deepEqual(t2i.providers.map(p => p.id), ['gpt_image_2_openai']);
});

test('gen_get_provider returns everything, and names the choices for an unknown id', async () => {
    const { tools } = makeTools();

    const full = JSON.parse(textOf(await tools.call('gen_get_provider', { provider_id: 'gpt_image_2_openai' })));
    assert.equal(full.parameters[0].name, 'prompt');

    const unknown = await tools.call('gen_get_provider', { provider_id: 'nope' });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /gpt_image_2_openai, edit_only/);
});

test('gen_start passes the HTTP body through untouched and returns the id', async () => {
    const { tools, seen } = makeTools();
    const body = {
        providerId: 'gpt_image_2_openai',
        aspect_ratio: '1:1',
        params: { prompt: 'a cat' }
    };

    const result = await tools.call('gen_start', body);

    assert.deepEqual(seen.accepted, [body]);
    assert.equal(JSON.parse(textOf(result)).generationId, 'generation_1');
    assert.equal(result.isError, undefined);
});

test('gen_start turns a rejected request into a readable refusal', async () => {
    const rejected = Object.assign(new Error('"aspect_ratio" is required for text-to-image generation.'), { statusCode: 400 });
    const { tools } = makeTools({ accept: async () => { throw rejected; } });

    const result = await tools.call('gen_start', { providerId: 'x' });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /aspect_ratio/);
});

test('gen_start reports an internal fault as an error result, not as a transport failure', async () => {
    const { tools } = makeTools({ accept: async () => { throw new Error('boom'); } });

    const result = await tools.call('gen_start', { providerId: 'x' });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /boom/);
});

test('gen_get_status never waits longer than the client-safe limit', async () => {
    const { tools, seen } = makeTools();

    await tools.call('gen_get_status', { generation_id: 'g', wait_seconds: 600 });
    await tools.call('gen_get_status', { generation_id: 'g', wait_seconds: -5 });
    await tools.call('gen_get_status', { generation_id: 'g' });

    assert.equal(seen.waited[0].ms, MAX_STATUS_WAIT_MS);
    assert.equal(seen.waited[1].ms, 0);
    assert.ok(seen.waited[2].ms > 0 && seen.waited[2].ms <= MAX_STATUS_WAIT_MS);
});

test('gen_get_status shows output paths, hides the HTTP status url, and flags failures', async () => {
    const { tools } = makeTools();
    const done = JSON.parse(textOf(await tools.call('gen_get_status', { generation_id: 'g' })));
    assert.deepEqual(done.outputPaths, ['C:\\out\\a.png']);
    assert.equal(done.statusUrl, undefined);

    const running = makeTools({
        waitForCompletion: async id => ({ generationId: id, status: 'running', outputPaths: [], error: null })
    }).tools;
    const pending = JSON.parse(textOf(await running.call('gen_get_status', { generation_id: 'g' })));
    assert.match(pending.next, /again/);

    const failing = makeTools({
        waitForCompletion: async id => ({ generationId: id, status: 'failed', outputPaths: [], error: 'Provider unavailable' })
    }).tools;
    const failed = await failing.call('gen_get_status', { generation_id: 'g' });
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /Provider unavailable/);

    const missing = makeTools({ waitForCompletion: async () => null }).tools;
    const unknown = await missing.call('gen_get_status', { generation_id: 'nope' });
    assert.equal(unknown.isError, true);
});

test('combineTools publishes both layers and routes each call to its owner', async () => {
    const calls = [];
    const clients = [];
    const ps = {
        list: () => [{ name: 'ps_start_task' }],
        call: async (name, args) => { calls.push(['ps', name, args]); return { content: [] }; },
        setClient: info => clients.push(info)
    };
    const gen = {
        list: () => [{ name: 'gen_start' }],
        call: async (name, args) => { calls.push(['gen', name, args]); return { content: [] }; }
    };
    const combined = combineTools([ps, gen]);

    assert.deepEqual(combined.list().map(tool => tool.name), ['ps_start_task', 'gen_start']);

    await combined.call('gen_start', { a: 1 });
    await combined.call('ps_start_task', { b: 2 });
    await combined.call('unknown_tool', {});
    assert.deepEqual(calls, [
        ['gen', 'gen_start', { a: 1 }],
        ['ps', 'ps_start_task', { b: 2 }],
        ['ps', 'unknown_tool', {}]
    ]);

    // A layer without setClient is simply skipped.
    combined.setClient({ name: 'agent' });
    assert.deepEqual(clients, [{ name: 'agent' }]);

    assert.throws(() => combineTools([ps, ps]), /named "ps_start_task"/);
});

/**
 * @param {import('node:test').TestContext} context - Active test context.
 * @returns {string} A temporary output directory removed after the test.
 */
function makeTempDir(context) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-tools-test-'));
    context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test('waitForCompletion returns as soon as the generation ends, and gives up at the limit', async context => {
    const tempDir = makeTempDir(context);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const service = createLocalGenerationService({
        tempDir,
        generate: async () => {
            await gate;
            const output = path.join(tempDir, 'out.png');
            fs.writeFileSync(output, 'x');
            return [{ status: 'done', image: output }];
        }
    });

    const accepted = await service.accept({
        providerId: 'p',
        aspect_ratio: '1:1',
        params: { prompt: 'x' }
    });
    assert.equal(accepted.status, 'queued');

    // Still running after a short wait: the call returns on time with the live state.
    const early = await service.waitForCompletion(accepted.generationId, 30);
    assert.ok(['queued', 'running'].includes(early.status));

    setTimeout(release, 20);
    const startedAt = Date.now();
    const finished = await service.waitForCompletion(accepted.generationId, 5000);
    assert.equal(finished.status, 'completed');
    assert.deepEqual(finished.outputPaths, [path.join(tempDir, 'out.png')]);
    assert.ok(Date.now() - startedAt < 2000, 'it must not wait out the full limit');

    assert.equal(await service.waitForCompletion('missing', 10), null);
});

test('a generation started through the service is readable over HTTP, and the other way round', async context => {
    const tempDir = makeTempDir(context);
    const service = createLocalGenerationService({
        tempDir,
        generate: async () => {
            const output = path.join(tempDir, 'shared.png');
            fs.writeFileSync(output, 'x');
            return [{ status: 'done', image: output }];
        }
    });

    const application = express();
    application.use(express.json());
    application.use(LOCAL_API_PREFIX, createLocalGenerationRouter({ service, getToken: () => 'tok' }));
    const server = await new Promise(resolve => {
        const listening = application.listen(0, '127.0.0.1', () => resolve(listening));
    });
    context.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;

    // Started over HTTP, read through the service (what gen_get_status does).
    const response = await fetch(`${base}${LOCAL_API_PREFIX}/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'tok' },
        body: JSON.stringify({ providerId: 'p', aspect_ratio: '1:1', params: { prompt: 'x' } })
    });
    assert.equal(response.status, 202);
    const started = await response.json();
    const viaService = await service.waitForCompletion(started.generationId, 5000);
    assert.equal(viaService.status, 'completed');

    // Started through the service (what gen_start does), read over HTTP.
    const accepted = await service.accept({ providerId: 'p', aspect_ratio: '1:1', params: { prompt: 'y' } });
    const viaHttp = await fetch(`${base}${accepted.statusUrl}`, { headers: { 'x-api-key': 'tok' } });
    assert.equal(viaHttp.status, 200);
    assert.equal((await viaHttp.json()).generationId, accepted.generationId);
    await service.waitForCompletion(accepted.generationId, 5000);
});
