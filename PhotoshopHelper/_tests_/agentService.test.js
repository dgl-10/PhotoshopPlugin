'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentService, resolveAgentPaths, buildPrompt } = require('../agent');

/**
 * Build the whole service over throwaway folders and a fake plugin channel.
 *
 * @param {import('node:test').TestContext} context - Active test context.
 * @param {object} [bridge] - Stand-in for the plugin channel.
 * @returns {object} { service, root }
 */
function makeService(context, bridge = null) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-agent-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const service = createAgentService({
        getBridge: () => bridge,
        paths: resolveAgentPaths({ resourcesPath: root, userDataPath: root }),
        isJournalEnabled: () => true,
        logger: { info() {}, warn() {}, error() {} }
    });

    return { service, root };
}

test('the paths put the author layer with Helper and the user layer in the data folder', () => {
    const paths = resolveAgentPaths({ resourcesPath: '/res', userDataPath: '/data' });

    assert.equal(paths.authorKnowledgeDir, path.resolve('/res', 'knowledge-base'));
    assert.equal(paths.userKnowledgeDir, path.resolve('/data', 'knowledge-base.user'));
    assert.equal(paths.workDir, path.resolve('/data', 'agent-workspace'));
});

test('the knowledge base folders are absolute, whatever folder Helper runs from', () => {
    // The agent is not told these folders, but Helper and the person's menu item open them,
    // and a relative path would depend on where Helper happened to start.
    const paths = resolveAgentPaths({ resourcesPath: '.', userDataPath: './data' });

    assert.ok(path.isAbsolute(paths.authorKnowledgeDir));
    assert.ok(path.isAbsolute(paths.userKnowledgeDir));
});

test('the service starts up and reports a usable state', context => {
    const { service } = makeService(context);
    const state = service.getState();

    assert.equal(state.channel.connected, false);
    assert.equal(state.task, null);
    assert.equal(state.agentRunning, null);
    assert.ok(Array.isArray(state.progress));
    assert.ok(state.knowledgeBase.userDir);
});

test('an external agent works with nothing configured for launching one', async context => {
    // Someone who only ever uses their own agent has no reason to fill in LLM_MODE, a CLI
    // or a key. That must not close the door on them: the MCP server and the channel to
    // Photoshop have nothing to do with Helper launching anything.
    const saved = { ...process.env };
    delete process.env.LLM_MODE;
    delete process.env.LLM_CLI_TYPE;
    delete process.env.LLM_CLI_MODEL;
    context.after(() => {
        process.env.LLM_MODE = saved.LLM_MODE;
        process.env.LLM_CLI_TYPE = saved.LLM_CLI_TYPE;
        process.env.LLM_CLI_MODEL = saved.LLM_CLI_MODEL;
    });

    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async () => ({
            document: {
                id: 1, name: 'test.psd', width: 100, height: 100,
                resolution: 72, colorMode: 'RGB', bitsPerChannel: 8, layerCount: 1
            },
            snapshot: { created: true, name: 'Before the task: x' },
            status: null
        }),
        sendCommand: () => 'id'
    };

    const { service } = makeService(context, bridge);

    const started = await service.tools.call('ps_start_task', { intent: 'describe the picture' });
    assert.ok(!started.isError, 'the task must start with no LLM configuration at all');
    assert.match(started.content[0].text, /Task task-/);

    // The panel, on the other hand, says plainly that it cannot launch anything.
    const state = service.getState();
    assert.equal(state.cli.configured, false);
    assert.ok(state.cli.problems.length > 0);
});

