'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentTools, formatStatus, MAX_BATCH_ARTICLES } = require('../agent/mcp-tools');
const { createTaskSession } = require('../agent/task-session');
const { createKnowledgeBase } = require('../agent/knowledge-base');

/**
 * Build the tool layer over a fake plugin.
 *
 * @param {import('node:test').TestContext} context - Active test context.
 * @param {object} [pluginAnswers] - Answers keyed by command name.
 * @param {object} [options]
 * @param {object} [options.taskOptions] - Passed to createTaskSession, e.g. a test clock.
 * @param {number} [options.dialogWaitMs] - Passed to createAgentTools.
 * @returns {object} { tools, tasks, kb, calls, journalLines }
 */
function makeTools(context, pluginAnswers = {}, { taskOptions = {}, dialogWaitMs } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-tools-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const silent = { info() {}, warn() {}, error() {} };
    const knowledgeBase = createKnowledgeBase({
        authorDir: path.join(root, 'knowledge-base'),
        userDir: path.join(root, 'knowledge-base.user'),
        logger: silent
    });

    const tasks = createTaskSession(taskOptions);
    const calls = [];

    const bridge = {
        getConnectedClients: () => (pluginAnswers.__disconnected ? 0 : 1),
        sendCommandAndWait: async (action, payload, timeoutMs) => {
            calls.push({ action, payload, timeoutMs });
            const answer = pluginAnswers[action];
            if (typeof answer === 'function') return answer(payload);
            if (answer === undefined) throw new Error(`no fake answer for ${action}`);
            return answer;
        },
        sendCommand: (action, payload) => { calls.push({ action, payload }); return 'id'; }
    };

    const journalLines = [];
    const journal = {
        startTask() {},
        logCall(entry) { journalLines.push(entry); },
        endTask() {}
    };

    const tools = createAgentTools({
        getBridge: () => bridge,
        tasks,
        knowledgeBase,
        journal,
        progress: { push() {} },
        getOrigin: () => pluginAnswers.__origin || 'external',
        dialogWaitMs
    });

    return { tools, tasks, knowledgeBase, calls, journalLines };
}

/**
 * A plausible answer from the plugin for ps_start_task.
 *
 * @returns {object}
 */
function startAnswer() {
    return {
        document: {
            id: 7,
            name: 'poster.psd',
            width: 2000,
            height: 3000,
            resolution: 300,
            colorMode: 'RGB',
            bitsPerChannel: 8,
            layerCount: 12
        },
        photoshopVersion: '26.4.0',
        snapshot: { created: true, name: 'Before the task: tidy up', historyStateId: 3 },
        status: { documentId: 7, documentName: 'poster.psd', historyStep: 'Open', sinceLastCall: [] }
    };
}

/**
 * Start a task and hand back its id.
 *
 * @param {object} tools - The tool layer.
 * @param {string} [intent] - What the agent says it is doing.
 * @returns {Promise<string>} The task id.
 */
async function startTask(tools, intent = 'work') {
    const started = await tools.call('ps_start_task', { intent });
    return started.content[0].text.match(/(task-[a-f0-9]+)/)[1];
}

test('every tool is prefixed ps_ so its area is readable from the flat list', context => {
    const { tools } = makeTools(context);

    for (const tool of tools.list()) {
        assert.ok(tool.name.startsWith('ps_'), `${tool.name} must carry the ps_ prefix`);
        assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
    }
});

test('every tool except ps_start_task requires the task id', context => {
    const { tools } = makeTools(context);

    for (const tool of tools.list()) {
        if (tool.name === 'ps_start_task') continue;
        assert.ok(
            tool.inputSchema.required.includes('task_id'),
            `${tool.name} must require task_id`
        );
    }
});

test('a call without a task is refused with the instruction to start one', async context => {
    const { tools } = makeTools(context);

    const result = await tools.call('ps_get_document', {});

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /ps_start_task/);
});

test('ps_start_task hands over the rules, the knowledge base and the document', async context => {
    const { tools, knowledgeBase } = makeTools(context, {
        agent_start_task: startAnswer()
    });

    knowledgeBase.writeArticle({
        id: 'curves', title: 'Curves', problem: 'adding a curves layer', body: 'text'
    });
    knowledgeBase.ensureUserLayer();
    fs.writeFileSync(
        path.join(knowledgeBase.paths.userDir, 'rules.md'),
        'Look first, change, then check.',
        'utf8'
    );

    const result = await tools.call('ps_start_task', { intent: 'tidy up' });
    const text = result.content[0].text;

    assert.ok(!result.isError);
    assert.match(text, /Task task-/);
    assert.match(text, /poster\.psd/);
    assert.match(text, /Look first, change, then check\./);
    // The index itself is asked for, not inlined; the start only says how big the base is.
    assert.match(text, /1 article,/);
    assert.match(text, /snapshot named/);
    // A task that only looks must not leave anything in the person's History panel.
    assert.match(text, /Nothing has been written to the document/);
    // One way into the base: the tools. The folders are never named.
    assert.match(text, /only through these tools — never by reading or writing its files/);
    assert.match(text, /ps_kb_list/);
    assert.match(text, /sub-agent/);
    // A sub-agent without MCP tools must not become a reason to skip the base.
    assert.match(text, /if your sub-agents cannot call MCP tools, read the base yourself/);
    assert.ok(!text.includes(knowledgeBase.paths.userDir), 'the user folder must not be named');
    // Marking an article and writing a new one are told apart, so "the base had nothing on
    // it" does not read as a reason to write.
    assert.match(text, /helped or failed is always wanted/);
    assert.match(text, /A new article is wanted only when/);
});

