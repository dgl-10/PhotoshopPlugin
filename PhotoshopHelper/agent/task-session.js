'use strict';

/**
 * The task frame of the document agent.
 *
 * Every agent — the one Helper launches itself and the one the user opens in their own
 * terminal — has to go through the same door: `ps_start_task` hands out the task id, the
 * working rules and the knowledge base index, and every other tool refuses to work
 * without that id. Tool descriptions are read unevenly by different agents, but a refusal
 * cannot be skipped, so the refusal is what actually delivers the rules.
 *
 * Only one task runs at a time. A task is bound to the document it started on, so the
 * user is free to switch documents while the agent works.
 */

const crypto = require('node:crypto');

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SUSPEND_TIMEOUT_MS = 30 * 60 * 1000;

// Steps kept per task for the panel's progress view. Older ones are dropped; the disk
// journal is the place where a full history belongs.
const MAX_STEPS_PER_TASK = 200;

/**
 * Error raised when a tool is called without a usable task id. The MCP layer turns it
 * into a tool result the agent can read and act on, not into a transport error.
 */
class TaskError extends Error {
    /**
     * @param {string} message - Text shown to the agent.
     * @param {string} code - Machine-readable reason.
     */
    constructor(message, code) {
        super(message);
        this.name = 'TaskError';
        this.code = code;
    }
}

/**
 * @param {number} ms - Milliseconds.
 * @returns {string} Human phrasing such as "4 minutes".
 */
function describeAge(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return 'less than a minute';
    if (minutes === 1) return '1 minute';
    return `${minutes} minutes`;
}

/**
 * Create the task registry.
 *
 * @param {object} [options]
 * @param {number} [options.idleTimeoutMs] - Silence after which an abandoned task closes itself.
 * @param {number} [options.suspendTimeoutMs] - How long a disconnected task remains resumable.
 * @param {() => number} [options.now] - Clock, replaced in tests.
 * @param {() => string} [options.generateId] - Task id factory, replaced in tests.
 * @returns {object} Task registry.
 */
