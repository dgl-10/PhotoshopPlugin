const assert = require('node:assert/strict');
const test   = require('node:test');
const fs     = require('node:fs');
const path   = require('node:path');

const {
    getCacheDir,
    ensureCacheDir,
    readCache,
    writeCache,
    deleteCache,
    cleanStaleCache
} = require('../agent/cli-models-cache');
const { getConfigPaths } = require('../setup/config-paths');

test('cli-models-cache directory matches getConfigPaths().cliModelsCachePath', () => {
    const paths = getConfigPaths();
    assert.equal(getCacheDir(), paths.cliModelsCachePath);
});

test('ensureCacheDir creates cache folder if it does not exist', () => {
    const dir = ensureCacheDir();
    assert.ok(dir);
    assert.ok(fs.existsSync(dir));
});

test('readCache returns null for an un-cached CLI', () => {
    deleteCache('claude');
    const result = readCache('claude');
    assert.equal(result, null);
});

test('writeCache stores payload and readCache retrieves it accurately', () => {
    const testData = {
        supports_native_image_generation: true,
        recommended_tiers: {
            Light:  { model: 'm-light', effort: 'low' },
            Medium: { model: 'm-medium', effort: 'medium' },
            High:   { model: 'm-high', effort: 'high' }
        },
        all_available_models: {
            High_Power: [{ model: 'm-high', available_efforts: ['high'] }]
        }
    };

    const written = writeCache('claude', testData);
    assert.equal(written, true);

    const cached = readCache('claude');
    assert.ok(cached);
    assert.deepEqual(cached.data, testData);
    assert.ok(cached.ageMs >= 0);

    // Clean up
    deleteCache('claude');
    assert.equal(readCache('claude'), null);
});

test('readCache removes corrupt or stale files automatically', () => {
    const dir = ensureCacheDir();
    const filePath = path.join(dir, 'codex.json');

    // Test corrupt file cleanup
    fs.writeFileSync(filePath, '{ invalid json ...', 'utf-8');
    assert.equal(readCache('codex'), null);
    assert.equal(fs.existsSync(filePath), false);

    // Test stale file cleanup (> 14 days)
    const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(filePath, JSON.stringify({
        cli: 'codex',
        fetchedAt: oldDate,
        data: { test: true }
    }), 'utf-8');

    assert.equal(readCache('codex'), null);
    assert.equal(fs.existsSync(filePath), false);
});
