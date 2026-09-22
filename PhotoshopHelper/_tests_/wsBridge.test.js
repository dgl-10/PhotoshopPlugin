'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

/**
 * Start a channel server on an ephemeral port.
 *
 * @param {import('node:test').TestContext} context - Active test context.
 * @param {string} [token] - Token the client has to present.
 * @param {Function|null} [onClientChange] - Structured lifecycle event observer.
 * @returns {Promise<object>} { server, port, MSG }
 */
async function createTestBridgeServer(context, token = 'test-token', onClientChange = null) {
    const { createWsBridgeServer, MSG } = require('../ws-bridge');
    const server = createWsBridgeServer({
        port: 0,
        token,
        logger: silentLogger(),
        onClientChange
    });
    await new Promise(resolve => server.wss.once('listening', resolve));
    const port = server.wss.address().port;
    context.after(async () => await server.close());
    return { server, port, MSG };
}

/**
 * @returns {object} A logger that keeps the test output readable.
 */
function silentLogger() {
    return { info() {}, warn() {}, error() {} };
}

/**
 * Connect and authenticate a fake plugin.
 *
 * The handler is attached before the token is sent. The server answers a reconnect with
 * the welcome and the re-sent commands back to back, and both can be delivered in one
 * pass, so a handler attached after awaiting authentication would miss the command.
 *
 * @param {number} port - Server port.
 * @param {string} [token] - Token to present.
 * @param {Function} [onMessage] - Called with every parsed message.
 * @param {string|null} [runtimeId] - Identity of the fake UXP runtime.
 * @returns {Promise<object>} An open socket.
 */
async function connectTestClient(port, token = 'test-token', onMessage = null, runtimeId = null) {
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });

    let welcomed = null;
    const welcome = new Promise(resolve => { welcomed = resolve; });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'welcome') welcomed();
        else if (onMessage) onMessage(msg, ws);
    });

    ws.send(JSON.stringify({ type: 'hello', token, runtimeId }));
    await welcome;
    return ws;
}

/**
 * Open a socket without presenting a token.
 *
 * @param {number} port - Server port.
 * @returns {Promise<object>} An open, unauthenticated socket.
 */
async function connectSilentClient(port) {
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    return ws;
}

