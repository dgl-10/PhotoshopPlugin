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

test('the AI line contains no rollback surface and no old dialog markup', () => {
    const html = source('index.html');
    const line = source('modules', 'agent-line.js');
    const indexJs = source('index.js');
    const api = source('PhotoshopHelper', 'agent', 'agent-api.js');
    const service = source('PhotoshopHelper', 'agent', 'index.js');
    const handlers = source('modules', 'command-handlers.js');
    const document = source('modules', 'agent-document.js');
    const completeSurface = [html, line, indexJs, api, service, handlers, document].join('\n');

    // The old fixed-size dialog is gone: no window that resizes itself is allowed in UXP
    // for this feature (see the "hard requirements" in ui02.00).
    assert.doesNotMatch(completeSurface, /assistant-dialog/);
    assert.doesNotMatch(completeSurface, /resizeTo/);
    assert.doesNotMatch(completeSurface, /fitDialog/);

    assert.doesNotMatch(completeSurface, /assistant-rollback/);
    assert.doesNotMatch(completeSurface, /agent_rollback/);
    assert.doesNotMatch(completeSurface, /router\.post\('\/rollback'/);
    assert.doesNotMatch(completeSurface, /ensureRollbackPoint|rollbackToStart/);
});

test('the line is hidden by default and Abort task only shows for an active task', () => {
    const html = source('index.html');
    const line = source('modules', 'agent-line.js');

    // Without turning the line on, the panel looks exactly as it always has.
    assert.match(html, /id="agent-line" class="agent-line" style="display: none"/);
    assert.match(html, /id="agent-line-abort"[^>]*style="display: none"/);

    // Abort task is shown only while a task exists (running or suspended), and hidden by
    // every other render path.
    assert.match(line, /function renderRunningTask[\s\S]*setShown\(abort, true\)/);
    assert.match(line, /function renderSuspendedTask[\s\S]*setShown\(byId\('agent-line-abort'\), true\)/);
    assert.match(line, /function renderPlain[\s\S]*setShown\(byId\('agent-line-abort'\), false\)/);
    assert.match(line, /function renderFinishedTask[\s\S]*setShown\(byId\('agent-line-abort'\), false\)/);
});

test('turning the line off disconnects the socket while preserving a resumable task', () => {
    const line = source('modules', 'agent-line.js');
    const service = source('PhotoshopHelper', 'agent', 'index.js');

    // The plugin owns the socket lifecycle: turning the line off sends an intentional
    // reason, whether the person clicked the menu item or the hour-without-tasks clock
    // fired on its own.
    assert.match(line, /function disable\(reasonCode, reason\)/);
    assert.match(line, /disconnectChannel\(reasonCode, reason \|\| 'FromPS \/ ToPS AI line turned off'\)/);
    assert.match(line, /bridgeClient\.disconnect\(\{ reason, reasonCode, intentional: true \}\)/);

    // Helper owns the task lifecycle: no clients suspends, same-runtime reconnect resumes.
    assert.match(service, /if \(event\.clients === 0\)[\s\S]*tasks\.suspend/);
    assert.match(service, /if \(event\.runtimeChanged\)[\s\S]*tasks\.resume/);
});

test('the hour-without-tasks clock turns the line off with its own reason code', () => {
    const line = source('modules', 'agent-line.js');
    const service = source('PhotoshopHelper', 'agent', 'index.js');

    assert.match(line, /function checkIdleTimeout/);
    assert.match(line, /disable\('ai-line-idle-timeout'/);
    // Helper turns that code into a sentence the agent can act on.
    assert.match(service, /'ai-line-idle-timeout':/);
    assert.match(service, /'ai-line-off':/);
});

test('the line recognises the abort reason Helper records for Abort task', () => {
    const line = source('modules', 'agent-line.js');
    const service = source('PhotoshopHelper', 'agent', 'index.js');

    // The two sides cannot share a module, so the text itself is the contract.
    const reason = service.match(/const ABORTED_BY_PERSON = '([^']+)'/);
    assert.ok(reason, 'Helper defines the abort reason');
    assert.ok(line.includes(`const ABORTED_BY_PERSON = '${reason[1]}'`), 'the line uses the same text');
});

test('every command Helper sends to the plugin has a handler there', () => {
    const tools = source('PhotoshopHelper', 'agent', 'mcp-tools.js');
    const handlers = source('modules', 'command-handlers.js');

    // A name that exists on one side only fails in Photoshop as "Unknown command", which no
    // test in Node would otherwise notice.
    const sent = [...new Set([...tools.matchAll(/callPlugin\('([a-z_]+)'/g)].map(match => match[1]))];
    assert.ok(sent.includes('agent_from_ps_capture'));
    assert.ok(sent.includes('agent_to_ps_load_file'));
    assert.ok(sent.includes('agent_to_ps_place_back'));

    const table = handlers.match(/const HANDLERS = \{([\s\S]*?)\};/);
    assert.ok(table, 'command-handlers.js keeps its HANDLERS table');
    for (const name of sent) {
        assert.match(table[1], new RegExp(`\\b${name}:`), `the plugin has no handler for ${name}`);
    }
});

test('the panel hands its FromPS and ToPS cards to the agent commands', () => {
    const indexJs = source('index.js');
    const handlers = source('modules', 'command-handlers.js');

    assert.match(indexJs, /commandHandlers\.connectPanel\(createPanelLink\(\)\)/);
    // The agent's capture goes through the same function as the Capture button.
    assert.match(indexJs, /const payload = await ps\.captureSelection\([^)]*\);\s*await addCapture\(payload\);/);
    assert.match(indexJs, /await addCapture\(payload, 'Agent captured'\)/);
    // Every capture gets an id that is never reused, so the agent can name it later.
    assert.match(indexJs, /payload\.id = nextCaptureId\+\+;/);
    // The agent's Place Back without its own choice feathers the way the person's would.
    assert.match(indexJs, /const effectiveFeather = currentPlaceBackFeather\(capturedPayload\.isSelectAll\);/);
    assert.match(indexJs, /return currentPlaceBackFeather\(isSelectAll\);/);
    // The agent's commands open one modal scope and do not open a second one inside it.
    assert.match(handlers, /ps\.captureSelectionInModal\(/);
    assert.match(handlers, /ps\.placeBackInModal\(/);
    assert.doesNotMatch(handlers, /ps\.captureSelection\(|ps\.placeBack\(/);
    // The capture is always named by id and checked against the task's document.
    assert.match(handlers, /if \(!Number\.isInteger\(payload\.captureId\)\)/);
    assert.match(handlers, /capture\.context\.documentId !== doc\.id/);
});
