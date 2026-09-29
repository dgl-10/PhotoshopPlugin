'use strict';

/**
 * Readable record of what a command-line agent prints while it works.
 *
 * Each CLI reports its work in its own format: Codex prints one JSON event per line, Grok
 * and Antigravity do the same in their streaming modes, and in their single-answer modes
 * they print one JSON object or plain text at the very end. This module turns all of it
 * into the same plain text — thoughts, remarks between steps, tool calls and tool output —
 * so it can be shown live in a window and returned to the caller next to the final answer.
 *
 * The record is informational only. The answer and the session id are still read by
 * parseOutput() in cli-runner.js, so a format this module does not recognise costs a line
 * of the record, never a result.
 */

// The record is returned in an HTTP response, so it has an upper bound.
const MAX_TRANSCRIPT_CHARS = 200 * 1000;

// One tool output or one unknown event is cut to this length.
const MAX_BLOCK_CHARS = 2000;

// Parse kinds whose output arrives as one JSON event per line.
const LINE_KINDS = new Set(['codex', 'grok-stream', 'agy-stream']);

// Codex prints this on stderr when stdin is not a terminal; it says nothing about the work.
const STDERR_NOISE = /^Reading additional input from stdin/i;

/**
 * @param {string} text - Text to shorten.
 * @param {number} [limit] - Longest allowed result.
 * @returns {string}
 */
function clip(text, limit = MAX_BLOCK_CHARS) {
    const value = String(text ?? '');
    return value.length > limit ? `${value.slice(0, limit)}… [cut, ${value.length} characters]` : value;
}

/**
 * @param {unknown} value - Anything that can be shown as JSON.
 * @param {number} [limit] - Longest allowed result.
 * @returns {string}
 */
function compactJson(value, limit = MAX_BLOCK_CHARS) {
    try {
        return clip(JSON.stringify(value), limit);
    } catch {
        return '';
    }
}

/**
 * Parse one whole JSON object from a string, or return null.
 *
 * @param {string} text - Candidate JSON.
 * @returns {object|null}
 */
