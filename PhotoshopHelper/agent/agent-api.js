'use strict';

/**
 * What the FromPS / ToPS AI line in the plugin talks to.
 *
 * These routes report the MCP connection and task state, can explicitly close an active
 * Photoshop task, provide MCP registration commands, and can ask Helper to bring the AI
 * Assist window to the front. All of them are protected by the plugin token, like the rest
 * of the plugin's privileged endpoints.
 */

const express = require('express');

const { buildInstallCommands, buildAgentInstructions, runInstall } = require('./mcp-setup');

/**
 * Build the router.
 *
 * @param {object} options
 * @param {object} options.service - The agent service from agent/index.js.
 * @param {number} options.port - Helper's HTTP port, for the setup commands.
 * @param {(options?: {section?: string}) => void} options.openAssistWindow - Opens or
 *   focuses the AI Assist window; see agent/assist-window.js.
 * @returns {import('express').Router}
 */
function createAgentRouter({ service, port, openAssistWindow }) {
    const router = express.Router();

    router.get('/state', (req, res) => {
        res.json(service.getState());
    });

    router.post('/stop', (req, res) => {
        res.json(service.stop());
    });

    router.get('/mcp-setup', (req, res) => {
        res.json({
            commands: buildInstallCommands({ port }),
            instructionsForAnAgent: buildAgentInstructions({ port })
        });
    });

    router.post('/mcp-setup/install', async (req, res) => {
        const cli = req.body && req.body.cli;
        if (!cli) {
            return res.status(400).json({ ok: false, output: 'Which CLI?' });
        }

        // Registering the server edits the person's own CLI configuration, so it only ever
        // happens on an explicit press in the panel.
        const outcome = await runInstall({ cli, port });
        res.json(outcome);
    });

    // The line's window button and its "How to connect an agent" link both go through
    // here: the line itself cannot open a window, only ask Helper — a background
    // application — to bring its own window forward.
    router.post('/open-window', (req, res) => {
        const section = req.body && req.body.section;
        openAssistWindow({ section });
        res.json({ ok: true });
    });

    return router;
}

module.exports = { createAgentRouter };