function createTaskSession(options = {}) {
    const idleTimeoutMs = options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS;
    const suspendTimeoutMs = options.suspendTimeoutMs || DEFAULT_SUSPEND_TIMEOUT_MS;
    const now = options.now || (() => Date.now());
    const generateId = options.generateId
        || (() => `task-${crypto.randomBytes(3).toString('hex')}`);

    let current = null;
    let lastClosed = null;
    const listeners = new Set();

    /**
     * @param {string} type - Event name.
     * @param {object} payload - Event body.
     */
    function emit(type, payload) {
        for (const listener of listeners) {
            try {
                listener(type, payload);
            } catch {
                // A broken listener must not break the task it is watching.
            }
        }
    }

    /**
     * Close a task that has been silent for longer than the idle timeout. Agents do walk
     * away mid-task — a crashed terminal, a closed window — and without this the next
     * task could never start.
     *
     * @returns {object|null} The task that was dropped, if any.
     */
    function expireIfIdle() {
        if (!current || !['running', 'suspended'].includes(current.state)) return null;

        const wasSuspended = current.state === 'suspended';
        // A task waiting for the person to finish in a Photoshop dialog is silent, not
        // abandoned. A lost connection still expires it through the suspension branch.
        if (!wasSuspended && current.waitingForPerson > 0) return null;
        const timeout = wasSuspended ? suspendTimeoutMs : idleTimeoutMs;
        const lastRelevantActivity = wasSuspended ? current.suspendedAt : current.lastActivityAt;
        if (now() - lastRelevantActivity < timeout) return null;

        const dropped = current;
        dropped.state = 'expired';
        dropped.abortReason = wasSuspended
            ? 'the Photoshop connection did not return in time'
            : 'the task was idle for too long';
        dropped.finishedAt = now();
        lastClosed = dropped;
        current = null;
        emit('expired', dropped);
        return dropped;
    }

    /**
     * Start a task and bind it to a document.
     *
     * @param {object} params
     * @param {string} params.intent - What the agent says it is about to do.
     * @param {object} [params.document] - { id, name } of the working document.
     * @param {string} [params.origin] - 'panel' or 'external', for the journal and the panel.
     * @param {string|null} [params.ownerChatId] - Built-in chat that owns the task.
     * @returns {object} The new task.
     * @throws {TaskError} When another task is still running.
     */
    function start({ intent, document, origin = 'external', ownerChatId = null }) {
        expireIfIdle();

        if (current && ['running', 'suspended'].includes(current.state)) {
            if (current.state === 'suspended') {
                throw new TaskError(describeSuspension(current), 'TASK_ALREADY_RUNNING');
            }
            throw new TaskError(
                `A task is already running: ${current.id} — "${current.intent}", started `
                + `${describeAge(now() - current.startedAt)} ago on document `
                + `"${current.documentName || 'unknown'}". Only one task runs at a time. `
                + 'Finish it with ps_finish_task, or wait: a task that goes silent for '
                + `${Math.round(idleTimeoutMs / 60000)} minutes closes itself.`,
                'TASK_ALREADY_RUNNING'
            );
        }

        const timestamp = now();
        current = {
            id: generateId(),
            intent: String(intent || '').trim() || 'unnamed task',
            origin,
            ownerChatId,
            state: 'running',
            startedAt: timestamp,
            lastActivityAt: timestamp,
            finishedAt: null,
            documentId: document && document.id !== undefined ? document.id : null,
            documentName: document ? document.name || null : null,
            documentPath: document ? document.path || null : null,
            photoshopVersion: null,
            snapshotName: null,
            snapshotCreated: false,
            snapshotHistoryId: null,
            suspendedAt: null,
            suspension: null,
            // How many calls are waiting right now for the person to finish in a dialog
            // (an interactive ps_execute_script). While above zero the task does not idle out.
            waitingForPerson: 0,
            // ps_finish_task refuses once while a dialog is open or its result unseen; a
            // second attempt closes the task anyway. Reset whenever a new dialog opens.
            finishWarnedAboutDialog: false,
            steps: [],
            // How many calls came back as failures. It is how we know the task was a
            // struggle, and a struggle is exactly what is worth writing down.
            failures: 0,
            // How many of those failures were scripts that ran to the end while Photoshop
            // rejected some of their commands. The agent saw no error on them, so the
            // struggle question has to name them.
            rejectedCalls: 0,
            // ps_finish_task asks once for a contribution when the task was hard and
            // nothing was written. Counting the attempts keeps that from becoming a loop.
            finishAttempts: 0,
            // Articles this task wrote or added to. They are the ones promoted when the
            // user confirms the result in ps_finish_task.
            touchedArticles: [],
            // The part of touchedArticles this task marked as failed. They are still lifted
            // on confirmation, for the note, but not counted as having helped.
            failedArticles: [],
            report: null,
            confirmed: null
        };

        emit('started', current);
        return current;
    }

    /**
     * Resolve a task id coming from a tool call.
     *
     * @param {string} taskId - Task id the agent passed.
     * @returns {object} The running task.
     * @throws {TaskError} When there is no task, or the id belongs to another one.
     */
    function require_(taskId) {
        expireIfIdle();

        if (!current) {
            if (lastClosed && taskId && lastClosed.id === taskId) {
                throw new TaskError(
                    `Task ${taskId} is no longer running: ${lastClosed.abortReason || lastClosed.state}. `
                    + 'Tell the person what happened. Start a new task only after Photoshop and '
                    + 'the FromPS / ToPS AI Assist connection are available.',
                    'TASK_ENDED'
                );
            }
            throw new TaskError(
                'No task is running. Call ps_start_task first: it returns the task id that '
                + 'every other tool needs, the rules for working with this Photoshop '
                + 'document, and the knowledge base index.',
                'NO_TASK'
            );
        }

        if (!taskId) {
            throw new TaskError(
                `This tool needs the task_id returned by ps_start_task. The running task is ${current.id}.`,
                'TASK_ID_MISSING'
            );
        }

        if (taskId !== current.id) {
            throw new TaskError(
                `There is no task ${taskId}. The running task is ${current.id} — `
                + `"${current.intent}". Use that id, or call ps_finish_task and start a new task.`,
                'TASK_ID_UNKNOWN'
            );
        }

        if (current.state === 'suspended') {
            throw new TaskError(describeSuspension(current), 'TASK_SUSPENDED');
        }

        current.lastActivityAt = now();
        return current;
    }

    /**
     * Build the actionable refusal shown to an agent while Photoshop is disconnected.
     *
     * @param {object} task - Suspended task.
     * @returns {string} Human-readable recovery instructions.
     */
    function describeSuspension(task) {
        const reason = task.suspension && task.suspension.reason
            ? task.suspension.reason
            : 'the connection to Photoshop was lost';
        const recovery = task.suspension && task.suspension.requiresRebind
            ? `The plugin runtime restarted, so call ps_resume_task with task_id "${task.id}" `
                + 'after the person reopens AI Assist. Inspect the document before repeating any change.'
            : 'Ask the person to check that Photoshop and the FromPS / ToPS plugin are open, '
                + 'then reopen AI Assist. After the connection returns, continue with the same task_id '
                + 'and inspect the document before repeating the interrupted operation.';

        return `Task ${task.id} is paused because ${reason}. ${recovery} Do not call ps_start_task.`;
    }

    /**
     * Keep a task alive while its Photoshop channel is unavailable.
     *
     * @param {object} details - Structured disconnect information.
     * @returns {object|null} The suspended task.
     */
    function suspend(details = {}) {
        if (!current || !['running', 'suspended'].includes(current.state)) return null;

        current.state = 'suspended';
        current.suspendedAt = current.suspendedAt || now();
        current.suspension = {
            reason: details.reason || 'the connection to Photoshop was lost',
            reasonCode: details.reasonCode || 'connection-lost',
            code: details.code || null,
            runtimeId: details.runtimeId || null,
            requiresRebind: Boolean(details.requiresRebind),
            at: details.at || now()
        };
        emit('suspended', current);
        return current;
    }

    /**
     * Return a suspended task to service after the plugin reconnects or rebinds it.
     *
     * @param {object} [details] - Resume metadata for the journal and panel.
     * @returns {object|null} The resumed task.
     */
    function resume(details = {}) {
        if (!current || current.state !== 'suspended') return current;

        const previousSuspension = current.suspension;
        current.state = 'running';
        current.lastActivityAt = now();
        current.suspendedAt = null;
        current.suspension = null;
        current.lastResume = {
            at: now(),
            reason: details.reason || 'the Photoshop connection returned',
            previousSuspension
        };
        emit('resumed', current);
        return current;
    }

    /**
     * Record a step for the panel's progress view.
     *
     * @param {string} taskId - Running task id.
     * @param {object} step - { tool, text }.
     * @returns {object|null} The stored step.
     */
    function addStep(taskId, step) {
        if (!current || current.id !== taskId) return null;

        const entry = { at: now(), tool: step.tool || null, text: step.text || '' };
        current.steps.push(entry);
        if (current.steps.length > MAX_STEPS_PER_TASK) {
            current.steps.splice(0, current.steps.length - MAX_STEPS_PER_TASK);
        }
        current.lastActivityAt = entry.at;
        emit('step', { task: current, step: entry });
        return entry;
    }

    /**
     * Keep a task from idling out while a call waits for the person to work in a Photoshop
     * dialog, which can take longer than the idle timeout on its own.
     *
     * @param {string} taskId - Running task id.
     * @returns {Function} Call it when the wait is over; it counts as activity. Calling it
     *   more than once, or after the task has ended, does nothing.
     */
    function waitForPerson(taskId) {
        if (!current || current.id !== taskId) return () => {};

        const task = current;
        task.waitingForPerson = (task.waitingForPerson || 0) + 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            task.waitingForPerson = Math.max(0, (task.waitingForPerson || 0) - 1);
            if (current === task) task.lastActivityAt = now();
        };
    }

    /**
     * Count a call that came back as a failure.
     *
     * @param {string} taskId - Running task id.
     * @param {object} [options]
     * @param {boolean} [options.rejectedCommands] - The call did not fail as such, but
     *   Photoshop rejected commands inside it. Counted as a failure all the same.
     * @returns {number} The failure count so far.
     */
    function noteFailure(taskId, { rejectedCommands = false } = {}) {
        if (!current || current.id !== taskId) return 0;
        current.failures += 1;
        if (rejectedCommands) current.rejectedCalls += 1;
        return current.failures;
    }

    /**
     * Remember that the task wrote to a knowledge base article.
     *
     * @param {string} taskId - Running task id.
     * @param {string} articleId - Article id.
     * @param {object} [options]
     * @param {boolean} [options.failed] - What was written is a note that the article did not
     *   work. The person's confirmation then vouches for the note, not for the article, so
     *   the article must not be counted as having helped.
     */
    function noteArticle(taskId, articleId, { failed = false } = {}) {
        if (!current || current.id !== taskId) return;
        if (!current.touchedArticles.includes(articleId)) {
            current.touchedArticles.push(articleId);
        }
        if (failed && !current.failedArticles.includes(articleId)) {
            current.failedArticles.push(articleId);
        }
    }

    /**
     * Close the task with the agent's own report.
     *
     * @param {string} taskId - Running task id.
     * @param {object} report - { summary, issues, suggestions }.
     * @returns {object} The finished task.
     */
    function finish(taskId, report) {
        const task = require_(taskId);
        task.state = 'finished';
        task.finishedAt = now();
        task.report = {
            summary: report.summary || '',
            issues: report.issues || '',
            suggestions: report.suggestions || ''
        };
        lastClosed = task;
        current = null;
        emit('finished', task);
        return task;
    }

    /**
     * Stop the task on the user's command from the panel.
     *
     * @param {string} [reason] - Why it was stopped.
     * @returns {object|null} The stopped task.
     */
    function abort(reason = 'stopped by the user') {
        if (!current || !['running', 'suspended'].includes(current.state)) return null;
        const task = current;
        task.state = 'aborted';
        task.abortReason = reason;
        task.finishedAt = now();
        lastClosed = task;
        current = null;
        emit('aborted', task);
        return task;
    }

    /**
     * The task currently running, after expiring an abandoned one.
     *
     * @returns {object|null}
     */
    function getCurrent() {
        expireIfIdle();
        return current;
    }

    /**
     * @returns {object|null} Most recently finished, aborted, or expired task.
     */
    function getLastClosed() {
        return lastClosed;
    }

    /**
     * @param {Function} listener - Called as (type, payload) on every task event.
     * @returns {Function} Unsubscribe.
     */
    function subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    return {
        start,
        require: require_,
        finish,
        abort,
        suspend,
        resume,
        describeSuspension,
        addStep,
        waitForPerson,
        noteFailure,
        noteArticle,
        getCurrent,
        getLastClosed,
        expireIfIdle,
        subscribe,
        idleTimeoutMs,
        suspendTimeoutMs
    };
}

module.exports = {
    createTaskSession,
    TaskError,
    DEFAULT_IDLE_TIMEOUT_MS,
    DEFAULT_SUSPEND_TIMEOUT_MS,
    // Exported for testing only; the phrasing is part of the refusal messages.
    describeAge
};
