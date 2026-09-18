/**
 * WebSocket Bridge Prototype — Plugin (UXP client) side.
 *
 * This is an ISOLATED prototype for testing bidirectional communication
 * between the Photoshop UXP plugin and the Helper. It uses the global
 * WebSocket API available in Adobe UXP.
 *
 * NOT integrated into the production plugin flow.
 *
 * Usage inside UXP:
 *   import { createWsBridgeClient } from './ws-bridge-prototype';
 *   const client = createWsBridgeClient({
 *       url: 'ws://127.0.0.1:18346',
 *       token: '<pairing-token-from-helper>'
 *   });
 *   client.connect();
 *   // client.onCommand = (commandId, action, payload) => { ... };
 *   // When done:
 *   client.disconnect();
 */

// ── Protocol message types (must match server) ──────────────────────────────

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

// ── Client factory ───────────────────────────────────────────────────────────

/**
 * Create a WebSocket bridge client for UXP.
 *
 * @param {{ url: string, token: string, maxReconnectDelay?: number }} options
 * @returns {{ connect: Function, disconnect: Function,
 *            sendResult: Function, sendError: Function,
 *            onCommand: Function|null, onStatusChange: Function|null,
 *            getStatus: Function }}
 */
function createWsBridgeClient({ url, token, maxReconnectDelay = 30000 }) {
    let ws = null;
    let authenticated = false;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let intentionalClose = false;

    // Set of commandIds already processed (deduplication)
    const processedCommands = new Set();

    // Public callbacks (assigned by the consumer)
    let onCommand = null;
    let onStatusChange = null;

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

    function connect() {
        intentionalClose = false;

        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
            return; // Already connecting or connected
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

            // Send hello with pairing token
            ws.send(JSON.stringify({
                type: MSG.HELLO,
                token: token,
                clientVersion: '1.0.0-prototype'
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

                    // Deduplication: if already processed, re-send cached result
                    if (processedCommands.has(commandId)) {
                        console.log(`[ws-bridge-client] Duplicate command ${commandId}, ignoring.`);
                        break;
                    }

                    // Send acknowledgment immediately
                    _send({ type: MSG.ACK, commandId });

                    // Invoke the command handler
                    if (typeof onCommand === 'function') {
                        try {
                            onCommand(commandId, action, payload);
                        } catch (err) {
                            sendError(commandId, err.message || 'Command handler error');
                        }
                    }
                    break;
                }

                case MSG.PING: {
                    _send({ type: MSG.PONG, timestamp: Date.now() });
                    break;
                }

                case MSG.CANCEL: {
                    // Server cancelled a command; nothing to do in this prototype
                    console.log(`[ws-bridge-client] Command ${msg.commandId} cancelled by server.`);
                    break;
                }

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

    function disconnect() {
        intentionalClose = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (ws) {
            ws.close(1000, 'Client disconnect');
            ws = null;
        }
        authenticated = false;
        _notifyStatus();
    }

    /**
     * Send the result of a command back to Helper.
     *
     * @param {string} commandId
     * @param {object} payload
     */
    function sendResult(commandId, payload) {
        processedCommands.add(commandId);
        _send({ type: MSG.RESULT, commandId, payload });
    }

    /**
     * Send an error response for a command back to Helper.
     *
     * @param {string} commandId
     * @param {string} errorMessage
     */
    function sendError(commandId, errorMessage) {
        processedCommands.add(commandId);
        _send({ type: MSG.ERROR, commandId, error: errorMessage });
    }

    function _send(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    function _scheduleReconnect() {
        if (intentionalClose) return;

        // Exponential backoff with jitter, capped at maxReconnectDelay
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

// Exported for UXP runtime; MSG and CommonJS wrapper are included only for Node.js unit / integration tests
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        createWsBridgeClient,
        MSG // Exported only for testing; represents protocol message constants
    };
}
