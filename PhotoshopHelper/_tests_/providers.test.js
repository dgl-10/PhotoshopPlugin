const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const JSON5 = require('json5');
const { detectFormattedImageMime } = require('../apiGenerator');

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
    assert.match(provider.tags.provider, SLUG_PATTERN,
        `${source} ${provider.id}: tags.provider must be a lowercase slug`);
    if (Array.isArray(provider.tags.family)) {
        assert.ok(provider.tags.family.length > 0,
            `${source} ${provider.id}: tags.family array must not be empty`);
        for (const family of provider.tags.family) {
            assert.equal(typeof family, 'string',
                `${source} ${provider.id}: tags.family entries must be strings`);
            assert.match(family, SLUG_PATTERN,
                `${source} ${provider.id}: tags.family entry "${family}" must be a lowercase slug`);
        }
    } else {
        assert.equal(typeof provider.tags.family, 'string',
            `${source} ${provider.id}: tags.family must be a string or string array`);
        assert.match(provider.tags.family, SLUG_PATTERN,
            `${source} ${provider.id}: tags.family must be a lowercase slug`);
    }
}

test('every shipped template provider has grouping tags', () => {
    const catalog = loadCatalog('providers.template.json');
    assert.ok(Array.isArray(catalog.providers) && catalog.providers.length > 0);

    for (const provider of catalog.providers) {
        assertProviderTags(provider, 'providers.template.json');
    }
});

test('every providers.user.json entry has grouping tags', () => {
    const catalog = loadCatalog('providers.user.json');
    assert.ok(Array.isArray(catalog.providers) && catalog.providers.length > 0);

    for (const provider of catalog.providers) {
        assertProviderTags(provider, 'providers.user.json');
    }
});

test('template and providers.user.json share the same tags for matching ids', () => {
    const templateById = new Map(
        loadCatalog('providers.template.json').providers.map(provider => [provider.id, provider])
    );
    const liveById = new Map(
        loadCatalog('providers.user.json').providers.map(provider => [provider.id, provider])
    );

    for (const [id, templateProvider] of templateById) {
        const liveProvider = liveById.get(id);
        if (!liveProvider) {
            continue;
        }

        assert.deepEqual(
            liveProvider.tags,
            templateProvider.tags,
            `${id}: tags in providers.user.json must match providers.template.json`
        );
    }
});

test('GET /api/webhelper/providers sanitization does not strip tags', () => {
    // The sanitization lives in providers-discovery.js, shared by the endpoint and the MCP tools.
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'providers-discovery.js'), 'utf8');

    assert.doesNotMatch(mainSource, /delete\s+sanitized\.tags\b/);
    for (const field of SERVER_STRIPPED_FIELDS) {
        assert.match(mainSource, new RegExp(`delete\\s+sanitized\\.${field}\\b`));
    }
});

test('detectFormattedImageMime detects PNG, JPEG, WebP, and GIF across raw base64 and Data URIs', () => {
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]).toString('base64');
    const jpegBase64 = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]).toString('base64');
    const webpBase64 = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'binary').toString('base64');
    const gifBase64 = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00', 'binary').toString('base64');

    assert.equal(detectFormattedImageMime(null, 'base64_raw'), null);
    assert.equal(detectFormattedImageMime('', 'base64_raw'), null);
    assert.equal(detectFormattedImageMime(pngBase64, 'base64_raw'), 'image/png');
    assert.equal(detectFormattedImageMime(jpegBase64, 'base64_raw'), 'image/jpeg');
    assert.equal(detectFormattedImageMime(webpBase64, 'base64_raw'), 'image/webp');
    assert.equal(detectFormattedImageMime(gifBase64, 'base64_raw'), 'image/gif');

    assert.equal(detectFormattedImageMime(`data:image/jpeg;base64,${jpegBase64}`, 'data_uri'), 'image/jpeg');
    // When a preprocessor re-encodes a WebP Data URI as PNG bytes, magic bytes win
    assert.equal(detectFormattedImageMime(`data:image/webp;base64,${pngBase64}`, 'data_uri'), 'image/png');
});
