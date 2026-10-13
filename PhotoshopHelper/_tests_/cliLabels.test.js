'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// The order of these requires is the point of this file. main.js loads apiGenerator
// first, which pulls in cli-image-provider, cli-service, cli-runner and mcp-setup one
// inside the other. mcp-setup once took the names from cli-service and received nothing,
// because cli-service was still loading at that moment; the AI Assist window then had no
// setup commands to show.
require('../apiGenerator');
const { CLI_LABELS } = require('../agent/cli-labels');
const cliService = require('../agent/cli-service');
const { buildInstallCommands } = require('../agent/mcp-setup');
const { getEligibleCliOptions, CLI_PROFILES } = require('../agent/cli-image-provider');

test('the registration commands carry the shared CLI names in the main.js load order', () => {
    const commands = buildInstallCommands({ port: 18345 });

    assert.deepEqual(
        commands.map(entry => [entry.cli, entry.label]),
        [
            ['claude', CLI_LABELS.claude],
            ['codex', CLI_LABELS.codex],
            ['grok', CLI_LABELS.grok],
            ['agy', CLI_LABELS.agy]
        ]
    );
    for (const entry of commands) {
        assert.equal(typeof entry.label, 'string');
        assert.notEqual(entry.label, '');
    }
});

test('cli-service hands out the same names it re-exports', () => {
    assert.equal(cliService.CLI_LABELS, CLI_LABELS);
    assert.deepEqual(Object.keys(CLI_LABELS).sort(), cliService.ALL_CLIS.slice().sort());
});

test('WebHelper names a CLI the same way in its dropdown and in its messages', () => {
    const eligible = {
        installed: true,
        enabled: true,
        nativeImageGen: true,
        tiers: { medium: { model: 'some-model' } }
    };
    const options = getEligibleCliOptions(
        Object.fromEntries(cliService.ALL_CLIS.map(cli => [cli, eligible]))
    );

    assert.equal(options.length, cliService.ALL_CLIS.length);
    for (const option of options) {
        assert.equal(option.label, CLI_LABELS[option.value]);
        assert.equal(CLI_PROFILES[option.value].label, CLI_LABELS[option.value]);
    }
});
