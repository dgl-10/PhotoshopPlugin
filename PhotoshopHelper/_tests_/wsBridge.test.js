'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function createTestBridgeServer(context, token = 'test-token') {
    const { createWsBridgeServer, MSG } = require('../ws-bridge-prototype');
    const server = createWsBridgeServer({ port: 0, token });
    // Wait for the server to start listening
    await new Promise(resolve => server.wss.once('listening', resolve));
    const port = server.wss.address().port;
    context.after(async () => await server.close());
    return { server, port, MSG };
}

async function connectTestClient(port, token = 'test-token') {
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    // Authenticate
    ws.send(JSON.stringify({ type: 'hello', token }));
    // Wait for welcome
    await new Promise(resolve => {
        ws.once('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'welcome') resolve();
        });
    });
    return ws;
}

test('sendCommandAndWait resolves on RESULT', async context => {
    const { server, port, MSG } = await createTestBridgeServer(context);
    const ws = await connectTestClient(port);
    
    ws.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.type === MSG.COMMAND) {
            ws.send(JSON.stringify({
                type: MSG.RESULT,
                commandId: msg.commandId,
                payload: { success: true }
            }));
        }
    });
    
    const result = await server.sendCommandAndWait('test', {});
    assert.deepEqual(result, { success: true });
    
    ws.close();
});

test('sendCommandAndWait rejects on ERROR', async context => {
    const { server, port, MSG } = await createTestBridgeServer(context);
    const ws = await connectTestClient(port);
    
    ws.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.type === MSG.COMMAND) {
            ws.send(JSON.stringify({
                type: MSG.ERROR,
                commandId: msg.commandId,
                error: 'some error'
            }));
        }
    });
    
    await assert.rejects(
        server.sendCommandAndWait('test', {}),
        /some error/
    );
    
    ws.close();
});

test('sendCommandAndWait rejects on timeout', async context => {
    const { server, port } = await createTestBridgeServer(context);
    const ws = await connectTestClient(port);
    
    // Don't send any response from the client
    
    await assert.rejects(
        server.sendCommandAndWait('test', {}, 100), // Short timeout
        /timed out/
    );
    
    ws.close();
});

test('waitForResult resolves when waiter is registered before result arrives', async context => {
    const { server, port, MSG } = await createTestBridgeServer(context);
    const ws = await connectTestClient(port);
    
    ws.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.type === MSG.COMMAND) {
            // Delay the result slightly to ensure wait starts
            setTimeout(() => {
                ws.send(JSON.stringify({
                    type: MSG.RESULT,
                    commandId: msg.commandId,
                    payload: { async: true }
                }));
            }, 10);
        }
    });
    
    // Send command separately
    const commandId = server.sendCommand('test', {});
    
    // Wait for the result
    const result = await server.waitForResult(commandId, 1000);
    assert.deepEqual(result, { async: true });
    
    ws.close();
});