function parseObject(text) {
    try {
        const value = JSON.parse(String(text || '').trim());
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Create a record for one CLI run.
 *
 * @param {string} parse - Parse kind returned by buildArgs(): claude, codex, grok, agy,
 *   grok-stream or agy-stream.
 * @param {object} [options]
 * @param {(text: string) => void} [options.onAppend] - Called with every new piece, so a
 *   window can show the run while it is still going.
 * @returns {{push: Function, finish: Function, getText: Function}}
 */
function createTranscript(parse, { onAppend } = {}) {
    const lineMode = LINE_KINDS.has(parse);
    const partial = { stdout: '', stderr: '' };
    let text = '';
    let truncated = false;
    // Streaming formats send a thought or an answer as many small pieces. They are joined
    // here and written out when something of another kind arrives.
    let pending = null;

    function emit(line) {
        if (!line) return;
        const piece = line.endsWith('\n') ? line : `${line}\n`;
        if (text.length + piece.length > MAX_TRANSCRIPT_CHARS) {
            if (!truncated) {
                truncated = true;
                const note = '[record cut: too long]\n';
                text += note;
                if (onAppend) onAppend(note);
            }
            return;
        }
        text += piece;
        if (onAppend) onAppend(piece);
    }

    function flushPending() {
        if (!pending) return;
        const body = pending.text.trim();
        if (body) emit(`[${pending.label}] ${body}`);
        pending = null;
    }

    function addDelta(label, delta) {
        if (typeof delta !== 'string' || delta === '') return;
        if (pending && pending.label !== label) flushPending();
        if (!pending) pending = { label, text: '' };
        pending.text += delta;
    }

    function emitBlock(label, body) {
        flushPending();
        emit(`[${label}] ${body}`);
    }

    function codexEvent(event) {
        const item = event.item || {};
        switch (event.type) {
            case 'item.started':
                if (item.type === 'command_execution') emitBlock('run', clip(item.command));
                return;
            case 'item.completed':
                if (item.type === 'reasoning') {
                    emitBlock('thinking', clip(item.text));
                } else if (item.type === 'agent_message') {
                    emitBlock('agent', clip(item.text));
                } else if (item.type === 'command_execution') {
                    emitBlock(`output, exit ${item.exit_code}`, clip(item.aggregated_output).trim());
                } else {
                    const { id, ...rest } = item;
                    emitBlock(item.type || 'item', compactJson(rest));
                }
                return;
            case 'turn.completed':
                emitBlock('done', compactJson(event.usage || {}));
                return;
            case 'turn.failed':
            case 'error':
                emitBlock('error', clip(event.message || event.error?.message || compactJson(event)));
                return;
            default:
        }
    }

    function grokEvent(event) {
        switch (event.type) {
            case 'thought':
                addDelta('thinking', event.data);
                return;
            case 'text':
                addDelta('agent', event.data);
                return;
            case 'tool_call':
                emitBlock('tool', `${event.title || event.toolName || ''} ${compactJson(event.rawInput, 600)}`.trim());
                return;
            case 'tool_call_update':
                if (event.status === 'completed' || event.status === 'failed') {
                    const first = Array.isArray(event.content) ? event.content[0] : null;
                    const output = first?.content?.text ?? compactJson(event.rawOutput, 600);
                    emitBlock(`tool ${event.status}`, clip(String(output).trim()));
                }
                return;
            case 'end':
                emitBlock('done', event.stopReason || '');
                return;
            case 'error':
                emitBlock('error', clip(event.message || event.data || compactJson(event)));
                return;
            default:
        }
    }

    function agyEvent(event) {
        if (event.event === 'step_update' && event.step_update) {
            const step = event.step_update;
            if (step.step_type === 'user_input') return;
            if (step.step_type === 'tool') {
                const info = step.tool_info || {};
                if (step.state === 'ACTIVE') {
                    emitBlock('tool', `${step.tool_name || info.name || ''} ${compactJson(info.parameters, 600)}`.trim());
                } else if (step.state === 'DONE') {
                    emitBlock('tool done', step.tool_name || info.name || '');
                }
                return;
            }
            // agent_response and any step kind that carries text, such as a thinking step.
            const label = step.step_type === 'agent_response' ? 'agent' : (step.step_type || 'step');
            addDelta(label, step.text_delta);
            if (step.state === 'DONE') flushPending();
            return;
        }
        if (event.event === 'result') {
            emitBlock('done', event.result?.status || '');
            return;
        }
        if (event.event === 'error') {
            emitBlock('error', clip(event.message || event.error?.message || compactJson(event)));
        }
    }

    function handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return;
        const event = trimmed.startsWith('{') ? parseObject(trimmed) : null;
        if (!event) {
            emitBlock('output', clip(trimmed));
            return;
        }
        if (parse === 'codex') codexEvent(event);
        else if (parse === 'grok-stream') grokEvent(event);
        else agyEvent(event);
    }

    function handleStderrLine(line) {
        const trimmed = line.trim();
        if (!trimmed || STDERR_NOISE.test(trimmed)) return;
        emitBlock('stderr', clip(trimmed));
    }

    /**
     * Feed a piece of the CLI's output. Only formats that arrive as one event per line are
     * shown while they arrive; the rest are written when the run ends.
     *
     * @param {'stdout'|'stderr'} stream - Where the piece came from.
     * @param {string} chunk - Decoded text.
     */
    function push(stream, chunk) {
        if (!lineMode) return;
        partial[stream] += chunk;
        const lines = partial[stream].split(/\r?\n/);
        partial[stream] = lines.pop();
        for (const line of lines) {
            if (stream === 'stdout') handleLine(line);
            else handleStderrLine(line);
        }
    }

    /**
     * Close the record when the process has ended.
     *
     * @param {string} stdout - Everything the CLI printed on stdout.
     * @param {string} stderr - Everything the CLI printed on stderr.
     */
    function finish(stdout, stderr) {
        if (lineMode) {
            if (partial.stdout.trim()) handleLine(partial.stdout);
            if (partial.stderr.trim()) handleStderrLine(partial.stderr);
            partial.stdout = '';
            partial.stderr = '';
            flushPending();
            return;
        }

        if (parse === 'grok') {
            const json = parseObject(stdout);
            if (json) {
                if (typeof json.thought === 'string' && json.thought.trim()) emitBlock('thinking', clip(json.thought));
                if (typeof json.text === 'string' && json.text.trim()) emitBlock('agent', clip(json.text));
                if (json.type === 'error') emitBlock('error', clip(json.message));
            }
        } else if (parse === 'claude') {
            const json = parseObject(stdout);
            if (json && typeof json.result === 'string' && json.result.trim()) emitBlock('agent', clip(json.result));
        } else if (String(stdout || '').trim()) {
            emitBlock('agent', clip(String(stdout).trim()));
        }

        const errors = String(stderr || '').split(/\r?\n/).filter(line => line.trim() && !STDERR_NOISE.test(line.trim()));
        if (errors.length > 0) emitBlock('stderr', clip(errors.join('\n')));
    }

    return { push, finish, getText: () => text };
}

module.exports = {
    createTranscript
};
