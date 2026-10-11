'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const crypto = require('node:crypto');

const {
    CLI_IMAGE_PROVIDER_ID,
    CLI_SCRATCH_DIRNAME,
    INTERNAL_AUTH_HEADER,
    CliScratchSpace,
    getEligibleCliOptions,
    buildCliImageProvider,
    buildCliImagePrompt,
    extractFirstJsonObject,
    classifyCliError,
    collectCliImageOutputs,
    createCliImageRouter,
    createFilePathReferenceSaver
} = require('../agent/cli-image-provider');
const {
    generate,
    formatReferenceImage,
    requireTextToImageAspectRatio
} = require('../apiGenerator');
const { downloadAndSaveImages } = require('../apiGeneratorResultsGetter');

// A small valid PNG keeps the tests independent from Electron's nativeImage module.
const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);
const ONE_PIXEL_DATA_URI = `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`;

/**
 * Create one test-owned temp root inside the repository and remove it after the test.
 * Keeping fixtures in the workspace avoids relying on machine-specific OS temp policies.
 *
 * @param {import('node:test').TestContext} context - Active test context.
 * @returns {string} Absolute fixture directory.
 */
function createFixtureDirectory(context) {
    const directory = path.join(
        __dirname,
        '.tmp-cli-image-provider',
        `${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(directory, { recursive: true });
    context.after(() => {
        fs.rmSync(directory, { recursive: true, force: true });
        try {
            fs.rmdirSync(path.dirname(directory));
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
        }
    });
    return directory;
}

/**
 * Return a complete eligible CLI settings record with small per-test overrides.
 *
 * @param {object} overrides - Values merged into the base record.
 * @returns {object} CLI config record.
 */
function eligibleCli(overrides = {}) {
    return {
        installed: true,
        enabled: true,
        nativeImageGen: true,
        tiers: {
            light: { model: 'light-model', effort: 'low' },
            medium: { model: 'medium-model', effort: 'medium' },
            high: { model: 'high-model', effort: 'high' }
        },
        ...overrides
    };
}

/**
 * Start one run through the private endpoint and follow its status route to the end.
 *
 * @param {string} generateUrl - URL of the submit route.
 * @param {object} body - Submit request body.
 * @param {string} [key='test-secret'] - Internal key sent with every request.
 * @returns {Promise<{submitted: Response, accepted: object, state: object|null}>} The submit
 *     response, its body, and the final run state (null when the run was not accepted).
 */
async function runThroughEndpoint(generateUrl, body, key = 'test-secret') {
    const headers = { 'content-type': 'application/json', [INTERNAL_AUTH_HEADER]: key };
    const submitted = await fetch(generateUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    const accepted = await submitted.json();
    if (submitted.status !== 202) return { submitted, accepted, state: null };

    for (let attempt = 0; attempt < 400; attempt += 1) {
        const state = await (await fetch(accepted.status_url, { headers })).json();
        if (state.status !== 'running') return { submitted, accepted, state };
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('The CLI run did not finish in time.');
}

/**
 * Serve the private endpoint on a free loopback port for the duration of one test.
 *
 * @param {import('node:test').TestContext} context - Active test context.
 * @param {object} routerOptions - Options for createCliImageRouter().
 * @returns {Promise<string>} URL of the submit route.
 */
async function serveCliImageEndpoint(context, routerOptions) {
    const application = express();
    application.use(express.json({ limit: '2mb' }));
    application.use('/api/internal/cli-image', createCliImageRouter(routerOptions));

    const server = await new Promise(resolve => {
        const listeningServer = application.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    context.after(async () => {
        await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    });
    return `http://127.0.0.1:${server.address().port}/api/internal/cli-image/generate`;
}

test('only installed, enabled native-image CLIs with a Medium model are offered', () => {
    const options = getEligibleCliOptions({
        codex: eligibleCli(),
        grok: eligibleCli({ enabled: false }),
        agy: eligibleCli({ tiers: { medium: { model: '', effort: 'high' } } }),
        claude: eligibleCli({ nativeImageGen: false })
    });

    assert.deepEqual(options, [{ value: 'codex', label: 'OpenAI Codex' }]);
});

test('the strict CLI instruction keeps the user prompt as an exact JSON string', () => {
    const userPrompt = '  A "quoted" prompt\nwith a second line.  ';
    const prompt = buildCliImagePrompt({
        prompt: userPrompt,
        doNotChangePrompt: true,
        numImages: 2,
        aspectRatio: '',
        sourcePath: 'C:\\temp\\source.png',
        referencePaths: ['C:\\temp\\reference.png'],
        outputDir: 'C:\\temp\\output'
    });

    assert.ok(prompt.includes(`prompt_json: ${JSON.stringify(userPrompt)}`));
    assert.match(prompt, /pass that exact string verbatim/i);
    assert.match(prompt, /requested_image_count: 2/);
    assert.ok(!prompt.includes('aspect_ratio:'));
});

test('buildCliImagePrompt requests final_prompt in output schema', () => {
    const prompt = buildCliImagePrompt({
        prompt: 'test prompt',
        numImages: 1
    });

    assert.match(prompt, /"final_prompt":"EXACT_PROMPT_SENT_TO_IMAGE_GENERATION_TOOL"/);
    assert.match(prompt, /exact prompt sent to the image generation tool/i);
});

test('JSON extraction tolerates noise and braces inside a message', () => {
    const parsed = extractFirstJsonObject(
        'startup noise\n```json\n{"status":"error","error":{"message":"bad } value"}}\n```'
    );

    assert.equal(parsed.status, 'error');
    assert.equal(parsed.error.message, 'bad } value');
});

test('output collection accepts outside images without copying when OUTPUT_DIRECTORY_REQUIRED is false', (t) => {
    const tempDir = createFixtureDirectory(t);
    const outputDir = path.join(tempDir, 'output');
    fs.mkdirSync(outputDir);
    const first = path.join(outputDir, 'first.png');
    const second = path.join(outputDir, 'nested', 'second.png');
    const outside = path.join(tempDir, 'outside.png');
    fs.mkdirSync(path.dirname(second));
    fs.writeFileSync(first, ONE_PIXEL_PNG);
    fs.writeFileSync(second, ONE_PIXEL_PNG);
    fs.writeFileSync(outside, ONE_PIXEL_PNG);

    const result = collectCliImageOutputs({
        ok: true,
        text: JSON.stringify({
            status: 'done',
            images: [{ path: first }, { path: outside }]
        })
    }, outputDir);

    assert.equal(result.length, 3);
    assert.ok(result.includes(fs.realpathSync(first)));
    assert.ok(result.includes(fs.realpathSync(second)));
    assert.ok(result.includes(fs.realpathSync(outside)));
});

test('CLI failures receive stable moderation, aspect, quota, and timeout codes', () => {
    assert.equal(classifyCliError('Prompt blocked by safety policy'), 'moderation');
    assert.equal(classifyCliError('Unsupported aspect ratio'), 'invalid_aspect_ratio');
    assert.equal(classifyCliError('Usage quota exhausted'), 'quota_exhausted');
    assert.equal(classifyCliError('Request timed out'), 'timeout');
    assert.equal(classifyCliError('Something else failed'), 'generation_failed');
});

test('identical reference bytes are stored once, by sha256, inside the CLI scratch directory', (t) => {
    const tempDir = createFixtureDirectory(t);
    const saver = createFilePathReferenceSaver(tempDir);
    const first = formatReferenceImage(ONE_PIXEL_DATA_URI, 0, 'file_path', value => value, saver);
    const second = formatReferenceImage(ONE_PIXEL_DATA_URI, 1, 'file_path', value => value, saver);
    const hash = crypto.createHash('sha256').update(ONE_PIXEL_PNG).digest('hex');

    assert.equal(first, second);
    assert.deepEqual(fs.readFileSync(first), ONE_PIXEL_PNG);
    assert.equal(path.basename(first), `${hash}.png`);
    assert.equal(
        path.resolve(path.dirname(first)),
        path.resolve(tempDir, CLI_SCRATCH_DIRNAME, 'references')
    );
    assert.deepEqual(fs.readdirSync(path.dirname(first)), [`${hash}.png`]);
});

test('scratch placement creates nothing until references or a required output directory need it', (t) => {
    const tempDir = createFixtureDirectory(t);
    const scratch = new CliScratchSpace(tempDir);

    const idle = scratch.placeRun({
        runId: 'idle',
        outputDirectoryRequired: false,
        hasAdditionalReferences: false
    });
    assert.equal(idle.usesScratch, false);
    assert.equal(idle.outputDir, null);
    assert.equal(idle.cwd, tempDir);
    assert.equal(fs.existsSync(path.join(tempDir, CLI_SCRATCH_DIRNAME)), false);

    const withReferences = scratch.placeRun({
        runId: 'refs',
        outputDirectoryRequired: false,
        hasAdditionalReferences: true
    });
    assert.equal(withReferences.usesScratch, true);
    assert.equal(withReferences.outputDir, null);
    assert.equal(path.resolve(withReferences.cwd), path.resolve(tempDir, CLI_SCRATCH_DIRNAME));
    assert.equal(fs.existsSync(path.join(tempDir, CLI_SCRATCH_DIRNAME, 'runs')), false);
    assert.equal(fs.existsSync(path.join(tempDir, CLI_SCRATCH_DIRNAME, 'references')), false);

    const withOutput = scratch.placeRun({
        runId: 'out',
        outputDirectoryRequired: true,
        hasAdditionalReferences: true
    });
    assert.equal(withOutput.usesScratch, true);
    assert.equal(path.resolve(withOutput.cwd), path.resolve(tempDir, CLI_SCRATCH_DIRNAME));
    assert.equal(path.basename(withOutput.outputDir), 'cli-image-out');
    assert.equal(path.basename(path.dirname(withOutput.outputDir)), 'runs');
    assert.ok(fs.existsSync(withOutput.outputDir));
});

test('an empty T2I aspect ratio is optional only when the provider opts in', () => {
    assert.throws(
        () => requireTextToImageAspectRatio('', null, null, []),
        /aspect_ratio.*required/
    );
    assert.doesNotThrow(
        () => requireTextToImageAspectRatio('', null, null, [], true)
    );
});

test('an existing reference file makes the scratch directory the cwd and is not copied', async (t) => {
    const tempDir = createFixtureDirectory(t);
    const referencePath = path.join(tempDir, 'already-on-disk.png');
    fs.writeFileSync(referencePath, ONE_PIXEL_PNG);

    let observedCwd = null;
    let observedPrompt = '';
    const application = express();
    application.use(express.json());
    application.use('/api/internal/cli-image', createCliImageRouter({
        tempDir,
        internalKey: 'test-secret',
        getCliConfig: async () => ({ codex: eligibleCli() }),
        runWithSelectedCli: async (_cli, prompt, _tier, options) => {
            observedCwd = options.cwd;
            observedPrompt = prompt;
            const imagePath = path.join(options.cwd, 'made.png');
            fs.writeFileSync(imagePath, ONE_PIXEL_PNG);
            return {
                ok: true,
                text: JSON.stringify({ status: 'done', images: [{ path: imagePath }] })
            };
        }
    }));

    const server = await new Promise(resolve => {
        const listeningServer = application.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    t.after(async () => {
        await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    });

    const { submitted, state } = await runThroughEndpoint(
        `http://127.0.0.1:${server.address().port}/api/internal/cli-image/generate`,
        {
            cli: 'codex',
            prompt: 'Use the reference.',
            num_images: 1,
            reference_image_paths: [referencePath]
        }
    );

    assert.equal(submitted.status, 202);
    assert.equal(state.status, 'done');
    assert.equal(state.images.length, 1);
    assert.equal(path.resolve(observedCwd), path.resolve(tempDir, CLI_SCRATCH_DIRNAME));
    assert.equal(fs.existsSync(path.join(tempDir, CLI_SCRATCH_DIRNAME, 'references')), false);
    assert.equal(fs.existsSync(path.join(tempDir, CLI_SCRATCH_DIRNAME, 'runs')), false);
    assert.ok(observedPrompt.includes(JSON.stringify(fs.realpathSync(referencePath))));
    assert.doesNotMatch(observedPrompt, /output_directory/);
});

test('router enforces per-CLI reference limits and aspect ratios', async (t) => {
    const tempDir = createFixtureDirectory(t);
    const application = express();
    application.use(express.json());
    application.use('/api/internal/cli-image', createCliImageRouter({
        tempDir,
        internalKey: 'test-secret',
        getCliConfig: async () => ({
            codex: eligibleCli(),
            grok: eligibleCli(),
            agy: eligibleCli()
        }),
        runWithSelectedCli: async () => ({ ok: true, text: '{"status":"done","images":[]}' })
    }));

    const server = await new Promise(resolve => {
        const listeningServer = application.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    t.after(async () => {
        await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    });
    const url = `http://127.0.0.1:${server.address().port}/api/internal/cli-image/generate`;

    // 4 references for agy (limit is 3) -> 400
    const agyTooMany = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [INTERNAL_AUTH_HEADER]: 'test-secret' },
        body: JSON.stringify({
            cli: 'agy',
            prompt: 'Test',
            num_images: 1,
            reference_image_paths: ['ref1.png', 'ref2.png', 'ref3.png', 'ref4.png']
        })
    });
    assert.equal(agyTooMany.status, 400);
    const agyBody = await agyTooMany.json();
    assert.equal(agyBody.error.code, 'too_many_references');

    // 4:3 ratio for grok (not supported) -> 400
    const grokBadRatio = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [INTERNAL_AUTH_HEADER]: 'test-secret' },
        body: JSON.stringify({
            cli: 'grok',
            prompt: 'Test',
            num_images: 1,
            aspect_ratio: '4:3',
            reference_image_paths: []
        })
    });
    assert.equal(grokBadRatio.status, 400);
    const grokBody = await grokBadRatio.json();
    assert.equal(grokBody.error.code, 'invalid_aspect_ratio');
});