test('a base too big to list is described rather than dumped', async context => {
    const { tools, knowledgeBase } = makeTools(context, { agent_start_task: startAnswer() });

    for (let index = 0; index < 45; index++) {
        knowledgeBase.writeArticle({
            id: `article-${index}`,
            title: `Article ${index}`,
            problem: `problem number ${index}`,
            body: 'text'
        });
    }

    const result = await tools.call('ps_start_task', { intent: 'anything' });
    const text = result.content[0].text;

    assert.match(text, /45 articles/);
    assert.match(text, /The index is not included here/);
    assert.doesNotMatch(text, /problem number 44/, 'the index itself must not be dumped');
});

test('a second ps_start_task while one runs is refused, not queued', async context => {
    const { tools } = makeTools(context, { agent_start_task: startAnswer() });

    await tools.call('ps_start_task', { intent: 'first' });
    const second = await tools.call('ps_start_task', { intent: 'second' });

    assert.equal(second.isError, true);
    assert.match(second.content[0].text, /already running/);
});

test('with no document open the task does not start', async context => {
    const { tools, tasks } = makeTools(context, { agent_start_task: { document: null } });

    const result = await tools.call('ps_start_task', { intent: 'anything' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no open document/);
    assert.equal(tasks.getCurrent(), null, 'the task slot is left free');
});

test('with the assistant dialog closed the agent is told exactly what to ask for', async context => {
    const { tools, tasks } = makeTools(context, { __disconnected: true });

    const result = await tools.call('ps_start_task', { intent: 'anything' });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /AI Assist/);
    assert.equal(tasks.getCurrent(), null);
});

test('ps_resume_task rebinds a suspended task after a plugin runtime restart', async context => {
    const { tools, tasks, calls } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_resume_task: {
            document: { id: 7, name: 'poster.psd', path: 'C:/work/poster.psd' },
            recoveredSnapshot: true,
            status: { documentId: 7, documentName: 'poster.psd', historyStep: 'Agent: curves' }
        }
    });
    const started = await tools.call('ps_start_task', { intent: 'curves' });
    const taskId = started.content[0].text.match(/(task-[a-f0-9]+)/)[1];

    tasks.suspend({
        reason: 'the Photoshop plugin runtime restarted',
        reasonCode: 'plugin-runtime-restarted',
        requiresRebind: true
    });

    const resumed = await tools.call('ps_resume_task', { task_id: taskId });

    assert.equal(resumed.isError, undefined);
    assert.match(resumed.content[0].text, /resumed/);
    assert.equal(tasks.getCurrent().state, 'running');
    assert.equal(calls.at(-1).action, 'agent_resume_task');
});

test('ps_get_image returns image content and a caption, never base64 as text', async context => {
    const { tools } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_get_image: {
            base64: 'iVBORw0KGgo=',
            mimeType: 'image/png',
            caption: 'flattened document of "poster.psd". Original 2000x3000 px. Reduced to 341x512.',
            status: { documentId: 7, documentName: 'poster.psd', historyStep: 'Open', sinceLastCall: [] }
        }
    });

    const started = await tools.call('ps_start_task', { intent: 'look' });
    const taskId = started.content[0].text.match(/(task-[a-f0-9]+)/)[1];

    const result = await tools.call('ps_get_image', { task_id: taskId });

    assert.equal(result.content[0].type, 'image');
    assert.equal(result.content[0].mimeType, 'image/png');
    assert.equal(result.content[0].data, 'iVBORw0KGgo=');
    assert.match(result.content[1].text, /Reduced to 341x512/);
});

test('ps_get_image asks for a reduced copy unless told otherwise', async context => {
    const { tools, calls } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_get_image: { base64: 'x', mimeType: 'image/png', caption: '', status: null }
    });

    const started = await tools.call('ps_start_task', { intent: 'look' });
    const taskId = started.content[0].text.match(/(task-[a-f0-9]+)/)[1];

    await tools.call('ps_get_image', { task_id: taskId });
    assert.equal(calls.at(-1).payload.maxSize, 512);

    await tools.call('ps_get_image', { task_id: taskId, full_size: true });
    assert.equal(calls.at(-1).payload.fullSize, true);
});

test('ps_execute_script passes the history name through', async context => {
    const { tools, calls } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_execute_script: { result: 3, status: null }
    });

    const started = await tools.call('ps_start_task', { intent: 'hide' });
    const taskId = started.content[0].text.match(/(task-[a-f0-9]+)/)[1];

    await tools.call('ps_execute_script', {
        task_id: taskId,
        code: 'return 3;',
        history_name: 'hide 5 text layers'
    });

    assert.equal(calls.at(-1).payload.historyName, 'hide 5 text layers');
});

test('ps_execute_script is not interactive by default and keeps the ordinary wait', async context => {
    const { tools, calls } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_execute_script: { result: 3, status: null }
    });
    const taskId = await startTask(tools, 'hide');

    await tools.call('ps_execute_script', { task_id: taskId, code: 'return 3;', history_name: 'hide' });
    assert.equal(calls.at(-1).payload.interactive, false);
    assert.equal(calls.at(-1).timeoutMs, 180_000);

    // Only a real true turns it on.
    await tools.call('ps_execute_script', {
        task_id: taskId, code: 'return 3;', history_name: 'hide', interactive: 'true'
    });
    assert.equal(calls.at(-1).payload.interactive, false);
    assert.equal(calls.at(-1).timeoutMs, 180_000);
});

test('an interactive ps_execute_script passes the flag through and waits much longer', async context => {
    const { tools, calls } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_execute_script: { result: null, status: null }
    });
    const taskId = await startTask(tools, 'liquify');

    await tools.call('ps_execute_script', {
        task_id: taskId, code: 'await action.batchPlay([...], {})', history_name: 'liquify', interactive: true
    });

    assert.equal(calls.at(-1).payload.interactive, true);
    assert.equal(calls.at(-1).payload.historyName, 'liquify');
    assert.equal(calls.at(-1).timeoutMs, 30 * 60 * 1000);
});

