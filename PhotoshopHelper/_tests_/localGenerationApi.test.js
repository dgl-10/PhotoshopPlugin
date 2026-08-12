const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const express = require('express');

const { resolveImageFilePath } = require('../apiGenerator');
const {
    LOCAL_API_PREFIX,
    createLocalGenerationRouter
} = require('../localGenerationApi');

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

        // Remove the shared fixture root when this was the last test using it. A
        // concurrent test may still own another child and will clean up afterward.
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
 * @returns {Promise<{baseUrl: string, tasks: object}>} Listening URL and task registry.
 */
async function startTestServer(context, options) {
    const application = express();
    const tasks = {};

    application.use(express.json());
    application.use(LOCAL_API_PREFIX, createLocalGenerationRouter({
        generate: options.generate,
        tasks,
        tempDir: options.tempDir,
        token: options.token || ''
    }));

    const server = await new Promise(resolve => {
        const listeningServer = application.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });

    context.after(async () => {
        await new Promise((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()));
        });
    });

    const address = server.address();
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        tasks
    };
}

/**
 * Create one reusable source/mask task through the public API.
 *
 * @param {string} baseUrl - Origin of the test server.
 * @param {object} body - Task request body.
 * @param {object} [headers={}] - Optional authentication headers.
 * @returns {Promise<{response: Response, task: object}>} Raw response and JSON body.
 */
async function createTask(baseUrl, body, headers = {}) {
    const response = await fetch(`${baseUrl}${LOCAL_API_PREFIX}/tasks`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...headers
        },
        body: JSON.stringify(body)
    });

    return {
        response,
        task: await response.json()
    };
}

/**
 * Poll one child generation until it reaches a terminal state.
 *
 * @param {string} statusUrl - Absolute generation status URL.
 * @param {object} [headers={}] - Optional authentication headers.
 * @returns {Promise<object>} Terminal generation representation.
 */
async function waitForTerminalGeneration(statusUrl, headers = {}) {
    const deadline = Date.now() + 2000;
    let generation = null;

    while (Date.now() < deadline) {
        const response = await fetch(statusUrl, { headers });
        assert.equal(response.status, 200);
        generation = await response.json();

        if (generation.status === 'completed' || generation.status === 'failed') {
            return generation;
        }

        await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.fail(`Generation did not reach a terminal state: ${JSON.stringify(generation)}`);
}

test('generation core resolves both WebHelper URLs and direct absolute paths', () => {
    const tempDirectory = path.resolve(__dirname, 'temporary-resolution-root');
    const absoluteImagePath = path.resolve(__dirname, 'external-source.png');

    assert.equal(
        resolveImageFilePath('/api/webhelper/file/task-source.png', tempDirectory),
        path.join(tempDirectory, 'task-source.png')
    );
    assert.equal(
        resolveImageFilePath(absoluteImagePath, tempDirectory),
        path.normalize(absoluteImagePath)
    );
    assert.equal(resolveImageFilePath(null, tempDirectory), null);
});

test('one task can run multiple independent generations without copying its inputs', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    const inputDirectory = path.join(fixtureDirectory, 'inputs');
    const outputDirectory = path.join(fixtureDirectory, 'outputs');
    const sourcePath = path.join(inputDirectory, 'source.png');
    const maskPath = path.join(inputDirectory, 'mask.png');
    const referencePath = path.join(inputDirectory, 'reference.png');
    const generatorCalls = [];

    fs.mkdirSync(inputDirectory, { recursive: true });
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(sourcePath, 'source fixture');
    fs.writeFileSync(maskPath, 'mask fixture');
    fs.writeFileSync(referencePath, 'reference fixture');

    const generate = async (...args) => {
        generatorCalls.push(args);
        const providerId = args[1];
        const outputFilename = `${providerId}.png`;
        fs.writeFileSync(path.join(outputDirectory, outputFilename), `${providerId} output`);
        return [{
            status: 'done',
            image: `/api/webhelper/file/${outputFilename}`
        }];
    };

    const { baseUrl } = await startTestServer(context, {
        generate,
        tempDir: outputDirectory
    });

    const created = await createTask(baseUrl, {
        sourceImagePath: sourcePath,
        maskImagePath: maskPath
    });

    assert.equal(created.response.status, 201);
    assert.equal(created.task.status, 'ready');
    assert.match(created.task.taskId, /^local_task_/);
    assert.equal(created.response.headers.get('location'), created.task.taskUrl);
    assert.deepEqual(fs.readdirSync(outputDirectory), []);

    const firstResponse = await fetch(`${baseUrl}${created.task.taskUrl}/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            providerId: 'provider-without-mask',
            use_mask: false,
            num_images: 1,
            params: { prompt: 'First prompt' }
        })
    });
    const firstAccepted = await firstResponse.json();

    const secondResponse = await fetch(`${baseUrl}${created.task.taskUrl}/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            providerId: 'provider-with-mask',
            use_mask: true,
            referenceImagePaths: [referencePath],
            params: { prompt: 'Second prompt' }
        })
    });
    const secondAccepted = await secondResponse.json();

    assert.equal(firstResponse.status, 202);
    assert.equal(secondResponse.status, 202);
    assert.notEqual(firstAccepted.generationId, secondAccepted.generationId);
    assert.equal(firstAccepted.taskId, created.task.taskId);
    assert.equal(secondAccepted.taskId, created.task.taskId);

    const firstGeneration = await waitForTerminalGeneration(`${baseUrl}${firstAccepted.statusUrl}`);
    const secondGeneration = await waitForTerminalGeneration(`${baseUrl}${secondAccepted.statusUrl}`);

    assert.equal(firstGeneration.status, 'completed');
    assert.equal(secondGeneration.status, 'completed');
    assert.deepEqual(firstGeneration.outputPaths, [
        path.resolve(outputDirectory, 'provider-without-mask.png')
    ]);
    assert.deepEqual(secondGeneration.outputPaths, [
        path.resolve(outputDirectory, 'provider-with-mask.png')
    ]);

    const taskResponse = await fetch(`${baseUrl}${created.task.taskUrl}`);
    const task = await taskResponse.json();
    assert.equal(taskResponse.status, 200);
    assert.equal(task.status, 'ready');
    assert.equal(task.sourceImagePath, path.normalize(sourcePath));
    assert.equal(task.maskImagePath, path.normalize(maskPath));
    assert.equal(task.generationCount, 2);
    assert.equal(task.generations.length, 2);

    const firstCall = generatorCalls.find(call => call[1] === 'provider-without-mask');
    const secondCall = generatorCalls.find(call => call[1] === 'provider-with-mask');

    // Both invocations use the same registered task and therefore the same retained
    // source/mask paths, but their use_mask flags and reference arrays remain local
    // to each independent generation object.
    assert.equal(firstCall[0], created.task.taskId);
    assert.equal(secondCall[0], created.task.taskId);
    assert.equal(firstCall[6], false);
    assert.equal(secondCall[6], true);
    assert.deepEqual(firstCall[5], []);
    assert.deepEqual(secondCall[5], [path.normalize(referencePath)]);
    assert.equal(firstCall[9][created.task.taskId].sourceImage, path.normalize(sourcePath));
    assert.equal(secondCall[9][created.task.taskId].maskImage, path.normalize(maskPath));
});

