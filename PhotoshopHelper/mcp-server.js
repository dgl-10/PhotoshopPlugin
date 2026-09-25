'use strict';

/**
 * The MCP server Helper publishes on its own HTTP server, on loopback only.
 *
 * The rules and knowledge base are handed out through this server rather than through
 * files in a project folder. An MCP client may be started from any working directory and
 * may not have filesystem access to Helper's data folder.
 *
 * Transport: Streamable HTTP, POST with JSON-RPC 2.0. Notifications (no `id`) are
 * answered with HTTP 202 and an empty body, which Codex's Rust client requires.
 */

const express = require('express');

const SERVER_INFO = {
    name: 'PhotoshopHelper',
    title: 'Photoshop Helper',
    version: '2.0.0'
};

// Protocol versions this server knows how to speak. The newest is offered when the client
// asks for something we do not recognise; every tested CLI negotiates from its own side.
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const PREFERRED_PROTOCOL_VERSION = '2024-11-05';

// Handed to the client at initialize. Agents read tool descriptions unevenly, so the
// first line of defence is this text and the second is the refusal every tool returns
// without a task id.
const SERVER_INSTRUCTIONS =
    'These tools work on the document open in Adobe Photoshop right now.\n'
    + 'If the person is only asking you something — which key does what, how some part of '
    + 'Photoshop works — just answer them. None of this is needed for that.\n'
    + 'Before you look at the document or change it, call ps_start_task. It returns the task '
    + 'id that every other ps_ tool requires, the rules for working with Photoshop, and a '
    + 'knowledge base of recipes that are known to work. Photoshop\'s scripting documentation '
    + 'is poor and action descriptors are easy to invent: read the knowledge base before you '
    + 'trust your own memory of a property name.\n'
    + 'When the result is something you would judge by eye, look at it with ps_get_image '
    + 'instead of deciding from numbers. If you cannot see an image, say so — do not guess '
    + 'what is in the document from layer names.\n'
    + 'If a tool says the Photoshop connection was lost, tell the person to reopen FromPS / '
    + 'ToPS AI. Closing only that window pauses rather than cancels the task. Reopening it in '
    + 'the same plugin runtime resumes the same task automatically; use ps_resume_task only '
    + 'when the tool says the plugin runtime restarted. Never repeat an uncertain change blindly.\n'
    + 'Finish with ps_finish_task.';

/**
 * Pick the protocol version to answer with.
 *
 * @param {string|undefined} requested - Version the client asked for.
 * @returns {string} A version this server supports.
 */
function negotiateProtocolVersion(requested) {
    if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
        return requested;
    }
    return PREFERRED_PROTOCOL_VERSION;
}

/**
 * Build the Express router for POST /mcp.
 *
 * @param {object} options
 * @param {object} options.tools - Tool layer from agent/mcp-tools.js: { list, call }.
 * @returns {import('express').Router}
 */
function createMcpRouter({ tools }) {
    const router = express.Router();

    router.post('/', async (req, res) => {
        const body = req.body;

        if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
            return res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32600, message: 'Invalid Request' },
                id: null
            });
        }

        const isNotification = !('id' in body);

        /**
         * @param {object} result - JSON-RPC result.
         * @returns {object} The Express response.
         */
        const respond = (result) => {
            if (isNotification) return res.status(202).end();
            return res.json({ jsonrpc: '2.0', id: body.id, result });
        };

        /**
         * @param {number} code - JSON-RPC error code.
         * @param {string} message - Error text.
         * @returns {object} The Express response.
         */
        const respondError = (code, message) => {
            if (isNotification) return res.status(202).end();
            return res.json({ jsonrpc: '2.0', id: body.id, error: { code, message } });
        };

        switch (body.method) {
            case 'initialize':
                // The client names itself here, and that is the only place it does. It goes
                // into the header of every knowledge base article, so a later reader knows
                // which agent wrote it.
                if (typeof tools.setClient === 'function') {
                    tools.setClient(body.params && body.params.clientInfo);
                }
                return respond({
                    protocolVersion: negotiateProtocolVersion(body.params && body.params.protocolVersion),
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: SERVER_INFO,
                    instructions: SERVER_INSTRUCTIONS
                });

            case 'notifications/initialized':
                return res.status(202).end();

            case 'ping':
                return respond({});

            case 'tools/list':
                return respond({ tools: tools.list() });

            case 'tools/call': {
                const { name, arguments: args } = body.params || {};
                if (typeof name !== 'string') {
                    return respondError(-32602, 'tools/call requires a tool name');
                }

                try {
                    const result = await tools.call(name, args || {});
                    return respond(result);
                } catch (error) {
                    // The tool layer already turns refusals into readable tool results;
                    // anything reaching here is a genuine fault on our side.
                    return respond({
                        content: [{ type: 'text', text: `Photoshop Helper failed: ${error.message}` }],
                        isError: true
                    });
                }
            }

            case 'server/discover':
                return respond({ serverInfo: SERVER_INFO });

            default:
                if (isNotification) {
                    return res.status(202).end();
                }
                return respondError(-32601, `Method not found: ${body.method}`);
        }
    });

    return router;
}

module.exports = {
    createMcpRouter,
    SERVER_INFO,
    SERVER_INSTRUCTIONS,
    SUPPORTED_PROTOCOL_VERSIONS,
    // Exported for testing only; version negotiation is otherwise internal to the router.
    negotiateProtocolVersion
};