test('file_path results are copied into the normal WebHelper result location', async (t) => {
    const tempDir = createFixtureDirectory(t);
    const runOutput = path.join(tempDir, 'cli-image-test', 'output');
    fs.mkdirSync(runOutput, { recursive: true });
    const sourcePath = path.join(runOutput, 'generated.png');
    fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);

    const results = await downloadAndSaveImages(
        [sourcePath],
        { format: 'file_path' },
        null,
        tempDir,
        'task-test',
        'cli_codex_t2i',
        { images: [sourcePath] }
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'done');
    assert.match(results[0].image, /^\/api\/webhelper\/file\/generated\/generated_image_/);
    const copiedPath = path.join(tempDir, '_WH_Generated', path.basename(results[0].image));
    assert.ok(fs.existsSync(copiedPath));
    assert.equal(path.dirname(copiedPath), path.join(tempDir, '_WH_Generated'));
    assert.notEqual(fs.realpathSync(copiedPath), fs.realpathSync(sourcePath));
});

test('file_path results located outside tempDir are accepted and copied into the normal WebHelper result location', async (t) => {
    const tempDir = createFixtureDirectory(t);
    const outsideDir = createFixtureDirectory(t);
    const sourcePath = path.join(outsideDir, 'agent-generated.png');
    fs.writeFileSync(sourcePath, ONE_PIXEL_PNG);

    const results = await downloadAndSaveImages(
        [sourcePath],
        { format: 'file_path' },
        null,
        tempDir,
        'task-outside-test',
        'cli_agy_t2i',
        { images: [sourcePath] }
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'done');
    assert.match(results[0].image, /^\/api\/webhelper\/file\/generated\/generated_image_/);
    const copiedPath = path.join(tempDir, '_WH_Generated', path.basename(results[0].image));
    assert.ok(fs.existsSync(copiedPath));
    assert.equal(path.dirname(copiedPath), path.join(tempDir, '_WH_Generated'));
    assert.notEqual(fs.realpathSync(copiedPath), fs.realpathSync(sourcePath));
});

