'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

const SERVICE_PATH = require.resolve('../agent/cli-service');

// Mirror the private constants of cli-service.js; update them together.
const INSTALL_CACHE_TTL_MS = 5 * 60 * 1000;
const INSTALL_RETRY_TTL_MS = 5 * 1000;
const INSTALL_PROBE_TIMEOUT_MS = 3000;

/**
 * Load a fresh copy of cli-service with `spawn` replaced by a stub.
 *
 * cli-service destructures `spawn` at load time and keeps the install cache in module
 * state, so every test gets its own module instance with its own stub and empty cache.
 *
 * @param {Function} fakeSpawn - Replacement for child_process.spawn.
 * @returns {object} The freshly loaded cli-service module.
 */
function loadServiceWithSpawn(fakeSpawn) {
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = fakeSpawn;
    delete require.cache[SERVICE_PATH];
    try {
        return require(SERVICE_PATH);
    } finally {
        childProcess.spawn = originalSpawn;
        delete require.cache[SERVICE_PATH];
    }
}

/**
 * Build a spawn stub whose outcome per binary is decided by `behavior`.
 *
 * Outcomes: a number (exit code emitted via 'close'), 'error' (emits 'error'),
 * 'throw' (spawn throws synchronously), 'hang' (emits nothing).
 *
 * @param {(cliName: string) => number|string} behavior
 * @returns {{ spawn: Function, calls: Array<object> }}
 */
function createSpawnStub(behavior) {
    const calls = [];
    const spawn = (cmd, args, options) => {
        const call = { cmd, args, options, child: null };
        calls.push(call);

        const outcome = behavior(args[0]);
        if (outcome === 'throw') {
            throw new Error('spawn failed synchronously');
        }

        const child = new EventEmitter();
        child.killed = false;
        child.kill = () => {
            child.killed = true;
            return true;
        };
        call.child = child;

        if (outcome === 'error') {
            setImmediate(() => child.emit('error', new Error('ENOENT')));
        } else if (typeof outcome === 'number') {
            setImmediate(() => child.emit('close', outcome));
        }
        return child;
    };
    return { spawn, calls };
}

// ── detectInstalledAsync ──────────────────────────────────────────────────

test('detectInstalledAsync reports true for exit code 0 and false otherwise', async () => {
    const stub = createSpawnStub(cli => (cli === 'claude' ? 0 : 1));
    const service = loadServiceWithSpawn(stub.spawn);

    assert.equal(await service.detectInstalledAsync('claude'), true);
    assert.equal(await service.detectInstalledAsync('codex'), false);
});

test('detectInstalledAsync looks the binary up without a shell and without a window', async () => {
    const stub = createSpawnStub(() => 0);
    const service = loadServiceWithSpawn(stub.spawn);

    await service.detectInstalledAsync('grok');

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.cmd, process.platform === 'win32' ? 'where.exe' : 'which');
    assert.deepEqual(call.args, ['grok']);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
});

test('detectInstalledAsync reports false when the lookup process fails to start', async () => {
    const stub = createSpawnStub(() => 'error');
    const service = loadServiceWithSpawn(stub.spawn);

    assert.equal(await service.detectInstalledAsync('claude'), false);
});

test('detectInstalledAsync reports false instead of rejecting when spawn throws synchronously', async () => {
    const stub = createSpawnStub(() => 'throw');
    const service = loadServiceWithSpawn(stub.spawn);

    assert.equal(await service.detectInstalledAsync('claude'), false);
});

test('detectInstalledAsync gives up after the timeout and kills the lookup process', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stub = createSpawnStub(() => 'hang');
    const service = loadServiceWithSpawn(stub.spawn);

    const pending = service.detectInstalledAsync('claude');
    t.mock.timers.tick(INSTALL_PROBE_TIMEOUT_MS);

    assert.equal(await pending, false);
    assert.equal(stub.calls[0].child.killed, true);
});

