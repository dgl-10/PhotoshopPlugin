const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const JSON5 = require('json5');

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SERVER_STRIPPED_FIELDS = [
    'request_config',
    'response_config',
    'image_format',
    'filename_suffix',
    'preprocessor'
];

/**
 * Load a JSON5 provider catalog from the PhotoshopHelper root.
 *
 * @param {string} fileName - Catalog file name.
 * @returns {{providers: object[]}} Parsed catalog.
 */
function loadCatalog(fileName) {
    const filePath = path.join(__dirname, '..', fileName);
    return JSON5.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Assert that one provider object has a well-formed tags block.
 *
 * @param {object} provider - Provider configuration.
 * @param {string} source - File name used in assertion messages.
 */
function assertProviderTags(provider, source) {
    assert.ok(provider && typeof provider.id === 'string' && provider.id.trim() !== '',
        `${source}: provider is missing id`);
    assert.equal(typeof provider.tags, 'object',
        `${source} ${provider.id}: tags must be an object`);
    assert.notEqual(provider.tags, null,
        `${source} ${provider.id}: tags must not be null`);
    assert.equal(typeof provider.tags.provider, 'string',
        `${source} ${provider.id}: tags.provider must be a string`);
    assert.equal(typeof provider.tags.family, 'string',
        `${source} ${provider.id}: tags.family must be a string`);
    assert.match(provider.tags.provider, SLUG_PATTERN,
        `${source} ${provider.id}: tags.provider must be a lowercase slug`);
    assert.match(provider.tags.family, SLUG_PATTERN,
        `${source} ${provider.id}: tags.family must be a lowercase slug`);
}

test('every shipped template provider has grouping tags', () => {
    const catalog = loadCatalog('providers.template.json');
    assert.ok(Array.isArray(catalog.providers) && catalog.providers.length > 0);

    for (const provider of catalog.providers) {
        assertProviderTags(provider, 'providers.template.json');
    }
});

test('every local providers.json entry has grouping tags', () => {
    const catalog = loadCatalog('providers.json');
    assert.ok(Array.isArray(catalog.providers) && catalog.providers.length > 0);

    for (const provider of catalog.providers) {
        assertProviderTags(provider, 'providers.json');
    }
});

test('template and providers.json share the same tags for matching ids', () => {
    const templateById = new Map(
        loadCatalog('providers.template.json').providers.map(provider => [provider.id, provider])
    );
    const liveById = new Map(
        loadCatalog('providers.json').providers.map(provider => [provider.id, provider])
    );

    for (const [id, templateProvider] of templateById) {
        const liveProvider = liveById.get(id);
        if (!liveProvider) {
            continue;
        }

        assert.deepEqual(
            liveProvider.tags,
            templateProvider.tags,
            `${id}: tags in providers.json must match providers.template.json`
        );
    }
});

test('GET /api/webhelper/providers sanitization does not strip tags', () => {
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

    assert.doesNotMatch(mainSource, /delete\s+sanitized\.tags\b/);
    for (const field of SERVER_STRIPPED_FIELDS) {
        assert.match(mainSource, new RegExp(`delete\\s+sanitized\\.${field}\\b`));
    }
});
