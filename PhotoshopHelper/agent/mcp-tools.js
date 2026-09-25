'use strict';

/**
 * The tools the MCP server hands to an agent.
 *
 * Naming. MCP has no namespaces and no groups: a server publishes one flat list, so the
 * only thing that says what a tool touches is its name. Everything in this file works on
 * the Photoshop document and is therefore prefixed `ps_` without exception — reading the
 * document, running a script, capturing an image, starting and finishing a task, and the
 * knowledge base. The same server will later publish tools that have nothing to do with
 * the document (generation through the Local Generation API and WebHelper); those get the
 * prefix `gen_`, so one look at the list separates the two.
 *
 * There are few ready-made tools on purpose. Everything that changes the document goes
 * through ps_execute_script, where batchPlay, the DOM and the Imaging API are all in
 * scope. The tuning happens in the text of the knowledge base, not in code: correcting an
 * article works immediately, while a new tool needs a release of both Helper and the
 * plugin. If it turns out during tuning that the agent keeps getting some frequent action
 * wrong even with an article in front of it, that action becomes a tool of its own.
 */

const { TaskError } = require('./task-session');

// The plugin answers fast for reads, slowly for anything that touches pixels. A heavy
// filter was measured at up to 12 seconds during the stage 1 channel tests, and a script
// written by an agent can chain several of them.
const TIMEOUT_READ_MS = 30_000;
const TIMEOUT_IMAGE_MS = 90_000;
const TIMEOUT_SCRIPT_MS = 180_000;

// An interactive ps_execute_script opens a Photoshop dialog (Liquify, Camera Raw, a filter)
// in front of the person, and the call only returns when they press OK or Cancel there.
// Someone retouching in Liquify can easily spend many minutes, and cutting the wait short
// would tell the agent "no answer" while the person is still working. Thirty minutes matches
// the other long limits around a task (the idle timeout in task-session.js and the run limit
// in cli-runner.js), so this wait is never the first thing to give up.
const TIMEOUT_INTERACTIVE_SCRIPT_MS = 30 * 60 * 1000;

// But no single MCP call may be held that long: the agent's own client gives up on a tool
// call after its own limit and throws the answer away. Antigravity cut an interactive call
// at 3 minutes while the person was still in Camera Raw; Codex's hard-coded default is
// 5 minutes (older versions used 60 seconds), and clients built on the MCP TypeScript SDK
// default to 60 seconds per request. So an interactive call answers after this long at the
// latest — with the result if the person is done, otherwise with "the dialog is still open,
// call ps_wait_for_dialog" — and each ps_wait_for_dialog call waits no longer than this
// either. Forty seconds stays well under the shortest of those limits.
const DIALOG_WAIT_MS = 40_000;

// Images cost context, so the default is a reduced copy. The agent can ask for a larger
// one or for the original when it actually needs to look closely.
const DEFAULT_IMAGE_MAX_SIZE = 512;
const HARD_IMAGE_MAX_SIZE = 8192;

const ASSISTANT_CLOSED_MESSAGE =
    'The connection to Photoshop is unavailable. Ask the person to check that Photoshop and '
    + 'the FromPS / ToPS plugin are open, then reopen AI Assist from the panel flyout menu. '
    + 'Do not guess that an unfinished change failed, and do not repeat it blindly.';

// The plugin marks this one case in the text of its error, because only the text crosses
// the channel. A task whose document went away is closed here rather than left to time out.
const DOCUMENT_CLOSED_MARKER = '[document-closed]';

// When a script throws, the commands Photoshop rejected before that ride at the end of the
// error text behind this marker, as JSON. The same string is defined in the plugin's
// modules/batchplay-watch.js.
const REJECTED_COMMANDS_MARKER = '[rejected-commands]';

// The batchPlay error code for "the user cancelled the operation".
const USER_CANCELLED_CODE = -128;

// Up to this many articles, the whole index is handed over at the start of a task: a few
// dozen one-line entries cost little and save a round trip. Past it, the index is
// something the agent asks for — ideally from a sub-agent, so the reading does not sit in
// its main context for the rest of the task. Set to 0 to never include the index inline.
const INLINE_INDEX_MAX_ARTICLES = 0;

// Up to this many articles can be read in a single batch call through ps_kb_read.
const MAX_BATCH_ARTICLES = 4;

// How the knowledge base is to be read, repeated in ps_start_task and in the descriptions of
// both reading tools: the descriptions are what the agent sees at the moment it decides,
// long after it read the rules. Reading it yourself is named as the fallback on purpose —
// an agent whose own rules forbid starting a sub-agent unasked once took "only from a
// sub-agent" as a reason not to read the base at all.
//
// The base is reached only through the ps_kb_ tools, and nothing handed to the agent says
// where its files are. An agent told the folders reads them, and then edits or adds files
// by hand, past the article header and the two layers — and possibly into the
// author's layer. Reads through the tools also land in the task journal.
const KB_READING_RULE =
    'Look at the knowledge base before your first change to the document and before you write '
    + 'a new article, and read it from a sub-agent, not in your main context. An article can '
    + 'be any length, so the number of articles tells you nothing about how much text you would '
    + 'take in, and whatever you read in your main context is sent again with every later call '
    + 'until the task ends. Give the sub-agent the problem; have it open every article whose '
    + 'index line looks like it — several at once through article_ids — and bring back the '
    + 'recipe and the article id, which you need later to mark with ps_kb_mark_helped or '
    + 'ps_kb_mark_failed. The sub-agent needs this server\'s ps_kb_ tools '
    + 'and the task id; if your sub-agents cannot call MCP tools, read the base yourself '
    + 'through the tools. If starting a sub-agent needs the person to allow it, ask them for '
    + 'that in one short line.';

// This many failed calls in one task means the agent was fighting Photoshop rather than
// working it. Two is deliberately low: one rejected descriptor is a typo, two is a wrong
// belief about how Photoshop works, and that is what is worth writing down.
const STRUGGLE_THRESHOLD = 2;

/**
 * @param {string} text - Text for the agent.
 * @param {boolean} [isError] - Whether this is a refusal.
 * @returns {object} An MCP tool result.
 */
function textResult(text, isError = false) {
    const result = { content: [{ type: 'text', text }] };
    if (isError) result.isError = true;
    return result;
}

/**
 * Render the short state line that closes every answer about the document.
 *
 * The agent has to see what the person did by hand without asking, the same way a coding
 * agent sees that a file changed under it.
 *
 * @param {object|null} status - The status block returned by the plugin.
 * @returns {string} One or two lines, or an empty string.
 */
function formatStatus(status) {
    if (!status || typeof status !== 'object') return '';

    const parts = [];
    if (status.documentName) {
        parts.push(`document: ${status.documentName} (id ${status.documentId})`);
    }
    if (status.historyStep) {
        parts.push(`current history step: "${status.historyStep}"`);
    }
    if (status.activeDocumentChanged) {
        parts.push('the person switched to another document, we worked in yours and switched back');
    }

    const lines = [];
    if (parts.length > 0) lines.push(`[state] ${parts.join(' · ')}`);

    if (Array.isArray(status.sinceLastCall) && status.sinceLastCall.length > 0) {
        lines.push(`[since your last call] ${status.sinceLastCall.join('; ')}`);
    }

    return lines.join('\n');
}

