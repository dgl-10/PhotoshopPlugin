'use strict';

/**
 * The journal of MCP calls.
 *
 * Only the calls are written to disk — what was called, with what, and a short result.
 * The agent's own reasoning is not recorded. MCP clients and command-line tools each
 * keep their own logs in formats Helper does not own and should not try to parse.
 *
 * Images never go into the journal, only a note of what was captured.
 *
 * In a development run it is always on; in a built Helper it is off unless the user turns
 * it on, because it is a diagnostic tool and not part of normal use.
 */

const fs = require('node:fs');
const path = require('node:path');

// How many task files are kept. Enough to look back over a working session, small enough
// that nobody has to think about it.
const MAX_TASK_FILES = 20;

// Arguments are trimmed before they are written: a script can be long, and the journal is
// meant to be readable.
const MAX_FIELD_LENGTH = 2000;

/**
 * Shorten a value for the journal without losing what it was.
 *
 * @param {*} value - Any argument or result.
 * @returns {*} Something small enough to write down.
 */
function trimForJournal(value) {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
        return value.length > MAX_FIELD_LENGTH
            ? `${value.slice(0, MAX_FIELD_LENGTH)}… (${value.length} characters)`
            : value;
    }

    if (Array.isArray(value)) {
        return value.slice(0, 20).map(trimForJournal);
    }

    if (typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = trimForJournal(item);
        }
        return result;
    }

    return value;
}

/**
 * Create the journal.
 *
 * @param {object} options
 * @param {string} options.dir - Folder for the per-task files.
 * @param {() => boolean} options.isEnabled - Read on every write, so the setting takes
 *   effect without a restart.
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {object} Journal.
 */
function createJournal({ dir, isEnabled, logger = console }) {
    let currentFile = null;

    /**
     * @returns {boolean} True when the folder exists and can be written to.
     */
    function ensureDir() {
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            return true;
        } catch (error) {
            logger.warn(`[agent-journal] Could not create ${dir}: ${error.message}`);
            return false;
        }
    }

    /**
     * Drop the oldest task files so the folder does not grow without end.
     */
    function pruneOldFiles() {
        try {
            const files = fs.readdirSync(dir)
                .filter(name => name.endsWith('.jsonl'))
                .map(name => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);

            for (const file of files.slice(MAX_TASK_FILES)) {
                fs.rmSync(path.join(dir, file.name), { force: true });
            }
        } catch (error) {
            logger.warn(`[agent-journal] Could not prune ${dir}: ${error.message}`);
        }
    }

    /**
     * @param {object} entry - One line of the journal.
     */
    function write(entry) {
        if (!isEnabled() || !currentFile) return;
        try {
            fs.appendFileSync(currentFile, `${JSON.stringify(entry)}\n`, 'utf8');
        } catch (error) {
            logger.warn(`[agent-journal] Could not write ${currentFile}: ${error.message}`);
        }
    }

    /**
     * Open a file for a new task.
     *
     * @param {object} task - The task that just started.
     */
    function startTask(task) {
        if (!isEnabled() || !ensureDir()) {
            currentFile = null;
            return;
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentFile = path.join(dir, `${stamp}_${task.id}.jsonl`);
        write({
            at: new Date().toISOString(),
            event: 'task-started',
            task: task.id,
            intent: task.intent,
            document: { id: task.documentId, name: task.documentName }
        });
        pruneOldFiles();
    }

    /**
     * Record one MCP call.
     *
     * @param {object} call - { task, tool, args, result, error, ms }.
     */
    function logCall(call) {
        write({
            at: new Date().toISOString(),
            event: 'tool-call',
            task: call.task || null,
            tool: call.tool,
            args: trimForJournal(call.args || {}),
            result: call.result === undefined ? null : trimForJournal(call.result),
            error: call.error || null,
            ms: call.ms === undefined ? null : call.ms
        });
    }

    /**
     * Close the file for a finished task.
     *
     * @param {object} task - The task that ended.
     * @param {string} how - 'finished', 'aborted' or 'expired'.
     */
    function endTask(task, how) {
        write({
            at: new Date().toISOString(),
            event: `task-${how}`,
            task: task.id,
            report: task.report || null
        });
        currentFile = null;
    }

    return { startTask, logCall, endTask, dir, MAX_TASK_FILES };
}

module.exports = {
    createJournal,
    MAX_TASK_FILES,
    // Exported for testing only; it decides what a long script looks like in the journal.
    trimForJournal
};
