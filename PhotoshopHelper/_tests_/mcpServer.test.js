'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

/**
 * Start an ephemeral Express server with the MCP router for testing.
 *
 * @param {import('node:test').TestContext} context - Active Node test context.
 * @param {Function} [getWsBridge=() => null] - Mock function for getWsBridge.
 * @returns {Promise<string>} Base URL of the listening server.
 */
async function startMcpTestServer(context, getWsBridge = () => null) {
    const express = require('express');
    const { createMcpRouter } = require('../mcp-server');
    const app = express();
    app.use(express.json());
    app.use('/mcp', createMcpRouter({ getWsBridge }));
    
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    
    context.after(async () => {
        await new Promise((resolve, reject) => {
            server.close(err => err ? reject(err) : resolve());
        });
    });
    
    return `http://127.0.0.1:${server.address().port}`;
}

test('POST /mcp with initialize returns capabilities', async context => {
    const baseUrl = await startMcpTestServer(context);
    
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.jsonrpc, '2.0');
    assert.equal(data.id, 1);
    assert.ok(data.result.protocolVersion);
    assert.ok(data.result.capabilities.tools);
    assert.ok(data.result.serverInfo);
});

test('POST /mcp with notifications/initialized returns HTTP 202', async context => {
    const baseUrl = await startMcpTestServer(context);
    
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    });
    
    assert.equal(response.status, 202);
    const text = await response.text();
    assert.equal(text, '');
});

test('POST /mcp with tools/list returns 4 tools', async context => {
    const baseUrl = await startMcpTestServer(context);
    
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });
    
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.id, 2);
    assert.ok(Array.isArray(data.result.tools));
    assert.equal(data.result.tools.length, 4);
    for (const tool of data.result.tools) {
        assert.ok(tool.name);
        assert.ok(tool.description);
        assert.ok(tool.inputSchema);
    }
});

test('POST /mcp with unknown method returns JSON-RPC error -32601', async context => {
    const baseUrl = await startMcpTestServer(context);
    
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'foo/bar', params: {} })
    });
    
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.id, 3);
    assert.equal(data.error.code, -32601);
});

test('POST /mcp with invalid JSON-RPC returns 400', async context => {
    const baseUrl = await startMcpTestServer(context);
    
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' })
    });
    
    assert.equal(response.status, 400);
});

test('POST /mcp with tools/call and no bridge returns error content', async context => {
    const baseUrl = await startMcpTestServer(context, () => null);
    
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_document_info' } })
    });
    
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.id, 4);
    assert.equal(data.result.isError, true);
    assert.ok(data.result.content[0].text.includes('connection'));
});

test('POST /mcp with tools/call and bridge but no clients returns error content', async context => {
    const mockBridge = { getConnectedClients: () => 0 };
    const baseUrl = await startMcpTestServer(context, () => mockBridge);
    
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_document_info' } })
    });
    
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.id, 5);
    assert.equal(data.result.isError, true);
    assert.ok(data.result.content[0].text.includes('plugin'));
});

test('POST /mcp with unknown notification returns HTTP 202', async context => {
    const baseUrl = await startMcpTestServer(context);
    
    const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' })
    });
    
    assert.equal(response.status, 202);
});