test('task creation rejects relative or missing source files', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    let generationCalls = 0;

    const { baseUrl, tasks } = await startTestServer(context, {
        tempDir: fixtureDirectory,
        generate: async () => {
            generationCalls += 1;
            return [];
        }
    });

    const created = await createTask(baseUrl, {
        sourceImagePath: 'relative/source.png'
    });

    assert.equal(created.response.status, 400);
    assert.match(created.task.error, /absolute file path/);
    assert.equal(generationCalls, 0);
    assert.deepEqual(tasks, {});
});

test('generation creation validates its parent task and reference paths', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    const sourcePath = path.join(fixtureDirectory, 'source.png');
    fs.writeFileSync(sourcePath, 'source fixture');

    const { baseUrl } = await startTestServer(context, {
        tempDir: fixtureDirectory,
        generate: async () => []
    });

    const missingTaskResponse = await fetch(
        `${baseUrl}${LOCAL_API_PREFIX}/tasks/missing/generations`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ providerId: 'test-provider' })
        }
    );
    assert.equal(missingTaskResponse.status, 404);

    const created = await createTask(baseUrl, { sourceImagePath: sourcePath });
    const invalidReferenceResponse = await fetch(`${baseUrl}${created.task.taskUrl}/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            providerId: 'test-provider',
            referenceImagePaths: ['relative-reference.png']
        })
    });

    assert.equal(invalidReferenceResponse.status, 400);
    assert.match((await invalidReferenceResponse.json()).error, /absolute file path/);

    const taskResponse = await fetch(`${baseUrl}${created.task.taskUrl}`);
    const task = await taskResponse.json();
    assert.equal(task.generationCount, 0);
});

test('configured token protects task and generation routes', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    const sourcePath = path.join(fixtureDirectory, 'source.png');
    const token = 'test-local-token';
    fs.writeFileSync(sourcePath, 'source fixture');

    const { baseUrl } = await startTestServer(context, {
        tempDir: fixtureDirectory,
        token,
        generate: async () => []
    });

    const unauthenticated = await createTask(baseUrl, { sourceImagePath: sourcePath });
    assert.equal(unauthenticated.response.status, 401);

    const headers = { authorization: `Bearer ${token}` };
    const authenticated = await createTask(baseUrl, { sourceImagePath: sourcePath }, headers);
    assert.equal(authenticated.response.status, 201);

    const protectedTaskResponse = await fetch(`${baseUrl}${authenticated.task.taskUrl}`);
    assert.equal(protectedTaskResponse.status, 401);

    const authenticatedTaskResponse = await fetch(`${baseUrl}${authenticated.task.taskUrl}`, { headers });
    assert.equal(authenticatedTaskResponse.status, 200);
});

test('background provider failures stay scoped to their generation', async context => {
    const fixtureDirectory = createFixtureDirectory(context);
    const sourcePath = path.join(fixtureDirectory, 'source.png');
    fs.writeFileSync(sourcePath, 'source fixture');

    // This test deliberately triggers the production error path. Silence its expected
    // diagnostic so the test runner output stays focused on unexpected failures.
    context.mock.method(console, 'error', () => {});

    const { baseUrl } = await startTestServer(context, {
        tempDir: fixtureDirectory,
        generate: async () => {
            throw new Error('Provider unavailable');
        }
    });

    const created = await createTask(baseUrl, { sourceImagePath: sourcePath });
    const generationResponse = await fetch(`${baseUrl}${created.task.taskUrl}/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'test-provider' })
    });
    const accepted = await generationResponse.json();
    const generation = await waitForTerminalGeneration(`${baseUrl}${accepted.statusUrl}`);

    assert.equal(generationResponse.status, 202);
    assert.equal(generation.status, 'failed');
    assert.deepEqual(generation.outputPaths, []);
    assert.equal(generation.error, 'Provider unavailable');

    // The reusable task remains ready, so the caller may retry with another provider
    // or parameter set without creating or copying the source task again.
    const taskResponse = await fetch(`${baseUrl}${created.task.taskUrl}`);
    const task = await taskResponse.json();
    assert.equal(task.status, 'ready');
    assert.equal(task.generationCount, 1);
    assert.equal(task.generations[0].status, 'failed');
});
