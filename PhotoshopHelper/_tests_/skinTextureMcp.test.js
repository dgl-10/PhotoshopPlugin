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

// Lifecycle tests require private binaries; corrupt present binaries remain hard failures.
const missingWasmCore = require('./skinTextureTestSupport').missingBinaryReason();
if (missingWasmCore) {
    test('skin texture private binary prerequisite', { skip: missingWasmCore }, () => {});
    return;
}

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

test('tools/list publishes the skin texture tools next to the existing ones', async context => {
    const { rpc } = await startServer(context);
    const { tools } = await rpc('tools/list', {});
    const names = tools.map(tool => tool.name);
    for (const name of ['ps_skin_texture_start', 'ps_skin_texture_status', 'ps_skin_texture_apply', 'ps_skin_texture_cancel', 'ps_skin_texture_find_areolas']) {
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
    // task20: the areola-only recipe, the areola strength, the areola records and their sources.
    assert.deepEqual(start.inputSchema.properties.recipe.enum, ['skin_v2', 'areola_v1']);
    assert.deepEqual(Object.keys(start.inputSchema.properties.params.properties).sort(), ['areolaStrength', 'azimuthDeg', 'elevationDeg', 'seed']);
    assert.equal(start.inputSchema.properties.params.additionalProperties, false);
    assert.deepEqual(start.inputSchema.properties.params.properties.seed, { type: 'integer', minimum: 0, maximum: 4294967295 });
    const fields = start.inputSchema.properties.fields;
    assert.equal(fields.required, undefined, 'face and areolas are each optional');
    assert.deepEqual(fields.properties.areolas.items.required, ['areola']);
    assert.equal(fields.properties.areolas.maxItems, 2);
    assert.deepEqual(Object.keys(start.inputSchema.properties.sources.properties), ['geometry', 'nipple', 'scale', 'light']);
    assert.match(start.description, /areola_v1/);
    assert.equal(fields.additionalProperties, false);
    assert.deepEqual(fields.properties.face.required, ['eyes', 'noseTip', 'mouth', 'chin']);
    assert.equal(fields.properties.face.additionalProperties, false);
    assert.equal(fields.properties.face.properties.eyes.minItems, 2);
    assert.equal(fields.properties.face.properties.eyes.maxItems, 2);
    assert.equal(fields.properties.face.properties.eyes.items.minItems, 2);
    assert.equal(fields.properties.face.properties.eyes.items.maxItems, 2);
    assert.match(start.description, /Formula 1 is visible/);
    assert.match(start.description, /Formula 2 is hidden and contains "Pores" and "Furrows"\. All four texture layers/);
    assert.match(start.description, /Areola Formula 1 is Fable \(fable_areola_v1 1\.0\.0\), Areola Formula 2 is Gemini \(gemini4_areola_v1 1\.0\.0\)/);

    const apply = tools.find(t => t.name === 'ps_skin_texture_apply');
    assert.match(apply.description, /Formula 2 is hidden with "Pores" and "Furrows"\. All four layers/);
    assert.ok('mask_source' in apply.inputSchema.properties, 'mask_source is in apply schema');
    assert.deepEqual(apply.inputSchema.required, ['task_id', 'job_id'], 'mask_source is not unconditionally required for repeats');
});

test('start, status and apply work end to end through the MCP router', async context => {
    const { callTool, fake } = await startServer(context);
    const started = await callTool('ps_start_task', { intent: 'add skin texture' });
    const taskId = started.text.match(/(task-[a-f0-9]+)/)[1];

    // Use real MCP JSON routing for face fields, including fractional/out-of-patch points.
    const face = { eyes: [[-12.5, 10], [90, 12]], noseTip: [40, 50], mouth: [[20, 80], [70, 80]], chin: [45, 110], yawDeg: 9 };
    const job = await callTool('ps_skin_texture_start', {
        task_id: taskId, request_id: 'cheek-1', rect: { x: 12, y: 8, width: 40, height: 30 }, px_per_mm: 5,
        params: { seed: 0, azimuthDeg: 42, elevationDeg: 25 }, fields: { face }
    });
    assert.ok(!job.result.isError, job.text);

    let status;
    for (let i = 0; i < 600; i++) {
        status = await callTool('ps_skin_texture_status', { task_id: taskId, job_id: job.json.job_id });
        if (status.json.phase === 'ready') break;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.json.phase, 'ready', status.text);
    assert.deepEqual(status.json.formulas.formula_1.params.fields, { face });
    assert.equal(status.json.formulas.formula_1.params.seed, 0);
    assert.deepEqual(status.json.formulas.formula_2.params.fields, { face });
    assert.equal(status.json.formulas.formula_3, undefined);

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
    assert.equal(applied.json.recipe_id, 'skin_v2');
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
    assert.match(describe('ps_skin_texture_start'), /At most 100 different/);
    assert.match(describe('ps_skin_texture_start'), /last 2 job records/);
    assert.match(describe('ps_skin_texture_status'), /preparing_write/);
    assert.match(describe('ps_skin_texture_status'), /can_cancel_without_change/);
    assert.match(describe('ps_skin_texture_cancel'), /preparing_write/);
    assert.match(describe('ps_skin_texture_apply'), /never sent automatically/);

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

test('ALLOW_AGENT_FORMULA_COMPARISON defaults to false and switches comparison guidance cleanly', async context => {
    const {
        ALLOW_AGENT_FORMULA_COMPARISON,
        buildToolDescriptions,
        postApplyComparisonGuidance
    } = require('../skin-texture/recipe-tool-contract');
    const { extendDescriptions } = require('../skin-texture/areola-tool-contract');
    const { appliedText } = require('../skin-texture/areola-job');

    assert.equal(ALLOW_AGENT_FORMULA_COMPARISON, false);

    // Live published MCP tool descriptions reflect the disabled comparison mode.
    const { rpc } = await startServer(context);
    const { tools } = await rpc('tools/list', {});
    const startDesc = tools.find(tool => tool.name === 'ps_skin_texture_start').description;
    const applyDesc = tools.find(tool => tool.name === 'ps_skin_texture_apply').description;
    assert.match(startDesc, /Leave Formula 1 visible and Formula 2 hidden as created/);
    assert.match(startDesc, /do not toggle formula groups, compare variants, or choose between them yourself/);
    assert.doesNotMatch(startDesc, /Compare formulas by showing exactly one formula group/);
    assert.match(applyDesc, /Leave Formula 1 visible and Formula 2 hidden as created/);
    assert.match(applyDesc, /Leave "Areola Formula 1" visible and the other areola group hidden as created/);
    assert.doesNotMatch(applyDesc, /Compare areola variants by showing exactly one areola group/);

    // Both skin-only and areola/combined next_step messages respect the disabled default.
    const opts = { responseBudgetMs: 15000, maxJobsPerTask: 12, maxRequestsPerTask: 100 };
    assert.match(postApplyComparisonGuidance(), /do not toggle, compare, or choose between formula variants yourself/);
    const skinAndAreolaJob = { request: { layout: { skin: true, areolas: true, cutout: true } } };
    const areolaOnlyJob = { request: { layout: { skin: false, areolas: true, cutout: false } } };
    assert.match(appliedText(skinAndAreolaJob), /Leave "Areola Formula 1" visible and the other areola group hidden; do not toggle or compare areola variants yourself/);
    assert.match(appliedText(skinAndAreolaJob), /Leave Formula 1 visible and Formula 2 hidden; do not toggle or compare formula variants yourself/);
    assert.match(appliedText(areolaOnlyJob), /Do not switch variants or tune opacity yourself unless the person explicitly asked/);

    // Flipping the toggle to true restores the original comparison wording verbatim.
    const enabledDesc = extendDescriptions(buildToolDescriptions(opts, true), true);
    assert.match(enabledDesc.start, /Compare formulas by showing exactly one formula group at a time; adjust strength with layer opacity in Photoshop\./);
    assert.match(enabledDesc.apply, /Show exactly one formula group at a time to compare; change layer opacity to adjust strength\./);
    assert.match(enabledDesc.apply, /Compare areola variants by showing exactly one areola group\./);
    assert.equal(postApplyComparisonGuidance(true), 'Compare by showing exactly one formula group; adjust strength with layer opacity using the returned IDs.');
    assert.match(appliedText(skinAndAreolaJob, true), /Compare them by showing exactly one areola group\./);
    assert.match(appliedText(skinAndAreolaJob, true), /Compare by showing exactly one formula group\./);
    assert.match(appliedText(skinAndAreolaJob, true), /Adjust strength with layer opacity using the returned IDs\./);
});