test('the existing generator runs the virtual provider end to end with a binary reference', async (t) => {
    const tempDir = createFixtureDirectory(t);
    let observedPrompt = '';
    const application = express();
    application.use(express.json({ limit: '2mb' }));
    application.use('/api/internal/cli-image', createCliImageRouter({
        tempDir,
        internalKey: 'integration-secret',
        getCliConfig: async () => ({ codex: eligibleCli() }),
        runWithSelectedCli: async (_cli, prompt, tier, options) => {
            assert.equal(tier, 'medium');
            observedPrompt = prompt;
            const outputPath = path.join(options.cwd, 'result.png');
            fs.writeFileSync(outputPath, ONE_PIXEL_PNG);
            return {
                ok: true,
                text: JSON.stringify({ status: 'done', images: [{ path: outputPath }] })
            };
        }
    }));

    const server = await new Promise(resolve => {
        const listeningServer = application.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    t.after(async () => {
        await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    });

    const provider = buildCliImageProvider(
        { codex: eligibleCli() },
        {
            endpointUrl: `http://127.0.0.1:${server.address().port}/api/internal/cli-image/generate`,
            internalKey: 'integration-secret',
            pollIntervalMs: 10
        }
    );
    const results = await generate(
        {},
        provider,
        1,
        '',
        {
            cli: 'codex',
            prompt: 'Use the reference.',
            do_not_change_prompt: false
        },
        [ONE_PIXEL_DATA_URI],
        false,
        false,
        tempDir,
        {}
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'done');
    assert.equal(results[0].providerId, CLI_IMAGE_PROVIDER_ID);
    assert.match(observedPrompt, /primary_source_image: ".*_WH_CliScratch[\\/]+references[\\/]+[a-f0-9]{64}\.png"/);
    assert.match(results[0].image, /^\/api\/webhelper\/file\/generated\/generated_image_/);
    const finalResultPath = path.join(tempDir, '_WH_Generated', path.basename(results[0].image));
    assert.ok(fs.existsSync(finalResultPath));
    assert.ok(fs.existsSync(finalResultPath.replace(/\.png$/, '.json')));
    const referenceFiles = fs.readdirSync(path.join(tempDir, CLI_SCRATCH_DIRNAME, 'references'));
    assert.equal(referenceFiles.length, 1);
});

test('the private endpoint returns the agent transcript and passes the window setting on', async (t) => {
    const tempDir = createFixtureDirectory(t);
    const seen = [];
    let failNext = false;
    const application = express();
    application.use(express.json());
    application.use('/api/internal/cli-image', createCliImageRouter({
        tempDir,
        internalKey: 'test-secret',
        getCliConfig: async () => ({ codex: eligibleCli() }),
        runWithSelectedCli: async (_cli, _prompt, _tier, options) => {
            seen.push(options);
            if (failNext) {
                return {
                    ok: true,
                    text: 'I could not make the picture.',
                    transcript: '[thinking] The request was refused.\n'
                };
            }
            const imagePath = path.join(options.cwd, 'made.png');
            fs.writeFileSync(imagePath, ONE_PIXEL_PNG);
            return {
                ok: true,
                text: JSON.stringify({ status: 'done', images: [{ path: imagePath }] }),
                transcript: '[thinking] Plan the picture.\n[agent] Done.\n'
            };
        }
    }));
    const server = await new Promise(resolve => {
        const listeningServer = application.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    t.after(async () => {
        await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    });
    const url = `http://127.0.0.1:${server.address().port}/api/internal/cli-image/generate`;
    const run = (extra) => runThroughEndpoint(
        url,
        { cli: 'codex', prompt: 'A fox.', num_images: 1, ...extra }
    );

    const hidden = await run({});
    assert.equal(hidden.submitted.status, 202);
    assert.equal(hidden.state.status, 'done');
    assert.equal(hidden.state.cli_transcript, '[thinking] Plan the picture.\n[agent] Done.\n');
    assert.equal(seen[0].showWindow, false, 'the window is off unless the request asks for it');
    assert.equal(seen[0].reasoningSummary, 'detailed');

    const shown = await run({ show_cli_window: true });
    assert.equal(shown.state.status, 'done');
    assert.equal(seen[1].showWindow, true);

    failNext = true;
    const failed = await run({});
    assert.equal(failed.submitted.status, 202, 'a run that fails later is still accepted');
    assert.equal(failed.state.status, 'failed');
    assert.match(failed.state.error.message, /I could not make the picture/);
    assert.match(failed.state.error.message, /--- CLI transcript ---\n\[thinking\] The request was refused\.$/);
    assert.equal(failed.state.error.cli_transcript, undefined, 'the transcript travels inside the message');
});

test('the submit route answers while the CLI is still working', async (t) => {
    const tempDir = createFixtureDirectory(t);
    let finishCli = null;
    const url = await serveCliImageEndpoint(t, {
        tempDir,
        internalKey: 'test-secret',
        getCliConfig: async () => ({ codex: eligibleCli() }),
        runWithSelectedCli: (_cli, _prompt, _tier, options) => new Promise(resolve => {
            finishCli = () => {
                const imagePath = path.join(options.cwd, 'late.png');
                fs.writeFileSync(imagePath, ONE_PIXEL_PNG);
                resolve({ ok: true, text: JSON.stringify({ status: 'done', images: [{ path: imagePath }] }) });
            };
        })
    });
    const headers = { 'content-type': 'application/json', [INTERNAL_AUTH_HEADER]: 'test-secret' };

    const submitted = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cli: 'codex', prompt: 'A slow fox.', num_images: 1 })
    });
    const accepted = await submitted.json();
    assert.equal(submitted.status, 202);
    assert.equal(accepted.status, 'running');
    assert.equal(accepted.status_url, url.replace(/\/generate$/, `/runs/${accepted.run_id}`));

    const stillRunning = await (await fetch(accepted.status_url, { headers })).json();
    assert.deepEqual(stillRunning, { status: 'running' });

    finishCli();
    let finished = stillRunning;
    for (let attempt = 0; attempt < 400 && finished.status === 'running'; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
        finished = await (await fetch(accepted.status_url, { headers })).json();
    }
    assert.equal(finished.status, 'done');
    assert.equal(finished.images.length, 1);
});