/**
 * Attach the state line to a tool's own text.
 *
 * @param {string} text - The tool's answer.
 * @param {object|null} status - Status block from the plugin.
 * @returns {string}
 */
function withStatus(text, status) {
    const statusText = formatStatus(status);
    return statusText ? `${text}\n\n${statusText}` : text;
}

/**
 * Describe the batchPlay commands Photoshop rejected during a script.
 *
 * batchPlay does not throw on these, so without this block a script that did not look at
 * its results reports success, and so does the agent.
 *
 * @param {object|null} report - { total, commands: [{ command, message, code }] } from the plugin.
 * @param {object} [options]
 * @param {boolean} [options.interactive] - The script ran as an interactive call, where the
 *   dialog was opened for the person on purpose; the -128 advice is worded for that case.
 * @returns {string} The block, or an empty string when nothing was rejected.
 */
function formatRejectedCommands(report, { interactive = false } = {}) {
    if (!report || typeof report !== 'object') return '';
    const commands = Array.isArray(report.commands) ? report.commands : [];
    const total = Math.max(Number(report.total) || 0, commands.length);
    if (total === 0) return '';

    const lines = [`Photoshop rejected ${total} command${total === 1 ? '' : 's'} in this script:`];
    for (const item of commands) {
        const code = item && Number.isFinite(item.code) ? ` (code ${item.code})` : '';
        const name = (item && item.command) || 'unknown';
        const message = (item && item.message) || 'no message';
        lines.push(`  - ${name}: ${message}${code}`);
    }
    if (total > commands.length) {
        lines.push(`  - and ${total - commands.length} more, not listed.`);
    }
    // Per Adobe's batchPlay documentation, -128 means the user cancelled the operation. For
    // the agent's commands that almost always means Photoshop showed the person a dialog and
    // it was dismissed, so the message is empty and the real cause is not in the answer.
    // In an interactive call the dialog was meant to be there, so "retry without display"
    // would be the wrong advice: most likely the person pressed Cancel, or Photoshop refused
    // to open the dialog and showed them an alert instead.
    if (interactive && commands.some(item => item && item.code === USER_CANCELLED_CODE)) {
        lines.push(
            `Code ${USER_CANCELLED_CODE} in an interactive call means the person closed the dialog `
            + 'with Cancel, cancelled the plugin command, or Photoshop could not open the dialog '
            + 'and showed them an alert instead. The answer does not say which: ask the person '
            + 'what they saw before trying again.'
        );
    } else if (commands.some(item => item && item.code === USER_CANCELLED_CODE)) {
        lines.push(
            `Code ${USER_CANCELLED_CODE} means a Photoshop dialog was shown to the person and `
            + 'dismissed, or the operation was cancelled, so the real reason is not in this '
            + 'answer: check your own descriptor, and if it used dialogOptions: "display", '
            + 'retry without it.'
        );
    }
    lines.push(
        'batchPlay does not throw when Photoshop rejects a command — it puts { _obj: "error" } '
        + 'in that command\'s place in the returned list — so a try/catch in the script will not '
        + 'see it.'
    );
    return lines.join('\n');
}

/**
 * Wait for a promise, but no longer than the given time. The promise itself is left running.
 *
 * @param {Promise} promise - A promise that never rejects.
 * @param {number} ms - Longest wait.
 * @returns {Promise<void>}
 */
async function waitAtMost(promise, ms) {
    let timer = null;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, ms); });
    try {
        await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @param {number} ms - Milliseconds.
 * @returns {string} Human phrasing such as "40 seconds" or "5 minutes".
 */
function describeDuration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    return `${Math.round(seconds / 60)} minutes`;
}

/**
 * Take the rejected commands off the end of a failed script's error text and describe them
 * in their place.
 *
 * @param {Error} error - The error that came back from the plugin.
 * @param {object} [options] - Passed on to formatRejectedCommands.
 * @returns {Error} The same error; its message is rewritten when it carried the marker.
 */
function explainRejectedCommandsInError(error, options = {}) {
    const message = String((error && error.message) || '');
    const at = message.lastIndexOf(REJECTED_COMMANDS_MARKER);
    if (at === -1) return error;

    let report;
    try {
        report = JSON.parse(message.slice(at + REJECTED_COMMANDS_MARKER.length));
    } catch {
        // Not what the plugin writes; better left as it came than cut in half.
        return error;
    }

    const block = formatRejectedCommands(report, options);
    const before = message.slice(0, at).trimEnd();
    error.message = block ? `${before}\n\n${block}` : before;
    return error;
}

/**
 * Build the tool layer.
 *
 * @param {object} options
 * @param {() => object|null} options.getBridge - Access to the plugin channel.
 * @param {object} options.tasks - Task registry from task-session.js.
 * @param {object} options.knowledgeBase - Knowledge base from knowledge-base.js.
 * @param {object} options.journal - Journal from journal.js.
 * @param {object} [options.progress] - Sink for human-readable progress, shown in the panel.
 * @param {number} [options.dialogWaitMs] - How long one call waits for the person to finish
 *   in a dialog before answering "still open". Defaults to DIALOG_WAIT_MS; tests shorten it.
 * @returns {object} { list, call, ASSISTANT_CLOSED_MESSAGE }
 */