test('the interactive flag is described in the tool schema', context => {
    const { tools } = makeTools(context);
    const tool = tools.list().find(item => item.name === 'ps_execute_script');

    assert.equal(tool.inputSchema.properties.interactive.type, 'boolean');
    assert.ok(!tool.inputSchema.required.includes('interactive'));
    assert.match(tool.inputSchema.properties.interactive.description, /dialogOptions: "display"/);
    assert.match(tool.inputSchema.properties.interactive.description, /Cancel Plugin Command/);
});

test('a task does not idle out while an interactive call waits for the person', async context => {
    let clock = 1_000_000;
    let releaseDialog = null;
    const { tools, tasks } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_execute_script: () => new Promise(resolve => {
            releaseDialog = () => resolve({ result: 'ok', status: null });
        })
    }, { taskOptions: { now: () => clock } });
    const taskId = await startTask(tools, 'liquify');

    const running = tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'liquify', interactive: true
    });
    await new Promise(resolve => setImmediate(resolve));

    // The person works in the dialog for longer than the idle limit.
    clock += tasks.idleTimeoutMs + 60_000;
    assert.equal(tasks.getCurrent().id, taskId, 'the task must stay open while the person works');

    releaseDialog();
    const result = await running;
    assert.ok(!result.isError);

    // The end of the wait counts as activity, so the next call finds the task alive.
    clock += 60_000;
    assert.equal(tasks.getCurrent().id, taskId);
});

test('code -128 in an interactive call points at the person, not at the descriptor', async context => {
    const answer = rejectedAnswer();
    answer.rejectedCommands.commands = [{ command: 'liquify', message: '', code: -128 }];
    const { tools } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_execute_script: answer
    });
    const taskId = await startTask(tools, 'liquify');

    const result = await tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'liquify', interactive: true
    });
    const text = result.content[0].text;

    assert.match(text, /Code -128 in an interactive call means the person closed the dialog/);
    assert.match(text, /ask the person what they saw/);
    assert.doesNotMatch(text, /retry without it/);
});

/**
 * Tools whose plugin holds an interactive script open until the test closes the dialog.
 *
 * @param {import('node:test').TestContext} context - Active test context.
 * @param {object} [options] - Passed to makeTools.
 * @returns {object} makeTools' result plus closeDialog(answer) and failDialog(message).
 */
function makeDialogTools(context, options = {}) {
    let resolveDialog = null;
    let rejectDialog = null;
    const made = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_finish_task: {},
        agent_execute_script: payload => (payload.interactive
            ? new Promise((resolve, reject) => { resolveDialog = resolve; rejectDialog = reject; })
            : { result: 'plain', status: null })
    }, { dialogWaitMs: 20, ...options });
    return {
        ...made,
        closeDialog: answer => resolveDialog(answer),
        failDialog: message => rejectDialog(new Error(message))
    };
}

/**
 * Let pending promise callbacks run.
 *
 * @returns {Promise<void>}
 */
function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

test('an interactive call answers "still open" instead of holding the client past its limit', async context => {
    const { tools, tasks, closeDialog } = makeDialogTools(context);
    const taskId = await startTask(tools, 'camera raw');

    const first = await tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'camera raw', interactive: true
    });
    assert.ok(!first.isError, 'the dialog being open is not an error');
    assert.match(first.content[0].text, /still working in it/);
    assert.match(first.content[0].text, /Do not open it again/);
    assert.match(first.content[0].text, /ps_wait_for_dialog/);

    // The person is still in the dialog: the task must not idle out.
    assert.equal(tasks.getCurrent().waitingForPerson, 1);

    const stillOpen = await tools.call('ps_wait_for_dialog', { task_id: taskId });
    assert.ok(!stillOpen.isError);
    assert.match(stillOpen.content[0].text, /still working in the dialog from "camera raw"/);
    assert.match(stillOpen.content[0].text, /Call ps_wait_for_dialog again/);

    closeDialog({
        result: 'applied',
        status: { documentId: 7, documentName: 'poster.psd', historyStep: 'Agent: camera raw' }
    });
    await flush();
    assert.equal(tasks.getCurrent().waitingForPerson, 0, 'the hold ends when the plugin answers');

    const delivered = await tools.call('ps_wait_for_dialog', { task_id: taskId });
    assert.ok(!delivered.isError);
    assert.match(delivered.content[0].text, /^Returned: applied/);
    assert.match(delivered.content[0].text, /\[state\] document: poster\.psd/);

    // Handed over once.
    const again = await tools.call('ps_wait_for_dialog', { task_id: taskId });
    assert.ok(!again.isError);
    assert.match(again.content[0].text, /No dialog is waiting/);
});

test('a dialog the person closes in time returns its result from the first call', async context => {
    const { tools, closeDialog } = makeDialogTools(context, { dialogWaitMs: 5_000 });
    const taskId = await startTask(tools, 'liquify');

    const running = tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'liquify', interactive: true
    });
    await flush();
    closeDialog({ result: 'ok', status: null });

    const result = await running;
    assert.ok(!result.isError);
    assert.equal(result.content[0].text, 'Returned: ok');
    const waited = await tools.call('ps_wait_for_dialog', { task_id: taskId });
    assert.match(waited.content[0].text, /No dialog is waiting/);
});

test('ps_wait_for_dialog with nothing pending says so plainly', async context => {
    const { tools } = makeDialogTools(context);
    const taskId = await startTask(tools, 'look');

    const result = await tools.call('ps_wait_for_dialog', { task_id: taskId });
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /No dialog is waiting in this task/);
});

