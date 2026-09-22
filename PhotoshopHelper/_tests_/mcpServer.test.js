'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

/**
 * A stand-in for the tool layer, so the router can be tested on its own.
 *
 * @param {object} [overrides] - Replacement list/call implementations.
 * @returns {object} A tools object.
 */
function fakeTools(overrides = {}) {
    return {
        list: overrides.list || (() => ([
            { name: 'ps_start_task', description: 'start', inputSchema: { type: 'object' } },
            { name: 'ps_get_document', description: 'read', inputSchema: { type: 'object' } }
        ])),
        call: overrides.call || (async (name) => ({
            content: [{ type: 'text', text: `called ${name}` }]
        }))
    };
}

/**
 * Start an ephemeral Express server with the MCP router.
 *
 * @param {import('node:test').TestContext} context - Active test context.
 * @param {object} [tools] - Tool layer to mount.
 * @returns {Promise<string>} Base URL of the listening server.
 */
async function startMcpTestServer(context, tools = fakeTools()) {
    const express = require('express');
    const { createMcpRouter } = require('../mcp-server');
    const app = express();
    app.use(express.json());
    app.use('/mcp', createMcpRouter({ tools }));

    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });

    context.after(async () => {
        await new Promise((resolve, reject) => {
            server.close(err => err ? reject(err) : resolve());
        });
    });

    return `http://127.0.0.1:${server.address().port}`;
}

/**
 * @param {string} baseUrl - Server base URL.
 * @param {object} body - JSON-RPC message.
 * @returns {Promise<object>} { status, json }
 */
async function rpc(baseUrl, body) {
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, text };
}

test('initialize answers with capabilities and instructions', async context => {
    const baseUrl = await startMcpTestServer(context);
    const { status, json } = await rpc(baseUrl, {
        jsonrpc: '2.0', id: 1, method: 'initialize', params: {}
    });

    assert.equal(status, 200);
    assert.equal(json.jsonrpc, '2.0');
    assert.equal(json.id, 1);
    assert.ok(json.result.protocolVersion);
    assert.ok(json.result.capabilities.tools);
    assert.ok(json.result.serverInfo);
    // The instructions are the first place an agent is told to start with ps_start_task.
    assert.match(json.result.instructions, /ps_start_task/);
});

test('initialize echoes a protocol version we support', async context => {
    const baseUrl = await startMcpTestServer(context);

    const supported = await rpc(baseUrl, {
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' }
    });
    assert.equal(supported.json.result.protocolVersion, '2025-06-18');

    const unknown = await rpc(baseUrl, {
        jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1.0.0' }
    });
    assert.equal(unknown.json.result.protocolVersion, '2024-11-05');
});

test('notifications/initialized returns HTTP 202 with an empty body', async context => {
    const baseUrl = await startMcpTestServer(context);
    const { status, text } = await rpc(baseUrl, {
        jsonrpc: '2.0', method: 'notifications/initialized'
    });

    // Codex's client fails to deserialize anything else here.
    assert.equal(status, 202);
    assert.equal(text, '');
});

test('tools/list returns what the tool layer publishes', async context => {
    const baseUrl = await startMcpTestServer(context);
    const { json } = await rpc(baseUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    assert.ok(Array.isArray(json.result.tools));
    assert.equal(json.result.tools.length, 2);
    for (const tool of json.result.tools) {
        assert.ok(tool.name.startsWith('ps_'), 'document tools carry the ps_ prefix');
        assert.ok(tool.description);
        assert.ok(tool.inputSchema);
    }
});

test('tools/call passes the arguments through and returns the content', async context => {
    let seen = null;
    const baseUrl = await startMcpTestServer(context, fakeTools({
        call: async (name, args) => {
            seen = { name, args };
            return { content: [{ type: 'text', text: 'done' }] };
        }
    }));

    const { json } = await rpc(baseUrl, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'ps_get_document', arguments: { task_id: 'task-1' } }
    });

    assert.deepEqual(seen, { name: 'ps_get_document', args: { task_id: 'task-1' } });
    assert.equal(json.result.content[0].text, 'done');
});

test('an image result travels as image content, not as text', async context => {
    const baseUrl = await startMcpTestServer(context, fakeTools({
        call: async () => ({
            content: [
                { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
                { type: 'text', text: 'caption' }
            ]
        })
    }));

    const { json } = await rpc(baseUrl, {
        jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ps_get_image', arguments: {} }
    });

    assert.equal(json.result.content[0].type, 'image');
    assert.equal(json.result.content[0].mimeType, 'image/png');
    assert.equal(json.result.content[1].type, 'text');
});

test('a failure inside a tool comes back as a readable tool result', async context => {
    const baseUrl = await startMcpTestServer(context, fakeTools({
        call: async () => { throw new Error('something broke'); }
    }));

    const { json } = await rpc(baseUrl, {
        jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ps_get_document', arguments: {} }
    });

    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /something broke/);
});

test('an unknown method returns JSON-RPC error -32601', async context => {
    const baseUrl = await startMcpTestServer(context);
    const { json } = await rpc(baseUrl, { jsonrpc: '2.0', id: 6, method: 'foo/bar', params: {} });

    assert.equal(json.error.code, -32601);
});

test('an invalid JSON-RPC message returns 400', async context => {
    const baseUrl = await startMcpTestServer(context);
    const { status } = await rpc(baseUrl, { foo: 'bar' });

    assert.equal(status, 400);
});

test('an unknown notification returns HTTP 202', async context => {
    const baseUrl = await startMcpTestServer(context);
    const { status } = await rpc(baseUrl, { jsonrpc: '2.0', method: 'notifications/cancelled' });

    assert.equal(status, 202);
});
