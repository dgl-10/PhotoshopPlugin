const crypto = require('node:crypto');

/**
 * Shared authentication primitives for every client of the local HTTP server.
 *
 * The server binds to the loopback interface, but loopback is not an access boundary:
 * any browser page the user visits, and any sandboxed local application, can reach it.
 * These helpers provide the two boundaries that actually hold — a same-origin check that
 * stops cross-site browser requests, and a shared-secret check that stops everything
 * which is not a paired client.
 */

/**
 * Create a cryptographically strong shared secret.
 *
 * @returns {string} A 256-bit secret encoded as lowercase hexadecimal.
 */
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Compare a supplied token without leaking partial-match timing information.
 *
 * @param {string} suppliedToken - Token extracted from an HTTP header.
 * @param {string} expectedToken - Token configured for this server.
 * @returns {boolean} True only when both UTF-8 byte sequences match exactly.
 */
function tokensMatch(suppliedToken, expectedToken) {
    const suppliedBuffer = Buffer.from(suppliedToken, 'utf8');
    const expectedBuffer = Buffer.from(expectedToken, 'utf8');

    // timingSafeEqual throws on a length mismatch, so the lengths are compared first.
    // Token length is not secret, only its contents are.
    if (suppliedBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

/**
 * Read a shared secret from either accepted header form.
 *
 * @param {import('express').Request} req - Incoming request.
 * @returns {string} The supplied token, or an empty string when none was sent.
 */
function extractToken(req) {
    const authorization = req.get('authorization') || '';
    const bearerPrefix = 'Bearer ';
    const bearerToken = authorization.startsWith(bearerPrefix)
        ? authorization.slice(bearerPrefix.length)
        : '';

    return bearerToken || req.get('x-api-key') || '';
}

/**
 * Determine whether a request came from a page this server itself served.
 *
 * Comparing Origin against the request's own Host rather than a hardcoded address keeps
 * WebHelper working unchanged when it is reached through a tunnel, where both values are
 * the tunnel hostname. A request without an Origin header is deliberately not treated as
 * same-origin: non-browser callers omit it, and they must present a token instead.
 *
 * @param {import('express').Request} req - Incoming request.
 * @returns {boolean} True when Origin and Host identify the same host and port.
 */
function isSameOriginRequest(req) {
    const origin = req.get('origin');
    const host = req.get('host');

    if (!origin || !host) {
        return false;
    }

    try {
        return new URL(origin).host === host;
    } catch (error) {
        // A malformed Origin cannot be matched against anything.
        return false;
    }
}

/**
 * Create middleware that requires a shared secret, optionally trusting same-origin pages.
 *
 * The expected token is read through a callback on every request so a rotated secret
 * takes effect without rebuilding the route table.
 *
 * @param {object} options - Middleware configuration.
 * @param {Function} options.getToken - Returns the currently expected token.
 * @param {boolean} [options.allowSameOrigin=false] - Accept same-origin browser requests.
 * @returns {import('express').RequestHandler} Express authentication middleware.
 */
function createAuthMiddleware(options) {
    if (!options || typeof options.getToken !== 'function') {
        throw new TypeError('createAuthMiddleware requires a getToken function.');
    }

    const allowSameOrigin = options.allowSameOrigin === true;

    return (req, res, next) => {
        if (allowSameOrigin) {
            const origin = req.get('origin');

            // The Fetch spec only attaches Origin to cross-origin requests and to
            // same-origin requests whose method is not GET/HEAD; a same-origin page's own
            // GET calls (WebHelper reading its providers or task queue) never carry one.
            // A malicious cross-site page cannot reproduce that omission — cross-origin
            // fetch/XHR always sets Origin regardless of method — so treating an absent
            // Origin as trusted here does not reopen the browser-drive-by attack this
            // middleware exists to stop. Only a present, mismatched Origin is rejected.
            if (!origin || isSameOriginRequest(req)) {
                return next();
            }
        }

        const expectedToken = options.getToken();

        // A missing secret means the server failed to initialize its own credentials.
        // Failing closed keeps an initialization bug from silently disabling the check.
        if (!expectedToken) {
            return res.status(503).json({ error: 'Server authentication is not initialized.' });
        }

        const suppliedToken = extractToken(req);

        if (!suppliedToken || !tokensMatch(suppliedToken, expectedToken)) {
            return res.status(401).json({ error: 'Unauthorized.' });
        }

        return next();
    };
}

/**
 * Create CORS middleware that reflects only the server's own origin.
 *
 * A wildcard policy lets any page the user happens to have open drive this API. Reflecting
 * just the matching origin means a cross-site request fails its preflight, so the browser
 * never sends the request at all. Requests carrying no Origin are left untouched: they are
 * not browser requests and are governed by the token middleware instead.
 *
 * @param {object} [options] - Middleware configuration.
 * @param {string[]} [options.methods] - Methods advertised to the browser.
 * @param {string[]} [options.headers] - Request headers advertised to the browser.
 * @returns {import('express').RequestHandler} Express CORS middleware.
 */
function createSameOriginCorsMiddleware(options = {}) {
    const methods = (options.methods || ['GET', 'POST', 'OPTIONS']).join(', ');
    const headers = (options.headers || ['Content-Type', 'Authorization', 'X-API-Key']).join(', ');

    return (req, res, next) => {
        const origin = req.get('origin');

        if (origin && isSameOriginRequest(req)) {
            res.header('Access-Control-Allow-Origin', origin);
            res.header('Vary', 'Origin');
            res.header('Access-Control-Allow-Methods', methods);
            res.header('Access-Control-Allow-Headers', headers);

            if (req.method === 'OPTIONS') {
                return res.sendStatus(200);
            }

            return next();
        }

        // Answer a cross-origin preflight explicitly rather than letting it fall through
        // to a route, so the browser reports a policy failure instead of a missing route.
        if (req.method === 'OPTIONS') {
            return res.sendStatus(origin ? 403 : 200);
        }

        return next();
    };
}

/**
 * Parse the credentials carried by an HTTP Basic Authorization header.
 *
 * Internal to createPasswordGate; not exported. _tests_/auth.test.js exercises it
 * indirectly by asserting on createPasswordGate's HTTP responses instead.
 *
 * @param {import('express').Request} req - Incoming request.
 * @returns {{username: string, password: string}|null} Credentials, or null when absent.
 */
function extractBasicCredentials(req) {
    const authorization = req.get('authorization') || '';
    const basicPrefix = 'Basic ';

    if (!authorization.startsWith(basicPrefix)) {
        return null;
    }

    try {
        const decoded = Buffer.from(authorization.slice(basicPrefix.length), 'base64').toString('utf8');
        const separatorIndex = decoded.indexOf(':');

        if (separatorIndex === -1) {
            return null;
        }

        return {
            username: decoded.slice(0, separatorIndex),
            password: decoded.slice(separatorIndex + 1)
        };
    } catch (error) {
        return null;
    }
}

/**
 * Create an optional password gate for the browser-facing WebHelper surface.
 *
 * HTTP Basic is used because the browser renders the prompt itself and replays the
 * credentials on same-origin requests, so the single-page app needs no login screen and
 * no session handling. The gate is inert until a password is configured, which preserves
 * the existing password-free local workflow.
 *
 * @param {object} options - Middleware configuration.
 * @param {Function} options.getPassword - Returns the configured password, or an empty string.
 * @param {Function} [options.getToken] - Returns a token that bypasses the gate.
 * @param {string} [options.realm='Photoshop Helper'] - Realm shown in the browser prompt.
 * @returns {import('express').RequestHandler} Express Basic-authentication middleware.
 */
function createPasswordGate(options) {
    if (!options || typeof options.getPassword !== 'function') {
        throw new TypeError('createPasswordGate requires a getPassword function.');
    }

    const realm = options.realm || 'Photoshop Helper';

    return (req, res, next) => {
        const expectedPassword = options.getPassword();

        if (!expectedPassword) {
            return next();
        }

        // A paired non-browser client authenticates with its token and never sees a prompt.
        if (typeof options.getToken === 'function') {
            const expectedToken = options.getToken();
            const suppliedToken = extractToken(req);

            if (expectedToken && suppliedToken && tokensMatch(suppliedToken, expectedToken)) {
                return next();
            }
        }

        const credentials = extractBasicCredentials(req);

        if (credentials && tokensMatch(credentials.password, expectedPassword)) {
            return next();
        }

        res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
        return res.status(401).json({ error: 'Unauthorized.' });
    };
}

module.exports = {
    // Consumed by main.js, localGenerationApi.js, and user-settings.js.
    generateToken,
    createAuthMiddleware,
    createSameOriginCorsMiddleware,
    createPasswordGate,

    // Not used by any runtime module — every call site is inside this file. Exported
    // only so _tests_/auth.test.js can exercise each piece in isolation instead of only
    // through the middleware built on top of it.
    tokensMatch,
    extractToken,
    isSameOriginRequest
};