test('while a dialog is open another script in the task is refused and not sent', async context => {
    const { tools, calls, closeDialog } = makeDialogTools(context);
    const taskId = await startTask(tools, 'camera raw');
    await tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'camera raw', interactive: true
    });
    const sent = calls.length;

    const refused = await tools.call('ps_execute_script', {
        task_id: taskId, code: 'y', history_name: 'crop'
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /still open in front of the person/);
    assert.match(refused.content[0].text, /ps_wait_for_dialog/);
    assert.equal(calls.length, sent, 'nothing reached the plugin');

    // After it closes but before the agent looked, the refusal says the result is waiting.
    closeDialog({ result: 'ok', status: null });
    await flush();
    const unseen = await tools.call('ps_execute_script', {
        task_id: taskId, code: 'y', history_name: 'crop'
    });
    assert.equal(unseen.isError, true);
    assert.match(unseen.content[0].text, /you have not seen its result yet/);

    await tools.call('ps_wait_for_dialog', { task_id: taskId });
    const allowed = await tools.call('ps_execute_script', {
        task_id: taskId, code: 'y', history_name: 'crop'
    });
    assert.ok(!allowed.isError);
});

test('ps_finish_task does not silently drop an open dialog, and closes on the second attempt', async context => {
    const { tools, tasks, journalLines } = makeDialogTools(context);
    const taskId = await startTask(tools, 'camera raw');
    await tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'camera raw', interactive: true
    });

    const first = await tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    assert.equal(first.isError, true);
    assert.match(first.content[0].text, /still open in front of the person/);
    assert.match(first.content[0].text, /ps_wait_for_dialog/);
    assert.equal(tasks.getCurrent().id, taskId, 'the task is still open');

    const second = await tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    assert.ok(!second.isError);
    assert.match(second.content[0].text, /is closed/);
    assert.equal(tasks.getCurrent(), null);
    assert.ok(
        journalLines.some(line => line.tool === 'ps_finish_task' && /still open/.test(line.error || '')),
        'the journal notes the task closed with the dialog open'
    );
});

test('the dialog warning in ps_finish_task does not use up the struggle question', async context => {
    const { tools, tasks, closeDialog } = makeDialogTools(context);
    const taskId = await startTask(tools, 'camera raw');
    tasks.noteFailure(taskId);
    tasks.noteFailure(taskId);
    await tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'camera raw', interactive: true
    });

    const dialogWarning = await tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    assert.match(dialogWarning.content[0].text, /still open/);

    closeDialog({ result: 'ok', status: null });
    await flush();
    await tools.call('ps_wait_for_dialog', { task_id: taskId });

    const struggle = await tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    assert.equal(struggle.isError, true);
    assert.match(struggle.content[0].text, /Before this closes/);
});

test('the result of a dialog reaches the journal even if the agent never asks for it', async context => {
    const { tools, journalLines, closeDialog } = makeDialogTools(context);
    const taskId = await startTask(tools, 'camera raw');
    await tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'camera raw', interactive: true
    });
    // The first answer itself is in the journal too.
    assert.ok(journalLines.some(line => line.tool === 'ps_execute_script'
        && /still working/.test(line.result && line.result.text)));

    closeDialog({ result: 'applied', status: null });
    await flush();

    const late = journalLines.find(line => line.args && /logged when the plugin answered/.test(line.args.note || ''));
    assert.ok(late, 'the late result is journalled on arrival');
    assert.equal(late.task, taskId);
    assert.equal(late.tool, 'ps_execute_script');
    assert.match(late.result.text, /Returned: applied/);
});

test('a dialog closed in time is journalled once, by the call itself', async context => {
    const { tools, journalLines, closeDialog } = makeDialogTools(context, { dialogWaitMs: 5_000 });
    const taskId = await startTask(tools, 'liquify');

    const running = tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'liquify', interactive: true
    });
    await flush();
    closeDialog({ result: 'ok', status: null });
    await running;

    const lines = journalLines.filter(line => line.tool === 'ps_execute_script');
    assert.equal(lines.length, 1);
});

test('rejected commands delivered through ps_wait_for_dialog are shown and counted once', async context => {
    const { tools, tasks, closeDialog } = makeDialogTools(context);
    const taskId = await startTask(tools, 'camera raw');
    await tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'camera raw', interactive: true
    });

    const answer = rejectedAnswer();
    answer.rejectedCommands.commands = [{ command: 'Adobe Camera Raw Filter', message: '', code: -128 }];
    closeDialog(answer);
    await flush();
    // Arrival alone counts nothing: counting happens when the agent is told.
    assert.equal(tasks.getCurrent().failures, 0);

    const result = await tools.call('ps_wait_for_dialog', { task_id: taskId });
    const text = result.content[0].text;
    assert.ok(!result.isError);
    assert.match(text, /Photoshop rejected 1 command/);
    assert.match(text, /Code -128 in an interactive call/);
    assert.match(text, /\[state\]/);
    assert.equal(tasks.getCurrent().failures, 1);
    assert.equal(tasks.getCurrent().rejectedCalls, 1);
});

test('a dialog script that threw comes back through ps_wait_for_dialog as an error, counted once', async context => {
    const { tools, tasks, failDialog } = makeDialogTools(context);
    const taskId = await startTask(tools, 'camera raw');
    await tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'camera raw', interactive: true
    });

    failDialog('Script failed: boom [rejected-commands]{"total":1,"commands":[{"command":"filter","message":"","code":-128}]}');
    await flush();

    const result = await tools.call('ps_wait_for_dialog', { task_id: taskId });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Script failed: boom/);
    assert.match(result.content[0].text, /Code -128 in an interactive call/);
    assert.doesNotMatch(result.content[0].text, /\[rejected-commands\]/);
    assert.equal(tasks.getCurrent().failures, 1);
});

test('ps_wait_for_dialog is described with its wait and requires the task id', context => {
    const { tools } = makeTools(context);
    const tool = tools.list().find(item => item.name === 'ps_wait_for_dialog');

    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ['task_id']);
    assert.match(tool.description, /40 seconds/);
    assert.match(tool.description, /Do not open the dialog again/);
    const script = tools.list().find(item => item.name === 'ps_execute_script');
    assert.match(script.inputSchema.properties.interactive.description, /ps_wait_for_dialog/);
});

/**
 * What the plugin answers when Photoshop rejected one command of a script that otherwise ran.
 *
 * @returns {object}
 */