test('detectInstalledAsync ignores a late close event after the timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stub = createSpawnStub(() => 'hang');
    const service = loadServiceWithSpawn(stub.spawn);

    const pending = service.detectInstalledAsync('claude');
    t.mock.timers.tick(INSTALL_PROBE_TIMEOUT_MS);
    stub.calls[0].child.emit('close', 0);

    assert.equal(await pending, false);
});

// ── detectAllInstalled ────────────────────────────────────────────────────

test('detectAllInstalled probes every CLI once and returns a full map', async () => {
    const stub = createSpawnStub(cli => (cli === 'claude' || cli === 'agy' ? 0 : 1));
    const service = loadServiceWithSpawn(stub.spawn);

    const result = await service.detectAllInstalled();

    assert.deepEqual(result, { claude: true, codex: false, grok: false, agy: true });
    assert.deepEqual(
        stub.calls.map(call => call.args[0]).sort(),
        service.ALL_CLIS.slice().sort()
    );
});

test('detectAllInstalled serves repeated calls from the cache within the TTL', async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const stub = createSpawnStub(() => 0);
    const service = loadServiceWithSpawn(stub.spawn);

    await service.detectAllInstalled();
    const probesAfterFirstCall = stub.calls.length;

    now += INSTALL_CACHE_TTL_MS - 1000;
    const cached = await service.detectAllInstalled();

    assert.equal(stub.calls.length, probesAfterFirstCall);
    assert.deepEqual(cached, { claude: true, codex: true, grok: true, agy: true });
});

test('detectAllInstalled hands out copies so callers cannot corrupt the cache', async () => {
    const stub = createSpawnStub(() => 0);
    const service = loadServiceWithSpawn(stub.spawn);

    const first = await service.detectAllInstalled();
    first.claude = false;
    const second = await service.detectAllInstalled();

    assert.equal(second.claude, true);
});

test('detectAllInstalled probes again once the TTL has expired', async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const stub = createSpawnStub(() => 0);
    const service = loadServiceWithSpawn(stub.spawn);

    await service.detectAllInstalled();
    const probesAfterFirstCall = stub.calls.length;

    now += INSTALL_CACHE_TTL_MS;
    await service.detectAllInstalled();

    assert.equal(stub.calls.length, probesAfterFirstCall * 2);
});

test('detectAllInstalled bypasses a fresh cache when forceRefresh is set', async () => {
    let installed = false;
    const stub = createSpawnStub(() => (installed ? 0 : 1));
    const service = loadServiceWithSpawn(stub.spawn);

    const before = await service.detectAllInstalled();
    installed = true;
    const after = await service.detectAllInstalled({ forceRefresh: true });

    assert.equal(before.claude, false);
    assert.equal(after.claude, true);
    assert.equal(stub.calls.length, service.ALL_CLIS.length * 2);
});

test('detectAllInstalled lets concurrent callers share one in-flight probe', async () => {
    const stub = createSpawnStub(() => 0);
    const service = loadServiceWithSpawn(stub.spawn);

    const [first, second] = await Promise.all([
        service.detectAllInstalled(),
        service.detectAllInstalled({ forceRefresh: true })
    ]);

    assert.equal(stub.calls.length, service.ALL_CLIS.length);
    assert.deepEqual(first, second);
});

test('detectInstalledAsync runs the lookup from an existing working directory', async () => {
    const stub = createSpawnStub(() => 0);
    const service = loadServiceWithSpawn(stub.spawn);

    await service.detectInstalledAsync('claude');

    assert.equal(stub.calls.length, 1);
    assert.equal(typeof stub.calls[0].options.cwd, 'string');
    assert.ok(stub.calls[0].options.cwd.length > 0);
    assert.equal(fs.existsSync(stub.calls[0].options.cwd), true);
});

test('detectAllInstalled caches clean negative results (exit code 1) for the full 5-minute TTL', async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const stub = createSpawnStub(() => 1);
    const service = loadServiceWithSpawn(stub.spawn);

    const first = await service.detectAllInstalled();
    assert.deepEqual(first, { claude: false, codex: false, grok: false, agy: false });
    const probesAfterFirstCall = stub.calls.length;

    // Well past the short retry TTL, a clean code === 1 result must still be served from cache.
    now += INSTALL_CACHE_TTL_MS - 1000;
    const second = await service.detectAllInstalled();

    assert.equal(stub.calls.length, probesAfterFirstCall);
    assert.deepEqual(second, { claude: false, codex: false, grok: false, agy: false });
});

