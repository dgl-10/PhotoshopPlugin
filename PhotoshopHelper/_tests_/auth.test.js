const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');

const {
    generateToken,
    tokensMatch,
    extractToken,
    isSameOriginRequest,
    createAuthMiddleware,
    createSameOriginCorsMiddleware,
    createPasswordGate
} = require('../auth');

/**
 * Start a minimal Express server that exercises one middleware for a single test.
 *
 * @param {import('node:test').TestContext} context - Active Node test context.
 * @param {import('express').RequestHandler} middleware - Middleware under test.
 * @returns {Promise<string>} Base URL of the listening server.
 */
async function startTestServer(context, middleware) {
    const application = express();

    application.use(middleware);
    application.all('/probe', (req, res) => res.json({ reached: true }));

    const server = await new Promise(resolve => {
        const listeningServer = application.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });

    context.after(async () => {
        await new Promise((resolve, reject) => {
            server.close(error => (error ? reject(error) : resolve()));
        });
    });

    return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Build a request-like object exposing only the header accessor the helpers use.
 *
 * @param {object} headers - Header values keyed by lowercase name.
 * @returns {{get: Function}} Minimal Express request stand-in.
 */
function fakeRequest(headers) {
    return {
        get: name => headers[name.toLowerCase()]
    };
}

test('generateToken returns a distinct 256-bit hex secret each time', () => {
    const first = generateToken();
    const second = generateToken();

    assert.match(first, /^[0-9a-f]{64}$/);
    assert.match(second, /^[0-9a-f]{64}$/);
    assert.notEqual(first, second);
});

test('tokensMatch compares exact values and rejects length mismatches', () => {
    assert.equal(tokensMatch('abc123', 'abc123'), true);
    assert.equal(tokensMatch('abc123', 'abc124'), false);

    // A length mismatch must be reported rather than thrown by timingSafeEqual.
    assert.equal(tokensMatch('short', 'considerably-longer'), false);
    assert.equal(tokensMatch('', ''), true);
});

test('extractToken reads both header forms and prefers Bearer', () => {
    assert.equal(extractToken(fakeRequest({ authorization: 'Bearer from-bearer' })), 'from-bearer');
    assert.equal(extractToken(fakeRequest({ 'x-api-key': 'from-api-key' })), 'from-api-key');
    assert.equal(
        extractToken(fakeRequest({ authorization: 'Bearer from-bearer', 'x-api-key': 'from-api-key' })),
        'from-bearer'
    );
    assert.equal(extractToken(fakeRequest({})), '');

    // A non-Bearer scheme must not be mistaken for a token.
    assert.equal(extractToken(fakeRequest({ authorization: 'Basic dXNlcjpwYXNz' })), '');
});

test('isSameOriginRequest matches Origin against the request host', () => {
    assert.equal(
        isSameOriginRequest(fakeRequest({ origin: 'http://127.0.0.1:18345', host: '127.0.0.1:18345' })),
        true
    );

    // A tunnel serves the page under its own hostname, and both values follow it.
    assert.equal(
        isSameOriginRequest(fakeRequest({ origin: 'https://abc.ngrok.io', host: 'abc.ngrok.io' })),
        true
    );

    assert.equal(
        isSameOriginRequest(fakeRequest({ origin: 'https://evil.example', host: '127.0.0.1:18345' })),
        false
    );

    // A different port is a different origin.
    assert.equal(
        isSameOriginRequest(fakeRequest({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:18345' })),
        false
    );

    // Absent or unparseable values can never establish same-origin.
    assert.equal(isSameOriginRequest(fakeRequest({ host: '127.0.0.1:18345' })), false);
    assert.equal(isSameOriginRequest(fakeRequest({ origin: 'not a url', host: '127.0.0.1:18345' })), false);
});

test('createAuthMiddleware rejects requests without a valid token', async context => {
    const baseUrl = await startTestServer(context, createAuthMiddleware({ getToken: () => 'correct-token' }));

    const missing = await fetch(`${baseUrl}/probe`);
    assert.equal(missing.status, 401);

    const wrong = await fetch(`${baseUrl}/probe`, { headers: { 'X-API-Key': 'wrong-token' } });
    assert.equal(wrong.status, 401);

    const bearer = await fetch(`${baseUrl}/probe`, { headers: { Authorization: 'Bearer correct-token' } });
    assert.equal(bearer.status, 200);

    const apiKey = await fetch(`${baseUrl}/probe`, { headers: { 'X-API-Key': 'correct-token' } });
    assert.equal(apiKey.status, 200);
});

test('createAuthMiddleware fails closed when no secret is configured', async context => {
    const baseUrl = await startTestServer(context, createAuthMiddleware({ getToken: () => '' }));

    // An uninitialized secret must never be read as "no authentication required".
    const response = await fetch(`${baseUrl}/probe`, { headers: { 'X-API-Key': 'anything' } });
    assert.equal(response.status, 503);
});

test('createAuthMiddleware reads the token on every request so rotation applies', async context => {
    let currentToken = 'first-token';
    const baseUrl = await startTestServer(context, createAuthMiddleware({ getToken: () => currentToken }));

    const before = await fetch(`${baseUrl}/probe`, { headers: { 'X-API-Key': 'first-token' } });
    assert.equal(before.status, 200);

    currentToken = 'second-token';

    const stale = await fetch(`${baseUrl}/probe`, { headers: { 'X-API-Key': 'first-token' } });
    assert.equal(stale.status, 401);

    const rotated = await fetch(`${baseUrl}/probe`, { headers: { 'X-API-Key': 'second-token' } });
    assert.equal(rotated.status, 200);
});

test('createAuthMiddleware trusts same-origin pages only when configured to', async context => {
    const baseUrl = await startTestServer(context, createAuthMiddleware({
        getToken: () => 'correct-token',
        allowSameOrigin: true
    }));

    const host = new URL(baseUrl).host;

    const sameOrigin = await fetch(`${baseUrl}/probe`, { headers: { Origin: baseUrl } });
    assert.equal(sameOrigin.status, 200, 'the page this server serves is a legitimate client');

    const crossOrigin = await fetch(`${baseUrl}/probe`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(crossOrigin.status, 401, 'another site must still present a token');

    // Same-origin GET/HEAD fetches never carry an Origin header at all (Fetch spec), so a
    // browser page's own read calls must pass without one. Only a mismatched Origin —
    // which cross-origin fetch always sends — is what a real attacker can produce.
    const noOrigin = await fetch(`${baseUrl}/probe`);
    assert.equal(noOrigin.status, 200);

    const tokenized = await fetch(`${baseUrl}/probe`, { headers: { 'X-API-Key': 'correct-token' } });
    assert.equal(tokenized.status, 200);
    assert.ok(host);
});

test('createSameOriginCorsMiddleware never advertises a wildcard origin', async context => {
    const baseUrl = await startTestServer(context, createSameOriginCorsMiddleware());

    const sameOrigin = await fetch(`${baseUrl}/probe`, { headers: { Origin: baseUrl } });
    assert.equal(sameOrigin.headers.get('access-control-allow-origin'), baseUrl);
    assert.equal(sameOrigin.headers.get('vary'), 'Origin');

    const crossOrigin = await fetch(`${baseUrl}/probe`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(
        crossOrigin.headers.get('access-control-allow-origin'),
        null,
        'a foreign page must not be granted read access to responses'
    );
});

test('createSameOriginCorsMiddleware refuses a cross-origin preflight', async context => {
    const baseUrl = await startTestServer(context, createSameOriginCorsMiddleware());

    // Failing the preflight is what stops the browser from ever sending the real request.
    const foreign = await fetch(`${baseUrl}/probe`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
    });
    assert.equal(foreign.status, 403);

    const own = await fetch(`${baseUrl}/probe`, {
        method: 'OPTIONS',
        headers: { Origin: baseUrl, 'Access-Control-Request-Method': 'POST' }
    });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, X-API-Key');
});

test('createPasswordGate stays inert until a password is configured', async context => {
    const baseUrl = await startTestServer(context, createPasswordGate({ getPassword: () => '' }));

    const response = await fetch(`${baseUrl}/probe`);
    assert.equal(response.status, 200, 'the existing password-free local workflow must be preserved');
});

test('createPasswordGate challenges the browser and accepts the password', async context => {
    const baseUrl = await startTestServer(context, createPasswordGate({
        getPassword: () => 'hunter2',
        getToken: () => 'plugin-token'
    }));

    const anonymous = await fetch(`${baseUrl}/probe`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate') || '', /^Basic realm=/);

    const wrong = await fetch(`${baseUrl}/probe`, {
        headers: { Authorization: `Basic ${Buffer.from('user:wrong').toString('base64')}` }
    });
    assert.equal(wrong.status, 401);

    const correct = await fetch(`${baseUrl}/probe`, {
        headers: { Authorization: `Basic ${Buffer.from('user:hunter2').toString('base64')}` }
    });
    assert.equal(correct.status, 200);

    // A paired client authenticates with its token and is never prompted.
    const paired = await fetch(`${baseUrl}/probe`, { headers: { 'X-API-Key': 'plugin-token' } });
    assert.equal(paired.status, 200);
});