function rejectedAnswer() {
    return {
        result: { success: true },
        status: { documentId: 7, documentName: 'poster.psd', historyStep: 'Agent: curves' },
        rejectedCommands: {
            total: 1,
            commands: [{
                command: 'set',
                message: 'FromPS-ToPS Dev: The command “Set” is not currently available.',
                code: -25920
            }]
        }
    };
}

test('a command Photoshop rejected is named after the returned value and counted once', async context => {
    const { tools, tasks } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_execute_script: rejectedAnswer()
    });
    const taskId = await startTask(tools, 'curves');

    const result = await tools.call('ps_execute_script', {
        task_id: taskId, code: 'await action.batchPlay([...], {})', history_name: 'curves'
    });
    const text = result.content[0].text;

    // Not an error: the rest of the script may have changed the document.
    assert.ok(!result.isError);
    assert.match(text, /^Returned: \{/);
    assert.match(text, /Photoshop rejected 1 command in this script:/);
    assert.match(text, /- set: FromPS-ToPS Dev: The command “Set” is not currently available\. \(code -25920\)/);
    assert.match(text, /try\/catch in the script will not see it/);
    // The block sits between the returned value and the state line.
    assert.ok(text.indexOf('Photoshop rejected') < text.indexOf('[state]'));

    assert.equal(tasks.getCurrent().failures, 1);
    assert.equal(tasks.getCurrent().rejectedCalls, 1);
});

test('code -128 is explained: a dialog was dismissed, so the cause is not in the answer', async context => {
    const answer = rejectedAnswer();
    answer.rejectedCommands.commands = [{ command: 'make', message: '', code: -128 }];
    const { tools } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_execute_script: answer
    });
    const taskId = await startTask(tools, 'vibrance');

    const result = await tools.call('ps_execute_script', {
        task_id: taskId, code: 'await action.batchPlay([...], {})', history_name: 'vibrance'
    });
    const text = result.content[0].text;

    assert.match(text, /- make: no message \(code -128\)/);
    assert.match(text, /Code -128 means a Photoshop dialog was shown to the person and dismissed/);
    assert.match(text, /check your own descriptor/);
    assert.match(text, /dialogOptions: "display", retry without it/);
});

test('other codes get no -128 explanation', async context => {
    const { tools } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_execute_script: rejectedAnswer()
    });
    const taskId = await startTask(tools, 'curves');

    const result = await tools.call('ps_execute_script', {
        task_id: taskId, code: 'x', history_name: 'curves'
    });

    assert.doesNotMatch(result.content[0].text, /Code -128/);
});

test('a script with nothing rejected says nothing about it and counts nothing', async context => {
    const { tools, tasks } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_execute_script: { result: 3, status: null }
    });
    const taskId = await startTask(tools, 'hide');

    const result = await tools.call('ps_execute_script', {
        task_id: taskId, code: 'return 3;', history_name: 'hide'
    });

    assert.equal(result.content[0].text, 'Returned: 3');
    assert.equal(tasks.getCurrent().failures, 0);
});

test('more rejections than the plugin listed are still counted in the text', async context => {
    const answer = rejectedAnswer();
    answer.rejectedCommands.total = 14;
    const { tools } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_execute_script: answer
    });
    const taskId = await startTask(tools, 'loop');

    const result = await tools.call('ps_execute_script', {
        task_id: taskId, code: 'loop', history_name: 'loop'
    });

    assert.match(result.content[0].text, /Photoshop rejected 14 commands/);
    assert.match(result.content[0].text, /and 13 more, not listed/);
});

test('a script that threw shows its rejected commands in plain words, counted once', async context => {
    // The tail is built by the plugin's own code, so this also holds the two sides to one format.
    const { formatForErrorText } = require('../../modules/batchplay-watch.js');
    const tail = formatForErrorText(rejectedAnswer().rejectedCommands);

    const { tools, tasks } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_execute_script: () => {
            throw new Error(
                "The script failed: Cannot read properties of undefined (reading 'layerID')\n"
                + `First lines of it:\nconst [made] = await action.batchPlay(...)${tail}`
            );
        }
    });
    const taskId = await startTask(tools, 'curves');

    const result = await tools.call('ps_execute_script', {
        task_id: taskId, code: 'const [made] = await action.batchPlay(...)', history_name: 'curves'
    });
    const text = result.content[0].text;

    assert.equal(result.isError, true);
    assert.match(text, /^The script failed: Cannot read properties/);
    assert.match(text, /Photoshop rejected 1 command in this script:/);
    assert.match(text, /\(code -25920\)/);
    assert.doesNotMatch(text, /\[rejected-commands\]/);
    assert.doesNotMatch(text, /"commands":/);

    assert.equal(tasks.getCurrent().failures, 1, 'one call, one failure');
    assert.equal(tasks.getCurrent().rejectedCalls, 0, 'the agent saw this one fail anyway');
});

test('rejected commands alone make the struggle question, and it names them', async context => {
    const { tools, tasks } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_finish_task: { status: null },
        agent_execute_script: rejectedAnswer()
    });
    const taskId = await startTask(tools, 'change an existing curves layer');

    for (let attempt = 0; attempt < 2; attempt++) {
        const ran = await tools.call('ps_execute_script', {
            task_id: taskId, code: 'set', history_name: 'try'
        });
        assert.ok(!ran.isError);
    }

    const firstFinish = await tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    const text = firstFinish.content[0].text;

    assert.equal(firstFinish.isError, true);
    assert.match(text, /2 of your calls went wrong/);
    assert.match(text, /In 2 of them the script itself did not fail, but Photoshop rejected/);
    assert.match(text, /the rejected form and the working one/);
    assert.match(text, /no new article and no note/);
    assert.ok(tasks.getCurrent(), 'the task is still open, so it can still write');
});