test('detectAllInstalled preserves last known state and uses short retry TTL when a probe times out', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);

    let mode = 'healthy';
    const stub = createSpawnStub((cli) => {
        if (mode === 'healthy') {
            return cli === 'claude' || cli === 'codex' ? 0 : 1;
        }
        if (mode === 'post-sleep-timeout') {
            if (cli === 'claude') return 'hang';
            if (cli === 'codex') return 1;
            if (cli === 'grok') return 0;
            return 1;
        }
        return cli === 'claude' ? 0 : 1;
    });
    const service = loadServiceWithSpawn(stub.spawn);

    // 1. Warm the cache while healthy.
    const initial = await service.detectAllInstalled();
    assert.deepEqual(initial, { claude: true, codex: true, grok: false, agy: false });

    // 2. Expire the 5-minute cache and simulate a post-hibernate timeout on claude.
    now += INSTALL_CACHE_TTL_MS;
    mode = 'post-sleep-timeout';
    const duringWakePromise = service.detectAllInstalled();
    // Let the non-hanging CLIs emit their 'close' events via setImmediate before ticking timeout.
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(INSTALL_PROBE_TIMEOUT_MS);
    const duringWake = await duringWakePromise;

    // claude keeps its previous true value; codex and grok reflect their clean exit codes.
    assert.deepEqual(duringWake, { claude: true, codex: false, grok: true, agy: false });
    const callsAfterTimeoutProbe = stub.calls.length;

    // 3. Within the short retry backoff, repeated calls do not storm process creation.
    now += INSTALL_RETRY_TTL_MS - 500;
    await service.detectAllInstalled();
    assert.equal(stub.calls.length, callsAfterTimeoutProbe);

    // 4. Right after the short retry backoff (not 5 minutes!), the service probes again.
    now += 600;
    mode = 'recovered';
    const recovered = await service.detectAllInstalled();
    assert.equal(stub.calls.length, callsAfterTimeoutProbe + service.ALL_CLIS.length);
    assert.deepEqual(recovered, { claude: true, codex: false, grok: false, agy: false });
});

test('detectAllInstalled does not poison the cache for 5 minutes when cold-start probes fail to spawn', async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);

    let failing = true;
    const stub = createSpawnStub((cli) => {
        if (failing) return 'error';
        return cli === 'codex' ? 0 : 1;
    });
    const service = loadServiceWithSpawn(stub.spawn);

    const coldFailure = await service.detectAllInstalled();
    assert.deepEqual(coldFailure, { claude: false, codex: false, grok: false, agy: false });

    // A reload a few seconds later (after INSTALL_RETRY_TTL_MS, well under 5 minutes) re-probes.
    failing = false;
    now += INSTALL_RETRY_TTL_MS;
    const recovered = await service.detectAllInstalled();
    assert.deepEqual(recovered, { claude: false, codex: true, grok: false, agy: false });
});

test('detectAllInstalled treats abnormal exit codes (e.g. where.exe code 2) as unreliable', async (t) => {
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);

    let codeForClaude = 0;
    const stub = createSpawnStub(cli => (cli === 'claude' ? codeForClaude : 1));
    const service = loadServiceWithSpawn(stub.spawn);

    assert.equal((await service.detectAllInstalled()).claude, true);

    // Exit code 2 must preserve previous state and retry after INSTALL_RETRY_TTL_MS, not 5 minutes.
    now += INSTALL_CACHE_TTL_MS;
    codeForClaude = 2;
    assert.equal((await service.detectAllInstalled()).claude, true);

    now += INSTALL_RETRY_TTL_MS;
    codeForClaude = 1;
    assert.equal((await service.detectAllInstalled()).claude, false);
});
