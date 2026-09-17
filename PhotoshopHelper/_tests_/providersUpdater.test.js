const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCatalogUpdater } = require('../providers-updater');
const { loadProvidersCatalog } = require('../providers-catalog');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const CATALOG_URL = 'https://example.test/providers.template.json';

function makeCatalogText(ids, eol = '\n') {
    const catalog = {
        response_handlers: { sync: { type: 'sync' } },
        providers: ids.map(id => ({
            id,
            name: `Model ${id}`,
            generation_modes: ['t2i'],
            request_config: { url: 'https://example.test/generate' },
            response_config: { $ref: 'sync' }
        }))
    };
    return JSON.stringify(catalog, null, 4).replace(/\n/g, eol);
}

/**
 * Paths laid out like a packaged app's settings folder, removed after the test.
 */
function makePaths(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-updater-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const downloadedProvidersPath = path.join(dir, 'providers.remote.json');
    return {
        sharedProvidersPath: downloadedProvidersPath,
        downloadedProvidersPath,
        userProvidersPath: path.join(dir, 'providers.user.json')
    };
}

/**
 * A fetch replacement answering every request with the same body.
 */
function makeFetch(body, { status = 200, calls = [] } = {}) {
    return async (url) => {
        calls.push(url);
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: new Map(),
            text: async () => body
        };
    };
}

function checkOnce(paths, fetchImpl, extra = {}) {
    const updater = createCatalogUpdater({
        url: CATALOG_URL,
        fetchImpl,
        paths,
        logger: silentLogger,
        ...extra
    });
    return updater.checkNow();
}

test('the first download is saved and used', async (t) => {
    const paths = makePaths(t);

    const result = await checkOnce(paths, makeFetch(makeCatalogText(['a', 'new'])));

    assert.deepEqual(result, { status: 'updated' });
    assert.deepEqual(loadProvidersCatalog({ paths }).providers.map(p => p.id), ['a', 'new']);
});

test('the same list with other line endings is not written again', async (t) => {
    const paths = makePaths(t);
    fs.writeFileSync(paths.downloadedProvidersPath, makeCatalogText(['a'], '\r\n'));

    const result = await checkOnce(paths, makeFetch(makeCatalogText(['a'])));

    assert.deepEqual(result, { status: 'unchanged' });
    assert.equal(fs.readFileSync(paths.downloadedProvidersPath, 'utf8'), makeCatalogText(['a'], '\r\n'));
});

test('a truncated download leaves the saved list untouched', async (t) => {
    const paths = makePaths(t);
    fs.writeFileSync(paths.downloadedProvidersPath, makeCatalogText(['a', 'b']));
    const full = makeCatalogText(['a', 'b', 'c']);

    const result = await checkOnce(paths, makeFetch(full.slice(0, full.length / 2)));

    assert.equal(result.status, 'error');
    assert.match(result.error, /damaged or incomplete/);
    assert.equal(fs.readFileSync(paths.downloadedProvidersPath, 'utf8'), makeCatalogText(['a', 'b']));
    assert.deepEqual(fs.readdirSync(path.dirname(paths.downloadedProvidersPath)), ['providers.remote.json']);
});

test('a list that fails validation is rejected', async (t) => {
    const paths = makePaths(t);

    const result = await checkOnce(paths, makeFetch(makeCatalogText(['a', 'a'])));

    assert.equal(result.status, 'error');
    assert.match(result.error, /listed more than once/);
    assert.equal(fs.existsSync(paths.downloadedProvidersPath), false);
});

test('nothing is downloaded in development', async (t) => {
    const paths = { ...makePaths(t), downloadedProvidersPath: null };
    const calls = [];

    const result = await checkOnce(paths, makeFetch(makeCatalogText(['a']), { calls }));

    assert.equal(result.status, 'error');
    assert.match(result.error, /disabled in development/);
    assert.equal(calls.length, 0);
});

test('only https addresses are used', async (t) => {
    const paths = makePaths(t);
    const calls = [];

    const result = await checkOnce(paths, makeFetch(makeCatalogText(['a']), { calls }), {
        url: 'http://example.test/providers.template.json'
    });

    assert.equal(result.status, 'error');
    assert.match(result.error, /must use https/);
    assert.equal(calls.length, 0);
});

test('an HTTP error is reported', async (t) => {
    const paths = makePaths(t);

    const result = await checkOnce(paths, makeFetch('Not Found', { status: 404 }));

    assert.deepEqual(result, { status: 'error', error: 'Server responded with HTTP 404' });
});

test('a check requested during another one shares its download and result', async (t) => {
    const paths = makePaths(t);
    const calls = [];
    const results = [];
    const updater = createCatalogUpdater({
        url: CATALOG_URL,
        fetchImpl: makeFetch(makeCatalogText(['a', 'b']), { calls }),
        paths,
        logger: silentLogger,
        onResult: result => results.push(result)
    });

    const [first, second] = await Promise.all([updater.checkNow(), updater.checkNow()]);

    assert.equal(calls.length, 1);
    assert.equal(first, second);
    assert.equal(first.status, 'updated');
    assert.equal(results.length, 1);
});
