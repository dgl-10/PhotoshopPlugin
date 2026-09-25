'use strict';

/**
 * What the AI Assist dialog in the plugin talks to.
 *
 * The dialog displays the MCP connection and task state, can explicitly close an active
 * Photoshop task, and provides MCP registration commands. These routes are protected by
 * the plugin token, like the rest of the plugin's privileged endpoints.
 */

const express = require('express');

const { buildInstallCommands, buildAgentInstructions, runInstall } = require('./mcp-setup');

/**
 * Build the router.
 *
 * @param {object} options
 * @param {object} options.service - The agent service from agent/index.js.
 * @param {number} options.port - Helper's HTTP port, for the setup commands.
 * @returns {import('express').Router}
 */
function createAgentRouter({ service, port }) {
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

    return router;
}

module.exports = { createAgentRouter };
