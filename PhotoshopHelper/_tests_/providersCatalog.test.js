const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const JSON5 = require('json5');

const {
    validateSharedCatalog,
    loadProvidersCatalog,
    findMissingEnvKeys,
    ensureUserCatalogFile
} = require('../providers-catalog');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeProvider(id, extra = {}) {
    return {
        id,
        name: `Model ${id}`,
        generation_modes: ['t2i'],
        request_config: { url: 'https://example.test/generate', headers: { Authorization: 'Key {{env:TEST_API_KEY}}' } },
        response_config: { $ref: 'sync' },
        ...extra
    };
}

function makeCatalog(providers, extra = {}) {
    return { response_handlers: { sync: { type: 'sync' } }, providers, ...extra };
}

/**
 * Create an empty folder with the two model list files' paths, removed after the test.
 */
function makePaths(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-catalog-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return {
        sharedProvidersPath: path.join(dir, 'providers.remote.json'),
        userProvidersPath: path.join(dir, 'providers.user.json')
    };
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 4));
}

test('the shared template is a complete model list', () => {
    const template = JSON5.parse(fs.readFileSync(path.join(__dirname, '..', 'providers.template.json'), 'utf8'));
    assert.deepEqual(validateSharedCatalog(template), []);
});

test('providers.user.json only adds models, it does not repeat shared ones', () => {
    const read = name => JSON5.parse(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'));
    const sharedIds = new Set(read('providers.template.json').providers.map(p => p.id));
    const repeated = read('providers.user.json').providers.map(p => p.id).filter(id => sharedIds.has(id));
    assert.deepEqual(repeated, []);
});

test('validation reports what makes a list unusable', () => {
    const problems = validateSharedCatalog(makeCatalog([
        makeProvider('a'),
        makeProvider('a'),
        makeProvider('b', { response_config: { $ref: 'nope' } })
    ]));

    assert.ok(problems.some(p => p.includes('"a" is listed more than once')));
    assert.ok(problems.some(p => p.includes('unknown response handler "nope"')));
});

test('a user model replaces the shared one with the same id, and "disabled" hides one', (t) => {
    const paths = makePaths(t);
    writeJson(paths.sharedProvidersPath, makeCatalog([makeProvider('a'), makeProvider('b'), makeProvider('c')]));
    writeJson(paths.userProvidersPath, {
        providers: [makeProvider('b', { name: 'My B' }), { id: 'c', disabled: true }]
    });

    const catalog = loadProvidersCatalog({ paths });

    assert.deepEqual(catalog.providers.map(p => [p.id, p.name]), [['a', 'Model a'], ['b', 'My B']]);
});

test('user models with new ids are appended and response handlers are combined', (t) => {
    const paths = makePaths(t);
    writeJson(paths.sharedProvidersPath, makeCatalog([makeProvider('a')]));
    writeJson(paths.userProvidersPath, {
        response_handlers: { sync: { type: 'sync', mine: true }, custom: { type: 'sync' } },
        providers: [makeProvider('x'), makeProvider('x', { name: 'duplicate' })]
    });

    const catalog = loadProvidersCatalog({ paths });

    assert.deepEqual(catalog.providers.map(p => [p.id, p.name]), [['a', 'Model a'], ['x', 'Model x']]);
    assert.deepEqual(catalog.response_handlers, { sync: { type: 'sync', mine: true }, custom: { type: 'sync' } });
});

test('missing files give an empty list, a broken file names itself', (t) => {
    const paths = makePaths(t);
    assert.deepEqual(loadProvidersCatalog({ paths }), { response_handlers: {}, providers: [] });

    fs.writeFileSync(paths.userProvidersPath, '{ "providers": [ oops ] }');
    assert.throws(() => loadProvidersCatalog({ paths }), /^Error: providers\.user\.json: /);
});

test('missing API keys include those of the referenced response handler', () => {
    const handlers = { polled: { type: 'async_poll', polling: { headers: { Authorization: '{{env:POLL_KEY}}' } } } };
    const provider = makeProvider('a', { response_config: { $ref: 'polled' } });

    const missing = findMissingEnvKeys(provider, handlers, { TEST_API_KEY: 'set', POLL_KEY: '   ' });

    assert.deepEqual(missing, ['POLL_KEY']);
});

test('a fresh install gets an empty providers.user.json with instructions', (t) => {
    const paths = makePaths(t);
    writeJson(paths.sharedProvidersPath, makeCatalog([makeProvider('a')]));

    assert.equal(ensureUserCatalogFile({ paths, logger: silentLogger }), true);

    const text = fs.readFileSync(paths.userProvidersPath, 'utf8');
    assert.deepEqual(JSON5.parse(text), { response_handlers: {}, providers: [] });
    assert.deepEqual(loadProvidersCatalog({ paths }).providers.map(p => p.id), ['a']);

    // A second launch leaves the file alone.
    fs.writeFileSync(paths.userProvidersPath, '{ "providers": [] } // edited');
    assert.equal(ensureUserCatalogFile({ paths, logger: silentLogger }), false);
    assert.equal(fs.readFileSync(paths.userProvidersPath, 'utf8'), '{ "providers": [] } // edited');
});
