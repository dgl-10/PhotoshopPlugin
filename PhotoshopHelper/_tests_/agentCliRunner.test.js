'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildArgs, parseOutput, sanitize, readAgentConfig } = require('../agent/cli-runner');
const { buildInstallCommands, TOKEN_ENV_VAR, SERVER_NAME } = require('../agent/mcp-setup');

test('Claude Code is launched with the MCP tools explicitly allowed', () => {
    const { binary, args } = buildArgs({
        cli: 'claude', model: 'haiku', prompt: 'do the thing'
    });

    assert.equal(binary, 'claude');
    // Without this the headless run denies the tools silently and the model answers that
    // it needs permission.
    const allowed = args[args.indexOf('--allowedTools') + 1];
    assert.match(allowed, new RegExp(`mcp__${SERVER_NAME}__\\*`));
    assert.ok(allowed.includes('WebSearch'), 'the agent must be able to look things up');
    assert.deepEqual(args.slice(0, 2), ['-p', 'do the thing']);
});

test('a saved session id resumes the existing CLI session', () => {
    const claude = buildArgs({ cli: 'claude', prompt: 'more', sessionId: 'abc-123' });
    assert.ok(claude.args.includes('--resume'));
    assert.ok(claude.args.includes('abc-123'));

    const grok = buildArgs({
        cli: 'grok',
        prompt: 'more',
        sessionId: 'sess-1',
        cwd: 'C:/work'
    });
    assert.ok(grok.args.indexOf('--cwd') < grok.args.indexOf('--resume'));
    assert.deepEqual(grok.args.slice(grok.args.indexOf('--resume'), grok.args.indexOf('--resume') + 2), [
        '--resume', 'sess-1'
    ]);
    assert.ok(!grok.args.includes('--session-id'));

    const codex = buildArgs({
        cli: 'codex',
        prompt: 'more',
        sessionId: 'thread-9',
        cwd: 'C:/work'
    });
    const resumeIndex = codex.args.indexOf('resume');

    // `resume` is a subcommand, so exec-level flags must come before it.
    assert.ok(resumeIndex > codex.args.indexOf('--color'));
    assert.ok(resumeIndex > codex.args.indexOf('-C'));
    assert.deepEqual(codex.args.slice(resumeIndex, resumeIndex + 2), ['resume', 'thread-9']);
    assert.equal(codex.args.at(-1), 'more');
});

test('Codex is launched the only way it works on Windows', () => {
    const { args } = buildArgs({ cli: 'codex', prompt: 'do it', outputFile: 'C:/tmp/out.txt' });

    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(args.includes('--json'));
    assert.equal(args.at(-1), 'do it');
});

test('Grok needs its folder trusted', () => {
    const { args } = buildArgs({ cli: 'grok', prompt: 'do it', cwd: 'C:/work' });

    assert.ok(args.includes('--trust'));
    assert.ok(args.includes('--always-approve'));
});

test('Helper refuses to launch Antigravity', () => {
    assert.throws(() => buildArgs({ cli: 'agy', prompt: 'x' }), /cannot launch/);
});

test('the answer and the session id are read out of what the CLI printed', () => {
    const claude = parseOutput('claude', '{"result":"all done","session_id":"s-1"}', null);
    assert.deepEqual(claude, { text: 'all done', sessionId: 's-1' });

    const grok = parseOutput(
        'grok',
        '{"text":"see the } character","stopReason":"end_turn","sessionId":"s-9"}',
        null
    );
    assert.deepEqual(grok, { text: 'see the } character', sessionId: 's-9', error: null });

    const grokEmpty = parseOutput('grok', '{"text":"","sessionId":"s-0"}', null);
    assert.equal(grokEmpty.text, '');
    assert.equal(grokEmpty.sessionId, 's-0');

    const grokFailed = parseOutput('grok', '{"type":"error","message":"Could not start session"}', null);
    assert.equal(grokFailed.text, null);
    assert.equal(grokFailed.error, 'Could not start session');

    const codex = parseOutput(
        'codex',
        '{"thread_id":"t-2"}\n{"type":"item.completed","item":{"content":[{"type":"text","text":"done"}]}}',
        null
    );
    assert.deepEqual(codex, { text: 'done', sessionId: 't-2' });
});

test('secrets are stripped from text returned to a caller', () => {
    const cleaned = sanitize('failed with Authorization: Bearer abc123secret and sk-abcdefghijklmnopqrstuvwxyz');

    assert.doesNotMatch(cleaned, /abc123secret/);
    assert.doesNotMatch(cleaned, /abcdefghijklmnopqrstuvwxyz/);
});

test('the agent cannot be launched unless Helper is set to a CLI', () => {
    const originalMode = process.env.LLM_MODE;
    const originalCli = process.env.LLM_CLI_TYPE;

    try {
        process.env.LLM_MODE = 'api';
        process.env.LLM_CLI_TYPE = 'claude';
        const config = readAgentConfig();

        assert.equal(config.configured, false);
        assert.match(config.problems.join(' '), /LLM_MODE must be "cli"/);
    } finally {
        if (originalMode === undefined) delete process.env.LLM_MODE;
        else process.env.LLM_MODE = originalMode;
        if (originalCli === undefined) delete process.env.LLM_CLI_TYPE;
        else process.env.LLM_CLI_TYPE = originalCli;
    }
});

test('the registration command refers to the environment variable, not the token', () => {
    const commands = buildInstallCommands({ port: 18345 });

    assert.equal(commands.length, 4);
    for (const entry of commands) {
        assert.match(entry.command, /127\.0\.0\.1:18345\/mcp/);
        assert.match(entry.command, new RegExp(TOKEN_ENV_VAR));
    }

    // Nothing here turns off the user's own MCP servers.
    assert.ok(commands.every(entry => !/strict/i.test(entry.command)));

    const grok = commands.find(entry => entry.cli === 'grok');
    const header = `Authorization: Bearer \${${TOKEN_ENV_VAR}}`;
    assert.equal(
        grok.copyCommand,
        `grok mcp add --transport http ${SERVER_NAME} http://127.0.0.1:18345/mcp --header '${header}'`
    );
    if (process.platform === 'win32') {
        assert.equal(
            grok.command,
            `grok mcp add --transport http ${SERVER_NAME} http://127.0.0.1:18345/mcp --header "${header}"`
        );
    } else {
        assert.equal(grok.command, grok.copyCommand);
    }
    assert.doesNotMatch(grok.note, /has not been verified|by hand/i);
});
