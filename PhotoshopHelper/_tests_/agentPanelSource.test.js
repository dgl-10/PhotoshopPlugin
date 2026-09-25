'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// UXP modules import Photoshop-only packages and therefore cannot be executed in Node's
// test process. These focused source-contract checks protect the small but important UI
// lifecycle boundary without pretending to emulate Photoshop or Spectrum components.
const repositoryRoot = path.resolve(__dirname, '..', '..');

/**
 * Read a repository source file as UTF-8.
 *
 * @param {...string} parts - Path components below the repository root.
 * @returns {string} File contents.
 */
function source(...parts) {
    return fs.readFileSync(path.join(repositoryRoot, ...parts), 'utf8');
}

test('AI Assist contains no rollback surface and shows Abort only for an active task', () => {
    const html = source('index.html');
    const panel = source('modules', 'agent-panel.js');
    const api = source('PhotoshopHelper', 'agent', 'agent-api.js');
    const service = source('PhotoshopHelper', 'agent', 'index.js');
    const handlers = source('modules', 'command-handlers.js');
    const document = source('modules', 'agent-document.js');
    const completeSurface = [html, panel, api, service, handlers, document].join('\n');

    assert.match(html, /id="assistant-abort"[^>]*style="display: none"/);
    assert.match(panel, /hasActiveTask = Boolean\(state\.task\)/);
    assert.match(panel, /setShown\(byId\('assistant-abort'\), hasActiveTask\)/);

    assert.doesNotMatch(completeSurface, /assistant-rollback/);
    assert.doesNotMatch(completeSurface, /agent_rollback/);
    assert.doesNotMatch(completeSurface, /router\.post\('\/rollback'/);
    assert.doesNotMatch(completeSurface, /ensureRollbackPoint|rollbackToStart/);
});

test('closing AI Assist disconnects the socket while preserving a resumable task', () => {
    const html = source('index.html');
    const panel = source('modules', 'agent-panel.js');
    const service = source('PhotoshopHelper', 'agent', 'index.js');

    // The plugin owns the socket lifecycle: a clean close sends an intentional reason.
    assert.match(panel, /bridgeClient\.disconnect\(\{ reason, reasonCode, intentional: true \}\)/);
    // Helper owns the task lifecycle: no clients suspends, same-runtime reconnect resumes.
    assert.match(service, /if \(event\.clients === 0\)[\s\S]*tasks\.suspend/);
    assert.match(service, /if \(event\.runtimeChanged\)[\s\S]*tasks\.resume/);
    // The behavior is also stated in the actual panel copy, not only in implementation notes.
    assert.match(html, /closing pauses the task/);
});

test('the dialog recognises the abort reason Helper records for Abort task', () => {
    const panel = source('modules', 'agent-panel.js');
    const service = source('PhotoshopHelper', 'agent', 'index.js');

    // The two sides cannot share a module, so the text itself is the contract.
    const reason = service.match(/const ABORTED_BY_PERSON = '([^']+)'/);
    assert.ok(reason, 'Helper defines the abort reason');
    assert.ok(panel.includes(`const ABORTED_BY_PERSON = '${reason[1]}'`), 'the dialog uses the same text');
});
