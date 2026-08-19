const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const express = require('express');

const { LOCAL_API_PREFIX, createLocalGenerationRouter } = require('../localGenerationApi');

/**
 * Create a test-owned directory inside the repository and remove it after the test.
 *
 * @param {import('node:test').TestContext} context - Active Node test context.
 * @returns {string} Absolute fixture directory path.
 */
function createFixtureDirectory(context) {
    const fixtureDirectory = path.join(
        __dirname,
        '.tmp-local-generation-api',
        `${Date.now()}-${Math.random().toString(36).slice(2)}`
    );

    fs.mkdirSync(fixtureDirectory, { recursive: true });
    context.after(() => {
        fs.rmSync(fixtureDirectory, { recursive: true, force: true });

        try {
            fs.rmdirSync(path.dirname(fixtureDirectory));
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') {
                throw error;
            }
        }
    });

    return fixtureDirectory;
}

/**
 * Start a minimal Express server around the production router for one test.
 *
 * @param {import('node:test').TestContext} context - Active Node test context.
 * @param {object} options - Router dependencies overridden by the test.
 * @returns {Promise<string>} Base URL of the listening server.
 */
async function startTestServer(context, options) {
    const application = express();

    application.use(express.json());
    application.use(LOCAL_API_PREFIX, createLocalGenerationRouter({
        generate: options.generate,
        tempDir: options.tempDir,
        getToken: options.getToken || (() => 'test-local-token'),
        getProvidersConfig: options.getProvidersConfig
    }));

    const server = await new Promise(resolve => {
        const listeningServer = application.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });

    context.after(async () => {
        await new Promise((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()));
        });
    });

    return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Start a generation through the public API using the test server's default token.
 *
 * @param {string} baseUrl - Origin of the test server.
 * @param {object} body - Generation request body.
 * @returns {Promise<{response: Response, body: object}>} Raw response and JSON body.
 */
async function startGeneration(baseUrl, body) {
    const response = await fetch(`${baseUrl}${LOCAL_API_PREFIX}/generations`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': 'test-local-token'
        },
        body: JSON.stringify(body)
    });

    return { response, body: await response.json() };
}

/**
 * Poll a generation until it reaches a terminal state.
 *
 * @param {string} statusUrl - Absolute generation status URL.
 * @returns {Promise<object>} Terminal generation representation.
 */
async function waitForTerminalGeneration(statusUrl) {
    const deadline = Date.now() + 2000;
    let generation = null;

    while (Date.now() < deadline) {
        const response = await fetch(statusUrl, { headers: { 'x-api-key': 'test-local-token' } });
        assert.equal(response.status, 200);
        generation = await response.json();

        if (generation.status === 'completed' || generation.status === 'failed') {
            return generation;
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.fail(`Generation did not reach a terminal state: ${JSON.stringify(generation)}`);
}

test('a self-contained generation runs to completion and reports an absolute output path', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    const sourcePath = path.join(fixtureDirectory, 'source.png');
    fs.writeFileSync(sourcePath, 'source fixture');

    const baseUrl = await startTestServer(context, {
        tempDir: fixtureDirectory,
        generate: async (input, providerId) => {
            const outputFilename = `${providerId}.png`;
            fs.writeFileSync(path.join(fixtureDirectory, outputFilename), `${providerId} output`);
            return [{ status: 'done', image: `/api/webhelper/file/${outputFilename}` }];
        }
    });

    const started = await startGeneration(baseUrl, {
        providerId: 'test-provider',
        sourceImagePath: sourcePath,
        params: { prompt: 'A test prompt' }
    });

    assert.equal(started.response.status, 202);
    assert.equal(started.body.status, 'queued');
    assert.equal(started.response.headers.get('location'), started.body.statusUrl);

    const generation = await waitForTerminalGeneration(`${baseUrl}${started.body.statusUrl}`);
    assert.equal(generation.status, 'completed');
    assert.deepEqual(generation.outputPaths, [path.resolve(fixtureDirectory, 'test-provider.png')]);
});

test('a request without a providerId is rejected before any generation runs', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    let generationCalls = 0;

    const baseUrl = await startTestServer(context, {
        tempDir: fixtureDirectory,
        generate: async () => {
            generationCalls += 1;
            return [];
        }
    });

    const started = await startGeneration(baseUrl, { aspect_ratio: '1:1' });

    assert.equal(started.response.status, 400);
    assert.match(started.body.error, /providerId/);
    assert.equal(generationCalls, 0);
});

