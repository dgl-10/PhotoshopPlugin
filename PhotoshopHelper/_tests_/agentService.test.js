'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentService, resolveAgentPaths } = require('../agent');

/**
 * Build the whole service over throwaway folders and an optional fake plugin channel.
 *
 * @param {import('node:test').TestContext} context - Active test context.
 * @param {object|null} [bridge] - Stand-in for the plugin channel.
 * @param {object} [options] - Extra createAgentService options.
 * @returns {object} Service and temporary root.
 */
function makeService(context, bridge = null, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-agent-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const service = createAgentService({
        getBridge: () => bridge,
        paths: resolveAgentPaths({ resourcesPath: root, userDataPath: root }),
        isJournalEnabled: () => true,
        logger: { info() {}, warn() {}, error() {} },
        ...options
    });

    return { service, root };
}

/**
 * Return the standard plugin response used when a task starts.
 *
 * @returns {object} Minimal document and state payload.
 */
function startAnswer() {
    return {
        document: {
            id: 1,
            name: 'test.psd',
            width: 100,
            height: 100,
            resolution: 72,
            colorMode: 'RGB',
            bitsPerChannel: 8,
            layerCount: 1
        },
        status: null
    };
}

test('the paths contain only the knowledge-base layers and journal', () => {
    const paths = resolveAgentPaths({ resourcesPath: '/res', userDataPath: '/data' });

    assert.deepEqual(paths, {
        authorKnowledgeDir: path.resolve('/res', 'knowledge-base'),
        userKnowledgeDir: path.resolve('/data', 'knowledge-base.user'),
        journalDir: path.resolve('/data', 'agent-journal')
    });
});

test('the knowledge base folders are absolute, whatever folder Helper runs from', () => {
    const paths = resolveAgentPaths({ resourcesPath: '.', userDataPath: './data' });

    assert.ok(path.isAbsolute(paths.authorKnowledgeDir));
    assert.ok(path.isAbsolute(paths.userKnowledgeDir));
});

test('the service state contains the MCP task surface only', context => {
    const { service } = makeService(context);
    const state = service.getState();

    assert.equal(state.channel.connected, false);
    assert.equal(state.task, null);
    assert.ok(Array.isArray(state.progress));
    assert.ok(state.knowledgeBase.userDir);
    assert.equal('cli' in state, false);
    assert.equal('rollback' in service, false, 'the removed rollback surface must not return');
});

test('MCP work requires no configuration for launching a command-line agent', async context => {
    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async () => startAnswer(),
        sendCommand: () => 'id'
    };
    const { service } = makeService(context, bridge);

    const started = await service.tools.call('ps_start_task', { intent: 'describe the picture' });
    assert.ok(!started.isError);
    assert.match(started.content[0].text, /Task task-/);
});

test('the tool layer is wired to the service', async context => {
    const { service } = makeService(context);

    assert.equal(service.tools.list().length, 13);

    // With no channel the answer is the sentence the MCP agent is meant to relay.
    const result = await service.tools.call('ps_start_task', { intent: 'anything' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /AI Assist/);
});

test('progress from the tools reaches the plugin state', async context => {
    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async () => startAnswer(),
        sendCommand: () => 'id'
    };
    const { service } = makeService(context, bridge);
    await service.tools.call('ps_start_task', { intent: 'tidy up' });

    const state = service.getState();
    assert.equal(state.task.intent, 'tidy up');
    assert.equal(state.task.documentName, 'test.psd');
    assert.ok(state.progress.some(step => /tidy up/.test(step.text)));
});

test('a dialog disconnect pauses the task and the same runtime resumes it', async context => {
    let connectedClients = 1;
    const bridge = {
        getConnectedClients: () => connectedClients,
        sendCommandAndWait: async () => startAnswer(),
        sendCommand: () => 'id'
    };
    const { service } = makeService(context, bridge);
    await service.tools.call('ps_start_task', { intent: 'recover' });

    connectedClients = 0;
    service.handlePluginConnectionChange({
        type: 'disconnected',
        clients: 0,
        reasonCode: 'assistant-dialog-closed',
        reason: 'AI Assist closed',
        runtimeId: 'runtime-1',
        at: Date.now()
    });

    assert.equal(service.getState().task.state, 'suspended');
    assert.match(service.tasks.describeSuspension(service.tasks.getCurrent()), /AI Assist/);

    connectedClients = 1;
    service.handlePluginConnectionChange({
        type: 'connected',
        clients: 1,
        runtimeId: 'runtime-1',
        previousRuntimeId: 'runtime-1',
        runtimeChanged: false,
        at: Date.now()
    });

    assert.equal(service.getState().task.state, 'running');
});