test('sendCommandAndWait resolves on RESULT', async context => {
    const { server, port, MSG } = await createTestBridgeServer(context);
    const ws = await connectTestClient(port, 'test-token', (msg, socket) => {
        if (msg.type === MSG.COMMAND) {
            socket.send(JSON.stringify({
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
    const ws = await connectTestClient(port, 'test-token', (msg, socket) => {
        if (msg.type === MSG.COMMAND) {
            socket.send(JSON.stringify({
                type: MSG.ERROR,
                commandId: msg.commandId,
                error: 'some error'
            }));
        }
    });

    await assert.rejects(server.sendCommandAndWait('test', {}), /some error/);

    ws.close();
});

test('a command that is never answered fails on its own deadline', async context => {
    const { server, port } = await createTestBridgeServer(context);
    const ws = await connectTestClient(port);

    await assert.rejects(
        server.sendCommandAndWait('test', {}, 100),
        /did not answer within/
    );

    ws.close();
});

test('waitForResult resolves when the waiter is registered before the result arrives', async context => {
    const { server, port, MSG } = await createTestBridgeServer(context);
    const ws = await connectTestClient(port, 'test-token', (msg, socket) => {
        if (msg.type === MSG.COMMAND) {
            setTimeout(() => {
                socket.send(JSON.stringify({
                    type: MSG.RESULT,
                    commandId: msg.commandId,
                    payload: { async: true }
                }));
            }, 10);
        }
    });

    const commandId = server.sendCommand('test', {});
    const result = await server.waitForResult(commandId, 1000);
    assert.deepEqual(result, { async: true });

    ws.close();
});

test('a client that has not presented the token receives no commands', async context => {
    const { server, port, MSG } = await createTestBridgeServer(context);

    const silent = await connectSilentClient(port);
    let sawCommand = false;
    silent.on('message', data => {
        const msg = JSON.parse(data.toString());
        if (msg.type === MSG.COMMAND) sawCommand = true;
    });

    const authenticated = await connectTestClient(port, 'test-token', (msg, socket) => {
        if (msg.type === MSG.COMMAND) {
            socket.send(JSON.stringify({
                type: MSG.RESULT, commandId: msg.commandId, payload: 'ok'
            }));
        }
    });

    const result = await server.sendCommandAndWait('test', {}, 1000);
    assert.equal(result, 'ok');
    assert.equal(sawCommand, false, 'an unauthenticated socket must never be sent a command');

    silent.close();
    authenticated.close();
});

test('a result is not lost when the connection drops before the answer gets out', async context => {
    const { server, port, MSG } = await createTestBridgeServer(context);

    // The first plugin takes the command, then vanishes without answering — the case
    // where the work was done but the answer never made it back.
    let resolveTaken = null;
    const taken = new Promise(resolve => { resolveTaken = resolve; });

    const first = await connectTestClient(port, 'test-token', (msg, ws) => {
        if (msg.type === MSG.COMMAND) {
            ws.send(JSON.stringify({ type: MSG.ACK, commandId: msg.commandId }));
            resolveTaken(msg.commandId);
        }
    });

    server.sendCommand('test', {});
    const takenCommandId = await taken;

    const waiting = server.waitForResult(takenCommandId, 5000);
    first.terminate();

    // The plugin comes back and is re-sent the command; it replays what it had cached.
    const second = await connectTestClient(port, 'test-token', (msg, ws) => {
        if (msg.type === MSG.COMMAND && msg.commandId === takenCommandId) {
            ws.send(JSON.stringify({
                type: MSG.RESULT, commandId: msg.commandId, payload: 'recovered'
            }));
        }
    });

    assert.equal(await waiting, 'recovered');
    second.close();
});

test('an in-flight command is not replayed into a new UXP runtime', async context => {
    const { server, port, MSG } = await createTestBridgeServer(context);
    let commandId = null;
    let resolveAcknowledged;
    const acknowledged = new Promise(resolve => { resolveAcknowledged = resolve; });

    const first = await connectTestClient(port, 'test-token', (msg, ws) => {
        if (msg.type === MSG.COMMAND) {
            commandId = msg.commandId;
            ws.send(JSON.stringify({ type: MSG.ACK, commandId }));
            resolveAcknowledged();
        }
    }, 'runtime-1');

    // Attach the rejection assertion before reconnecting so Node never treats the expected
    // safety failure as a temporarily unhandled promise rejection.
    const waiting = assert.rejects(
        server.sendCommandAndWait('agent_execute_script', { taskId: 'task-1' }, 5000),
        /outcome is unknown/
    );
    await acknowledged;
    first.terminate();

    let replayed = false;
    const second = await connectTestClient(port, 'test-token', (msg) => {
        if (msg.type === MSG.COMMAND && msg.commandId === commandId) replayed = true;
    }, 'runtime-2');

    await waiting;
    assert.equal(replayed, false, 'a new runtime must not execute an ambiguous mutation');
    second.close();
});

test('an old command that someone still waits for is kept; an abandoned one is dropped', async context => {
    const { COMMAND_RETENTION_MS } = require('../ws-bridge');
    const { server, port, MSG } = await createTestBridgeServer(context);
    // The plugin takes every command and never answers, like one waiting for the person
    // to finish in a Photoshop dialog.
    const ws = await connectTestClient(port, 'test-token', (msg, socket) => {
        if (msg.type === MSG.COMMAND) {
            socket.send(JSON.stringify({ type: MSG.ACK, commandId: msg.commandId }));
        }
    });

    const waitedFor = server.sendCommand('agent_execute_script', {});
    const waiting = server.waitForResult(waitedFor, 5000);
    const abandoned = server.sendCommand('agent_ping', {});

    // Both look older than the retention period.
    const longAgo = Date.now() - COMMAND_RETENTION_MS - 1000;
    server.commandQueue.get(waitedFor).createdAt = longAgo;
    server.commandQueue.get(abandoned).createdAt = longAgo;

    // Queuing any new command is what prunes the queue.
    server.sendCommand('agent_ping', {});

    assert.equal(server.commandQueue.has(waitedFor), true, 'a command with a live waiter must stay');
    assert.equal(server.commandQueue.has(abandoned), false, 'a command nobody waits for is dropped');

    ws.send(JSON.stringify({ type: MSG.RESULT, commandId: waitedFor, payload: 'done' }));
    assert.equal(await waiting, 'done');
    ws.close();
});

test('an intentional dialog close reports its actionable reason', async context => {
    let resolveDisconnect;
    const disconnected = new Promise(resolve => { resolveDisconnect = resolve; });
    const { port, MSG } = await createTestBridgeServer(context, 'test-token', event => {
        if (event.type === 'disconnected') resolveDisconnect(event);
    });
    const ws = await connectTestClient(port, 'test-token', null, 'runtime-1');

    ws.send(JSON.stringify({
        type: MSG.GOODBYE,
        reasonCode: 'assistant-dialog-closed',
        reason: 'Assistant panel closed',
        intentional: true
    }));
    ws.close(1000, 'Assistant panel closed');

    const event = await disconnected;
    assert.equal(event.clients, 0);
    assert.equal(event.reasonCode, 'assistant-dialog-closed');
    assert.equal(event.intentional, true);
    assert.equal(event.runtimeId, 'runtime-1');
});