test('a relative source path is rejected before any generation runs', async context => {
    const fixtureDirectory = createFixtureDirectory(context);

    const baseUrl = await startTestServer(context, {
        tempDir: fixtureDirectory,
        generate: async () => []
    });

    const started = await startGeneration(baseUrl, {
        providerId: 'test-provider',
        sourceImagePath: 'relative/source.png'
    });

    assert.equal(started.response.status, 400);
    assert.match(started.body.error, /absolute file path/);
});

test('the shared token is mandatory: absent or wrong credentials are rejected, correct ones pass', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    const sourcePath = path.join(fixtureDirectory, 'source.png');
    fs.writeFileSync(sourcePath, 'source fixture');

    // The authorized request below is accepted and then fails during background
    // generation, which logs through the production error path by design.
    context.mock.method(console, 'error', () => {});

    const application = express();
    application.use(express.json());
    application.use(LOCAL_API_PREFIX, createLocalGenerationRouter({
        generate: async () => [],
        tempDir: fixtureDirectory,
        getToken: () => 'the-real-token'
    }));
    const server = await new Promise(resolve => {
        const listeningServer = application.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    context.after(() => new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
    }));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const noToken = await fetch(`${baseUrl}${LOCAL_API_PREFIX}/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'p', sourceImagePath: sourcePath })
    });
    assert.equal(noToken.status, 401, 'no token must never be treated as authorized, unlike the old optional mode');

    const wrongToken = await fetch(`${baseUrl}${LOCAL_API_PREFIX}/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
        body: JSON.stringify({ providerId: 'p', sourceImagePath: sourcePath })
    });
    assert.equal(wrongToken.status, 401);

    const rightToken = await fetch(`${baseUrl}${LOCAL_API_PREFIX}/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer the-real-token' },
        body: JSON.stringify({ providerId: 'p', sourceImagePath: sourcePath })
    });
    assert.equal(rightToken.status, 202);
});

test('an unknown generationId returns 404 rather than exposing another caller state', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    const baseUrl = await startTestServer(context, {
        tempDir: fixtureDirectory,
        generate: async () => []
    });

    const response = await fetch(`${baseUrl}${LOCAL_API_PREFIX}/generations/does-not-exist`, {
        headers: { 'x-api-key': 'test-local-token' }
    });
    assert.equal(response.status, 404);
});

test('a background provider failure is reported on the generation without crashing the server', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    const sourcePath = path.join(fixtureDirectory, 'source.png');
    fs.writeFileSync(sourcePath, 'source fixture');

    // This test deliberately triggers the production error-logging path.
    context.mock.method(console, 'error', () => {});

    const baseUrl = await startTestServer(context, {
        tempDir: fixtureDirectory,
        generate: async () => {
            throw new Error('Provider unavailable');
        }
    });

    const started = await startGeneration(baseUrl, {
        providerId: 'test-provider',
        sourceImagePath: sourcePath
    });
    assert.equal(started.response.status, 202);

    const generation = await waitForTerminalGeneration(`${baseUrl}${started.body.statusUrl}`);
    assert.equal(generation.status, 'failed');
    assert.equal(generation.error, 'Provider unavailable');
    assert.deepEqual(generation.outputPaths, []);
});

test('an inline provider runs to completion, passes the provider object, and returns providerSnapshot in status', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    const inlineProvider = {
        id: 'custom-inline-provider',
        generation_modes: ['t2i'],
        image_format: 'url',
        request_config: {
            endpoint_url: 'https://example.com/api/generate',
            method: 'POST'
        },
        response_config: {
            $ref: 'sync'
        }
    };

    let receivedProviderArg = null;

    const baseUrl = await startTestServer(context, {
        tempDir: fixtureDirectory,
        getProvidersConfig: () => ({
            response_handlers: { sync: { type: 'sync' } },
            providers: []
        }),
        generate: async (input, providerIdOrObject) => {
            receivedProviderArg = providerIdOrObject;
            const outputFilename = 'inline-output.png';
            fs.writeFileSync(path.join(fixtureDirectory, outputFilename), 'inline output data');
            return [{ status: 'done', image: `/api/webhelper/file/${outputFilename}` }];
        }
    });

    const started = await startGeneration(baseUrl, {
        provider: inlineProvider,
        aspect_ratio: '1:1',
        params: { prompt: 'A test prompt for inline provider' }
    });

    assert.equal(started.response.status, 202);
    assert.equal(started.body.status, 'queued');

    const generation = await waitForTerminalGeneration(`${baseUrl}${started.body.statusUrl}`);
    assert.equal(generation.status, 'completed');
    assert.equal(generation.providerId, 'custom-inline-provider');
    assert.deepEqual(generation.providerSnapshot, inlineProvider);
    assert.deepEqual(generation.outputPaths, [path.resolve(fixtureDirectory, 'inline-output.png')]);
    assert.deepEqual(receivedProviderArg, inlineProvider);
});

test('a request specifying both providerId and provider is rejected with 400', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    let generationCalls = 0;

    const baseUrl = await startTestServer(context, {
        tempDir: fixtureDirectory,
        generate: async () => {
            generationCalls += 1;
            return [];
        }
    });

    const started = await startGeneration(baseUrl, {
        providerId: 'existing-provider',
        provider: {
            generation_modes: ['t2i'],
            image_format: 'url',
            request_config: {},
            response_config: { $ref: 'sync' }
        },
        aspect_ratio: '1:1'
    });

    assert.equal(started.response.status, 400);
    assert.match(started.body.error, /Cannot specify both "providerId" and "provider"/);
    assert.equal(generationCalls, 0);
});

test('a request with neither providerId nor provider is rejected with 400', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    let generationCalls = 0;

    const baseUrl = await startTestServer(context, {
        tempDir: fixtureDirectory,
        generate: async () => {
            generationCalls += 1;
            return [];
        }
    });

    const started = await startGeneration(baseUrl, { aspect_ratio: '1:1' });

    assert.equal(started.response.status, 400);
    assert.match(started.body.error, /Either "providerId" or "provider" is required/);
    assert.equal(generationCalls, 0);
});

test('an inline provider with invalid or missing schema fields is rejected with 400', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    const baseUrl = await startTestServer(context, {
        tempDir: fixtureDirectory,
        generate: async () => []
    });

    // Not an object
    const notAnObject = await startGeneration(baseUrl, { provider: 'not-an-object', aspect_ratio: '1:1' });
    assert.equal(notAnObject.response.status, 400);
    assert.match(notAnObject.body.error, /"provider" must be a JSON object/);

    // Missing generation_modes
    const missingModes = await startGeneration(baseUrl, {
        provider: { image_format: 'url', request_config: {}, response_config: { $ref: 'sync' } },
        aspect_ratio: '1:1'
    });
    assert.equal(missingModes.response.status, 400);
    assert.match(missingModes.body.error, /generation_modes/);

    // Unsupported generation mode
    const unsupportedModes = await startGeneration(baseUrl, {
        provider: { generation_modes: ['video'], image_format: 'url', request_config: {}, response_config: { $ref: 'sync' } },
        aspect_ratio: '1:1'
    });
    assert.equal(unsupportedModes.response.status, 400);
    assert.match(unsupportedModes.body.error, /unsupported modes/);

    // Missing image_format
    const missingFormat = await startGeneration(baseUrl, {
        provider: { generation_modes: ['t2i'], request_config: {}, response_config: { $ref: 'sync' } },
        aspect_ratio: '1:1'
    });
    assert.equal(missingFormat.response.status, 400);
    assert.match(missingFormat.body.error, /image_format/);

    // Missing request_config
    const missingReqConfig = await startGeneration(baseUrl, {
        provider: { generation_modes: ['t2i'], image_format: 'url', response_config: { $ref: 'sync' } },
        aspect_ratio: '1:1'
    });
    assert.equal(missingReqConfig.response.status, 400);
    assert.match(missingReqConfig.body.error, /request_config/);

    // Missing response_config
    const missingRespConfig = await startGeneration(baseUrl, {
        provider: { generation_modes: ['t2i'], image_format: 'url', request_config: {} },
        aspect_ratio: '1:1'
    });
    assert.equal(missingRespConfig.response.status, 400);
    assert.match(missingRespConfig.body.error, /response_config/);

    // Missing $ref
    const missingRef = await startGeneration(baseUrl, {
        provider: { generation_modes: ['t2i'], image_format: 'url', request_config: {}, response_config: {} },
        aspect_ratio: '1:1'
    });
    assert.equal(missingRef.response.status, 400);
    assert.match(missingRef.body.error, /\$ref/);
});

test('an inline provider with unknown response handler $ref is rejected with 400', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    const baseUrl = await startTestServer(context, {
        tempDir: fixtureDirectory,
        getProvidersConfig: () => ({
            response_handlers: { replicate: { type: 'async_poll' } },
            providers: []
        }),
        generate: async () => []
    });

    const unknownRef = await startGeneration(baseUrl, {
        provider: {
            generation_modes: ['t2i'],
            image_format: 'url',
            request_config: {},
            response_config: { $ref: 'non_existent_handler' }
        },
        aspect_ratio: '1:1'
    });

    assert.equal(unknownRef.response.status, 400);
    assert.match(unknownRef.body.error, /Unknown response handler "non_existent_handler"/);
});