test('the status route needs the internal key and keeps a finished run readable', async (t) => {
    const tempDir = createFixtureDirectory(t);
    const url = await serveCliImageEndpoint(t, {
        tempDir,
        internalKey: 'test-secret',
        getCliConfig: async () => ({ codex: eligibleCli() }),
        runWithSelectedCli: async (_cli, _prompt, _tier, options) => {
            const imagePath = path.join(options.cwd, 'made.png');
            fs.writeFileSync(imagePath, ONE_PIXEL_PNG);
            return { ok: true, text: JSON.stringify({ status: 'done', images: [{ path: imagePath }] }) };
        }
    });

    const { accepted, state } = await runThroughEndpoint(
        url,
        { cli: 'codex', prompt: 'A fox.', num_images: 1 }
    );
    assert.equal(state.status, 'done');

    const withoutKey = await fetch(accepted.status_url);
    assert.equal(withoutKey.status, 401);
    const wrongKey = await fetch(accepted.status_url, { headers: { [INTERNAL_AUTH_HEADER]: 'wrong' } });
    assert.equal(wrongKey.status, 401);

    const headers = { [INTERNAL_AUTH_HEADER]: 'test-secret' };
    const repeated = await fetch(accepted.status_url, { headers });
    assert.equal(repeated.status, 200, 'a repeated status request still finds the finished run');
    assert.deepEqual(await repeated.json(), state);

    const unknown = await fetch(accepted.status_url.replace(accepted.run_id, 'no-such-run'), { headers });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'unknown_run');
});

