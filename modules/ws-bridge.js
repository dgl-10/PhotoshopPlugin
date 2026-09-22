/**
 * The channel between Helper and the Photoshop plugin — plugin (UXP client) side.
 *
 * Two things changed from the stage 1 prototype:
 *
 *   1. A command that arrives twice — which happens after a reconnect, because Helper
 *      re-sends everything it never saw an answer for — used to be ignored. Ignoring it
 *      loses the answer for good. Now the result of every command is kept and replayed,
 *      so the work is done once and the answer always arrives.
 *   2. The connection is no longer opened at plugin start. It is opened while the AI
 *      assistant panel is open and closed a while after it is really closed; hiding,
 *      minimising and switching tabs are not closing.
 */

// ── Protocol message types (must match the server) ──────────────────────────

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

// How many finished commands are remembered for replay. A task is tens of calls, so this
// covers a reconnect in the middle of a long one without growing without bound.
const RESULT_CACHE_SIZE = 100;

/**
 * Create the channel client.
 *
 * @param {{ url: string, token: string, runtimeId?: string, maxReconnectDelay?: number }} options
 * @returns {object} The client.
 */
function createWsBridgeClient({ url, token, runtimeId = null, maxReconnectDelay = 30000 }) {
    let ws = null;
    let authenticated = false;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let intentionalClose = false;

    // commandId -> { type: 'result'|'error', payload } for commands already handled.
    const finished = new Map();
    // Commands being worked on right now, so a duplicate does not start a second run.
    const inFlight = new Set();

    let onCommand = null;
    let onStatusChange = null;

    /**
     * @returns {string} 'disconnected', 'connecting', 'authenticating' or 'connected'.
     */
    function getStatus() {
        if (!ws) return 'disconnected';
        if (ws.readyState === WebSocket.CONNECTING) return 'connecting';
        if (ws.readyState === WebSocket.OPEN && authenticated) return 'connected';
        if (ws.readyState === WebSocket.OPEN && !authenticated) return 'authenticating';
        if (ws.readyState === WebSocket.CLOSING) return 'closing';
        return 'disconnected';
    }

    function _notifyStatus() {
        if (typeof onStatusChange === 'function') {
            try { onStatusChange(getStatus()); } catch { /* ignore */ }
        }
    }

    /**
     * @param {object} obj - Message to send.
     */
    function _send(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    /**
     * Remember a finished command so a repeat delivery can be answered without doing the
     * work again.
     *
     * @param {string} commandId - Command that finished.
     * @param {object} entry - { type, payload }.
     */
    function _remember(commandId, entry) {
        finished.set(commandId, entry);
        inFlight.delete(commandId);
        while (finished.size > RESULT_CACHE_SIZE) {
            const oldest = finished.keys().next().value;
            finished.delete(oldest);
        }
    }

    function connect() {
        intentionalClose = false;

        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
            return;
        }

        authenticated = false;
        _notifyStatus();

        try {
            ws = new WebSocket(url);
        } catch (err) {
            console.error('[ws-bridge-client] Failed to create WebSocket:', err.message);
            _scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            reconnectAttempt = 0;
            _notifyStatus();
            ws.send(JSON.stringify({
                type: MSG.HELLO,
                token: token,
                runtimeId,
                clientVersion: '2.1.0'
            }));
        };

        ws.onmessage = (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                console.warn('[ws-bridge-client] Received non-JSON message.');
                return;
            }

            if (!authenticated) {
                if (msg.type === MSG.WELCOME) {
                    authenticated = true;
                    console.log('[ws-bridge-client] Authenticated with Helper.');
                    _notifyStatus();
                }
                return;
            }

            switch (msg.type) {
                case MSG.COMMAND: {
                    const { commandId, action, payload } = msg;

                    // Already answered: replay instead of running it again. This is the
                    // path that saves a result when the socket dropped after the work was
                    // done but before the answer got out.
                    const cached = finished.get(commandId);
                    if (cached) {
                        _send({ type: MSG.ACK, commandId });
                        _send(cached.type === 'error'
                            ? { type: MSG.ERROR, commandId, error: cached.payload }
                            : { type: MSG.RESULT, commandId, payload: cached.payload });
                        break;
                    }

                    // Still running: acknowledge and let the original run answer.
                    if (inFlight.has(commandId)) {
                        _send({ type: MSG.ACK, commandId });
                        break;
                    }

                    inFlight.add(commandId);
                    _send({ type: MSG.ACK, commandId });

                    if (typeof onCommand === 'function') {
                        try {
                            onCommand(commandId, action, payload);
                        } catch (err) {
                            sendError(commandId, err.message || 'Command handler error');
                        }
                    } else {
                        sendError(commandId, 'The plugin has no handler for commands yet.');
                    }
                    break;
                }

                case MSG.PING:
                    _send({ type: MSG.PONG, timestamp: Date.now() });
                    break;

                case MSG.CANCEL:
                    console.log(`[ws-bridge-client] Command ${msg.commandId} cancelled by Helper.`);
                    break;

                default:
                    console.warn(`[ws-bridge-client] Unknown message type: ${msg.type}`);
            }
        };

        ws.onclose = (event) => {
            authenticated = false;
            _notifyStatus();

            if (!intentionalClose) {
                console.log(`[ws-bridge-client] Disconnected (code=${event.code}). Scheduling reconnect...`);
                _scheduleReconnect();
            }
        };

        ws.onerror = (event) => {
            console.error('[ws-bridge-client] WebSocket error:', event.message || 'unknown');
        };
    }

    function disconnect(options = {}) {
        const reason = options.reason || 'Assistant panel closed';
        const reasonCode = options.reasonCode || 'assistant-dialog-closed';
        const intentional = options.intentional !== false;

        intentionalClose = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (ws) {
            // Detach the handlers first: a late 'close' from this socket must not reset the
            // state of a new connection opened right after (dialog closed and reopened).
            const old = ws;
            ws = null;
            // Send an application-level reason before the close handshake. The WebSocket
            // close reason is useful too, but an abrupt host shutdown may discard it.
            if (old.readyState === WebSocket.OPEN) {
                try {
                    old.send(JSON.stringify({
                        type: MSG.GOODBYE,
                        reason,
                        reasonCode,
                        intentional,
                        runtimeId
                    }));
                } catch (error) {
                    console.warn('[ws-bridge-client] Sending the close reason failed:', error.message);
                }
            }
            old.onopen = old.onmessage = old.onclose = old.onerror = null;
            // Between reconnect attempts the old socket is already CLOSED, and closing it
            // again throws.
            if (old.readyState === WebSocket.CONNECTING || old.readyState === WebSocket.OPEN) {
                try {
                    old.close(1000, reason.slice(0, 120));
                } catch (err) {
                    console.warn('[ws-bridge-client] Closing the socket failed:', err.message);
                }
            }
        }
        authenticated = false;
        _notifyStatus();
    }

    /**
     * Send the result of a command back to Helper.
     *
     * @param {string} commandId - Command being answered.
     * @param {object} payload - The answer.
     */
    function sendResult(commandId, payload) {
        _remember(commandId, { type: 'result', payload });
        _send({ type: MSG.RESULT, commandId, payload });
    }

    /**
     * Send a failure back to Helper.
     *
     * @param {string} commandId - Command being answered.
     * @param {string} errorMessage - What went wrong.
     */
    function sendError(commandId, errorMessage) {
        _remember(commandId, { type: 'error', payload: errorMessage });
        _send({ type: MSG.ERROR, commandId, error: errorMessage });
    }

    function _scheduleReconnect() {
        if (intentionalClose) return;

        const baseDelay = Math.min(1000 * Math.pow(2, reconnectAttempt), maxReconnectDelay);
        const jitter = Math.random() * baseDelay * 0.3;
        const delay = Math.round(baseDelay + jitter);

        reconnectAttempt++;
        console.log(`[ws-bridge-client] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})...`);

        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    }

    return {
        connect,
        disconnect,
        sendResult,
        sendError,
        getStatus,
        get onCommand() { return onCommand; },
        set onCommand(fn) { onCommand = fn; },
        get onStatusChange() { return onStatusChange; },
        set onStatusChange(fn) { onStatusChange = fn; }
    };
}

// Exported for the UXP runtime; the CommonJS wrapper and MSG exist for Node.js tests.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        createWsBridgeClient,
        MSG, // Exported only for testing; represents protocol message constants.
        RESULT_CACHE_SIZE
    };
}
