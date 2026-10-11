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
