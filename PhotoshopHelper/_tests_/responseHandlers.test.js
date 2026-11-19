'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { waitForApiResult } = require('../apiGeneratorResultsGetter');

const SYNC_HANDLER = {
    type: 'sync',
    result: {
        source: 'submit_response',
        images: { format: '{{format}}', extract: ['{{extract}}'] }
    }
};

/**
 * Serve one fixed JSON answer on a free loopback port for the duration of one test.
 *
 * @param {import('node:test').TestContext} context - Active test context.
 * @param {object} answer - Body returned for every request.
 * @returns {Promise<string>} URL of the server.
 */
async function serveJson(context, answer) {
    const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise(resolve => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}/status`;
}

/**
 * Build a polling handler that reads its status URL from the submit response.
 *
 * @param {object} [pollingOverrides] - Values merged into the polling section.
 * @returns {object} Handler definition.
 */
function pollingHandler(pollingOverrides = {}) {
    return {
        type: 'async_poll',
        polling: {
            url_template: '{{status_url}}',
            variables_from_submit: { status_url: 'status_url' },
            method: 'GET',
            interval_ms: 5,
            timeout_ms: 2000,
            status: { path: 'status', in_progress: ['running'], completed: ['done'], failed: ['failed'] },
            error_path: 'error',
            ...pollingOverrides
        },
        result: {
            source: 'poll_response',
            images: { format: 'url', extract: [{ path: 'images', mode: 'array' }] }
        }
    };
}

test('a catalog handler is found through $ref', async () => {
    const result = await waitForApiResult(
        { images: ['https://example.test/a.png'] },
        { $ref: 'sync', params: { format: 'url', extract: [{ path: 'images', mode: 'array' }] } },
        { sync: SYNC_HANDLER },
        {}
    );

    assert.deepEqual(result.imageStrings, ['https://example.test/a.png']);
    assert.equal(result.imagesConfig.format, 'url');
});

test('a missing catalog handler is still reported by name', async () => {
    await assert.rejects(
        waitForApiResult({}, { $ref: 'absent' }, { sync: SYNC_HANDLER }, {}),
        /Response handler "absent" not found/
    );
});

test('a handler carried inside response_config needs no catalog entry', async (t) => {
    const statusUrl = await serveJson(t, { status: 'done', images: ['https://example.test/b.png'] });

    const result = await waitForApiResult(
        { status_url: statusUrl },
        { handler: pollingHandler() },
        {},
        {}
    );

    assert.deepEqual(result.imageStrings, ['https://example.test/b.png']);
    assert.equal(result.finalData.status, 'done');
});

test('a failed poll offers its URL as a manual link unless the handler opts out', async (t) => {
    const statusUrl = await serveJson(t, { status: 'failed', error: 'The job broke.' });

    await assert.rejects(
        waitForApiResult({ status_url: statusUrl }, { handler: pollingHandler() }, {}, {}),
        (error) => {
            assert.equal(error.message, 'The job broke.');
            assert.equal(error.fallback_url, statusUrl);
            return true;
        }
    );

    await assert.rejects(
        waitForApiResult(
            { status_url: statusUrl },
            { handler: pollingHandler({ expose_fallback_url: false }) },
            {},
            {}
        ),
        (error) => {
            assert.equal(error.message, 'The job broke.');
            assert.equal(error.fallback_url, undefined);
            return true;
        }
    );
});

test('sync error_paths selects the first non-empty match and falls back when none match', async () => {
    const responseConfig = {
        $ref: 'sync',
        params: {
            format: 'url',
            extract: [{ path: 'images', mode: 'array' }],
            error_paths: [
                'missing.field',
                'null_field',
                'blank_field',
                'empty_array',
                'empty_object',
                'primary_error',
                'secondary_error'
            ]
        }
    };

    await assert.rejects(
        waitForApiResult(
            {
                null_field: null,
                blank_field: '   \n\t  ',
                empty_array: [],
                empty_object: {},
                primary_error: '  Content blocked by policy.  ',
                secondary_error: 'Fallback error'
            },
            responseConfig,
            { sync: SYNC_HANDLER },
            {}
        ),
        { message: 'Content blocked by policy.' }
    );

    // When error_paths is configured but nothing matches, keep the default error message
    await assert.rejects(
        waitForApiResult(
            {
                null_field: null,
                blank_field: '   ',
                empty_array: [],
                empty_object: {}
            },
            responseConfig,
            { sync: SYNC_HANDLER },
            {}
        ),
        { message: 'Could not extract image data from provider response.' }
    );

    // Confirm base SYNC_HANDLER was not mutated with error_paths from the previous call
    await assert.rejects(
        waitForApiResult(
            { primary_error: 'Should not leak into shared handler' },
            { $ref: 'sync', params: { format: 'url', extract: [{ path: 'images', mode: 'array' }] } },
            { sync: SYNC_HANDLER },
            {}
        ),
        { message: 'Could not extract image data from provider response.' }
    );
});

test('sync error_paths accepts a single string path and formats non-string values', async () => {
    const baseExtract = [{ path: 'images', mode: 'array' }];

    await assert.rejects(
        waitForApiResult(
            { error: { detail: 'Single string path error' } },
            { $ref: 'sync', params: { format: 'url', extract: baseExtract, error_paths: 'error.detail' } },
            { sync: SYNC_HANDLER },
            {}
        ),
        { message: 'Single string path error' }
    );

    await assert.rejects(
        waitForApiResult(
            { code: 429 },
            { $ref: 'sync', params: { format: 'url', extract: baseExtract, error_paths: ['code'] } },
            { sync: SYNC_HANDLER },
            {}
        ),
        { message: '429' }
    );

    await assert.rejects(
        waitForApiResult(
            { blocked: true },
            { $ref: 'sync', params: { format: 'url', extract: baseExtract, error_paths: ['blocked'] } },
            { sync: SYNC_HANDLER },
            {}
        ),
        { message: 'true' }
    );

    await assert.rejects(
        waitForApiResult(
            { reasons: ['SAFETY', 'RECITATION'] },
            { $ref: 'sync', params: { format: 'url', extract: baseExtract, error_paths: ['reasons'] } },
            { sync: SYNC_HANDLER },
            {}
        ),
        { message: '["SAFETY","RECITATION"]' }
    );

    await assert.rejects(
        waitForApiResult(
            { detail: { reason: 'SAFETY' } },
            { $ref: 'sync', params: { format: 'url', extract: baseExtract, error_paths: ['detail'] } },
            { sync: SYNC_HANDLER },
            {}
        ),
        { message: '{"reason":"SAFETY"}' }
    );
});

test('sync handler error_paths can be defined directly and overridden via params', async () => {
    const customSyncHandler = {
        type: 'sync',
        result: {
            source: 'submit_response',
            images: {
                format: 'url',
                extract: [{ path: 'images', mode: 'array' }],
                error_paths: ['handler_error']
            }
        }
    };

    await assert.rejects(
        waitForApiResult(
            { handler_error: 'From handler default', param_error: 'From param override' },
            { $ref: 'custom_sync' },
            { custom_sync: customSyncHandler },
            {}
        ),
        { message: 'From handler default' }
    );

    await assert.rejects(
        waitForApiResult(
            { handler_error: 'From handler default', param_error: 'From param override' },
            { $ref: 'custom_sync', params: { error_paths: ['param_error'] } },
            { custom_sync: customSyncHandler },
            {}
        ),
        { message: 'From param override' }
    );

    await assert.rejects(
        waitForApiResult(
            { handler_error: 'From handler default' },
            { $ref: 'custom_sync', params: { error_paths: [] } },
            { custom_sync: customSyncHandler },
            {}
        ),
        { message: 'Could not extract image data from provider response.' }
    );
});

test('async handlers ignore result.images.error_paths when completed response has no images', async (t) => {
    const statusUrl = await serveJson(t, {
        status: 'done',
        images: [],
        soft_error: 'Should be ignored for async handlers'
    });
    const handler = pollingHandler();
    handler.result.images.error_paths = ['soft_error'];

    await assert.rejects(
        waitForApiResult({ status_url: statusUrl }, { handler }, {}, {}),
        { message: 'Could not extract image data from provider response.' }
    );
});