test('a finished run is forgotten once its retention time has passed', async (t) => {
    const tempDir = createFixtureDirectory(t);
    let finishCli = null;
    const url = await serveCliImageEndpoint(t, {
        tempDir,
        internalKey: 'test-secret',
        getCliConfig: async () => ({ codex: eligibleCli() }),
        runWithSelectedCli: () => new Promise(resolve => {
            finishCli = () => resolve({ ok: false, text: '', error: 'The CLI stopped.' });
        }),
        runRetentionMs: 20
    });
    const headers = { 'content-type': 'application/json', [INTERNAL_AUTH_HEADER]: 'test-secret' };

    const submitted = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cli: 'codex', prompt: 'A fox.', num_images: 1 })
    });
    const accepted = await submitted.json();

    // The retention clock starts only when the run ends, so a long run is never forgotten.
    await new Promise(resolve => setTimeout(resolve, 80));
    const whileRunning = await fetch(accepted.status_url, { headers });
    assert.equal(whileRunning.status, 200);
    assert.deepEqual(await whileRunning.json(), { status: 'running' });

    finishCli();
    let lastStatus = whileRunning.status;
    for (let attempt = 0; attempt < 1000 && lastStatus !== 404; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
        lastStatus = (await fetch(accepted.status_url, { headers })).status;
    }
    assert.equal(lastStatus, 404);
});

