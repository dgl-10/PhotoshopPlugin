'use strict';

/**
 * The document agent, assembled.
 *
 * One place that ties together the task frame, the knowledge base, the journal, the chats
 * and the launching of a CLI, and hands out the two things the rest of Helper needs: the
 * MCP tool layer and the router the assistant dialog talks to.
 */

const path = require('node:path');

const { createTaskSession } = require('./task-session');
const { createKnowledgeBase } = require('./knowledge-base');
const { createJournal } = require('./journal');
const { createChatStore } = require('./chat-store');
const { createCliRunner } = require('./cli-runner');
const { createAgentTools } = require('./mcp-tools');
const { SERVER_NAME } = require('./mcp-setup');

/**
 * What the panel puts in front of the person's words, so that an agent launched from here
 * arrives the same way an external one does: through ps_start_task.
 *
 * @param {string} text - What the person typed.
 * @param {object} [options] - Current task context for a continued chat.
 * @param {object|null} [options.task] - Existing task owned by this chat.
 * @returns {string} The prompt for the CLI.
 */
function buildPrompt(text, options = {}) {
    const task = options.task || null;
    const taskInstructions = task
        ? task.state === 'suspended'
            ? [
                `Task ${task.id} is paused; do not call ps_start_task.`,
                'Call ps_resume_task with that task id after the Photoshop connection is back,',
                'then inspect the document before repeating the interrupted operation.'
            ]
            : [
                `Task ${task.id} is already active on "${task.documentName || 'the Photoshop document'}".`,
                'Continue it with the same task id; do not call ps_start_task again.'
            ]
        : [
            'If it means looking at the document or changing it, call ps_start_task first: it gives',
            'you the task id the other ps_ tools need, the rules for working with Photoshop, and a',
            'knowledge base of recipes that are known to work. Finish with ps_finish_task.'
        ];

    return [
        'A document is open in Adobe Photoshop and you can work on it through the MCP server',
        `"${SERVER_NAME}".`,
        '',
        'If what follows is only a question — a shortcut, how something in Photoshop works —',
        'answer it and stop. Starting a task for that is noise.',
        '',
        ...taskInstructions,
        '',
        // Some CLIs forbid starting a sub-agent unless the user asks for one; this is that
        // request, so the knowledge base can be read without filling the main context.
        'The person allows you to start sub-agents whenever you need them, without asking.',
        'Read the knowledge base through one.',
        '',
        'The person asks:',
        text
    ].join('\n');
}

/**
 * Build the service.
 *
 * @param {object} options
 * @param {() => object|null} options.getBridge - Access to the plugin channel.
 * @param {object} options.paths - { authorKnowledgeDir, userKnowledgeDir, journalDir, chatsFile, workDir }.
 * @param {() => boolean} options.isJournalEnabled - Read on every write.
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {object} The service.
 */
