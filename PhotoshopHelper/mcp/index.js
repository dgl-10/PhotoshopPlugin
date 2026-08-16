const crypto = require('node:crypto');

const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');

const { createOptionalTokenMiddleware } = require('../localGenerationApi');
const { createPhotoshopHelperMcpServer } = require('./createServer');

const MCP_PATH = '/mcp';

/**
 * JSON-RPC error payload used when the HTTP request is not a valid MCP session.
 *
 * @param {string} message - Error message.
 * @returns {object} JSON-RPC 2.0 error body.
 */
function jsonRpcError(message) {
    return {
        jsonrpc: '2.0',
        error: {
            code: -32000,
            message
        },
        id: null
    };
}

/**
 * Mount Streamable HTTP MCP on the existing Express app.
 *
 * Sessions are stored by mcp-session-id so a second local client does not
 * replace the first. The already-parsed Express JSON body is passed through.
 *
 * @param {import('express').Express} expressApp - Existing Express instance.
 * @param {object} options - Runtime dependencies supplied by main.js.
 * @param {Function} options.generate - Existing generate() function.
 * @param {string} options.tempDir - Shared generation output directory.
 * @param {string} [options.token=''] - Optional LOCAL_GENERATION_API_TOKEN.
 * @param {Function} [options.onGenerationAccepted] - Usage/accounting hook.
 * @param {string} options.appVersion - Application version.
 * @param {string} options.guidePath - Absolute path to MCP_GUIDE.md.
 * @param {Function} [options.getAvailableProviders] - Optional catalog override.
 * @returns {() => Promise<void>} Close function for tray quit.
 */
function mountMcpServer(expressApp, options) {
    if (!expressApp || typeof expressApp.post !== 'function') {
        throw new TypeError('mountMcpServer requires an Express app.');
    }
    if (!options || typeof options.generate !== 'function') {
        throw new TypeError('mountMcpServer requires a generate function.');
    }
    if (!options.tempDir || typeof options.tempDir !== 'string') {
        throw new TypeError('mountMcpServer requires a tempDir path.');
    }
    if (!options.guidePath || typeof options.guidePath !== 'string') {
        throw new TypeError('mountMcpServer requires a guidePath.');
    }

    const sessions = new Map();
    const auth = createOptionalTokenMiddleware(options.token || '');

    const handlePost = async (req, res) => {
        const sessionId = req.get('mcp-session-id');

        try {
            if (sessionId && sessions.has(sessionId)) {
                const session = sessions.get(sessionId);
                await session.transport.handleRequest(req, res, req.body);
                return;
            }

            if (!sessionId && isInitializeRequest(req.body)) {
                const session = { transport: null, server: null };
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => crypto.randomUUID(),
                    onsessioninitialized: initializedSessionId => {
                        sessions.set(initializedSessionId, session);
                    },
                    onsessionclosed: closedSessionId => {
                        sessions.delete(closedSessionId);
                    }
                });

                transport.onclose = () => {
                    const closedId = transport.sessionId;
                    if (closedId) {
                        sessions.delete(closedId);
                    }
                };

                const server = createPhotoshopHelperMcpServer(options);
                session.transport = transport;
                session.server = server;
                await server.connect(transport);
                await transport.handleRequest(req, res, req.body);
                return;
            }

            res.status(400).json(jsonRpcError('Bad Request: No valid session ID provided'));
        } catch (error) {
            console.error('[MCP] Failed to handle POST /mcp:', error);
            if (!res.headersSent) {
                res.status(500).json(jsonRpcError('Internal server error'));
            }
        }
    };

    const handleSessionRequest = async (req, res) => {
        const sessionId = req.get('mcp-session-id');
        if (!sessionId || !sessions.has(sessionId)) {
            res.status(400).send('Invalid or missing session ID');
            return;
        }

        try {
            const session = sessions.get(sessionId);
            await session.transport.handleRequest(req, res);
        } catch (error) {
            console.error(`[MCP] Failed to handle ${req.method} /mcp:`, error);
            if (!res.headersSent) {
                res.status(500).send('Error processing MCP request');
            }
        }
    };

    expressApp.post(MCP_PATH, auth, handlePost);
    expressApp.get(MCP_PATH, auth, handleSessionRequest);
    expressApp.delete(MCP_PATH, auth, handleSessionRequest);

    console.log('[MCP] Streamable HTTP endpoint mounted at /mcp');

    return async function closeMcpServer() {
        const closing = [];
        for (const [sessionId, session] of sessions.entries()) {
            closing.push(Promise.resolve().then(async () => {
                try {
                    await session.transport.close();
                } catch (error) {
                    console.error(`[MCP] Failed to close session ${sessionId}:`, error);
                }
            }));
        }
        sessions.clear();
        await Promise.all(closing);
    };
}

module.exports = {
    MCP_PATH,
    mountMcpServer
};
