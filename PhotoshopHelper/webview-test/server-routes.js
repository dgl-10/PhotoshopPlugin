'use strict';

const path = require('node:path');
const express = require('express');
const { buildAgentInstructions } = require('../agent/mcp-setup');

/**
 * Register isolated experimental routes for the webview test bench.
 * All endpoints enforce local-only access (no remote or tunneled traffic).
 *
 * @param {import('express').Express} app - Express application instance
 * @param {Function} checkIsLocal - Local machine verification function
 * @param {number} port - PhotoshopHelper port
 */
function registerWebviewTestRoutes(app, checkIsLocal, port) {
    let liveCounter = 0;

    // Security guard middleware: reject any non-local requests
    const enforceLocalOnly = (req, res, next) => {
        if (!checkIsLocal(req)) {
            return res.status(403).json({ error: 'Forbidden: Local machine requests only' });
        }
        next();
    };

    // Serve static files for the webview test page
    app.use('/webview-test', enforceLocalOnly, express.static(path.join(__dirname, '.')));

    // GET /api/webview-test/live - Harmless live update endpoint (counter + timestamp)
    app.get('/api/webview-test/live', enforceLocalOnly, (req, res) => {
        liveCounter++;
        res.json({
            ok: true,
            counter: liveCounter,
            timestamp: new Date().toISOString(),
            uptimeSeconds: Math.round(process.uptime())
        });
    });

    // GET /api/webview-test/instructions - Real MCP agent instructions text
    app.get('/api/webview-test/instructions', enforceLocalOnly, (req, res) => {
        try {
            const instructions = buildAgentInstructions({ port });
            res.json({
                ok: true,
                instructions
            });
        } catch (error) {
            res.status(500).json({ ok: false, error: error.message });
        }
    });
}

module.exports = {
    registerWebviewTestRoutes
};