test('the tool layer is wired to the service', async context => {
    const { service } = makeService(context);

    assert.equal(service.tools.list().length, 13);

    // With no channel the answer is the sentence the agent is meant to relay.
    const result = await service.tools.call('ps_start_task', { intent: 'anything' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /AI Assist/);
});

test('progress from the tools reaches the panel state', async context => {
    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async () => ({
            document: {
                id: 1, name: 'test.psd', width: 100, height: 100,
                resolution: 72, colorMode: 'RGB', bitsPerChannel: 8, layerCount: 1
            },
            snapshot: { created: true, name: 'Before the task: x' },
            status: null
        }),
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
        sendCommandAndWait: async () => ({
            document: {
                id: 1, name: 'test.psd', width: 100, height: 100,
                resolution: 72, colorMode: 'RGB', bitsPerChannel: 8, layerCount: 1
            },
            snapshot: { created: false, name: 'Before the task: recover' },
            status: null
        }),
        sendCommand: () => 'id'
    };
    const { service } = makeService(context, bridge);
    await service.tools.call('ps_start_task', { intent: 'recover' });

    connectedClients = 0;
    service.handlePluginConnectionChange({
        type: 'disconnected',
        clients: 0,
        reasonCode: 'assistant-dialog-closed',
        reason: 'Assistant panel closed',
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

test('Stop closes the task and lets the document side know', async context => {
    const sent = [];
    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async () => ({
            document: {
                id: 1, name: 'test.psd', width: 100, height: 100,
                resolution: 72, colorMode: 'RGB', bitsPerChannel: 8, layerCount: 1
            },
            snapshot: { created: false },
            status: null
        }),
        sendCommand: (action, payload) => { sent.push({ action, payload }); return 'id'; }
    };

    const { service } = makeService(context, bridge);
    await service.tools.call('ps_start_task', { intent: 'work' });

    const stopped = service.stop();

    assert.equal(stopped.stopped, true);
    assert.equal(service.tasks.getCurrent(), null);
    assert.equal(sent.at(-1).action, 'agent_finish_task');
});

test('confirming a finished task lifts the articles it wrote', async context => {
    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async (action) => (action === 'agent_start_task'
            ? {
                document: {
                    id: 1, name: 'test.psd', width: 100, height: 100,
                    resolution: 72, colorMode: 'RGB', bitsPerChannel: 8, layerCount: 1
                },
                snapshot: { created: false },
                status: null
            }
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

    const awaiting = service.getState().lastFinishedTask;
    assert.deepEqual(awaiting.articles, ['clipped-curves']);
    assert.equal(awaiting.confirmed, null);

    const confirmed = service.confirmLastTask(true);
    assert.deepEqual(confirmed.promoted, ['clipped-curves']);
    assert.match(service.knowledgeBase.readArticle('clipped-curves').text, /user-confirmed/);
});

test('confirming lifts a failure note, but does not count the failed article as helped', async context => {
    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async (action) => (action === 'agent_start_task'
            ? {
                document: {
                    id: 1, name: 'test.psd', width: 100, height: 100,
                    resolution: 72, colorMode: 'RGB', bitsPerChannel: 8, layerCount: 1
                },
                snapshot: { created: false },
                status: null
            }
            : { status: null }),
        sendCommand: () => 'id'
    };

    const { service } = makeService(context, bridge);
    service.knowledgeBase.writeArticle({ id: 'old-recipe', title: 'Old', problem: 'p', body: 'b' });
    const started = await service.tools.call('ps_start_task', { intent: 'x' });
    const taskId = started.content[0].text.match(/(task-[a-f0-9]+)/)[1];

    await service.tools.call('ps_kb_mark_failed', {
        task_id: taskId, article_id: 'old-recipe', note: 'rejected in 27.1; the DOM call worked'
    });
    await service.tools.call('ps_kb_contribute', {
        task_id: taskId, article_id: 'new-recipe', title: 'New', problem: 'q', body: 'b'
    });
    await service.tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });

    const confirmed = service.confirmLastTask(true);
    assert.deepEqual(confirmed.promoted.sort(), ['new-recipe', 'old-recipe']);

    const failedArticle = service.knowledgeBase.readArticle('old-recipe').text;
    assert.match(failedArticle, /user-confirmed/);
    assert.match(failedArticle, /helped 0 times, did not work 1 times/);
    // An article the task wrote itself is still counted once when the person confirms.
    assert.match(service.knowledgeBase.readArticle('new-recipe').text, /helped 1 times/);
});

test('saying the result was not good lifts nothing', async context => {
    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async (action) => (action === 'agent_start_task'
            ? {
                document: {
                    id: 1, name: 'test.psd', width: 100, height: 100,
                    resolution: 72, colorMode: 'RGB', bitsPerChannel: 8, layerCount: 1
                },
                snapshot: { created: false },
                status: null
            }
            : { status: null }),
        sendCommand: () => 'id'
    };

    const { service } = makeService(context, bridge);
    const started = await service.tools.call('ps_start_task', { intent: 'x' });
    const taskId = started.content[0].text.match(/(task-[a-f0-9]+)/)[1];

    await service.tools.call('ps_kb_contribute', {
        task_id: taskId, article_id: 'a', title: 'A', problem: 'p', body: 'b'
    });
    await service.tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });

    assert.deepEqual(service.confirmLastTask(false).promoted, []);
    assert.match(service.knowledgeBase.readArticle('a').text, /agent-written/);
});

test('the journal records the calls and keeps images out of it', async context => {
    const bridge = {
        getConnectedClients: () => 1,
        sendCommandAndWait: async (action) => (action === 'agent_start_task'
            ? {
                document: {
                    id: 1, name: 'test.psd', width: 100, height: 100,
                    resolution: 72, colorMode: 'RGB', bitsPerChannel: 8, layerCount: 1
                },
                snapshot: { created: false },
                status: null
            }
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
    assert.doesNotMatch(contents, /AAAAAAAA/, 'the picture itself must not be written down');
});

test('the prompt from the panel sends the agent through ps_start_task', () => {
    const prompt = buildPrompt('hide the text layers');

    assert.match(prompt, /ps_start_task/);
    assert.match(prompt, /photoshop-helper/);
    assert.match(prompt, /hide the text layers/);
    // A plain question should not become a task: it costs the person a snapshot in their
    // History panel that they then have to delete by hand.
    assert.match(prompt, /only a question/);
});

test('a continued panel chat reuses its existing Photoshop task', () => {
    const prompt = buildPrompt('continue', {
        task: {
            id: 'task-123',
            state: 'suspended',
            documentName: 'poster.psd'
        }
    });

    assert.match(prompt, /Task task-123 is paused/);
    assert.match(prompt, /ps_resume_task/);
    assert.doesNotMatch(prompt, /call ps_start_task first/);
});

test('chats remember their CLI session so the next message continues it', context => {
    const { service } = makeService(context);

    const chat = service.chats.createChat({ cli: 'claude', model: 'haiku' });
    service.chats.addMessage(chat.id, { role: 'user', text: 'hide the text layers' });
    service.chats.setSession(chat.id, { sessionId: 's-1' });

    const listed = service.chats.listChats();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].hasSession, true);
    // The first thing the person says names the chat, so the list reads as a history.
    assert.equal(listed[0].title, 'hide the text layers');
});
