'use strict';

/**
 * The channel between Helper and the Photoshop plugin — Helper (server) side.
 *
 * Grown out of the stage 1 prototype. Three things that were fine for a prototype and are
 * not fine here were fixed:
 *
 *   1. A result used to be lost when the connection dropped between "command accepted"
 *      and the answer. Now a command lives in the queue until it reaches a terminal
 *      state, the waiter keeps waiting until its own deadline rather than failing with
 *      the socket, and a reconnecting plugin is re-sent everything unfinished. The plugin
 *      caches its results by commandId and replays them instead of doing the work twice.
 *   2. Commands used to go to every connected socket, including one that had not shown
 *      the token yet. Now only authenticated sockets are tracked, and a command goes to
 *      exactly one of them — the most recent — because only one Photoshop panel is
 *      expected and two would execute the same command twice.
 *   3. The plugin used to connect on every start. Now it connects when the assistant
 *      panel is open; that side of the change lives in the plugin.
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
    GOODBYE: 'goodbye',
    PING:    'ping',
    PONG:    'pong'
};

// A command that never reached a terminal state is dropped after this long, so a plugin
// that disappears for good cannot fill the queue.
const COMMAND_RETENTION_MS = 10 * 60 * 1000;

const HELLO_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Constant-time string comparison, so the token cannot be guessed by timing.
 *
 * @param {string} a - First value.
 * @param {string} b - Second value.
 * @returns {boolean} True when equal.
 */
function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
}

/**
 * Create the channel server.
 *
 * @param {object} options
 * @param {number} options.port - Loopback port to listen on.
 * @param {string} options.token - Pairing token the plugin must present.
 * @param {object} [options.logger] - Destination for diagnostics.
 * @param {Function} [options.onClientChange] - Called with a structured connection event.
 * @returns {object} The channel server.
 */
