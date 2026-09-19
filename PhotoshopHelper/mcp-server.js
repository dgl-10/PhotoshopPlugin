'use strict';

const express = require('express');

const SERVER_INFO = {
    name: "PhotoshopHelper-MCP",
    version: "1.0.0"
};

const TOOLS = [
    {
        name: "get_document_info",
        description: "Get information about open Photoshop documents: dimensions, layer list (name, type, visibility, ID), active layer, and selection state.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false
        }
    },
    {
        name: "execute_batch_play",
        description: "Execute an array of Photoshop batchPlay action descriptors and return results. Each descriptor is a JSON object like { _obj: 'hide', _target: [...] }. The operation is wrapped in executeAsModal with a single history state.",
        inputSchema: {
            type: "object",
            properties: {
                descriptors: {
                    type: "array",
                    items: { type: "object" }
                },
                options: {
                    type: "object"
                }
            },
            required: ["descriptors"]
        }
    },
    {
        name: "execute_script",
        description: "Execute JavaScript code inside the Photoshop UXP plugin with access to Photoshop API modules: app, action, core, imaging, constants. The code runs inside executeAsModal. Return a value by assigning to `result` variable. Example: `result = app.activeDocument.name;`",
        inputSchema: {
            type: "object",
            properties: {
                code: {
                    type: "string"
                }
            },
            required: ["code"]
        }
    },
    {
        name: "get_image",
        description: "Capture a PNG image of the document, a specific layer, or a region. Returns base64-encoded PNG data. The image is scaled so the longest side does not exceed maxDimension (default 1024px).",
        inputSchema: {
            type: "object",
            properties: {
                target: {
                    type: "string",
                    enum: ["document", "layer"],
                    default: "document"
                },
                layerId: {
                    type: "number"
                },
                bounds: {
                    type: "object",
                    properties: {
                        left: { type: "number" },
                        top: { type: "number" },
                        right: { type: "number" },
                        bottom: { type: "number" }
                    },
                    required: ["left", "top", "right", "bottom"]
                },
                maxDimension: {
                    type: "number",
                    default: 1024
                }
            }
        }
    }
];

function createMcpRouter({ getWsBridge }) {
    const router = express.Router();

    router.post('/', async (req, res) => {
        const body = req.body;
        
        if (!body || body.jsonrpc !== "2.0") {
            return res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id: null });
        }

        const isNotification = !('id' in body);
        const respond = (result) => {
            if (isNotification) return res.status(202).end();
            return res.json({ jsonrpc: "2.0", id: body.id, result });
        };
        
        const respondError = (code, message) => {
            if (isNotification) return res.status(202).end();
            return res.json({ jsonrpc: "2.0", id: body.id, error: { code, message } });
        };

        switch (body.method) {
            case 'initialize':
                return respond({
                    protocolVersion: "2024-11-05",
                    capabilities: {
                        tools: {}
                    },
                    serverInfo: SERVER_INFO
                });
                
            case 'notifications/initialized':
                return res.status(202).end();
                
            case 'tools/list':
                return respond({
                    tools: TOOLS
                });
                
            case 'tools/call': {
                const { name, arguments: args } = body.params || {};
                const wsBridge = getWsBridge();
                
                if (!wsBridge) {
                    return respond({
                        content: [{ type: "text", text: "Error: Photoshop connection is not available. Make sure PhotoshopHelper is fully initialized." }],
                        isError: true
                    });
                }

                if (wsBridge.getConnectedClients() === 0) {
                    return respond({
                        content: [{ type: "text", text: "Error: No Photoshop plugin is connected. Make sure Photoshop is running with the plugin panel open." }],
                        isError: true
                    });
                }
                
                try {
                    let result;
                    if (name === "get_document_info") {
                        result = await wsBridge.sendCommandAndWait("get_document_info", args || {});
                    } else if (name === "execute_batch_play") {
                        result = await wsBridge.sendCommandAndWait("execute_batch_play", args || {});
                    } else if (name === "execute_script") {
                        result = await wsBridge.sendCommandAndWait("execute_script", args || {});
                    } else if (name === "get_image") {
                        result = await wsBridge.sendCommandAndWait("get_image", args || {});
                    } else {
                        return respondError(-32601, "Method not found");
                    }
                    
                    return respond({
                        content: [{
                            type: "text",
                            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
                        }]
                    });
                } catch (err) {
                    return respond({
                        content: [{ type: "text", text: `Error: ${err.message}` }],
                        isError: true
                    });
                }
            }

            case 'server/discover':
                return respond({
                    serverInfo: SERVER_INFO
                });
                
            default:
                if (isNotification) {
                    return res.status(202).end();
                }
                return respondError(-32601, "Method not found");
        }
    });

    return router;
}

module.exports = { createMcpRouter };
