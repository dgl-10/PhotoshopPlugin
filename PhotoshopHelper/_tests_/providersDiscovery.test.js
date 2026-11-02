'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { listClientProviders } = require('../providers-discovery');

const SAMPLE_CATALOG = {
    response_handlers: {},
    providers: [
        {
            id: 'openai_gpt_image',
            name: 'GPT Image',
            tags: { provider: 'openai', family: 'gpt-image' },
            request_config: { url: 'https://api.example.com', single_image_per_request: true },
            response_config: { handler: 'json' },
            image_format: 'png',
            filename_suffix: '_gpt',
            preprocessor: 'none'
        }
    ]
};

const SAMPLE_CLI_PROVIDER = {
    id: '__cli_native_image_gen__',
    name: 'CLI Agent',
    tags: { provider: 'cli', family: 'cli' },
    request_config: { url: 'http://127.0.0.1:18345/internal', single_image_per_request: false },
    response_config: { handler: { type: 'async_poll' } }
};

test('listClientProviders returns sanitized catalog and runtime CLI providers when healthy', async () => {
    const result = await listClientProviders({
        loadProvidersCatalog: () => SAMPLE_CATALOG,
        findMissingEnvKeys: () => [],
        getRuntimeCliImageProvider: async () => SAMPLE_CLI_PROVIDER
    });

    assert.deepEqual(result.map(p => p.id), ['openai_gpt_image', '__cli_native_image_gen__']);
    assert.equal(result[0].single_image_per_request, true);
    assert.equal(result[0].request_config, undefined);
});

test('listClientProviders still returns catalog providers when runtime CLI discovery fails', async () => {
    const result = await listClientProviders({
        loadProvidersCatalog: () => SAMPLE_CATALOG,
        findMissingEnvKeys: () => [],
        getRuntimeCliImageProvider: async () => {
            throw new Error('EBUSY: resource busy or locked, open user-settings.json');
        }
    });

    assert.deepEqual(result.map(p => p.id), ['openai_gpt_image']);
});

test('WebHelper api.loadProviders aborts a stalled /api/webhelper/providers request after 8000ms', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    const apiPath = path.join(__dirname, '..', 'webhelper', 'js', 'api.js');
    const source = fs.readFileSync(apiPath, 'utf8');
    const dataUrl = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
    const webhelperApi = await import(dataUrl);

    t.mock.method(globalThis, 'fetch', (_url, options = {}) => new Promise((_resolve, reject) => {
        if (options.signal) {
            options.signal.addEventListener('abort', () => {
                const abortErr = new Error('The operation was aborted.');
                abortErr.name = 'AbortError';
                reject(abortErr);
            }, { once: true });
        }
    }));

    const pending = webhelperApi.loadProviders();
    await Promise.resolve();
    t.mock.timers.tick(8000);

    await assert.rejects(pending, { name: 'AbortError' });
});