test('a task is labelled by which way the agent came, without asking the agent', async context => {
    const external = makeTools(context, { agent_start_task: startAnswer() });
    await external.tools.call('ps_start_task', { intent: 'from my own terminal' });
    assert.equal(external.tasks.getCurrent().origin, 'external');

    const fromPanel = makeTools(context, { agent_start_task: startAnswer(), __origin: 'panel' });
    await fromPanel.tools.call('ps_start_task', { intent: 'from the panel' });
    assert.equal(fromPanel.tasks.getCurrent().origin, 'panel');
});

test('an article records who wrote it and which Photoshop it was checked on', async context => {
    const { tools, knowledgeBase } = makeTools(context, { agent_start_task: startAnswer() });
    tools.setClient({ name: 'claude-code', version: '2.1.268' });

    const taskId = await startTask(tools, 'clip a curves layer');
    await tools.call('ps_kb_contribute', {
        task_id: taskId,
        article_id: 'clipped-curves',
        title: 'Clipped curves',
        problem: 'a curves layer clipped to the one below',
        body: 'the descriptor that worked',
        what_did_not_work: 'the property name I remembered does not exist'
    });

    const article = knowledgeBase.readArticle('clipped-curves').text;

    // Neither of these is typed by the agent: one is measured in Photoshop, the other is
    // how the client named itself when it connected.
    assert.match(article, /Photoshop: 26\.4\.0/);
    assert.match(article, /written by: claude-code 2\.1\.268/);
    assert.match(article, /written on task: task-/);
    assert.match(article, /agent-written/);
    // The rakes are kept as their own section, not folded into the recipe.
    assert.match(article, /What did not work first/);
    assert.match(article, /the property name I remembered does not exist/);
});

test('a task that fought Photoshop and wrote nothing is asked for it once', async context => {
    const { tools, tasks } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_finish_task: { status: null },
        agent_execute_script: () => { throw new Error('that descriptor was rejected'); }
    });

    const taskId = await startTask(tools, 'something hard');

    for (let attempt = 0; attempt < 2; attempt++) {
        const failed = await tools.call('ps_execute_script', {
            task_id: taskId, code: 'nope', history_name: 'try'
        });
        assert.equal(failed.isError, true);
    }

    const firstFinish = await tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    assert.equal(firstFinish.isError, true);
    assert.match(firstFinish.content[0].text, /ps_kb_contribute/);
    assert.ok(tasks.getCurrent(), 'the task is still open, so it can still write');

    // Asked once, never twice: an agent with nothing to say would invent an article.
    const secondFinish = await tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    assert.ok(!secondFinish.isError);
    assert.equal(tasks.getCurrent(), null);
});

test('a task that went smoothly is not nagged', async context => {
    const { tools, tasks } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_finish_task: { status: null },
        agent_get_document: { document: {}, openDocuments: [], status: null }
    });

    const taskId = await startTask(tools, 'something easy');
    await tools.call('ps_get_document', { task_id: taskId });

    const finished = await tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });

    assert.ok(!finished.isError);
    assert.equal(tasks.getCurrent(), null);
    // Nothing written on a smooth task is fine, and saying otherwise pushes towards
    // articles nobody needs.
    assert.doesNotMatch(finished.content[0].text, /wrote nothing/);
});

test('marking is two tools, and only the failed one has a text field', context => {
    const { tools } = makeTools(context);
    const byName = Object.fromEntries(tools.list().map(tool => [tool.name, tool]));

    assert.equal(byName.ps_kb_append, undefined, 'the old tool is gone, with no alias');

    // The helped mark has nothing a weak agent could fill with "worked reliably".
    const helped = byName.ps_kb_mark_helped.inputSchema;
    assert.deepEqual(Object.keys(helped.properties).sort(), ['article_id', 'task_id']);
    assert.deepEqual(helped.required.sort(), ['article_id', 'task_id']);
    assert.equal(helped.additionalProperties, false);

    const failed = byName.ps_kb_mark_failed.inputSchema;
    assert.deepEqual(Object.keys(failed.properties).sort(), ['article_id', 'note', 'task_id']);
    assert.deepEqual(failed.required.sort(), ['article_id', 'note', 'task_id']);
    assert.equal(failed.additionalProperties, false);
});

test('no agent-facing text still names ps_kb_append', async context => {
    const { tools, knowledgeBase } = makeTools(context, { agent_start_task: startAnswer() });
    const shipped = path.join(__dirname, '..', 'knowledge-base');
    fs.mkdirSync(knowledgeBase.paths.authorDir, { recursive: true });
    fs.copyFileSync(path.join(shipped, 'rules.md'), path.join(knowledgeBase.paths.authorDir, 'rules.md'));

    const started = await tools.call('ps_start_task', { intent: 'anything' });
    const descriptions = tools.list().map(tool => JSON.stringify(tool)).join('\n');

    assert.doesNotMatch(started.content[0].text, /ps_kb_append/);
    assert.match(started.content[0].text, /ps_kb_mark_helped/);
    assert.doesNotMatch(descriptions, /ps_kb_append/);

    // The shipped articles are read by the agent too.
    const articlesDir = path.join(shipped, 'articles');
    for (const name of fs.readdirSync(articlesDir)) {
        const text = fs.readFileSync(path.join(articlesDir, name), 'utf8');
        assert.doesNotMatch(text, /ps_kb_append/, `${name} still names ps_kb_append`);
    }
});

test('everything written into the knowledge base is asked for in English', context => {
    // The person may talk to the agent in any language; the base is shared by every agent.
    const { tools } = makeTools(context);
    const byName = Object.fromEntries(tools.list().map(tool => [tool.name, tool]));

    assert.match(byName.ps_kb_contribute.description, /in English/);
    assert.match(byName.ps_kb_mark_failed.description, /in English/);

    const rules = fs.readFileSync(path.join(__dirname, '..', 'knowledge-base', 'rules.md'), 'utf8');
    assert.match(rules, /write into the knowledge base is in English/);
});

