'use strict';

/**
 * WebSocket Bridge Prototype — Helper (server) side.
 *
 * This is an ISOLATED prototype for measuring latency, reconnect behavior,
 * and bidirectional communication between Helper and the UXP plugin.
 * It is NOT integrated into the production server flow.
 *
 * Usage (standalone test):
 *   const { createWsBridgeServer } = require('./ws-bridge-prototype');
 *   const server = createWsBridgeServer({ port: 18346, token: 'test-token' });
 *   // ... run tests ...
 *   server.close();
 */

const crypto = require('node:crypto');

// ── Protocol message types ───────────────────────────────────────────────────

const MSG = {
    HELLO:   'hello',
    WELCOME: 'welcome',
    COMMAND: 'command',
    ACK:     'ack',
    RESULT:  'result',
    ERROR:   'error',
    CANCEL:  'cancel',
    PING:    'ping',
    PONG:    'pong'
};

// ── Server factory ───────────────────────────────────────────────────────────

/**
 * Create a WebSocket bridge server on a given port.
 *
 * @param {{ port: number, token: string, logger?: object }} options
 * @returns {{ wss: object, close: () => Promise<void>,
 *            sendCommand: (action: string, payload?: object) => string,
 *            getConnectedClients: () => number,
 *            commandQueue: Map }}
 */
