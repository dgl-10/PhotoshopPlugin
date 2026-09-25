'use strict';

/**
 * Assemble the Photoshop document-agent service used by the MCP server and the plugin's
 * AI Assist dialog.
 *
 * An MCP client owns its own interaction with the person; Helper owns only the Photoshop
 * task, the knowledge base, the diagnostic journal, and the live status shown in the
 * plugin.
 */

const path = require('node:path');

const { createTaskSession } = require('./task-session');
const { createKnowledgeBase } = require('./knowledge-base');
const { createJournal } = require('./journal');
const { createAgentTools } = require('./mcp-tools');

// Why a task ended when the person pressed Abort task in AI Assist. The agent reads it in
// the refusal of its next call; the plugin's AI Assist dialog (modules/agent-panel.js)
// compares against this exact text to say "aborted by you", so change both together.
const ABORTED_BY_PERSON = 'the person pressed Abort task';

/**
 * Build the service.
 *
 * @param {object} options
 * @param {() => object|null} options.getBridge - Access to the plugin channel.
 * @param {object} options.paths - Knowledge-base and journal folders.
 * @param {() => boolean} options.isJournalEnabled - Read on every journal write.
 * @param {() => boolean} [options.isAgentSeen] - Whether an MCP agent has started a task on
 *   this machine before, as remembered across Helper runs. Without it every run starts as
 *   if no agent had ever connected.
 * @param {() => void} [options.onAgentSeen] - Called when the first task of this Helper run
 *   starts, so the caller can remember it.
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {object} The document-agent service.
 */
function createAgentService({
    getBridge,
    paths,
    isJournalEnabled,
    isAgentSeen = () => false,
    onAgentSeen = () => {},
    logger = console
}) {
    const tasks = createTaskSession();
    const knowledgeBase = createKnowledgeBase({
        authorDir: paths.authorKnowledgeDir,
        userDir: paths.userKnowledgeDir,
        logger
    });
    const journal = createJournal({ dir: paths.journalDir, isEnabled: isJournalEnabled, logger });

    // The report remains visible after ps_finish_task closes the task, until the next task
    // starts. Displaying it has no side effects on task state or knowledge-base articles.
    let lastFinishedTask = null;

    // Whether a task has started during this Helper run. Together with isAgentSeen() it tells
    // AI Assist that its setup instructions have done their job.
    let agentSeenThisRun = false;

    // Steps of the running task in human words. This lives in memory on purpose: the MCP
    // client owns its own transcript, while the plugin only needs recent operational state.
    let progressLog = [];

    tasks.subscribe((type, payload) => {
        if (type === 'started') {
            // A new task owns the dialog from now on: the previous report and steps go.
            progressLog = [];
            lastFinishedTask = null;
            if (!agentSeenThisRun) {
                agentSeenThisRun = true;
                try {
                    onAgentSeen();
                } catch (error) {
                    logger.warn(`[agent] Could not record the first agent: ${error.message}`);
                }
            }
            return;
        }

        if (type === 'finished' || type === 'aborted' || type === 'expired') {
            lastFinishedTask = {
                id: payload.id,
                intent: payload.intent,
                state: payload.state,
                report: payload.report,
                startedAt: payload.startedAt,
                finishedAt: payload.finishedAt,
                abortReason: payload.abortReason || null,
                documentName: payload.documentName
            };

            // ps_finish_task closes its journal itself after the final plugin call. The
            // task registry closes only abnormal endings here.
            if (type !== 'finished') journal.endTask(payload, type);
        }
    });

    const progress = {
        /**
         * Keep the recent human-readable steps that the AI Assist dialog displays.
         *
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
        progress
    });

    /**
     * Return everything the AI Assist dialog needs to show.
     *
     * @returns {object} Current channel, task, progress, report, and knowledge-base state.
     */
    function getState() {
        const bridge = getBridge();
        const task = tasks.getCurrent();

        return {
            channel: {
                connected: Boolean(bridge) && bridge.getConnectedClients() > 0,
                clients: bridge ? bridge.getConnectedClients() : 0,
                lastDisconnect: bridge && typeof bridge.getLastDisconnect === 'function'
                    ? bridge.getLastDisconnect()
                    : null
            },
            task: task
                ? {
                    id: task.id,
                    intent: task.intent,
                    state: task.state,
                    startedAt: task.startedAt,
                    // Any tool call counts as activity. AI Assist warns when the agent has
                    // been silent for a while, unless it waits for the person in a dialog.
                    lastActivityAt: task.lastActivityAt,
                    waitingForPerson: (task.waitingForPerson || 0) > 0,
                    documentId: task.documentId,
                    documentName: task.documentName,
                    suspendedAt: task.suspendedAt,
                    suspension: task.suspension
                }
                : null,
            progress: progressLog,
            lastFinishedTask,
            agentSeen: agentSeenThisRun || Boolean(isAgentSeen()),
            knowledgeBase: {
                articles: knowledgeBase.listArticles().length,
                userDir: knowledgeBase.paths.userDir
            }
        };
    }

    /**
     * Close the current Photoshop task. The MCP client is a separate process owned by the
     * person, so this cannot and must not try to stop that process.
     *
     * @returns {{stopped: boolean, message: string}} Outcome for the plugin UI.
     */
    function stop() {
        const abortedTask = tasks.abort(ABORTED_BY_PERSON);
        if (!abortedTask) {
            return { stopped: false, message: 'There is no active task.' };
        }

        // Let the plugin release its document binding even though the MCP client may still
        // be running. Any later call with the old task id is refused by the task registry.
        const bridge = getBridge();
        if (bridge && bridge.getConnectedClients() > 0) {
            bridge.sendCommand('agent_finish_task', { taskId: abortedTask.id });
        }

        return {
            stopped: true,
            message: 'The task was aborted. The MCP agent may still be running; its next call '
                + 'with the old task id will be refused.'
        };
    }

    /**
     * Apply a plugin WebSocket lifecycle event to the current task. Losing the view is not
     * the same as cancelling work: closing AI Assist only removes the document channel.
     * The task remains resumable until its suspension timeout or an explicit Abort task
     * action. A reconnect from the same UXP runtime resumes it automatically below.
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
            return;
        }

        if (task.state !== 'suspended') return;

        if (event.runtimeChanged) {
            // A recreated UXP runtime no longer has the document binding or cached command
            // results. Keep the task paused until ps_resume_task validates and rebinds it.
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
    }

    /**
     * Close a task whose document went away, so the next task can start.
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
        knowledgeBase,
        journal,
        getState,
        stop,
        handlePluginConnectionChange,
        abortCurrentTask
    };
}

/**
 * Derive document-agent folders from Helper's config paths. Absolute paths keep packaged
 * and development runs independent of the process working directory.
 *
 * @param {object} configPaths - Result of getConfigPaths().
 * @returns {object} Knowledge-base and journal folders.
 */
function resolveAgentPaths(configPaths) {
    return {
        authorKnowledgeDir: path.resolve(configPaths.resourcesPath, 'knowledge-base'),
        userKnowledgeDir: path.resolve(configPaths.userDataPath, 'knowledge-base.user'),
        journalDir: path.resolve(configPaths.userDataPath, 'agent-journal')
    };
}

module.exports = { createAgentService, resolveAgentPaths };
