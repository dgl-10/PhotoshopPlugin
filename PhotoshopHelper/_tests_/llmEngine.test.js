const assert = require('node:assert/strict');
const test = require('node:test');

const {
    getLlmConfig,
    getLlmCapabilities,
    sendLlmQuery,
    _internal: {
        buildCliArgs,
        parseCliOutput,
        parseFirstJson,
        parseCodexJsonl,
        sanitizeError,
        VALID_MODES,
        VALID_API_PROVIDERS,
        VALID_CLI_TYPES
    }
} = require('../llm-engine');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Temporarily override environment variables and restore them after the test.
 *
 * @param {import('node:test').TestContext} context
 * @param {Record<string, string|undefined>} overrides
 */
function withEnv(context, overrides) {
    const saved = {};
    for (const [key, value] of Object.entries(overrides)) {
        saved[key] = process.env[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    context.after(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Configuration Tests
// ══════════════════════════════════════════════════════════════════════════════

test('getLlmConfig returns unconfigured when LLM_MODE is not set', (t) => {
    withEnv(t, { LLM_MODE: undefined });
    const config = getLlmConfig();
    assert.equal(config.configured, false);
    assert.equal(config.mode, null);
    assert.ok(config.errors.length > 0);
    assert.ok(config.errors[0].includes('LLM_MODE'));
});

test('getLlmConfig validates LLM_MODE value', (t) => {
    withEnv(t, { LLM_MODE: 'invalid' });
    const config = getLlmConfig();
    assert.equal(config.configured, false);
    assert.ok(config.errors.some(e => e.includes('"api" or "cli"')));
});

test('getLlmConfig validates API mode requires provider, model, and key', (t) => {
    withEnv(t, {
        LLM_MODE: 'api',
        LLM_API_PROVIDER: undefined,
        LLM_API_MODEL: undefined,
        OPENAI_API_KEY: undefined
    });
    const config = getLlmConfig();
    assert.equal(config.configured, false);
    assert.ok(config.errors.some(e => e.includes('LLM_API_PROVIDER')));
    assert.ok(config.errors.some(e => e.includes('LLM_API_MODEL')));
});

test('getLlmConfig accepts valid API configuration', (t) => {
    withEnv(t, {
        LLM_MODE: 'api',
        LLM_API_PROVIDER: 'openai',
        LLM_API_MODEL: 'gpt-5-mini',
        OPENAI_API_KEY: 'sk-test-key-12345678901234567890'
    });
    const config = getLlmConfig();
    assert.equal(config.configured, true);
    assert.equal(config.mode, 'api');
    assert.equal(config.apiProvider, 'openai');
    assert.equal(config.apiModel, 'gpt-5-mini');
    assert.deepEqual(config.errors, []);
});

test('getLlmConfig validates CLI mode requires type and model', (t) => {
    withEnv(t, {
        LLM_MODE: 'cli',
        LLM_CLI_TYPE: undefined,
        LLM_CLI_MODEL: undefined
    });
    const config = getLlmConfig();
    assert.equal(config.configured, false);
    assert.ok(config.errors.some(e => e.includes('LLM_CLI_TYPE')));
    assert.ok(config.errors.some(e => e.includes('LLM_CLI_MODEL')));
});

test('getLlmConfig rejects unknown CLI type', (t) => {
    withEnv(t, {
        LLM_MODE: 'cli',
        LLM_CLI_TYPE: 'unknown',
        LLM_CLI_MODEL: 'some-model'
    });
    const config = getLlmConfig();
    assert.equal(config.configured, false);
    assert.ok(config.errors.some(e => e.includes('unknown')));
});

test('getLlmConfig accepts all valid CLI types', (t) => {
    for (const cliType of VALID_CLI_TYPES) {
        withEnv(t, {
            LLM_MODE: 'cli',
            LLM_CLI_TYPE: cliType,
            LLM_CLI_MODEL: 'test-model'
        });
        const config = getLlmConfig();
        assert.equal(config.configured, true, `CLI type "${cliType}" should be valid`);
        assert.equal(config.cliType, cliType);
    }
});

test('getLlmConfig never exposes API keys', (t) => {
    withEnv(t, {
        LLM_MODE: 'api',
        LLM_API_PROVIDER: 'openai',
        LLM_API_MODEL: 'gpt-5-mini',
        OPENAI_API_KEY: 'sk-secret-key-that-should-not-appear'
    });
    const config = getLlmConfig();
    const serialized = JSON.stringify(config);
    assert.ok(!serialized.includes('sk-secret'), 'Config must not contain API keys');
});

test('getLlmConfig normalizes mode and provider to lowercase', (t) => {
    withEnv(t, {
        LLM_MODE: ' API ',
        LLM_API_PROVIDER: ' OpenAI ',
        LLM_API_MODEL: 'gpt-5-mini',
        OPENAI_API_KEY: 'sk-test-key-12345678901234567890'
    });
    const config = getLlmConfig();
    assert.equal(config.mode, 'api');
    assert.equal(config.apiProvider, 'openai');
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Capabilities Tests
// ══════════════════════════════════════════════════════════════════════════════

test('getLlmCapabilities returns null mode when unconfigured', (t) => {
    withEnv(t, { LLM_MODE: undefined });
    const caps = getLlmCapabilities();
    assert.equal(caps.mode, null);
    assert.equal(caps.supportsImages, false);
});

test('getLlmCapabilities returns correct API capabilities', (t) => {
    withEnv(t, {
        LLM_MODE: 'api',
        LLM_API_PROVIDER: 'openai',
        LLM_API_MODEL: 'gpt-5-mini',
        OPENAI_API_KEY: 'sk-test-key-12345678901234567890'
    });
    const caps = getLlmCapabilities();
    assert.equal(caps.mode, 'api');
    assert.equal(caps.supportsImages, true);
    assert.equal(caps.requiresUserSubscription, false);
});

test('getLlmCapabilities returns correct CLI capabilities', (t) => {
    withEnv(t, {
        LLM_MODE: 'cli',
        LLM_CLI_TYPE: 'codex',
        LLM_CLI_MODEL: 'gpt-5.6-luna'
    });
    const caps = getLlmCapabilities();
    assert.equal(caps.mode, 'cli');
    assert.equal(caps.supportsSessionResume, true);
    assert.equal(caps.requiresUserSubscription, true);
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. CLI Argument Building Tests
// ══════════════════════════════════════════════════════════════════════════════

test('buildCliArgs for claude produces correct argv', () => {
    const { binary, args, parseMode } = buildCliArgs('claude', {
        prompt: 'Hello world',
        model: 'haiku'
    });
    assert.equal(binary, 'claude');
    assert.equal(parseMode, 'json');
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('Hello world'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('json'));
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('haiku'));
    assert.ok(args.includes('--permission-mode'));
    assert.ok(args.includes('dontAsk'));
    assert.ok(args.includes('--allowedTools'));
    assert.ok(args.includes('Read'));
});

test('buildCliArgs for codex produces correct argv with mandatory flags', () => {
    const { binary, args, parseMode } = buildCliArgs('codex', {
        prompt: 'Test prompt',
        model: 'gpt-5.6-luna',
        cwd: 'C:\\Projects\\test',
        outputFile: 'C:\\tmp\\out.txt'
    });
    assert.equal(binary, 'codex');
    assert.equal(parseMode, 'file');
    assert.ok(args.includes('exec'));
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(args.includes('--skip-git-repo-check'));
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('-m'));
    assert.ok(args.includes('gpt-5.6-luna'));
    assert.ok(args.includes('-c'));
    assert.ok(args.includes('model_reasoning_effort=low'));
    assert.ok(args.includes('-C'));
    assert.ok(args.includes('-o'));
    // Prompt is the last positional argument
    assert.equal(args[args.length - 1], 'Test prompt');
});

test('buildCliArgs for codex passes image via -i flag', () => {
    const { args } = buildCliArgs('codex', {
        prompt: 'Analyze image',
        model: 'gpt-5.6-luna',
        images: ['C:\\images\\test.png']
    });
    assert.ok(args.includes('-i'));
    assert.ok(args.includes('C:\\images\\test.png'));
});

test('buildCliArgs for agy produces correct argv', () => {
    const { binary, args, parseMode } = buildCliArgs('agy', {
        prompt: 'Test',
        model: 'gemini-3.7-flash-high'
    });
    assert.equal(binary, 'agy');
    assert.equal(parseMode, 'json');
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('Test'));
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('gemini-3.7-flash-high'));
    assert.ok(args.includes('--output-format'));
});

test('buildCliArgs for grok produces correct argv', () => {
    const { binary, args, parseMode } = buildCliArgs('grok', {
        prompt: 'Test',
        model: 'grok-4.5',
        cwd: 'C:\\Projects\\test'
    });
    assert.equal(binary, 'grok');
    assert.equal(parseMode, 'json');
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('--no-subagents'));
    assert.ok(args.includes('-m'));
    assert.ok(args.includes('grok-4.5'));
    assert.ok(args.includes('--cwd'));
});

test('buildCliArgs throws for unknown CLI type', () => {
    assert.throws(
        () => buildCliArgs('unknown', { prompt: 'test' }),
        /Unknown CLI type/
    );
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Output Parsing Tests
// ══════════════════════════════════════════════════════════════════════════════

test('parseFirstJson extracts JSON from mixed output', () => {
    const input = 'Some log line\n{"result": "hello", "session_id": "abc"}\nMore text';
    const json = parseFirstJson(input);
    assert.deepEqual(json, { result: 'hello', session_id: 'abc' });
});

test('parseFirstJson returns null for non-JSON input', () => {
    assert.equal(parseFirstJson('no json here'), null);
    assert.equal(parseFirstJson(''), null);
});

test('parseFirstJson handles nested JSON', () => {
    const input = '{"outer": {"inner": "value"}, "ok": true}';
    const json = parseFirstJson(input);
    assert.deepEqual(json, { outer: { inner: 'value' }, ok: true });
});

test('parseCliOutput extracts Claude response from JSON', () => {
    const stdout = '{"result": "Hello from Claude", "session_id": "s1"}';
    const text = parseCliOutput('claude', 'json', stdout, null);
    assert.equal(text, 'Hello from Claude');
});

test('parseCliOutput extracts Agy response from JSON', () => {
    const stdout = '{"response": "Hello from Agy", "conversation_id": "c1", "status": "SUCCESS"}';
    const text = parseCliOutput('agy', 'json', stdout, null);
    assert.equal(text, 'Hello from Agy');
});

test('parseCliOutput extracts Grok response from JSON', () => {
    const stdout = '{"text": "Hello from Grok", "sessionId": "g1"}';
    const text = parseCliOutput('grok', 'json', stdout, null);
    assert.equal(text, 'Hello from Grok');
});

test('parseCliOutput returns null for empty response', () => {
    const stdout = '{"result": "", "session_id": "s1"}';
    const text = parseCliOutput('claude', 'json', stdout, null);
    assert.equal(text, null);
});

test('parseCodexJsonl extracts text from JSONL stream', () => {
    const stdout = [
        '{"type":"thread.started","thread_id":"t1"}',
        '{"type":"item.completed","item":{"content":[{"type":"text","text":"Hello from Codex"}]}}',
        '{"type":"turn.completed"}'
    ].join('\n');
    const text = parseCodexJsonl(stdout);
    assert.equal(text, 'Hello from Codex');
});

test('parseCodexJsonl returns null when no text found', () => {
    const stdout = '{"type":"thread.started","thread_id":"t1"}';
    assert.equal(parseCodexJsonl(stdout), null);
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Sanitization Tests
// ══════════════════════════════════════════════════════════════════════════════

test('sanitizeError removes API key patterns', () => {
    const dirty = 'Error: Invalid key sk-proj-1234567890abcdefghijklmnop';
    const clean = sanitizeError(dirty);
    assert.ok(!clean.includes('sk-proj-1234'), 'Should not contain API key');
    assert.ok(clean.includes('sk-***'));
});

test('sanitizeError removes Bearer tokens', () => {
    const dirty = 'Authorization: Bearer sk-secrettoken123456789012345';
    const clean = sanitizeError(dirty);
    assert.ok(!clean.includes('secrettoken'));
    assert.ok(clean.includes('Bearer ***'));
});

test('sanitizeError truncates long messages', () => {
    const long = 'x'.repeat(1000);
    const clean = sanitizeError(long);
    assert.ok(clean.length <= 500);
});

test('sanitizeError handles empty and non-string input', () => {
    assert.equal(sanitizeError(''), '');
    assert.equal(sanitizeError(null), '');
    assert.equal(sanitizeError(undefined), '');
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Query Validation Tests
// ══════════════════════════════════════════════════════════════════════════════

test('sendLlmQuery rejects missing prompt', async (t) => {
    withEnv(t, {
        LLM_MODE: 'api',
        LLM_API_PROVIDER: 'openai',
        LLM_API_MODEL: 'gpt-5-mini',
        OPENAI_API_KEY: 'sk-test-key-12345678901234567890'
    });

    const result = await sendLlmQuery({});
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('Prompt'));
});

test('sendLlmQuery rejects non-string prompt', async (t) => {
    withEnv(t, {
        LLM_MODE: 'api',
        LLM_API_PROVIDER: 'openai',
        LLM_API_MODEL: 'gpt-5-mini',
        OPENAI_API_KEY: 'sk-test-key-12345678901234567890'
    });

    const result = await sendLlmQuery({ prompt: 42 });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('string'));
});

test('sendLlmQuery returns error when LLM is not configured', async (t) => {
    withEnv(t, { LLM_MODE: undefined });
    const result = await sendLlmQuery({ prompt: 'Hello' });
    assert.equal(result.ok, false);
    assert.equal(result.mode, 'none');
    assert.ok(result.error.includes('not configured'));
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Enum Integrity Tests
// ══════════════════════════════════════════════════════════════════════════════

test('VALID_MODES contains expected values', () => {
    assert.ok(VALID_MODES.has('api'));
    assert.ok(VALID_MODES.has('cli'));
    assert.equal(VALID_MODES.size, 2);
});

test('VALID_API_PROVIDERS contains openai', () => {
    assert.ok(VALID_API_PROVIDERS.has('openai'));
});

test('VALID_CLI_TYPES contains all four CLIs', () => {
    assert.ok(VALID_CLI_TYPES.has('codex'));
    assert.ok(VALID_CLI_TYPES.has('claude'));
    assert.ok(VALID_CLI_TYPES.has('agy'));
    assert.ok(VALID_CLI_TYPES.has('grok'));
    assert.equal(VALID_CLI_TYPES.size, 4);
});