test('a CLI timeout reaches the generator as its own message, without a manual download link', async (t) => {
    const tempDir = createFixtureDirectory(t);
    const timeoutMessage = 'Query timed out after 20 minutes. The CLI did not finish in time.';
    const url = await serveCliImageEndpoint(t, {
        tempDir,
        internalKey: 'integration-secret',
        getCliConfig: async () => ({ codex: eligibleCli() }),
        runWithSelectedCli: async () => ({ ok: false, text: '', error: timeoutMessage })
    });
    const provider = buildCliImageProvider(
        { codex: eligibleCli() },
        { endpointUrl: url, internalKey: 'integration-secret', pollIntervalMs: 10 }
    );

    const results = await generate(
        {},
        provider,
        1,
        '1:1',
        { cli: 'codex', prompt: 'A fox.', do_not_change_prompt: false },
        [],
        false,
        false,
        tempDir,
        {}
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'error');
    assert.equal(results[0].error, `[timeout] ${timeoutMessage}`);
    assert.equal(results[0].fallback_url, undefined);
});

test('the CLI provider carries its own polling handler, which outlasts the CLI timeout', () => {
    const provider = buildCliImageProvider({ codex: eligibleCli() }, {
        endpointUrl: 'http://127.0.0.1:1/generate',
        internalKey: 'k'
    });
    const { handler } = provider.response_config;

    assert.equal(provider.response_config.$ref, undefined, 'no catalog handler is referenced');
    assert.equal(handler.type, 'async_poll');
    assert.ok(handler.polling.timeout_ms > 20 * 60 * 1000);
    assert.match(provider.remarks, /limited to 20 minutes/);
    assert.equal(handler.polling.use_request_headers, true);
    assert.equal(handler.polling.expose_fallback_url, false);
    assert.equal(handler.result.images.format, 'file_path');

    const tuned = buildCliImageProvider({ codex: eligibleCli() }, {
        endpointUrl: 'http://127.0.0.1:1/generate',
        internalKey: 'k',
        pollIntervalMs: 500,
        pollTimeoutMs: 9000
    });
    assert.equal(tuned.response_config.handler.polling.interval_ms, 500);
    assert.equal(tuned.response_config.handler.polling.timeout_ms, 9000);
});

test('the CLI provider offers the window as a boolean parameter that reaches the request', () => {
    const provider = buildCliImageProvider({ codex: eligibleCli() }, {
        endpointUrl: 'http://127.0.0.1:1/generate',
        internalKey: 'k'
    });
    const parameter = provider.parameters.find(entry => entry.name === 'show_cli_window');
    assert.equal(parameter.type, 'boolean');
    assert.equal(parameter.default, false);
    assert.equal(provider.request_config.body_template.show_cli_window, '{{show_cli_window}}');
});
