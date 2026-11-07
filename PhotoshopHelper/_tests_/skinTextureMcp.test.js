'use strict';

/**
 * The skin texture tools as an MCP client sees them: listed by tools/list and called through
 * Helper's real MCP router and agent service, next to the existing tools.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createAgentService, resolveAgentPaths } = require('../agent');
const { createMcpRouter } = require('../mcp-server');
const { createFakePhotoshop } = require('./skinTextureFakes');

/**
 * Helper's agent service over a fake plugin, behind the real MCP router on an ephemeral port.
 *
 * @param {import('node:test').TestContext} context - Test context.
 * @param {object} [skinTexture] - Options of the service's skin texture job manager (limits).
 * @returns {Promise<object>} { rpc, fake, service }
 */
async function startServer(context, skinTexture = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-mcp-'));
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
    const app = express();
    app.use(express.json());
    app.use('/mcp', createMcpRouter({ tools: service.tools }));
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    context.after(async () => {
        await service.dispose();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    let id = 0;
    async function rpc(method, params) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
        });
        return (await response.json()).result;
    }
    async function callTool(name, args) {
        const result = await rpc('tools/call', { name, arguments: args });
        const text = result.content[0].text;
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { result, text, json };
    }
    return { rpc, callTool, fake, service };
}

test('tools/list publishes the four skin texture tools next to the existing ones', async context => {
    const { rpc } = await startServer(context);
    const { tools } = await rpc('tools/list', {});
    const names = tools.map(tool => tool.name);
    for (const name of ['ps_skin_texture_start', 'ps_skin_texture_status', 'ps_skin_texture_apply', 'ps_skin_texture_cancel']) {
        assert.ok(names.includes(name), name);
        const tool = tools.find(t => t.name === name);
        assert.ok(tool.inputSchema.required.includes('task_id'), `${name} needs the task id`);
        assert.ok(tool.description.length > 200, `${name} explains itself`);
    }
    for (const name of ['ps_start_task', 'ps_execute_script', 'ps_get_image', 'ps_kb_list', 'ps_finish_task']) {
        assert.ok(names.includes(name), `${name} is still published`);
    }
    const start = tools.find(t => t.name === 'ps_skin_texture_start');
    assert.match(start.description, /document pixels/);
    assert.match(start.description, /px_per_mm/);
    assert.match(start.description, /63 mm/);
    assert.deepEqual(start.inputSchema.required, ['task_id', 'request_id', 'rect', 'px_per_mm']);
    assert.equal('outputs' in start.inputSchema.properties, false, 'outputs must not be in published start schema');
    assert.ok('recipe' in start.inputSchema.properties, 'recipe is in start schema');

    const apply = tools.find(t => t.name === 'ps_skin_texture_apply');
    assert.ok('mask_source' in apply.inputSchema.properties, 'mask_source is in apply schema');
    assert.deepEqual(apply.inputSchema.required, ['task_id', 'job_id'], 'mask_source is not unconditionally required for repeats');
});

test('start, status and apply work end to end through the MCP router', async context => {
    const { callTool, fake } = await startServer(context);
    const started = await callTool('ps_start_task', { intent: 'add skin texture' });
    const taskId = started.text.match(/(task-[a-f0-9]+)/)[1];

    const job = await callTool('ps_skin_texture_start', {
        task_id: taskId, request_id: 'cheek-1', rect: { x: 12, y: 8, width: 40, height: 30 }, px_per_mm: 5
    });
    assert.ok(!job.result.isError, job.text);

    let status;
    for (let i = 0; i < 600; i++) {
        status = await callTool('ps_skin_texture_status', { task_id: taskId, job_id: job.json.job_id });
        if (status.json.phase === 'ready') break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.json.phase, 'ready', status.text);

    // Applying without mask_source on first write is refused
    const noMask = await callTool('ps_skin_texture_apply', { task_id: taskId, job_id: job.json.job_id });
    assert.equal(noMask.result.isError, true);
    assert.equal(noMask.json.error.code, 'MASK_SOURCE_REQUIRED');

    // Applying with selection mask_source writes Skin group with 4 components
    const applied = await callTool('ps_skin_texture_apply', {
        task_id: taskId,
        job_id: job.json.job_id,
        mask_source: { kind: 'selection' }
    });
    assert.equal(applied.json.phase, 'applied', applied.text);
    assert.equal(applied.json.recipe_id, 'skin_pair_v1');
    assert.ok(fake.doc.layers.some(layer => layer.name.startsWith('Skin')));
    assert.equal(applied.json.apply.layers.length, 4);

    // Legacy outputs are refused before computing
    const legacyStart = await callTool('ps_skin_texture_start', {
        task_id: taskId,
        request_id: 'legacy-outputs',
        rect: { x: 12, y: 8, width: 40, height: 30 },
        px_per_mm: 5,
        outputs: ['main']
    });
    assert.equal(legacyStart.result.isError, true);
    assert.equal(legacyStart.json.error.code, 'INVALID_OUTPUTS');

    // The existing tools behave as before around them.
    const refused = await callTool('ps_skin_texture_status', { task_id: 'task-000000', job_id: job.json.job_id });
    assert.equal(refused.result.isError, true);
    assert.match(refused.text, /There is no task task-000000/);
    const finished = await callTool('ps_finish_task', { task_id: taskId, summary: 'done' });
    assert.match(finished.text, /is closed/);
});

test('through the MCP router: the descriptions state the request_id limits and the send boundary; a dropped request_id is refused', async context => {
    const { rpc, callTool, fake } = await startServer(context, { limits: { maxJobsPerTask: 2 } });
    const { tools } = await rpc('tools/list', {});
    const describe = name => tools.find(tool => tool.name === name).description;
    assert.match(describe('ps_skin_texture_start'), /REQUEST_ALREADY_USED/);
    assert.match(describe('ps_skin_texture_start'), /at most 100 different/);
    assert.match(describe('ps_skin_texture_start'), /last 2 job records/);
    assert.match(describe('ps_skin_texture_status'), /preparing_write/);
    assert.match(describe('ps_skin_texture_status'), /can_cancel_without_change/);
    assert.match(describe('ps_skin_texture_cancel'), /preparing_write/);
    assert.match(describe('ps_skin_texture_apply'), /never sent by itself/);

    const started = await callTool('ps_start_task', { intent: 'add skin texture' });
    const taskId = started.text.match(/(task-[a-f0-9]+)/)[1];
    const rect = { x: 4, y: 4, width: 16, height: 16 };
    const jobIds = {};
    for (const requestId of ['a', 'b', 'c']) {
        const job = await callTool('ps_skin_texture_start', { task_id: taskId, request_id: requestId, rect, px_per_mm: 5 });
        assert.ok(!job.result.isError, job.text);
        jobIds[requestId] = job.json.job_id;
        await callTool('ps_skin_texture_cancel', { task_id: taskId, job_id: job.json.job_id });
    }
    const again = await callTool('ps_skin_texture_start', { task_id: taskId, request_id: 'a', rect, px_per_mm: 5 });
    assert.equal(again.result.isError, true);
    assert.equal(again.json.error.code, 'REQUEST_ALREADY_USED');
    assert.equal(again.json.error.details.job_id, jobIds.a);
    assert.equal(again.json.error.details.phase, 'cancelled');
    assert.equal(fake.state.scripts.filter(record => record.kind === 'probe').length, 3, 'the refused repeat reached nothing');
});
