'use strict';

/**
 * What the assistant dialog in the plugin talks to.
 *
 * The dialog is a UXP page with no way to spawn a process, so everything it needs — the
 * state of the task, the chats, launching the agent, stopping it, rolling the document
 * back — goes through these routes. They are protected by the plugin token, like the rest
 * of the plugin's endpoints, and they never reach a paid API: the runner refuses to work
 * unless Helper is configured for a CLI on the person's own subscription.
 */

const express = require('express');

const { buildInstallCommands, buildAgentInstructions, runInstall } = require('./mcp-setup');

/**
 * Build the router.
 *
 * @param {object} options
 * @param {object} options.service - The agent service from agent/index.js.
 * @param {number} options.port - Helper's HTTP port, for the setup commands.
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {import('express').Router}
 */
function createAgentRouter({ service, port, logger = console }) {
    const router = express.Router();

    router.get('/state', (req, res) => {
        res.json(service.getState());
    });

    router.get('/chats', (req, res) => {
        res.json({ chats: service.chats.listChats() });
    });

    router.post('/chats', (req, res) => {
        const config = service.runner.readAgentConfig();
        const chat = service.chats.createChat({
            cli: config.cli || null,
            model: config.model || null,
            title: (req.body && req.body.title) || undefined
        });
        res.json({ chat });
    });

    router.get('/chats/:id', (req, res) => {
        const chat = service.chats.getChat(req.params.id);
        if (!chat) {
            return res.status(404).json({ error: 'No such chat.' });
        }
        res.json({ chat, state: service.getState() });
    });

    router.delete('/chats/:id', (req, res) => {
        res.json({ deleted: service.chats.deleteChat(req.params.id) });
    });

    router.post('/chats/:id/messages', async (req, res) => {
        const text = req.body && typeof req.body.text === 'string' ? req.body.text.trim() : '';
        if (!text) {
            return res.status(400).json({ error: 'The message is empty.' });
        }

        const chat = service.chats.getChat(req.params.id);
        if (!chat) {
            return res.status(404).json({ error: 'No such chat.' });
        }

        const accepted = service.sendToAgent(chat, text);
        if (!accepted.ok) {
            return res.status(409).json({ error: accepted.error });
        }

        // The agent works for minutes. The panel polls the chat instead of holding a request
        // open, which also means closing the panel cannot cancel a task by accident.
        res.json({ accepted: true });
    });

    router.post('/stop', (req, res) => {
        res.json(service.stop());
    });

    router.post('/rollback', async (req, res) => {
        try {
            res.json(await service.rollback());
        } catch (error) {
            logger.warn(`[agent-api] Rollback failed: ${error.message}`);
            res.status(500).json({ ok: false, message: error.message });
        }
    });

    router.post('/confirm', (req, res) => {
        const confirmed = req.body ? req.body.confirmed !== false : true;
        res.json(service.confirmLastTask(confirmed));
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