function createWsBridgeServer({ port, token, logger }) {
    // ws is required only here so the rest of the app can load without it
    let WebSocketServer;
    try {
        ({ WebSocketServer } = require('ws'));
    } catch {
        throw new Error(
            'The "ws" package is required for the WebSocket bridge prototype. ' +
            'Install it with: npm install ws'
        );
    }

    const log = logger || console;
    const commandQueue = new Map(); // commandId -> { action, payload, state, sentAt, result }
    const waiters = new Map(); // commandId -> { resolve, reject, timeoutId }

    const wss = new WebSocketServer({ port, host: '127.0.0.1' });

    wss.on('listening', () => {
        log.info(`[ws-bridge] Prototype server listening on ws://127.0.0.1:${port}`);
    });

    wss.on('connection', (ws) => {
        let authenticated = false;
        let helloTimeout = null;

        // Require a hello message with the correct token within 5 seconds
        helloTimeout = setTimeout(() => {
            if (!authenticated) {
                log.warn('[ws-bridge] Client did not authenticate in time, closing.');
                ws.close(4001, 'Authentication timeout');
            }
        }, 5000);

        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString('utf-8'));
            } catch {
                log.warn('[ws-bridge] Received non-JSON message, ignoring.');
                return;
            }

            // First message must be hello with the pairing token
            if (!authenticated) {
                if (msg.type === MSG.HELLO && _constantTimeEqual(msg.token, token)) {
                    authenticated = true;
                    clearTimeout(helloTimeout);
                    ws.send(JSON.stringify({
                        type: MSG.WELCOME,
                        serverVersion: '1.0.0-prototype',
                        timestamp: Date.now()
                    }));
                    log.info('[ws-bridge] Client authenticated successfully.');

                    // Re-send any pending commands
                    for (const [id, cmd] of commandQueue) {
                        if (cmd.state === 'queued' || cmd.state === 'sent') {
                            cmd.state = 'sent';
                            ws.send(JSON.stringify({
                                type: MSG.COMMAND,
                                commandId: id,
                                action: cmd.action,
                                payload: cmd.payload
                            }));
                        }
                    }
                } else {
                    log.warn('[ws-bridge] Invalid hello, closing connection.');
                    ws.close(4003, 'Invalid token');
                }
                return;
            }

            // Handle authenticated messages
            switch (msg.type) {
                case MSG.ACK: {
                    const cmd = commandQueue.get(msg.commandId);
                    if (cmd) {
                        cmd.state = 'acknowledged';
                        cmd.ackedAt = Date.now();
                    }
                    break;
                }

                case MSG.RESULT: {
                    const cmd = commandQueue.get(msg.commandId);
                    if (cmd) {
                        cmd.state = 'completed';
                        cmd.result = msg.payload;
                        cmd.completedAt = Date.now();
                    }
                    const waiter = waiters.get(msg.commandId);
                    if (waiter) {
                        clearTimeout(waiter.timeoutId);
                        waiters.delete(msg.commandId);
                        waiter.resolve(msg.payload);
                    }
                    break;
                }

                case MSG.ERROR: {
                    const cmd = commandQueue.get(msg.commandId);
                    if (cmd) {
                        cmd.state = 'failed';
                        cmd.error = msg.error || msg.payload;
                        cmd.completedAt = Date.now();
                    }
                    const waiter = waiters.get(msg.commandId);
                    if (waiter) {
                        clearTimeout(waiter.timeoutId);
                        waiters.delete(msg.commandId);
                        waiter.reject(new Error(msg.error || msg.payload || 'Unknown error'));
                    }
                    break;
                }

                case MSG.PONG: {
                    // Heartbeat response received
                    ws._lastPong = Date.now();
                    break;
                }

                case MSG.PING: {
                    // Client-initiated ping — respond with pong
                    ws.send(JSON.stringify({ type: MSG.PONG, timestamp: Date.now() }));
                    break;
                }

                default:
                    log.warn(`[ws-bridge] Unknown message type: ${msg.type}`);
            }
        });

        ws.on('close', (code, reason) => {
            clearTimeout(helloTimeout);
            log.info(`[ws-bridge] Client disconnected (code=${code}, reason=${reason || 'none'}).`);
        });

        ws.on('error', (err) => {
            log.error(`[ws-bridge] WebSocket error: ${err.message}`);
        });

        // Heartbeat: send ping every 30 seconds
        const heartbeatInterval = setInterval(() => {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: MSG.PING, timestamp: Date.now() }));
            }
        }, 30_000);

        ws.on('close', () => clearInterval(heartbeatInterval));
    });

    /**
     * Send a command to all authenticated clients.
     *
     * @param {string} action - Command action name.
     * @param {object} [payload] - Command payload.
     * @returns {string} The generated commandId.
     */
    function sendCommand(action, payload = {}) {
        const commandId = crypto.randomUUID();
        const cmd = {
            action,
            payload,
            state: 'queued',
            createdAt: Date.now(),
            result: null,
            error: null
        };
        commandQueue.set(commandId, cmd);

        let delivered = false;
        for (const client of wss.clients) {
            if (client.readyState === client.OPEN) {
                delivered = true;
                client.send(JSON.stringify({
                    type: MSG.COMMAND,
                    commandId,
                    action,
                    payload
                }));
            }
        }

        if (delivered) {
            cmd.state = 'sent';
            cmd.sentAt = Date.now();
        }
        // If no connected clients, state stays 'queued' until a client connects
        // and the hello handler re-sends pending commands.

        return commandId;
    }

    function getConnectedClients() {
        let count = 0;
        for (const client of wss.clients) {
            if (client.readyState === client.OPEN) count++;
        }
        return count;
    }

    function close() {
        return new Promise((resolve) => {
            // Close all client connections
            for (const client of wss.clients) {
                client.close(1001, 'Server shutting down');
            }
            wss.close(() => {
                log.info('[ws-bridge] Prototype server closed.');
                resolve();
            });
        });
    }

    function waitForResult(commandId, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            // Check if the command has already completed before registering the waiter
            const cmd = commandQueue.get(commandId);
            if (!cmd) {
                return reject(new Error(`Unknown command: ${commandId}`));
            }
            if (cmd.state === 'completed') {
                return resolve(cmd.result);
            }
            if (cmd.state === 'failed') {
                return reject(new Error(cmd.error || 'Command failed'));
            }

            const timeoutId = setTimeout(() => {
                waiters.delete(commandId);
                reject(new Error(`Command ${commandId} timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            waiters.set(commandId, { resolve, reject, timeoutId });
        });
    }

    function sendCommandAndWait(action, payload = {}, timeoutMs = 30000) {
        const commandId = sendCommand(action, payload);
        return waitForResult(commandId, timeoutMs);
    }

    return { wss, close, sendCommand, sendCommandAndWait, waitForResult, getConnectedClients, commandQueue };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Constant-time string comparison to prevent timing attacks on token validation.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function _constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
}

module.exports = {
    createWsBridgeServer,
    MSG // Exported only for testing; represents protocol message constants
};
