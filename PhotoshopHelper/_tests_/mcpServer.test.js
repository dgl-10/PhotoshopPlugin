const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { mountMcpServer } = require('../mcp');

const catalog = [
    {
        id: 'seedream_v4_5_fal',
        name: 'Seedream v4.5 via Fal API Key',
        generation_modes: ['t2i', 'i2i'],
        parameters: [
            { name: 'prompt', type: 'string', default: '' },
            {
                name: 'resolution',
                type: 'dropdown',
                options: [{ value: '1k' }, { value: '2k', hidden: true }]
            }
        ]
    },
    {
        id: 'i2i_only',
        name: 'Edit only',
        generation_modes: ['i2i']
    }
];

async function listen(app) {
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', err => (err ? reject(err) : resolve()));
    });
    return server;
}

async function connectClient(url) {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client({ name: 'mcp-server-test', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
}

function parseToolText(result) {
    return JSON.parse(result.content[0].text);
}

describe('MCP Streamable HTTP server', () => {
    let httpServer;
    let closeMcp;
    let baseUrl;
    let tempDir;
    let generateCalls;
    const accepted = [];

    before(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-http-'));
        generateCalls = 0;

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        closeMcp = mountMcpServer(app, {
            generate: async () => {
                generateCalls += 1;
                const outputPath = path.join(tempDir, `out_${generateCalls}.png`);
                fs.writeFileSync(outputPath, 'png');
                return [{ status: 'done', image: outputPath }];
            },
            tempDir,
            token: '',
            onGenerationAccepted: generation => accepted.push(generation.generationId),
            appVersion: '0.0.0-test',
            guidePath: path.join(__dirname, '..', 'MCP_GUIDE.md'),
            getAvailableProviders: () => catalog
        });

        httpServer = await listen(app);
        const address = httpServer.address();
        baseUrl = `http://127.0.0.1:${address.port}/mcp`;
    });

    after(async () => {
        if (closeMcp) {
            await closeMcp();
        }
        if (httpServer) {
            await new Promise((resolve, reject) => {
                httpServer.close(err => (err ? reject(err) : resolve()));
            });
        }
    });

    it('advertises the handshake and the three tools', async () => {
        const { client } = await connectClient(baseUrl);
        try {
            const init = client.getServerCapabilities ? client.getServerCapabilities() : null;
            const instructions = client.getInstructions ? client.getInstructions() : '';
            if (typeof instructions === 'string') {
                assert.match(instructions, /list_providers/);
                assert.match(instructions, /MCP_GUIDE\.md/);
                assert.doesNotMatch(instructions, /Inpaint/);
            }

            const listed = await client.listTools();
            assert.deepEqual(
                listed.tools.map(tool => tool.name).sort(),
                ['generate_image', 'get_providers_details', 'list_providers']
            );
            const details = listed.tools.find(tool => tool.name === 'get_providers_details');
            assert.match(details.description, /Do not request every provider/);
            void init;
        } finally {
            await client.close();
        }
    });

    it('lists providers and returns compact details', async () => {
        const { client } = await connectClient(baseUrl);
        try {
            const listed = await client.callTool({
                name: 'list_providers',
                arguments: { mode: 't2i' }
            });
            assert.deepEqual(parseToolText(listed).providers.map(provider => provider.id), [
                'seedream_v4_5_fal'
            ]);

            const details = await client.callTool({
                name: 'get_providers_details',
                arguments: { providerIds: ['seedream_v4_5_fal', 'missing'] }
            });
            const payload = parseToolText(details);
            assert.equal(payload.providers[0].parameters[1].options[0], '1k');
            assert.equal(payload.providers[0].parameters[1].options.includes('2k'), false);
            assert.deepEqual(payload.notFound, ['missing']);

            const wildcard = await client.callTool({
                name: 'get_providers_details',
                arguments: { providerIds: ['*'] }
            });
            assert.equal(wildcard.isError, true);
        } finally {
            await client.close();
        }
    });

    it('keeps two sessions independent', async () => {
        const first = await connectClient(baseUrl);
        const second = await connectClient(baseUrl);
        try {
            const fromFirst = parseToolText(await first.client.callTool({
                name: 'list_providers',
                arguments: {}
            }));
            const fromSecond = parseToolText(await second.client.callTool({
                name: 'list_providers',
                arguments: {}
            }));
            assert.equal(fromFirst.providers.length, 2);
            assert.equal(fromSecond.providers.length, 2);
        } finally {
            await first.client.close();
            await second.client.close();
        }
    });

    it('waits for generate_image and does not treat executor failure as a protocol error', async () => {
        const { client } = await connectClient(baseUrl);
        try {
            const completed = await client.callTool({
                name: 'generate_image',
                arguments: {
                    providerId: 'seedream_v4_5_fal',
                    aspect_ratio: '1:1',
                    prompt: 'a cloud'
                }
            });
            const completedPayload = parseToolText(completed);
            assert.equal(completed.isError, undefined);
            assert.equal(completedPayload.status, 'completed');
            assert.equal(completedPayload.outputPaths.length, 1);
            assert.equal(fs.existsSync(completedPayload.outputPaths[0]), true);
            assert.equal(accepted.includes(completedPayload.generationId), true);

            const malformed = await client.callTool({
                name: 'generate_image',
                arguments: {
                    providerId: 'seedream_v4_5_fal',
                    prompt: 'missing ratio'
                }
            });
            assert.equal(malformed.isError, true);
            assert.equal(generateCalls, 1);
        } finally {
            await client.close();
        }
    });

    it('requires the optional token on /mcp when configured', async () => {
        const app = express();
        app.use(express.json());
        const close = mountMcpServer(app, {
            generate: async () => [],
            tempDir,
            token: 'secret-token',
            appVersion: '0.0.0-test',
            guidePath: path.join(__dirname, '..', 'MCP_GUIDE.md'),
            getAvailableProviders: () => catalog
        });
        const server = await listen(app);
        const url = `http://127.0.0.1:${server.address().port}/mcp`;

        try {
            const unauthorized = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} })
            });
            assert.equal(unauthorized.status, 401);

            const authorized = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer secret-token'
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2025-03-26',
                        capabilities: {},
                        clientInfo: { name: 'auth-test', version: '0.0.0' }
                    }
                })
            });
            assert.notEqual(authorized.status, 401);
        } finally {
            await close();
            await new Promise((resolve, reject) => {
                server.close(err => (err ? reject(err) : resolve()));
            });
        }
    });
});