test('no agent-facing text names the knowledge base folders', async context => {
    // An agent told where the files are reads them, and then edits them by hand past the
    // header, the counters and the layers. The base is reached through the ps_kb_ tools only.
    const { tools, knowledgeBase } = makeTools(context, { agent_start_task: startAnswer() });
    const { authorDir, userDir } = knowledgeBase.paths;

    // The shipped rules, so their text is checked too, and an article in each layer, so
    // every part of the knowledge base block gets built.
    const shipped = path.join(__dirname, '..', 'knowledge-base');
    fs.mkdirSync(path.join(authorDir, 'articles'), { recursive: true });
    fs.copyFileSync(path.join(shipped, 'rules.md'), path.join(authorDir, 'rules.md'));
    fs.writeFileSync(
        path.join(authorDir, 'articles', 'shipped-recipe.md'),
        '---\nid: shipped-recipe\ntitle: Shipped\nproblem: p\n---\n\ntext\n',
        'utf8'
    );
    knowledgeBase.writeArticle({ id: 'written-recipe', title: 'Written', problem: 'q', body: 'text' });

    const started = await tools.call('ps_start_task', { intent: 'anything' });
    const taskId = started.content[0].text.match(/(task-[a-f0-9]+)/)[1];
    const index = await tools.call('ps_kb_list', { task_id: taskId });
    const missingRead = await tools.call('ps_kb_read', { task_id: taskId, article_id: 'no-such-article' });
    const missingMark = await tools.call('ps_kb_mark_helped', { task_id: taskId, article_id: 'no-such-article' });

    const texts = {
        'the ps_start_task answer': started.content[0].text,
        'the tool descriptions': tools.list().map(tool => JSON.stringify(tool)).join('\n'),
        'the ps_kb_list answer': index.content[0].text,
        'ps_kb_read of a missing article': missingRead.content[0].text,
        'ps_kb_mark_helped of a missing article': missingMark.content[0].text
    };

    const dirs = [authorDir, userDir, path.dirname(authorDir)];
    for (const [where, text] of Object.entries(texts)) {
        for (const dir of dirs) {
            // As written, with forward slashes, and with the backslashes JSON doubles.
            for (const form of [dir, dir.replace(/\\/g, '/'), JSON.stringify(dir).slice(1, -1)]) {
                assert.ok(!text.includes(form), `${where} names ${form}`);
            }
        }
        assert.doesNotMatch(text, /Read the folders yourself|folders ps_start_task named/, where);
    }
    assert.match(texts['the ps_start_task answer'], /never by reading or writing its files/);
});

test('a helped mark only counts, writes nothing, and does not silence the struggle question', async context => {
    const { tools, tasks, knowledgeBase } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_finish_task: { status: null },
        agent_execute_script: () => { throw new Error('that descriptor was rejected'); }
    });

    // Shipped by the author, so a written note would have to create a user-layer twin.
    fs.mkdirSync(path.join(knowledgeBase.paths.authorDir, 'articles'), { recursive: true });
    fs.writeFileSync(
        path.join(knowledgeBase.paths.authorDir, 'articles', 'used-recipe.md'),
        '---\nid: used-recipe\ntitle: Used\nproblem: p\n---\n\ntext\n',
        'utf8'
    );

    const taskId = await startTask(tools, 'something hard');
    // A client that ignores the schema may still send a note; it must not reach the base.
    const marked = await tools.call('ps_kb_mark_helped', {
        task_id: taskId, article_id: 'used-recipe', note: 'Worked reliably, applied successfully'
    });
    assert.ok(!marked.isError);
    assert.match(marked.content[0].text, /Marked "used-recipe" as helped/);
    assert.deepEqual(tasks.getCurrent().touchedArticles, [], 'a counter is not something written');
    assert.ok(
        !fs.existsSync(path.join(knowledgeBase.paths.userDir, 'articles', 'used-recipe.md')),
        'no twin is created'
    );
    const article = knowledgeBase.readArticle('used-recipe').text;
    assert.match(article, /helped 1 times/);
    assert.doesNotMatch(article, /Worked reliably/);

    for (let attempt = 0; attempt < 2; attempt++) {
        await tools.call('ps_execute_script', { task_id: taskId, code: 'nope', history_name: 'try' });
    }

    const firstFinish = await tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    assert.equal(firstFinish.isError, true, 'the fight still has to be written down');
    assert.match(firstFinish.content[0].text, /no new article and no note/);
    assert.match(firstFinish.content[0].text, /ps_kb_mark_failed/);
});

test('a failed mark needs a note, and with one it counts as written down', async context => {
    const { tools, tasks, knowledgeBase } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_finish_task: { status: null },
        agent_execute_script: () => { throw new Error('that descriptor was rejected'); }
    });

    knowledgeBase.writeArticle({ id: 'used-recipe', title: 'Used', problem: 'p', body: 'text' });

    const taskId = await startTask(tools, 'something hard');

    const refused = await tools.call('ps_kb_mark_failed', {
        task_id: taskId, article_id: 'used-recipe', note: '  '
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /what helped instead/);
    assert.deepEqual(tasks.getCurrent().touchedArticles, []);
    assert.match(knowledgeBase.readArticle('used-recipe').text, /did not work 0 times/);

    const marked = await tools.call('ps_kb_mark_failed', {
        task_id: taskId,
        article_id: 'used-recipe',
        note: 'the key in the table was wrong; $Sat worked'
    });
    assert.ok(!marked.isError);
    assert.deepEqual(tasks.getCurrent().touchedArticles, ['used-recipe']);
    const article = knowledgeBase.readArticle('used-recipe').text;
    assert.match(article, /did not work 1 times/);
    assert.match(article, /\$Sat worked/);

    for (let attempt = 0; attempt < 2; attempt++) {
        await tools.call('ps_execute_script', { task_id: taskId, code: 'nope', history_name: 'try' });
    }

    // The note is what the struggle question asks for, so the task closes at once, and
    // the article waits for the person's confirmation like one the task wrote.
    const finished = await tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });
    assert.ok(!finished.isError);
    assert.match(finished.content[0].text, /used-recipe/);
});

