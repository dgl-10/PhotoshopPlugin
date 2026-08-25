const assert = require('node:assert/strict');
const test = require('node:test');

const {
    getLocalApiToken,
    regenerateLocalApiToken,
    saveTokenToUserEnvironment,
    getTokenFromUserEnvironment
} = require('../user-settings');

test('getLocalApiToken respects PHOTOSHOP_HELPER_LOCAL_API_TOKEN environment variable', async () => {
    const originalPhotoshopHelperVar = process.env.PHOTOSHOP_HELPER_LOCAL_API_TOKEN;

    try {
        process.env.PHOTOSHOP_HELPER_LOCAL_API_TOKEN = 'custom-configured-token';

        const token = await getLocalApiToken();
        assert.equal(token, 'custom-configured-token');
    } finally {
        if (originalPhotoshopHelperVar !== undefined) {
            process.env.PHOTOSHOP_HELPER_LOCAL_API_TOKEN = originalPhotoshopHelperVar;
        } else {
            delete process.env.PHOTOSHOP_HELPER_LOCAL_API_TOKEN;
        }
    }
});

test('regenerateLocalApiToken generates and stores a new 64-char hex token', async () => {
    const newToken = await regenerateLocalApiToken();
    assert.match(newToken, /^[0-9a-f]{64}$/);

    const originalPhotoshopHelperVar = process.env.PHOTOSHOP_HELPER_LOCAL_API_TOKEN;

    try {
        delete process.env.PHOTOSHOP_HELPER_LOCAL_API_TOKEN;

        const resolvedToken = await getLocalApiToken();
        assert.equal(resolvedToken, newToken);
    } finally {
        if (originalPhotoshopHelperVar !== undefined) {
            process.env.PHOTOSHOP_HELPER_LOCAL_API_TOKEN = originalPhotoshopHelperVar;
        } else {
            delete process.env.PHOTOSHOP_HELPER_LOCAL_API_TOKEN;
        }
    }
});

test('saveTokenToUserEnvironment rejects invalid token input', () => {
    const nullResult = saveTokenToUserEnvironment(null);
    assert.equal(nullResult.success, false);
    assert.equal(nullResult.error, 'Invalid token value.');

    const emptyResult = saveTokenToUserEnvironment('');
    assert.equal(emptyResult.success, false);
    assert.equal(emptyResult.error, 'Invalid token value.');
});

test('getTokenFromUserEnvironment returns null on non-Windows platforms', { skip: process.platform === 'win32' }, () => {
    const result = getTokenFromUserEnvironment();
    assert.equal(result, null);
});

test('getTokenFromUserEnvironment returns a string or null on Windows', { skip: process.platform !== 'win32' }, () => {
    const result = getTokenFromUserEnvironment();
    // The value in HKCU\Environment may or may not be set; either outcome is valid.
    assert.ok(result === null || typeof result === 'string', `Expected string or null, got: ${typeof result}`);
});

test('saveTokenToUserEnvironment and getTokenFromUserEnvironment roundtrip on Windows', { skip: process.platform !== 'win32' }, () => {
    const testVarName = 'PHOTOSHOP_HELPER_TEST_TOKEN_' + Date.now();
    const testTokenVal = 'test-token-val-12345';

    try {
        const saveResult = saveTokenToUserEnvironment(testTokenVal, testVarName);
        assert.equal(saveResult.success, true);

        const readBack = getTokenFromUserEnvironment(testVarName);
        assert.equal(readBack, testTokenVal);
    } finally {
        // Clean up test environment variable from HKCU\Environment by setting it to empty string/null.
        const { spawnSync } = require('node:child_process');
        spawnSync('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-Command',
            '& { param($name) [System.Environment]::SetEnvironmentVariable($name, $null, [System.EnvironmentVariableTarget]::User) }',
            testVarName
        ], { windowsHide: true });
    }
});