test('Abort task closes the task and releases the document side', async context => {
    const sent = [];
    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async () => startAnswer(),
        sendCommand: (action, payload) => {
            sent.push({ action, payload });
            return 'id';
        }
    };
    const { service } = makeService(context, bridge);
    await service.tools.call('ps_start_task', { intent: 'work' });

    const stopped = service.stop();
    assert.equal(stopped.stopped, true);
    assert.equal(service.tasks.getCurrent(), null);
    assert.equal(sent.at(-1).action, 'agent_finish_task');

    // AI Assist shows the aborted task, and says "aborted by you" for exactly this reason.
    const finished = service.getState().lastFinishedTask;
    assert.equal(finished.state, 'aborted');
    assert.equal(finished.abortReason, 'the person pressed Abort task');
    assert.equal(finished.intent, 'work');
    assert.ok(finished.startedAt <= finished.finishedAt);
});

/**
 * A plugin channel that answers every task call, enough to start and finish tasks.
 *
 * @returns {object} Fake bridge.
 */
function workingBridge() {
    return {
        getConnectedClients: () => 1,
        sendCommandAndWait: async action => (action === 'agent_start_task'
            ? startAnswer()
            : { status: null }),
        sendCommand: () => 'id'
    };
}

/**
 * @param {object} result - MCP tool result of ps_start_task.
 * @returns {string} The task id it hands out.
 */
function taskIdOf(result) {
    return result.content[0].text.match(/(task-[a-f0-9]+)/)[1];
}

test('a new task clears the previous report and its steps', async context => {
    const { service } = makeService(context, workingBridge());
    const first = await service.tools.call('ps_start_task', { intent: 'first' });
    await service.tools.call('ps_finish_task', { task_id: taskIdOf(first), summary: 'done' });
    assert.equal(service.getState().lastFinishedTask.intent, 'first');

    await service.tools.call('ps_start_task', { intent: 'second' });
    const state = service.getState();
    assert.equal(state.lastFinishedTask, null);
    assert.equal(state.task.intent, 'second');
    assert.ok(state.progress.every(step => step.taskId === state.task.id));
});

test('the first task of a run marks the agent as seen, once', async context => {
    let seen = 0;
    const { service } = makeService(context, workingBridge(), { onAgentSeen: () => { seen += 1; } });
    assert.equal(service.getState().agentSeen, false);

    await service.tools.call('ps_start_task', { intent: 'one' });
    service.stop();
    await service.tools.call('ps_start_task', { intent: 'two' });

    assert.equal(seen, 1);
    assert.equal(service.getState().agentSeen, true);
});

test('an agent remembered from an earlier run counts as seen', context => {
    const { service } = makeService(context, null, { isAgentSeen: () => true });
    assert.equal(service.getState().agentSeen, true);
});

test('a running task tells the dialog when the agent last acted', async context => {
    const { service } = makeService(context, workingBridge());
    await service.tools.call('ps_start_task', { intent: 'look' });

    const task = service.getState().task;
    assert.ok(task.lastActivityAt >= task.startedAt);
    assert.equal(task.waitingForPerson, false);
});

test('a finished task leaves an informational report and does not alter its article', async context => {
    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async action => (action === 'agent_start_task'
            ? startAnswer()
            : { status: null }),
        sendCommand: () => 'id'
    };
    const { service } = makeService(context, bridge);
    const started = await service.tools.call('ps_start_task', { intent: 'curves' });
    const taskId = started.content[0].text.match(/(task-[a-f0-9]+)/)[1];

    await service.tools.call('ps_kb_contribute', {
        task_id: taskId,
        article_id: 'clipped-curves',
        title: 'Clipped curves',
        problem: 'a curves layer clipped to the one below',
        body: 'the descriptor that worked'
    });
    await service.tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });

    const state = service.getState();
    assert.equal(state.lastFinishedTask.report.summary, 'done');
    const article = service.knowledgeBase.readArticle('clipped-curves').text;
    assert.match(article, /confidence: agent-written/);
    assert.match(article, /the descriptor that worked/);
});

test('the journal records calls and keeps image bytes out of it', async context => {
    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async action => (action === 'agent_start_task'
            ? startAnswer()
            : { base64: 'AAAA'.repeat(1000), mimeType: 'image/png', caption: 'a look', status: null }),
        sendCommand: () => 'id'
    };
    const { service, root } = makeService(context, bridge);
    const started = await service.tools.call('ps_start_task', { intent: 'look' });
    const taskId = started.content[0].text.match(/(task-[a-f0-9]+)/)[1];
    await service.tools.call('ps_get_image', { task_id: taskId });

    const dir = path.join(root, 'agent-journal');
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.jsonl'));
    assert.equal(files.length, 1);

    const contents = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.match(contents, /"tool":"ps_get_image"/);
    assert.match(contents, /image not stored in the journal/);
    assert.doesNotMatch(contents, /AAAAAAAA/);
});