test('the state line tells the agent what the person did', () => {
    const line = formatStatus({
        documentId: 7,
        documentName: 'poster.psd',
        historyStep: 'Agent: hide 5 text layers',
        sinceLastCall: ['the person did 2 things by hand'],
        activeDocumentChanged: true
    });

    assert.match(line, /poster\.psd \(id 7\)/);
    assert.match(line, /Agent: hide 5 text layers/);
    assert.match(line, /switched to another document/);
    assert.match(line, /the person did 2 things by hand/);
});

test('finishing frees the slot and names the articles awaiting confirmation', async context => {
    const { tools, tasks } = makeTools(context, {
        agent_start_task: startAnswer(),
        agent_finish_task: { status: null }
    });

    const started = await tools.call('ps_start_task', { intent: 'curves' });
    const taskId = started.content[0].text.match(/(task-[a-f0-9]+)/)[1];

    await tools.call('ps_kb_contribute', {
        task_id: taskId,
        article_id: 'curves-clipped',
        title: 'Clipped curves',
        problem: 'a curves layer clipped to the one below',
        body: 'the descriptor that worked'
    });

    const finished = await tools.call('ps_finish_task', { task_id: taskId, summary: 'done' });

    assert.match(finished.content[0].text, /curves-clipped/);
    assert.equal(tasks.getCurrent(), null);
});

test('ps_kb_read single article returns markdown and reflects found status', async context => {
    const { tools } = makeTools(context, { agent_start_task: startAnswer() });
    const taskId = await startTask(tools, 'read single article');

    await tools.call('ps_kb_contribute', {
        task_id: taskId,
        article_id: 'recipe-one',
        title: 'Recipe 1',
        problem: 'problem 1',
        body: 'body 1'
    });

    // Existing article returns plain markdown text with isError falsy
    const okRes = await tools.call('ps_kb_read', { task_id: taskId, article_id: 'recipe-one' });
    assert.equal(Boolean(okRes.isError), false);
    assert.match(okRes.content[0].text, /recipe-one/);
    assert.match(okRes.content[0].text, /body 1/);

    // Missing article returns plain markdown text with isError true
    const notFoundRes = await tools.call('ps_kb_read', { task_id: taskId, article_id: 'missing-article' });
    assert.equal(notFoundRes.isError, true);
    assert.match(notFoundRes.content[0].text, /There is no article "missing-article"/);
});

test('ps_kb_read batch reads up to 4 articles with deduplication and request order', async context => {
    const { tools } = makeTools(context, { agent_start_task: startAnswer() });
    const taskId = await startTask(tools, 'read batch');

    await tools.call('ps_kb_contribute', {
        task_id: taskId,
        article_id: 'art-b',
        title: 'Article B',
        problem: 'problem B',
        body: 'body B'
    });
    await tools.call('ps_kb_contribute', {
        task_id: taskId,
        article_id: 'art-a',
        title: 'Article A',
        problem: 'problem A',
        body: 'body A'
    });

    // Request with duplicate 'art-b' and missing 'art-c'
    const res = await tools.call('ps_kb_read', {
        task_id: taskId,
        article_ids: ['art-b', 'art-c', 'art-a', 'art-b']
    });

    assert.equal(Boolean(res.isError), false);
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(Array.isArray(parsed.articles));
    assert.equal(parsed.articles.length, 3, 'duplicate IDs were pruned');

    // Strict order: art-b, art-c, art-a
    assert.equal(parsed.articles[0].article_id, 'art-b');
    assert.equal(parsed.articles[0].status, 'ok');
    assert.match(parsed.articles[0].content, /body B/);

    assert.equal(parsed.articles[1].article_id, 'art-c');
    assert.equal(parsed.articles[1].status, 'not_found');
    assert.match(parsed.articles[1].error, /There is no article "art-c"/);

    assert.equal(parsed.articles[2].article_id, 'art-a');
    assert.equal(parsed.articles[2].status, 'ok');
    assert.match(parsed.articles[2].content, /body A/);
});

test('ps_kb_read enforces validation rules, task check, and hard limit of 4', async context => {
    assert.equal(MAX_BATCH_ARTICLES, 4);

    const { tools } = makeTools(context, { agent_start_task: startAnswer() });
    const taskId = await startTask(tools, 'read validation');

    // Both provided
    const bothRes = await tools.call('ps_kb_read', {
        task_id: taskId,
        article_id: 'one',
        article_ids: ['two']
    });
    assert.equal(bothRes.isError, true);
    assert.match(bothRes.content[0].text, /not both/i);

    // Neither provided
    const neitherRes = await tools.call('ps_kb_read', { task_id: taskId });
    assert.equal(neitherRes.isError, true);
    assert.match(neitherRes.content[0].text, /must be provided/i);

    // Exceeds limit of 4 unique articles
    const tooManyRes = await tools.call('ps_kb_read', {
        task_id: taskId,
        article_ids: ['1', '2', '3', '4', '5']
    });
    assert.equal(tooManyRes.isError, true);
    assert.match(tooManyRes.content[0].text, /At most 4 articles/);

    // Empty array
    const emptyRes = await tools.call('ps_kb_read', {
        task_id: taskId,
        article_ids: []
    });
    assert.equal(emptyRes.isError, true);
    assert.match(emptyRes.content[0].text, /non-empty array/i);

    // Non-string item in array
    const invalidItemRes = await tools.call('ps_kb_read', {
        task_id: taskId,
        article_ids: ['ok', 123]
    });
    assert.equal(invalidItemRes.isError, true);
    assert.match(invalidItemRes.content[0].text, /non-empty string/i);

    // Invalid task_id drops the entire call
    const badTaskRes = await tools.call('ps_kb_read', {
        task_id: 'task-nonexistent',
        article_ids: ['art-b']
    });
    assert.equal(badTaskRes.isError, true);
});