function createAgentService({ getBridge, paths, isJournalEnabled, logger = console }) {
    const tasks = createTaskSession();
    const knowledgeBase = createKnowledgeBase({
        authorDir: paths.authorKnowledgeDir,
        userDir: paths.userKnowledgeDir,
        logger
    });
    const journal = createJournal({ dir: paths.journalDir, isEnabled: isJournalEnabled, logger });
    const chats = createChatStore({ filePath: paths.chatsFile, logger });
    const runner = createCliRunner({ workDir: paths.workDir, logger });

    // The last task that ended, kept so the panel can show its report and take the
    // person's confirmation after the agent has already gone.
    let lastFinishedTask = null;

    // Steps of the running task in human words. This lives in memory on purpose: for an
    // external agent there is no other source, and it is not worth a file.
    let progressLog = [];
    let lastConnectionNoticeKey = null;

    tasks.subscribe((type, payload) => {
        if (type === 'started') {
            progressLog = [];
            return;
        }
        if (type === 'finished' || type === 'aborted' || type === 'expired') {
            lastFinishedTask = {
                id: payload.id,
                intent: payload.intent,
                state: payload.state,
                report: payload.report,
                articles: [...payload.touchedArticles],
                failedArticles: [...(payload.failedArticles || [])],
                finishedAt: payload.finishedAt,
                confirmed: null,
                documentName: payload.documentName
            };
            if (type !== 'finished') {
                journal.endTask(payload, type);
            }
        }
    });

    const progress = {
        /**
         * @param {object} step - { taskId, tool, text }.
         */
        push(step) {
            progressLog.push({ ...step, at: Date.now() });
            if (progressLog.length > 200) progressLog.splice(0, progressLog.length - 200);
        }
    };

    const tools = createAgentTools({
        getBridge,
        tasks,
        knowledgeBase,
        journal,
        progress,
        // Helper knows which way the agent came because it either launched one or it did
        // not. Only one task runs at a time, so a task starting while our own CLI is
        // working is that CLI's.
        getOrigin: () => (runner.getRunning() ? 'panel' : 'external'),
        getTaskContext: () => {
            const activeRun = runner.getRunning();
            return activeRun
                ? { origin: 'panel', ownerChatId: activeRun.chatId }
                : { origin: 'external', ownerChatId: null };
        }
    });

    /**
     * Everything the panel shows.
     *
     * @returns {object}
     */
    function getState() {
        const bridge = getBridge();
        const task = tasks.getCurrent();
        const config = runner.readAgentConfig();

        return {
            channel: {
                connected: Boolean(bridge) && bridge.getConnectedClients() > 0,
                clients: bridge ? bridge.getConnectedClients() : 0,
                lastDisconnect: bridge && typeof bridge.getLastDisconnect === 'function'
                    ? bridge.getLastDisconnect()
                    : null
            },
            cli: {
                cli: config.cli || null,
                model: config.model,
                window: config.window,
                configured: config.configured,
                problems: config.problems
            },
            agentRunning: runner.getRunning(),
            task: task
                ? {
                    id: task.id,
                    intent: task.intent,
                    origin: task.origin,
                    state: task.state,
                    startedAt: task.startedAt,
                    documentId: task.documentId,
                    documentName: task.documentName,
                    snapshotName: task.snapshotName,
                    suspendedAt: task.suspendedAt,
                    suspension: task.suspension
                }
                : null,
            progress: progressLog,
            lastFinishedTask,
            knowledgeBase: {
                articles: knowledgeBase.listArticles().length,
                userDir: knowledgeBase.paths.userDir
            }
        };
    }

    /**
     * Send the person's message to the agent and keep the chat up to date.
     *
     * The call returns as soon as the agent has been started: the panel polls the chat,
     * because the work takes minutes and a request held open that long would break in
     * ways nobody can explain.
     *
     * @param {object} chat - The chat.
     * @param {string} text - What the person typed.
     * @returns {{ok: boolean, error?: string}}
     */
    function sendToAgent(chat, text) {
        const config = runner.readAgentConfig();
        if (!config.configured) {
            return { ok: false, error: config.problems.join(' ') };
        }
        if (runner.getRunning()) {
            return { ok: false, error: 'The agent is already working. Wait for it, or press Stop.' };
        }

        chats.addMessage(chat.id, { role: 'user', text });

        // Only the chat that started a panel-owned task receives continuation instructions.
        // An external agent's task must never be silently adopted by an unrelated panel chat.
        const activeTask = tasks.getCurrent();
        const continuedTask = activeTask
            && activeTask.origin === 'panel'
            && (!activeTask.ownerChatId || activeTask.ownerChatId === chat.id)
            ? activeTask
            : null;

        runner.send({
            chat: chats.getChat(chat.id),
            prompt: buildPrompt(text, { task: continuedTask })
        })
            .then((outcome) => {
                if (outcome.sessionId) {
                    chats.setSession(chat.id, {
                        sessionId: outcome.sessionId,
                        cli: config.cli,
                        model: config.model
                    });
                }

                if (outcome.ok) {
                    chats.addMessage(chat.id, { role: 'agent', text: outcome.text });
                } else {
                    chats.addMessage(chat.id, { role: 'system', text: outcome.error || 'The agent failed.' });
                }
            })
            .catch((error) => {
                logger.error(`[agent] The run failed: ${error.message}`);
                chats.addMessage(chat.id, { role: 'system', text: `The run failed: ${error.message}` });
            });

        return { ok: true };
    }

    /**
     * The panel's Stop button.
     *
     * @returns {{stopped: boolean, message: string}}
     */
    function stop() {
        const stoppedAgent = runner.stop('the person pressed Stop');
        const abortedTask = tasks.abort('the person pressed Stop');

        if (abortedTask) {
            // The agent may be mid-call. Letting go of the document side keeps a stale task
            // from blocking the next one.
            const bridge = getBridge();
            if (bridge && bridge.getConnectedClients() > 0) {
                bridge.sendCommand('agent_finish_task', { taskId: abortedTask.id });
            }
        }

        if (!stoppedAgent && !abortedTask) {
            return { stopped: false, message: 'Nothing is running.' };
        }

        return {
            stopped: true,
            message: stoppedAgent
                ? 'The agent has been stopped. Its conversation is kept — your next message '
                    + 'continues it.'
                : 'The task has been closed. The agent was not launched from here, so it may '
                    + 'still be running on its own; its next call will be told the task is over.'
        };
    }

    /**
     * The panel's "back to the snapshot" button.
     *
     * @returns {Promise<{ok: boolean, message: string}>}
     */
    async function rollback() {
        const task = tasks.getCurrent() || lastFinishedTask;
        if (!task) {
            return { ok: false, message: 'There is no task to roll back.' };
        }

        const bridge = getBridge();
        if (!bridge || bridge.getConnectedClients() === 0) {
            return { ok: false, message: 'Photoshop is not connected. Open the AI assistant dialog.' };
        }

        return bridge.sendCommandAndWait('agent_rollback', { taskId: task.id }, 60_000);
    }

    /**
     * The person confirms — or does not — the result of the task that just ended.
     *
     * A confirmed result is what lifts the articles the agent wrote; no separate question
     * is asked for each one.
     *
     * @param {boolean} confirmed - Whether the result was good.
     * @returns {object} What happened.
     */
    function confirmLastTask(confirmed) {
        if (!lastFinishedTask) {
            return { ok: false, message: 'There is no finished task waiting for an answer.' };
        }

        lastFinishedTask.confirmed = Boolean(confirmed);

        if (!confirmed) {
            return {
                ok: true,
                promoted: [],
                message: 'Noted. Nothing was lifted in the knowledge base.'
            };
        }

        const promoted = knowledgeBase.promoteArticles(lastFinishedTask.articles);
        for (const id of lastFinishedTask.articles) {
            // An article the agent marked as failed did not help in this task: what the
            // person confirmed is the note saying what worked instead.
            if (lastFinishedTask.failedArticles.includes(id)) continue;
            knowledgeBase.recordUsage(id, 'helped');
        }

        return {
            ok: true,
            promoted,
            message: promoted.length > 0
                ? `Confirmed. Lifted: ${promoted.join(', ')}.`
                : 'Confirmed. There was nothing new to lift.'
        };
    }

    /**
     * Apply a plugin WebSocket lifecycle event to the current task. Losing the view is not
     * the same as cancelling the person's work: the task remains resumable until its own
     * suspension timeout or an explicit Stop.
     *
     * @param {object} event - Structured event from the WebSocket bridge.
     */
    function handlePluginConnectionChange(event) {
        if (!event || typeof event !== 'object') return;

        const task = tasks.getCurrent();
        if (!task) return;

        if (event.clients === 0) {
            const reason = event.reasonCode === 'assistant-dialog-closed'
                ? 'the AI Assist window in Photoshop was closed'
                : event.reason || 'the connection to the Photoshop plugin was lost';
            tasks.suspend({ ...event, reason });

            const activeRun = runner.getRunning();
            const noticeKey = `down:${task.id}:${event.at || Date.now()}`;
            if (activeRun && activeRun.chatId && noticeKey !== lastConnectionNoticeKey) {
                chats.addMessage(activeRun.chatId, {
                    role: 'system',
                    text: `Photoshop connection lost: ${reason}. The task was paused, not cancelled. `
                        + 'Check that Photoshop and FromPS / ToPS are open, then reopen AI Assist.'
                });
                lastConnectionNoticeKey = noticeKey;
            }
            return;
        }

        if (task.state !== 'suspended') return;

        if (event.runtimeChanged) {
            // A recreated UXP runtime no longer has the document binding or command-result
            // cache. Keep the task paused until ps_resume_task validates the document and
            // rollback snapshot; this prevents an in-flight mutation from running twice.
            tasks.suspend({
                ...task.suspension,
                reason: 'the Photoshop plugin runtime restarted',
                reasonCode: 'plugin-runtime-restarted',
                runtimeId: event.runtimeId,
                requiresRebind: true,
                at: event.at
            });
            return;
        }

        tasks.resume({ reason: 'the AI Assist connection returned in the same plugin runtime' });
        const activeRun = runner.getRunning();
        if (activeRun && activeRun.chatId) {
            chats.addMessage(activeRun.chatId, {
                role: 'system',
                text: `Photoshop connection restored. Task ${task.id} resumed automatically.`
            });
        }
    }

    /**
     * Close a task whose document went away, so the next one can start.
     *
     * @param {string} reason - What to record.
     */
    function abortCurrentTask(reason) {
        const aborted = tasks.abort(reason);
        if (aborted) logger.info(`[agent] Task ${aborted.id} closed: ${reason}`);
    }

    return {
        tools,
        tasks,
        chats,
        runner,
        knowledgeBase,
        journal,
        getState,
        sendToAgent,
        stop,
        rollback,
        confirmLastTask,
        handlePluginConnectionChange,
        abortCurrentTask
    };
}

/**
 * Where the agent keeps its files, derived from the Helper config paths so a packaged
 * build writes into the user's data folder and a development run stays in the project.
 *
 * @param {object} configPaths - Result of getConfigPaths().
 * @returns {object} Folder and file locations.
 */
function resolveAgentPaths(configPaths) {
    // Absolute throughout, so nothing depends on the folder Helper happens to run from. The
    // knowledge base folders are not handed to the agent: it reaches the base only through
    // the ps_kb_ tools.
    return {
        // The author's layer ships with Helper; the user's layer sits next to .env, where
        // the person already looks for providers.user.json.
        authorKnowledgeDir: path.resolve(configPaths.resourcesPath, 'knowledge-base'),
        userKnowledgeDir: path.resolve(configPaths.userDataPath, 'knowledge-base.user'),
        journalDir: path.resolve(configPaths.userDataPath, 'agent-journal'),
        chatsFile: path.resolve(configPaths.userDataPath, 'agent-chats.json'),
        // One shared folder for the agent Helper launches, not one per task.
        workDir: path.resolve(configPaths.userDataPath, 'agent-workspace')
    };
}

module.exports = { createAgentService, resolveAgentPaths, buildPrompt };