function createWsBridgeServer({ port, token, logger, onClientChange }) {
    // ws is required only here so the rest of the app can load without it.
    let WebSocketServer;
    try {
        ({ WebSocketServer } = require('ws'));
    } catch {
        throw new Error(
            'The "ws" package is required for the plugin channel. Install it with: npm install ws'
        );
    }

    const log = logger || console;
    const commandQueue = new Map(); // commandId -> { action, payload, state, result, error, … }
    const waiters = new Map();      // commandId -> { resolve, reject, timeoutId }
    const authenticated = new Set(); // Sockets that presented a valid token.
    let lastRuntimeId = null;
    let lastDisconnect = null;

    const wss = new WebSocketServer({ port, host: '127.0.0.1' });

    wss.on('listening', () => {
        log.info(`[ws-bridge] Listening on ws://127.0.0.1:${port}`);
    });

    /**
     * Tell whoever is interested that the number of connected plugins changed.
     */
    function notifyClientChange(event) {
        if (typeof onClientChange === 'function') {
            try {
                onClientChange({
                    clients: getConnectedClients(),
                    at: Date.now(),
                    ...event
                });
            } catch {
                // A broken listener must not take the channel down with it.
            }
        }
    }

    /**
     * The socket a command is sent to: the most recently authenticated one. Only one
     * Photoshop panel is expected; sending to all of them would run the command twice.
     *
     * @returns {object|null} A live authenticated socket.
     */
    function activeClient() {
        let chosen = null;
        for (const client of authenticated) {
            if (client.readyState === client.OPEN) chosen = client;
        }
        return chosen;
    }

    /**
     * Drop commands that reached a terminal state long ago, and fail the ones that never
     * did. Called whenever a new command is queued, which is often enough.
     */
    function pruneQueue() {
        const now = Date.now();
        for (const [id, cmd] of commandQueue) {
            const age = now - cmd.createdAt;
            if (age < COMMAND_RETENTION_MS) continue;
            // Someone is still waiting for this one: an interactive script waits for the
            // person for up to half an hour. Dropping it would stop it from being re-sent
            // after a reconnect, and the plugin's cached answer would never arrive.
            if (waiters.has(id)) continue;
            commandQueue.delete(id);
        }
    }

    /**
     * @param {string} commandId - Command to deliver.
     * @param {object} cmd - Queue entry.
     * @returns {boolean} True when it went out over a live socket.
     */
    function deliver(commandId, cmd) {
        const client = activeClient();
        if (!client) return false;

        try {
            client.send(JSON.stringify({
                type: MSG.COMMAND,
                commandId,
                action: cmd.action,
                payload: cmd.payload
            }));
            cmd.state = 'sent';
            cmd.sentAt = Date.now();
            cmd.deliveredRuntimeId = client._runtimeId || null;
            return true;
        } catch (error) {
            log.warn(`[ws-bridge] Could not send command ${commandId}: ${error.message}`);
            return false;
        }
    }

    /**
     * @param {string} commandId - Command that finished.
     * @param {*} payload - Its result.
     */
    function settleResult(commandId, payload) {
        const cmd = commandQueue.get(commandId);
        if (cmd) {
            cmd.state = 'completed';
            cmd.result = payload;
            cmd.completedAt = Date.now();
        }
        const waiter = waiters.get(commandId);
        if (waiter) {
            clearTimeout(waiter.timeoutId);
            waiters.delete(commandId);
            waiter.resolve(payload);
        }
    }

    /**
     * @param {string} commandId - Command that failed.
     * @param {string} message - Why.
     */
    function settleError(commandId, message) {
        const cmd = commandQueue.get(commandId);
        if (cmd) {
            cmd.state = 'failed';
            cmd.error = message;
            cmd.completedAt = Date.now();
        }
        const waiter = waiters.get(commandId);
        if (waiter) {
            clearTimeout(waiter.timeoutId);
            waiters.delete(commandId);
            waiter.reject(new Error(message));
        }
    }

    wss.on('connection', (ws) => {
        // The application-level heartbeat works in UXP's browser-like WebSocket client.
        // The timestamp is checked as well as written: a half-open TCP socket must stop
        // counting as a live Photoshop panel instead of accepting commands forever.
        ws._lastPong = Date.now();
        ws._goodbye = null;

        let helloTimeout = setTimeout(() => {
            if (!authenticated.has(ws)) {
                log.warn('[ws-bridge] Client did not authenticate in time, closing.');
                ws.close(4001, 'Authentication timeout');
            }
        }, HELLO_TIMEOUT_MS);

        const heartbeatInterval = setInterval(() => {
            if (ws.readyState === ws.OPEN) {
                if (Date.now() - ws._lastPong > HEARTBEAT_INTERVAL_MS * 2) {
                    ws._disconnectOverride = {
                        reasonCode: 'heartbeat-timeout',
                        reason: 'The Photoshop plugin stopped answering heartbeat messages.',
                        intentional: false
                    };
                    ws.terminate();
                    return;
                }
                try {
                    ws.send(JSON.stringify({ type: MSG.PING, timestamp: Date.now() }));
                } catch (error) {
                    // The close event owns state cleanup. Terminating here only ensures a
                    // send race cannot escape the timer and crash Helper.
                    log.warn(`[ws-bridge] Heartbeat send failed: ${error.message}`);
                    ws.terminate();
                }
            }
        }, HEARTBEAT_INTERVAL_MS);

        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString('utf-8'));
            } catch {
                log.warn('[ws-bridge] Received non-JSON message, ignoring.');
                return;
            }

            if (!authenticated.has(ws)) {
                if (msg.type === MSG.HELLO && constantTimeEqual(msg.token, token)) {
                    const runtimeId = typeof msg.runtimeId === 'string' && msg.runtimeId
                        ? msg.runtimeId
                        : null;
                    const previousRuntimeId = lastRuntimeId;
                    const runtimeChanged = Boolean(
                        previousRuntimeId && runtimeId && previousRuntimeId !== runtimeId
                    );

                    ws._runtimeId = runtimeId;
                    authenticated.add(ws);
                    if (runtimeId) lastRuntimeId = runtimeId;
                    clearTimeout(helloTimeout);
                    helloTimeout = null;
                    ws.send(JSON.stringify({
                        type: MSG.WELCOME,
                        serverVersion: '2.1.0',
                        timestamp: Date.now()
                    }));
                    log.info('[ws-bridge] Plugin authenticated.'
                        + `${runtimeChanged ? ' A new UXP runtime was detected.' : ''}`);
                    notifyClientChange({
                        type: 'connected',
                        runtimeId,
                        previousRuntimeId,
                        runtimeChanged
                    });

                    // Anything unfinished is safe to resend only to the same UXP runtime.
                    // That runtime still owns the command-result cache and will replay a
                    // result rather than execute the command twice. A new runtime has lost
                    // the cache; blindly replaying a Photoshop mutation could apply it twice.
                    for (const [id, cmd] of commandQueue) {
                        if (cmd.state === 'queued'
                            || cmd.state === 'sent'
                            || cmd.state === 'acknowledged'
                            || cmd.state === 'timed-out') {
                            if (cmd.deliveredRuntimeId
                                && runtimeId
                                && cmd.deliveredRuntimeId !== runtimeId) {
                                settleError(
                                    id,
                                    'The Photoshop plugin restarted while this command was in flight. '
                                    + 'Its outcome is unknown, so it was not repeated automatically. '
                                    + 'Reopen AI Assist, resume the task, and inspect the document before '
                                    + 'retrying any change.'
                                );
                                continue;
                            }
                            deliver(id, cmd);
                        }
                    }
                } else {
                    log.warn('[ws-bridge] Invalid hello, closing connection.');
                    ws.close(4003, 'Invalid token');
                }
                return;
            }

            switch (msg.type) {
                case MSG.GOODBYE:
                    // A clean application-level reason is more useful than a generic close
                    // code. The subsequent close event remains the single notification point.
                    ws._goodbye = {
                        reasonCode: msg.reasonCode || 'client-closed',
                        reason: msg.reason || 'The Photoshop plugin closed the channel.',
                        intentional: msg.intentional !== false
                    };
                    break;

                case MSG.ACK: {
                    const cmd = commandQueue.get(msg.commandId);
                    if (cmd && cmd.state !== 'completed' && cmd.state !== 'failed') {
                        cmd.state = 'acknowledged';
                        cmd.ackedAt = Date.now();
                    }
                    break;
                }

                case MSG.RESULT:
                    settleResult(msg.commandId, msg.payload);
                    break;

                case MSG.ERROR:
                    settleError(msg.commandId, msg.error || msg.payload || 'Unknown error');
                    break;

                case MSG.PONG:
                    ws._lastPong = Date.now();
                    break;

                case MSG.PING:
                    try {
                        ws.send(JSON.stringify({ type: MSG.PONG, timestamp: Date.now() }));
                    } catch {
                        ws.terminate();
                    }
                    break;

                default:
                    log.warn(`[ws-bridge] Unknown message type: ${msg.type}`);
            }
        });

        ws.on('close', (code, reason) => {
            if (helloTimeout) clearTimeout(helloTimeout);
            clearInterval(heartbeatInterval);
            const wasAuthenticated = authenticated.delete(ws);
            const closeReason = Buffer.isBuffer(reason)
                ? reason.toString('utf-8')
                : String(reason || '');
            const details = ws._disconnectOverride || ws._goodbye || {
                reasonCode: code === 1000 ? 'normal-close' : 'connection-lost',
                reason: closeReason || 'The plugin connection ended without a reason.',
                intentional: code === 1000
            };
            lastDisconnect = {
                ...details,
                code,
                closeReason,
                runtimeId: ws._runtimeId || null,
                at: Date.now()
            };
            log.info(`[ws-bridge] Client disconnected (code=${code}, reason=${closeReason || 'none'}).`);
            // Waiters are deliberately left alone. A command in flight is not lost with
            // the socket: the plugin may well have finished it and will replay the result
            // when it reconnects, and the waiter has its own deadline.
            if (wasAuthenticated) {
                notifyClientChange({ type: 'disconnected', ...lastDisconnect });
            }
        });

        ws.on('error', (err) => {
            log.error(`[ws-bridge] WebSocket error: ${err.message}`);
        });
    });

    /**
     * Queue a command for the plugin.
     *
     * @param {string} action - Command name.
     * @param {object} [payload] - Command payload.
     * @returns {string} The command id.
     */
    function sendCommand(action, payload = {}) {
        pruneQueue();

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
        deliver(commandId, cmd);
        return commandId;
    }

    /**
     * Wait for a command's answer.
     *
     * @param {string} commandId - Command id from sendCommand.
     * @param {number} [timeoutMs] - Deadline.
     * @returns {Promise<*>} The plugin's result.
     */
    function waitForResult(commandId, timeoutMs = 30_000) {
        return new Promise((resolve, reject) => {
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
                const pending = commandQueue.get(commandId);
                if (pending && pending.state !== 'completed') {
                    pending.state = 'timed-out';
                }
                reject(new Error(
                    `Photoshop did not answer within ${Math.round(timeoutMs / 1000)} seconds. `
                    + (getConnectedClients() === 0
                        ? 'The connection to the FromPS / ToPS plugin is down. Ask the person '
                            + 'to check that Photoshop and the plugin are open, then reopen AI Assist.'
                        : 'A heavy filter may still be holding Photoshop up.')
                ));
            }, timeoutMs);

            waiters.set(commandId, { resolve, reject, timeoutId });
        });
    }

    /**
     * @param {string} action - Command name.
     * @param {object} [payload] - Command payload.
     * @param {number} [timeoutMs] - Deadline.
     * @returns {Promise<*>} The plugin's result.
     */
    function sendCommandAndWait(action, payload = {}, timeoutMs = 30_000) {
        const commandId = sendCommand(action, payload);
        return waitForResult(commandId, timeoutMs);
    }

    /**
     * @returns {number} How many authenticated plugins are connected.
     */
    function getConnectedClients() {
        let count = 0;
        for (const client of authenticated) {
            if (client.readyState === client.OPEN) count++;
        }
        return count;
    }

    /**
     * @returns {object|null} The most recent structured disconnect reason.
     */
    function getLastDisconnect() {
        return lastDisconnect ? { ...lastDisconnect } : null;
    }

    /**
     * @returns {string|null} Identity of the currently active UXP JavaScript runtime.
     */
    function getActiveRuntimeId() {
        const client = activeClient();
        return client ? client._runtimeId || null : null;
    }

    /**
     * @returns {Promise<void>} Resolves when the server has stopped.
     */
    function close() {
        return new Promise((resolve) => {
            for (const client of wss.clients) {
                client.close(1001, 'Server shutting down');
            }
            authenticated.clear();
            wss.close(() => {
                log.info('[ws-bridge] Server closed.');
                resolve();
            });
        });
    }

    return {
        wss,
        close,
        sendCommand,
        sendCommandAndWait,
        waitForResult,
        getConnectedClients,
        getLastDisconnect,
        getActiveRuntimeId,
        commandQueue
    };
}

module.exports = {
    createWsBridgeServer,
    MSG, // Exported only for testing; represents protocol message constants.
    COMMAND_RETENTION_MS
};