function createAgentTools({
    getBridge,
    tasks,
    knowledgeBase,
    journal,
    progress,
    dialogWaitMs = DIALOG_WAIT_MS
}) {
    // Seconds, for the tool descriptions and answers.
    const dialogWaitSeconds = Math.max(1, Math.round(dialogWaitMs / 1000));

    // The interactive ps_execute_script whose dialog may still be open, or whose result
    // arrived and has not been handed to the agent yet. Only one can exist: Photoshop is
    // modal while the dialog is open. Shape: { taskId, historyName, startedAt, promise,
    // outcome: null | { answer } | { error }, handedOff, delivered }.
    let pendingDialog = null;
    // Who is on the other end, as the MCP client named itself when it connected. It goes
    // into the header of every article, because "which agent wrote this" is part of how
    // much the next reader should trust it.
    let clientName = 'unknown';

    /**
     * @param {object|null} clientInfo - The clientInfo block from initialize.
     */
    function setClient(clientInfo) {
        if (!clientInfo || typeof clientInfo !== 'object') return;
        const name = String(clientInfo.name || '').trim();
        const version = String(clientInfo.version || '').trim();
        if (name) clientName = version ? `${name} ${version}` : name;
    }

    /**
     * Send one command to the plugin and wait for its answer.
     *
     * @param {string} action - Command name understood by the plugin.
     * @param {object} payload - Command payload.
     * @param {number} timeoutMs - How long to wait.
     * @returns {Promise<object>} The plugin's result.
     * @throws {Error} When the assistant dialog is closed or the plugin reported a failure.
     */
    async function callPlugin(action, payload, timeoutMs) {
        const bridge = getBridge();
        if (!bridge || bridge.getConnectedClients() === 0) {
            const error = new Error(ASSISTANT_CLOSED_MESSAGE);
            error.code = 'PANEL_CLOSED';
            throw error;
        }
        return bridge.sendCommandAndWait(action, payload, timeoutMs);
    }

    /**
     * Describe the knowledge base to an agent that has just arrived.
     *
     * There is one way in: the ps_kb_ tools. Where the articles live on disk is never
     * named here — see KB_READING_RULE for why.
     *
     * Reading is cheapest from a sub-agent: an index and three articles to find one answer
     * is a lot of text to leave sitting in the main context for the rest of the task.
     *
     * @returns {string} The block that goes into the ps_start_task answer.
     */
    function describeKnowledgeBase() {
        const articles = knowledgeBase.listArticles();
        const lines = [
            '## Knowledge base',
            `${articles.length} article${articles.length === 1 ? '' : 's'}, written by the author `
            + 'of Helper and by agents before you. Each starts with a short header: the problem '
            + 'it is for, who wrote it, when it was written, the Photoshop version, its manual '
            + 'confidence label, and how often agents reported that it helped or failed.',
            '',
            'Use it only through these tools — never by reading or writing its files:',
            '  ps_kb_list gives one line per article, ps_kb_read gives one article (or up to 4 via article_ids);',
            '  ps_kb_contribute writes a new technical article;',
            '  ps_kb_mark_helped and ps_kb_mark_failed record how an article worked for an agent.',
            'The tools keep the article header, counters, failure notes, and the two layers straight.',
            KB_READING_RULE,
            '',
            'Mark every article you actually followed: helped if it worked exactly as written, '
            + 'failed with a note if it did not or needed a change. These agent marks never change '
            + 'manual confidence. Write a new article only when the next agent would otherwise get '
            + 'something wrong or lose real time on it — the rules above say how to tell.'
        ];

        if (articles.length === 0) {
            lines.push(
                '',
                'The base is empty so far. That does not make everything you do worth an article.'
            );
        } else if (articles.length <= INLINE_INDEX_MAX_ARTICLES) {
            lines.push(
                '',
                'It is still small, so here is the whole index. Open an article only when its '
                + 'line looks like your problem.',
                knowledgeBase.formatIndex()
            );
        } else {
            lines.push(
                '',
                'The index is not included here. Ask for it with ps_kb_list, as described above.'
            );
        }

        return lines.join('\n');
    }

    /**
     * @param {string} taskId - Task the step belongs to.
     * @param {string} text - Human phrasing of what is happening, for the panel.
     * @param {string} tool - Tool that caused it.
     */
    function note(taskId, text, tool) {
        tasks.addStep(taskId, { tool, text });
        if (progress && typeof progress.push === 'function') {
            progress.push({ taskId, tool, text });
        }
    }

    const TOOLS = [
        {
            name: 'ps_start_task',
            description:
                'Start work on the open Photoshop document. Call this before you look at the '
                + 'document or change it: it returns the task id that all other ps_ tools require, '
                + 'the rules for working with this document, the knowledge base, and what is in '
                + 'the document right now. If the person only asked you something — a shortcut, '
                + 'how some part of Photoshop works — answer them; none of this is needed and a '
                + 'task for it is just noise. Only one task runs at a time.',
            inputSchema: {
                type: 'object',
                properties: {
                    intent: {
                        type: 'string',
                        description: 'One sentence on what you are about to do, in the person\'s words.'
                    }
                },
                required: ['intent'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_resume_task',
            description:
                'Resume a task that was paused because the Photoshop plugin or its AI Assist '
                + 'window disconnected. Use the existing task_id; never call ps_start_task to '
                + 'replace a paused task. If the whole plugin runtime restarted, this validates '
                + 'the original document identity before rebinding the task.',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' }
                },
                required: ['task_id'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_finish_task',
            description:
                'End the task. Say what you did, what you are unhappy with, and what the person '
                + 'could tune to their own taste. Before finishing, mark every knowledge article '
                + 'you followed with ps_kb_mark_helped or ps_kb_mark_failed. The report goes to '
                + 'the AI Assist dialog. If the '
                + 'task was a fight and you have written nothing down, this will ask you for a '
                + 'technical contribution once before it closes.',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    summary: { type: 'string', description: 'What you did.' },
                    issues: { type: 'string', description: 'What you are not happy with, or could not check.' },
                    suggestions: { type: 'string', description: 'What the person may want to tune.' }
                },
                required: ['task_id', 'summary'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_get_document',
            description:
                'General facts about the working document and its layer tree, plus a short list '
                + 'of every open document. Ask for one layer\'s details with ps_get_layer instead '
                + 'of pulling the whole tree deep.',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    include_layers: {
                        type: 'boolean',
                        description: 'Include the layer tree. Default true.'
                    },
                    max_depth: {
                        type: 'number',
                        description: 'How deep into groups to go. Default 3.'
                    }
                },
                required: ['task_id'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_get_layer',
            description:
                'Everything about one layer: kind, bounds, opacity, blend mode, mask, effects, '
                + 'text and adjustment settings where they exist. '
                + 'Values come from the Photoshop Action Descriptor (batchPlay get), not the DOM — '
                + 'opacity is 0–255, bounds and effects are in descriptor format. '
                + 'Use these structures when building batchPlay calls; look them up in the '
                + 'uxp-photoshop documentation when the shape is unclear.',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    layer_id: { type: 'number' }
                },
                required: ['task_id', 'layer_id'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_get_image',
            description:
                'Look at the document with your own eyes. Returns a real image, not text. By '
                + 'default a reduced copy, at most 512 pixels on the long side; ask for more only '
                + 'when you need to look closely, because images cost context. The caption says '
                + 'whether it was reduced and at what scale — coordinates you send back are '
                + 'always in real document pixels. You can capture the flattened document, a '
                + 'layer\'s content, a layer mask, the selection or a channel, each with an '
                + 'optional region.',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    target: {
                        type: 'string',
                        enum: ['document', 'layer', 'layer_mask', 'selection', 'channel'],
                        description: 'What to capture. Default "document".'
                    },
                    layer_id: {
                        type: 'number',
                        description: 'Required for "layer" and "layer_mask".'
                    },
                    mask_kind: {
                        type: 'string',
                        enum: ['user', 'vector'],
                        description: 'Which mask of the layer. Default "user".'
                    },
                    channel: {
                        type: 'string',
                        description: 'For "channel": "red", "green", "blue", or the name of an alpha channel.'
                    },
                    bounds: {
                        type: 'object',
                        description: 'Region in real document pixels.',
                        properties: {
                            left: { type: 'number' },
                            top: { type: 'number' },
                            right: { type: 'number' },
                            bottom: { type: 'number' }
                        },
                        required: ['left', 'top', 'right', 'bottom'],
                        additionalProperties: false
                    },
                    max_size: {
                        type: 'number',
                        description: `Longest side in pixels. Default ${DEFAULT_IMAGE_MAX_SIZE}.`
                    },
                    full_size: {
                        type: 'boolean',
                        description: 'Ask for the original size. Use it only when you really need it.'
                    }
                },
                required: ['task_id'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_execute_script',
            description:
                'Run JavaScript inside the plugin against the working document. In scope: app, '
                + 'action (batchPlay), core, imaging, constants, and `doc`, the working document '
                + 'of this task. Return a value with `return` or by assigning to `result`. The '
                + 'whole call becomes one step in the History panel with the name you give, so '
                + 'the person can read their own history afterwards. Everything that changes the '
                + 'document goes through here; look first, change, then check. '
                + 'Top-level `await` is available: the code runs inside an async function. '
                + 'If the script throws, partial changes stay as one named history step; inspect '
                + 'the document and use Photoshop\'s normal History controls if necessary. `doc` '
                + 'always points to the task\'s document even when the '
                + 'person has switched to another one. To open a dialog the person works in '
                + 'themselves, see `interactive` (experimental).',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    code: { type: 'string' },
                    history_name: {
                        type: 'string',
                        description: 'What to call this step in the History panel, in plain words, '
                            + 'for example "hide 5 text layers".'
                    },
                    interactive: {
                        type: 'boolean',
                        description: 'Experimental, default false. Opens a Photoshop dialog in front '
                            + 'of the person, who then works in it themselves (Liquify, Camera Raw, a '
                            + 'filter dialog). Use it only when the person asked to have that dialog '
                            + 'opened for them. Otherwise apply the filter yourself with values you '
                            + 'choose, without a dialog. The command that opens the dialog needs '
                            + '_options: { dialogOptions: "display" }. The person may work in the '
                            + `dialog for many minutes, so the call waits at most ${dialogWaitSeconds} `
                            + 'seconds. If they press OK or Cancel by then, you get the result as '
                            + 'usual. If not, the answer says the dialog is still open: do not open '
                            + 'it again and do not repeat the call — call ps_wait_for_dialog until '
                            + 'the result comes. Until then the task runs no other script. The '
                            + 'person can also stop it through Plugins > Cancel Plugin Command. Put '
                            + 'only the dialog and what directly belongs to it in such a call.'
                    }
                },
                required: ['task_id', 'code', 'history_name'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_wait_for_dialog',
            description:
                'Wait for the person to finish in a dialog that an interactive ps_execute_script '
                + 'opened, when that call answered that the dialog is still open. As soon as the '
                + 'person presses OK or Cancel, this returns what ps_execute_script would have '
                + 'returned: the value, any commands Photoshop rejected, and the state line. If '
                + `they are still working after ${dialogWaitSeconds} seconds, it says so; then `
                + 'call it again. Do not open the dialog again while you wait. The result is '
                + 'handed over once; if no dialog is waiting, this says so.',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' }
                },
                required: ['task_id'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_kb_list',
            description:
                KB_READING_RULE + ' '
                + 'The knowledge base index: one line per article — its id, which layer it is in, '
                + 'manual confidence, helped/failed agent counts, Photoshop version, and problem.',
            inputSchema: {
                type: 'object',
                properties: { task_id: { type: 'string' } },
                required: ['task_id'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_kb_read',
            description:
                KB_READING_RULE + ' '
                + 'Read one or several knowledge base articles by id (up to 4), from both layers at once. '
                + 'Provide either article_id for a single article (returns markdown text), or article_ids '
                + 'to read up to 4 articles in a single batch call (returns structured JSON with per-article status). '
                + 'The article is a hint, not the truth: after following it, check the result, then '
                + 'call ps_kb_mark_helped if it worked exactly as written or ps_kb_mark_failed if '
                + 'it did not or needed a change. Pay particular attention to whether the Photoshop '
                + 'version matches.',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: {
                        type: 'string',
                        description: 'Active task id from ps_start_task.'
                    },
                    article_id: {
                        type: 'string',
                        description: 'Id of a single article to read. Provide either article_id or article_ids, not both.'
                    },
                    article_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        maxItems: 4,
                        description: 'List of article ids to read in batch (maximum 4). Provide either article_id or article_ids, not both.'
                    }
                },
                required: ['task_id'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_kb_contribute',
            description:
                'Leave behind what this task taught you — if it taught you something. Write an '
                + 'article only for what the next agent, starting from the tool descriptions, the '
                + 'documentation and its own knowledge, would get wrong or lose real time on: an '
                + 'undocumented descriptor, documentation that was wrong, a trap that damages the '
                + 'document, a measured limit or timing. A documented call that worked the first '
                + 'time is not worth an article, even when the base has nothing on it; when in '
                + 'doubt and nothing failed, do not write. If the task was '
                + 'hard — a descriptor you were sure of was rejected, you went three ways round '
                + 'before one worked — that is exactly what belongs here, and nobody else will '
                + 'write it. Say what you tried that did not work and why, then what did work, '
                + 'with the descriptors or the script, and how you checked the result. Give only '
                + 'causes you verified: if you got round a failure without finding why, say so, '
                + 'and never conclude from your own failed attempts that something does not work '
                + 'in Photoshop or in this Helper. Do it '
                + 'yourself, without being asked. Look at the index first and do not write a '
                + 'near-copy of an article on the same problem. If an existing article needed a '
                + 'change, preserve that evidence with ps_kb_mark_failed; if it worked as written, '
                + 'there is nothing to add to its body. A base full of near-copies is worse than a small one. Write '
                + 'the article in English — title, problem, body and what_did_not_work — whatever '
                + 'language the person talks to you in. The Photoshop version and which agent you '
                + 'are get filled in for you.',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    article_id: {
                        type: 'string',
                        description: 'Short id in dashes, for example "curves-clipped-to-layer".'
                    },
                    title: { type: 'string' },
                    problem: {
                        type: 'string',
                        description: 'The one line that goes into the index: the problem or the kind of task.'
                    },
                    body: {
                        type: 'string',
                        description: 'What works, in Markdown, with the code or descriptors that ran.'
                    },
                    what_did_not_work: {
                        type: 'string',
                        description: 'The rakes you stepped on first, and why they failed — or what '
                            + 'surprised you. This is usually the most useful half of the article. '
                            + 'If nothing failed and nothing surprised you, the article itself '
                            + 'probably should not be written.'
                    }
                },
                required: ['task_id', 'article_id', 'title', 'problem', 'body'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_kb_mark_helped',
            description:
                'Mark an article you followed as helped because it worked exactly as written. '
                + 'Call this once for every such article before ps_finish_task. It increments only '
                + 'the agent-usage counter: it writes no note, does not rate the overall task, and '
                + 'never changes the article\'s manual confidence. If you changed or added any '
                + 'required step, use ps_kb_mark_failed instead.',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    article_id: { type: 'string' }
                },
                required: ['task_id', 'article_id'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_kb_mark_failed',
            description:
                'Mark an article you followed as failed, including when it worked only after a '
                + 'change or extra step. The English note is preserved for the next agent. This '
                + 'increments the agent-usage counter, does not rate the overall task, and never '
                + 'changes manual confidence.',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    article_id: { type: 'string' },
                    note: {
                        type: 'string',
                        description: 'In English: what failed, why, and what worked instead.'
                    }
                },
                required: ['task_id', 'article_id', 'note'],
                additionalProperties: false
            }
        }
    ];

    // ── Individual tools ─────────────────────────────────────────────────────

    /**
     * @param {object} args - Tool arguments.
     * @returns {Promise<object>} MCP tool result.
     */
    async function startTask(args) {
        const intent = String(args.intent || '').trim();
        if (!intent) {
            return textResult('ps_start_task needs "intent": one sentence on what you are about to do.', true);
        }

        const running = tasks.getCurrent();
        if (running) {
            if (running.state === 'suspended') {
                return textResult(tasks.describeSuspension(running), true);
            }
            // Raised through the same path as every other refusal, so the agent reads one
            // consistent explanation instead of a transport error.
            return textResult(
                `A task is already running: ${running.id} — "${running.intent}". Only one task runs `
                + 'at a time. Finish it with ps_finish_task, or wait: a task that goes silent for '
                + `${Math.round(tasks.idleTimeoutMs / 60000)} minutes closes itself.`,
                true
            );
        }

        // The task is created first so the plugin can bind its own context to the id, and
        // dropped again if the document side fails.
        //
        const task = tasks.start({ intent });

        let opened;
        try {
            opened = await callPlugin('agent_start_task', { taskId: task.id, intent }, TIMEOUT_READ_MS);
        } catch (error) {
            tasks.abort('could not reach the document');
            return textResult(error.message, true);
        }

        if (!opened || !opened.document) {
            tasks.abort('no open document');
            return textResult(
                'Photoshop has no open document. Ask the person to open one, then call ps_start_task again.',
                true
            );
        }

        task.documentId = opened.document.id;
        task.documentName = opened.document.name;
        task.documentPath = opened.document.path || null;
        task.photoshopVersion = opened.photoshopVersion || 'unknown';
        journal.startTask(task);
        note(task.id, `started: ${intent}`, 'ps_start_task');

        const rules = knowledgeBase.readRules();

        const text = [
            `Task ${task.id} started.`,
            `Working document: ${opened.document.name} (id ${opened.document.id}), `
            + `${opened.document.width}×${opened.document.height} px, `
            + `${opened.document.resolution} ppi, ${opened.document.colorMode}, `
            + `${opened.document.bitsPerChannel} bit, ${opened.document.layerCount} layers.`,
            'Nothing has been written to the document. A task that only looks leaves the '
            + 'person\'s history exactly as it was; each change script becomes one named '
            + 'Photoshop History step.',
            'Pass task_id to every other ps_ tool. The task is bound to this document: if the '
            + 'person switches to another one, your calls still go to this document.',
            '',
            '## How to work here',
            rules || '(No rules file was found. Work carefully: look first, change, then check.)',
            '',
            describeKnowledgeBase(),
            '',
            formatStatus(opened.status)
        ].filter(line => line !== null).join('\n');

        return textResult(text);
    }

    /**
     * Reconnect a paused task to its original Photoshop document. A normal dialog reopen
     * resumes automatically; this explicit tool is for a recreated UXP runtime whose
     * in-memory document binding and result cache no longer exist.
     *
     * @param {object} args - { task_id }.
     * @returns {Promise<object>} MCP tool result.
     */
    async function resumeTask(args) {
        const task = tasks.getCurrent();
        if (!task) {
            return textResult(
                'There is no paused task to resume. Call ps_start_task only after confirming '
                + 'that Photoshop and AI Assist are connected.',
                true
            );
        }
        if (!args.task_id || args.task_id !== task.id) {
            return textResult(
                `The resumable task is ${task.id}, not ${args.task_id || '(missing)'}.`,
                true
            );
        }
        if (task.state === 'running') {
            return textResult(
                `Task ${task.id} is already connected. Continue with the same task_id; do not start a new task.`
            );
        }

        const bridge = getBridge();
        if (!bridge || bridge.getConnectedClients() === 0) {
            return textResult(tasks.describeSuspension(task), true);
        }

        let resumed;
        try {
            resumed = await callPlugin('agent_resume_task', {
                taskId: task.id,
                documentId: task.documentId,
                documentName: task.documentName,
                documentPath: task.documentPath
            }, TIMEOUT_READ_MS);
        } catch (error) {
            return textResult(error.message, true);
        }

        if (!resumed || !resumed.document || resumed.error) {
            return textResult(
                (resumed && resumed.error)
                    || 'The original Photoshop document could not be rebound safely.',
                true
            );
        }

        task.documentId = resumed.document.id;
        task.documentName = resumed.document.name;
        task.documentPath = resumed.document.path || task.documentPath;
        tasks.resume({ reason: 'the Photoshop plugin rebound the original document' });
        note(task.id, 'Photoshop connection restored; task resumed', 'ps_resume_task');

        return textResult(withStatus(
            `Task ${task.id} resumed on "${task.documentName}". `
            + 'Inspect the current document before repeating the operation that was interrupted.',
            resumed.status
        ));
    }

    /**
     * @param {object} args - Tool arguments.
     * @returns {Promise<object>} MCP tool result.
     */
    async function finishTask(args) {
        const task = tasks.require(args.task_id);

        // A dialog the person may still be working in, or whose result the agent has not
        // seen, would otherwise be dropped without a word: the report would describe a
        // document the agent has not looked at since. So the first attempt is refused with
        // the reason. A second attempt closes the task anyway — the person may have walked
        // away from the dialog, and an agent that has been told and insists must not be
        // stuck in a task it cannot end. The journal notes that it closed that way. This
        // does not count towards the struggle question's single refusal below.
        const dialog = pendingDialogFor(task.id);
        if (dialog && !task.finishWarnedAboutDialog) {
            task.finishWarnedAboutDialog = true;
            return textResult(
                dialog.outcome
                    ? `The dialog from "${dialog.historyName}" has closed, but you have not seen `
                    + 'its result. Call ps_wait_for_dialog to get it — it answers at once — check '
                    + 'the document, then call ps_finish_task again.'
                    : `The dialog from "${dialog.historyName}" is still open in front of the person. `
                    + 'Wait for its result with ps_wait_for_dialog before you finish: Photoshop has '
                    + 'probably applied what they did there, and your report should say what that '
                    + 'was. If the person tells you to stop anyway, call ps_finish_task again and '
                    + 'it will close.',
                true
            );
        }
        if (dialog) {
            // Closing anyway: the result, if it ever comes, belongs to a finished task.
            logDialogAbandoned(task, dialog);
            pendingDialog = null;
        }

        task.finishAttempts += 1;

        // A task that fought Photoshop and wrote nothing down is the one case where the
        // base should have grown and did not. Telling the agent to write things down in
        // the rules is not enough — it is reading its own summary by now and heading for
        // the door. So the first attempt to close such a task comes back with the
        // question instead, and the second closes it regardless: nagging an agent that
        // has nothing to say would only earn us an invented article.
        //
        // A failed article mark counts as a contribution because its note is exactly the
        // reusable evidence this reminder asks for. A helped mark does not: incrementing a
        // counter should not silence a reminder to record a newly discovered workaround.
        // A script that ran to the end while Photoshop rejected some of its commands counts
        // too, and the question names it: the agent saw no error on those calls, and would
        // otherwise not know what failures it is being asked about.
        if (task.failures >= STRUGGLE_THRESHOLD
            && task.contributedArticles.length === 0
            && task.finishAttempts === 1) {
            const rejectedLine = task.rejectedCalls > 0
                ? ` In ${task.rejectedCalls} of them the script itself did not fail, but `
                + 'Photoshop rejected one or more of its commands.'
                : '';
            return textResult(
                `Before this closes: ${task.failures} of your calls went wrong, and you have `
                + `written nothing into the knowledge base.${rejectedLine} Whatever you worked `
                + 'out the hard way here — the '
                + 'descriptor Photoshop rejected, the property that does not exist, the way round '
                + 'you eventually found — the next agent will walk into it again unless you write '
                + 'it down now with ps_kb_contribute, or with ps_kb_mark_failed when an article '
                + 'failed or needed a change. If a command was rejected and you then '
                + 'found a form that works, the rejected form and the working one, side by side, are exactly '
                + 'what belongs there. Then call ps_finish_task again. If there is genuinely '
                + 'nothing worth keeping — the rejection was a typo you fixed, say — call it again '
                + 'and it will close.',
                true
            );
        }

        try {
            await callPlugin('agent_finish_task', { taskId: task.id }, TIMEOUT_READ_MS);
        } catch {
            // The document side may already be gone — a closed document, a closed panel.
            // The task still has to close cleanly on this side.
        }

        const finished = tasks.finish(task.id, {
            summary: args.summary,
            issues: args.issues,
            suggestions: args.suggestions
        });
        journal.endTask(finished, 'finished');
        note(task.id, 'task finished', 'ps_finish_task');

        // Nothing is said about writing when nothing was written. The struggle question
        // above has already dealt with the task that should have written something; for a
        // task that went smoothly, a closing "you wrote nothing" only pushes agents towards
        // articles nobody needs.
        return textResult(`Task ${task.id} is closed.\nYour report is in the AI Assist dialog.`);
    }

    /**
     * @param {object} args - Tool arguments.
     * @returns {Promise<object>} MCP tool result.
     */
    async function getDocument(args) {
        const task = tasks.require(args.task_id);
        note(task.id, 'looking at the document', 'ps_get_document');

        const answer = await callPlugin('agent_get_document', {
            taskId: task.id,
            includeLayers: args.include_layers !== false,
            maxDepth: Number.isFinite(args.max_depth) ? args.max_depth : 3
        }, TIMEOUT_READ_MS);

        const text = JSON.stringify({
            document: answer.document,
            openDocuments: answer.openDocuments
        }, null, 2);

        return textResult(withStatus(text, answer.status));
    }

    /**
     * @param {object} args - Tool arguments.
     * @returns {Promise<object>} MCP tool result.
     */
    async function getLayer(args) {
        const task = tasks.require(args.task_id);
        note(task.id, `looking at layer ${args.layer_id}`, 'ps_get_layer');

        const answer = await callPlugin('agent_get_layer', {
            taskId: task.id,
            layerId: args.layer_id
        }, TIMEOUT_READ_MS);

        return textResult(withStatus(JSON.stringify(answer.layer, null, 2), answer.status));
    }

    /**
     * @param {object} args - Tool arguments.
     * @returns {Promise<object>} MCP tool result: an image plus its caption.
     */
    async function getImage(args) {
        const task = tasks.require(args.task_id);
        const target = args.target || 'document';
        note(task.id, `taking a look: ${target}`, 'ps_get_image');

        const maxSize = args.full_size
            ? HARD_IMAGE_MAX_SIZE
            : Math.min(HARD_IMAGE_MAX_SIZE, Math.max(32, Number(args.max_size) || DEFAULT_IMAGE_MAX_SIZE));

        const answer = await callPlugin('agent_get_image', {
            taskId: task.id,
            target,
            layerId: args.layer_id,
            maskKind: args.mask_kind || 'user',
            channel: args.channel,
            bounds: args.bounds,
            maxSize,
            fullSize: Boolean(args.full_size)
        }, TIMEOUT_IMAGE_MS);

        if (!answer || !answer.base64) {
            return textResult(withStatus(
                'Nothing came back from that capture. There may be no pixels in that region, or '
                + 'the layer may be empty.',
                answer && answer.status
            ), true);
        }

        // The image goes back as an image, through the protocol's own image content type.
        // On the stage 2 testbench base64 travelled as ordinary text and the model simply
        // did not see it.
        return {
            content: [
                { type: 'image', data: answer.base64, mimeType: answer.mimeType || 'image/png' },
                { type: 'text', text: withStatus(answer.caption || '', answer.status) }
            ]
        };
    }

    /**
     * @param {object} args - Tool arguments.
     * @returns {Promise<object>} MCP tool result.
     */
    async function executeScript(args) {
        const task = tasks.require(args.task_id);

        // Photoshop is modal while the person works in a dialog, so another script could
        // not run anyway; it would only sit in the queue and time out. And the agent must
        // see what the dialog did before it changes anything else.
        const waiting = pendingDialogFor(task.id);
        if (waiting) {
            return textResult(
                waiting.outcome
                    ? `The dialog from "${waiting.historyName}" has closed, but you have not seen `
                    + 'its result yet. Call ps_wait_for_dialog first — it answers at once — then '
                    + 'run this script if it is still needed.'
                    : `The dialog from "${waiting.historyName}" is still open in front of the `
                    + 'person, and Photoshop runs no script until it closes. Do not open it again. '
                    + 'Call ps_wait_for_dialog to wait for its result, then run this script if it '
                    + 'is still needed.',
                true
            );
        }

        const historyName = String(args.history_name || '').trim() || 'script';
        // Only a real `true` turns it on: a string "false" from a careless client must not
        // put a dialog in front of the person.
        const interactive = args.interactive === true;
        note(
            task.id,
            interactive ? `${historyName} (a dialog for the person)` : historyName,
            'ps_execute_script'
        );

        const payload = { taskId: task.id, code: args.code, historyName, interactive };

        if (!interactive) {
            let answer;
            try {
                answer = await callPlugin('agent_execute_script', payload, TIMEOUT_SCRIPT_MS);
            } catch (error) {
                // A script that threw is already counted as a failure by call(); here its
                // rejected commands, if any, only get described.
                throw explainRejectedCommandsInError(error);
            }
            return deliverScriptOutcome(task, { answer }, false);
        }

        // The person may spend longer in the dialog than the task's idle limit; the task
        // must not close under them while they work. The hold is released when the plugin
        // answers, not when this call returns, because the dialog may outlive the call.
        const releaseWait = tasks.waitForPerson(task.id);
        // A new dialog deserves its own warning in ps_finish_task.
        task.finishWarnedAboutDialog = false;

        const entry = {
            taskId: task.id,
            historyName,
            startedAt: Date.now(),
            outcome: null,
            handedOff: false,
            delivered: false,
            done: null
        };
        // `done` never rejects: the outcome, good or bad, is stored on the entry and handed
        // over by whichever call is waiting when it lands.
        entry.done = callPlugin('agent_execute_script', payload, TIMEOUT_INTERACTIVE_SCRIPT_MS)
            .then(
                answer => settleDialog(entry, { answer }, releaseWait),
                error => settleDialog(entry, { error }, releaseWait)
            );
        pendingDialog = entry;

        await waitAtMost(entry.done, dialogWaitMs);
        if (entry.outcome) return handOverDialog(task, entry);

        // The person is still in the dialog. Holding this call longer would run into the
        // client's own limit, and a call the client gave up on is an answer nobody reads.
        entry.handedOff = true;
        return textResult(
            `The dialog from "${historyName}" is open in front of the person, and they are still `
            + `working in it. Do not open it again and do not repeat this call. Call `
            + `ps_wait_for_dialog with task_id "${task.id}": it returns the result as soon as the `
            + 'person presses OK or Cancel, or says after '
            + `${dialogWaitSeconds} seconds that they are still working — then call it again. `
            + 'Until the dialog closes, this task runs no other script.'
        );
    }

    /**
     * @param {object} args - { task_id }.
     * @returns {Promise<object>} MCP tool result.
     */
    async function waitForDialog(args) {
        const task = tasks.require(args.task_id);
        const entry = pendingDialogFor(task.id);
        if (!entry) {
            return textResult(
                'No dialog is waiting in this task, so there is nothing to wait for. If an '
                + 'interactive ps_execute_script already gave you its result, continue from it; '
                + 'check the document with ps_get_document or ps_get_image if you are unsure.'
            );
        }

        if (!entry.outcome) await waitAtMost(entry.done, dialogWaitMs);

        if (!entry.outcome) {
            return textResult(
                `The person is still working in the dialog from "${entry.historyName}" (open for `
                + `${describeDuration(Date.now() - entry.startedAt)}). Call ps_wait_for_dialog `
                + 'again. Do not open the dialog again.'
            );
        }
        if (entry.delivered) {
            // Two waits were running at once and the other one took the result.
            return textResult(
                `The result of the dialog from "${entry.historyName}" was already handed over `
                + 'in another ps_wait_for_dialog call. Continue from that answer.'
            );
        }
        note(task.id, `${entry.historyName}: the person closed the dialog`, 'ps_wait_for_dialog');
        return handOverDialog(task, entry);
    }

    /**
     * The dialog of this task that is still open or whose result the agent has not seen.
     *
     * @param {string} taskId - Task id.
     * @returns {object|null} The pending entry.
     */
    function pendingDialogFor(taskId) {
        if (!pendingDialog || pendingDialog.taskId !== taskId || pendingDialog.delivered) return null;
        return pendingDialog;
    }

    /**
     * Store the plugin's final answer to an interactive script.
     *
     * @param {object} entry - The pending dialog.
     * @param {object} outcome - { answer } or { error }.
     * @param {Function} releaseWait - Lets the task idle out again.
     */
    function settleDialog(entry, outcome, releaseWait) {
        entry.outcome = outcome;
        releaseWait();
        // Once the first answer said "still open", the agent may never come back for the
        // result — its client may even have dropped it. The journal gets it regardless.
        // Only while the task is still open: its journal file closes with it, and the line
        // must not land in the file of a task that started later.
        const current = tasks.getCurrent();
        if (entry.handedOff && pendingDialog === entry && current && current.id === entry.taskId) {
            logDialogResult(entry);
        }
    }

    /**
     * Give the agent a dialog's result, once.
     *
     * @param {object} task - The running task.
     * @param {object} entry - The pending dialog, with its outcome.
     * @returns {object} MCP tool result, or throws the script's error as call() expects.
     */
    function handOverDialog(task, entry) {
        entry.delivered = true;
        if (pendingDialog === entry) pendingDialog = null;
        return deliverScriptOutcome(task, entry.outcome, true);
    }

    /**
     * Turn the plugin's answer to a script into the agent's answer, counting a script whose
     * commands Photoshop rejected. A script that threw is rethrown for call() to count.
     *
     * @param {object} task - The running task.
     * @param {object} outcome - { answer } or { error }.
     * @param {boolean} interactive - Whether the script opened a dialog for the person.
     * @returns {object} MCP tool result.
     */
    function deliverScriptOutcome(task, outcome, interactive) {
        if (outcome.error) throw explainRejectedCommandsInError(outcome.error, { interactive });

        const answer = outcome.answer || {};
        const { text, rejected } = renderScriptAnswer(answer, interactive);
        // The script ran to the end, but Photoshop refused some of its commands. It is not
        // marked as an error: the rest of the script may well have changed the document,
        // and the agent must not read it as "nothing happened". It is counted as a failed
        // call, once, because to the struggle question it is exactly that.
        if (rejected) tasks.noteFailure(task.id, { rejectedCommands: true });
        return textResult(text);
    }

    /**
     * @param {object} answer - The plugin's answer to agent_execute_script.
     * @param {boolean} interactive - Whether the script opened a dialog for the person.
     * @returns {{ text: string, rejected: boolean }}
     */
    function renderScriptAnswer(answer, interactive) {
        const value = answer.result === undefined ? null : answer.result;
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        const rejected = formatRejectedCommands(answer.rejectedCommands, { interactive });
        const body = rejected ? `Returned: ${text}\n\n${rejected}` : `Returned: ${text}`;
        return { text: withStatus(body, answer.status), rejected: Boolean(rejected) };
    }

    /**
     * Write the final result of an interactive script into the journal at the moment the
     * plugin reports it, whether or not the agent ever asks for it.
     *
     * @param {object} entry - The settled dialog.
     */
    function logDialogResult(entry) {
        const record = {
            task: entry.taskId,
            tool: 'ps_execute_script',
            args: {
                history_name: entry.historyName,
                interactive: true,
                note: 'the dialog closed after the first answer; logged when the plugin answered'
            },
            ms: Date.now() - entry.startedAt
        };
        try {
            if (entry.outcome.error) {
                // The marker is taken off the text here; doing it again on delivery is harmless.
                record.error = explainRejectedCommandsInError(entry.outcome.error, { interactive: true }).message;
            } else {
                const { text } = renderScriptAnswer(entry.outcome.answer || {}, true);
                record.result = summarizeForJournal(textResult(text));
            }
            journal.logCall(record);
        } catch {
            // The journal is a record, not part of the work: it must not break the task.
        }
    }

    /**
     * Note in the journal that a task was closed while its dialog was open or unseen.
     *
     * @param {object} task - The task being closed.
     * @param {object} entry - The pending dialog.
     */
    function logDialogAbandoned(task, entry) {
        try {
            journal.logCall({
                task: task.id,
                tool: 'ps_finish_task',
                args: { history_name: entry.historyName, interactive: true },
                error: entry.outcome
                    ? 'The task was closed before the agent picked up the result of this dialog; '
                    + 'the result is logged above.'
                    : 'The task was closed while this dialog was still open; its result will not '
                    + 'be logged.',
                ms: Date.now() - entry.startedAt
            });
        } catch {
            // See logDialogResult.
        }
    }

    /**
     * @param {object} args - Tool arguments.
     * @returns {object} MCP tool result.
     */
    function kbList(args) {
        tasks.require(args.task_id);
        return textResult(knowledgeBase.formatIndex());
    }

    /**
     * @param {object} args - Tool arguments.
     * @returns {object} MCP tool result.
     */
    function kbRead(args) {
        const task = tasks.require(args.task_id);

        const hasSingle = args.article_id !== undefined && args.article_id !== null;
        const hasBatch = args.article_ids !== undefined && args.article_ids !== null;

        if (!hasSingle && !hasBatch) {
            return textResult('Either "article_id" or "article_ids" must be provided.', true);
        }
        if (hasSingle && hasBatch) {
            return textResult('Provide either "article_id" or "article_ids", not both.', true);
        }

        if (hasSingle) {
            if (typeof args.article_id !== 'string' || !args.article_id.trim()) {
                return textResult('article_id must be a non-empty string.', true);
            }
            const id = args.article_id.trim();
            note(task.id, `reading the article "${id}"`, 'ps_kb_read');
            const article = knowledgeBase.readArticle(id);
            return textResult(article.text, !article.found);
        }

        const rawIds = args.article_ids;
        if (!Array.isArray(rawIds) || rawIds.length === 0) {
            return textResult('article_ids must be a non-empty array of article IDs.', true);
        }

        const uniqueIds = [];
        const seen = new Set();
        for (const raw of rawIds) {
            if (typeof raw !== 'string' || !raw.trim()) {
                return textResult('Each article ID in article_ids must be a non-empty string.', true);
            }
            const id = raw.trim();
            if (!seen.has(id)) {
                seen.add(id);
                uniqueIds.push(id);
            }
        }

        if (uniqueIds.length === 0) {
            return textResult('article_ids must contain at least one valid article ID.', true);
        }
        if (uniqueIds.length > MAX_BATCH_ARTICLES) {
            return textResult(
                `At most ${MAX_BATCH_ARTICLES} articles can be read in one batch (requested ${uniqueIds.length}).`,
                true
            );
        }

        note(
            task.id,
            `reading ${uniqueIds.length} article${uniqueIds.length === 1 ? '' : 's'} (${uniqueIds.join(', ')})`,
            'ps_kb_read'
        );

        const articles = [];
        for (const id of uniqueIds) {
            const article = knowledgeBase.readArticle(id);
            if (article.found) {
                articles.push({
                    article_id: id,
                    status: 'ok',
                    content: article.text
                });
            } else {
                articles.push({
                    article_id: id,
                    status: 'not_found',
                    error: article.text
                });
            }
        }

        return textResult(JSON.stringify({ articles }, null, 2));
    }

    /**
     * @param {object} args - Tool arguments.
     * @returns {object} MCP tool result.
     */
    function kbContribute(args) {
        const task = tasks.require(args.task_id);
        const written = knowledgeBase.writeArticle({
            id: args.article_id,
            title: args.title,
            problem: args.problem,
            body: args.body,
            whatDidNotWork: args.what_did_not_work,
            taskId: task.id,
            // Measured, not asked for. The agent would have to guess both, and the version
            // is the thing that makes an old recipe wrong.
            photoshopVersion: task.photoshopVersion,
            agent: clientName
        });

        if (written.ok) {
            tasks.noteContribution(task.id, written.id);
            note(task.id, `wrote the article "${written.id}"`, 'ps_kb_contribute');
        }
        return textResult(written.message, !written.ok);
    }

    /**
     * Record that a knowledge article worked exactly as written for this agent.
     *
     * @param {object} args - Tool arguments.
     * @returns {object} MCP tool result.
     */
    function kbMarkHelped(args) {
        const task = tasks.require(args.task_id);
        const marked = knowledgeBase.markHelped({ id: args.article_id });

        if (marked.ok) {
            // A helped mark is only evidence about one use. It neither changes manual
            // confidence nor counts as a new contribution for the struggle reminder.
            note(task.id, `marked the article "${marked.id}" as helped`, 'ps_kb_mark_helped');
        }
        return textResult(marked.message, !marked.ok);
    }

    /**
     * Record that a knowledge article failed or needed a change for this agent.
     *
     * @param {object} args - Tool arguments.
     * @returns {object} MCP tool result.
     */
    function kbMarkFailed(args) {
        const task = tasks.require(args.task_id);
        const marked = knowledgeBase.markFailed({
            id: args.article_id,
            note: args.note,
            taskId: task.id
        });

        if (marked.ok) {
            // The failure note is reusable knowledge, so it satisfies the same struggle
            // reminder as a newly contributed article. It still does not affect confidence.
            tasks.noteContribution(task.id, marked.id);
            note(task.id, `marked the article "${marked.id}" as failed, with a note`, 'ps_kb_mark_failed');
        }
        return textResult(marked.message, !marked.ok);
    }

    const HANDLERS = {
        ps_start_task: startTask,
        ps_resume_task: resumeTask,
        ps_finish_task: finishTask,
        ps_get_document: getDocument,
        ps_get_layer: getLayer,
        ps_get_image: getImage,
        ps_execute_script: executeScript,
        ps_wait_for_dialog: waitForDialog,
        ps_kb_list: kbList,
        ps_kb_read: kbRead,
        ps_kb_contribute: kbContribute,
        ps_kb_mark_helped: kbMarkHelped,
        ps_kb_mark_failed: kbMarkFailed
    };

    /**
     * @returns {object[]} Tool definitions for tools/list.
     */
    function list() {
        return TOOLS;
    }

    /**
     * Run one tool.
     *
     * @param {string} name - Tool name.
     * @param {object} args - Tool arguments.
     * @returns {Promise<object>} MCP tool result. Refusals come back as tool results with
     *   isError, never as transport errors, because the agent has to be able to read them.
     */
    async function call(name, args = {}) {
        const handler = HANDLERS[name];
        if (!handler) {
            return textResult(
                `There is no tool "${name}". Available: ${Object.keys(HANDLERS).join(', ')}.`,
                true
            );
        }

        const startedAt = Date.now();
        try {
            const result = await handler(args || {});
            journal.logCall({
                task: args.task_id || (tasks.getCurrent() && tasks.getCurrent().id) || null,
                tool: name,
                args: name === 'ps_get_image' ? { ...args, note: 'image not stored in the journal' } : args,
                result: summarizeForJournal(result),
                ms: Date.now() - startedAt
            });
            return result;
        } catch (error) {
            let message = error instanceof TaskError || error.code === 'PANEL_CLOSED'
                ? error.message
                : `${error.message}`;

            const activeTask = tasks.getCurrent();
            if (!(error instanceof TaskError)
                && activeTask
                && activeTask.state === 'suspended'
                && (!args.task_id || args.task_id === activeTask.id)) {
                message = tasks.describeSuspension(activeTask);
            }

            if (message.includes(DOCUMENT_CLOSED_MARKER)) {
                message = message.replace(DOCUMENT_CLOSED_MARKER, '').trim();
                // Closing the task writes the journal entry through the service's listener.
                tasks.abort('the document was closed');
            }

            // Counted so ps_finish_task can tell a task that went smoothly from one that
            // did not. A refusal for a missing task id is not a struggle with Photoshop.
            if (!(error instanceof TaskError)) {
                tasks.noteFailure(args.task_id);
            }

            journal.logCall({
                task: args.task_id || null,
                tool: name,
                args,
                error: message,
                ms: Date.now() - startedAt
            });
            return textResult(message, true);
        }
    }

    /**
     * Reduce a tool result to something worth writing down. Images are named, not stored.
     *
     * @param {object} result - MCP tool result.
     * @returns {object}
     */
    function summarizeForJournal(result) {
        const kinds = (result.content || []).map(part => part.type);
        const texts = (result.content || [])
            .filter(part => part.type === 'text')
            .map(part => part.text);
        return {
            content: kinds,
            isError: Boolean(result.isError),
            text: texts.join('\n').slice(0, 600)
        };
    }

    return { list, call, setClient, ASSISTANT_CLOSED_MESSAGE };
}

module.exports = {
    createAgentTools,
    ASSISTANT_CLOSED_MESSAGE,
    DEFAULT_IMAGE_MAX_SIZE,
    // Exported for testing only; limits the maximum number of articles read in one batch.
    MAX_BATCH_ARTICLES,
    // Exported for testing only; it is the shape of the state line the agent reads.
    formatStatus
};
