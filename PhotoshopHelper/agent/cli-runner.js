'use strict';

/**
 * Reusable executor for launching a configured command-line agent.
 *
 * The MCP server is already registered on this machine (see mcp-setup.js) — it is not
 * handed over on every launch, and the person's other MCP servers are left switched on.
 * This module starts the CLI on the person's subscription, gives the caller the result and
 * any reusable session id, and can stop a long-running process. It deliberately knows
 * nothing about a particular UI or product workflow, so WebHelper and later prompt tools
 * can reuse the researched process-management code.
 *
 * Only the CLI path lives here. The path through an API key is separate, and this module
 * refuses to run when Helper is configured for API mode so a local action cannot silently
 * turn into a paid request.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { SERVER_NAME } = require('./mcp-setup');


// The agent may work for a long time — a task is many tool calls and a person watching.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// After a polite stop, this long before the process is killed outright.
const FORCE_KILL_AFTER_MS = 5000;

/**
 * Read the agent's settings out of the environment.
 *
 * @returns {object} { cli, model, window, workDir, configured, problems }
 */
function readAgentConfig() {
    const mode = (process.env.LLM_MODE || '').toLowerCase().trim();
    const cli = (process.env.LLM_CLI_TYPE || '').toLowerCase().trim();
    const model = (process.env.LLM_CLI_MODEL || '').trim();
    const effort = (process.env.LLM_CLI_EFFORT || '').trim();
    const window = (process.env.AGENT_CLI_WINDOW || 'hidden').toLowerCase().trim();
    const workDir = (process.env.AGENT_WORK_DIR || '').trim();

    const problems = [];
    if (mode !== 'cli') {
        problems.push(
            'LLM_MODE must be "cli" to run a command-line agent. API-key execution is a '
            + 'separate path.'
        );
    }

    return {
        cli,
        model: model || null,
        effort: effort || null,
        window: window === 'visible' ? 'visible' : 'hidden',
        workDir: workDir || null,
        configured: problems.length === 0,
        problems
    };
}

/**
 * Normalize model name and effort specifically for the Antigravity CLI (`agy`).
 *
 * Antigravity CLI expects lowercase hyphenated slugs (e.g. "gemini-3.8-flash", "gemini-3.1-pro").
 * For Gemini models, effort levels are baked directly into the model slug
 * (e.g. "gemini-3.8-flash-high", "gemini-3.1-pro-high") rather than passed via --effort.
 *
 * @param {string|null} rawModel - Model name from settings or UI (e.g. "Gemini 3.1 Pro", "gemini-3.8-flash").
 * @param {string|null} [rawEffort] - Optional reasoning effort (e.g. "high", "medium", "low").
 * @returns {{ model: string|null, effort: string|null }}
 */
function normalizeAgyModel(rawModel, rawEffort) {
    if (!rawModel || typeof rawModel !== 'string' || !rawModel.trim()) {
        const effort = rawEffort && typeof rawEffort === 'string' && rawEffort.trim()
            ? rawEffort.trim().toLowerCase()
            : null;
        return { model: null, effort };
    }

    let model = rawModel.trim();
    let effort = rawEffort && typeof rawEffort === 'string' && rawEffort.trim()
        ? rawEffort.trim().toLowerCase()
        : null;

    // 1. Extract effort if it was embedded in UI parenthetical title, e.g. "Gemini 3.8 Flash (High)"
    const parentheticalMatch = model.match(/\((low|medium|high)\)$/i);
    if (parentheticalMatch) {
        if (!effort) effort = parentheticalMatch[1].toLowerCase();
        model = model.replace(/\s*\((low|medium|high)\)$/i, '').trim();
    }

    // 2. Convert to lowercase hyphenated slug
    // e.g. "Gemini 3.1 Pro" -> "gemini-3.1-pro"
    // e.g. "gemini-3.8-flash" -> "gemini-3.8-flash" (already valid, stays identical)
    model = model
        .toLowerCase()
        .replace(/[\s_]+/g, '-')       // Replace spaces and underscores with hyphens
        .replace(/[^a-z0-9.-]/g, '')    // Remove invalid punctuation
        .replace(/-+/g, '-');          // Collapse duplicate hyphens

    // 3. Check if the model already has an effort suffix (e.g. -low, -medium, -high)
    const suffixMatch = model.match(/-(low|medium|high)$/);
    if (suffixMatch) {
        // If an explicit effort was passed and differs from suffix, update suffix
        if (effort && ['low', 'medium', 'high'].includes(effort) && suffixMatch[1] !== effort) {
            model = model.replace(/-(low|medium|high)$/, `-${effort}`);
        }
        // Effort is already encoded in the slug; suppress separate --effort flag
        return { model, effort: null };
    }

    // 4. If effort is provided ('low' | 'medium' | 'high')
    if (effort && ['low', 'medium', 'high'].includes(effort)) {
        // For Gemini models in agy, effort must be part of the slug (e.g. gemini-3.8-flash-high)
        if (model.startsWith('gemini')) {
            model = `${model}-${effort}`;
            return { model, effort: null };
        }
        // Non-Gemini models (e.g. Claude / third-party) can retain --effort if supported
        return { model, effort };
    }

    return { model, effort: null };
}

/**
 * Build the command line for one CLI.
 *
 * Permissions are deliberately wide. Without a web search and without being able to run
 * things in its own folder, the agent writes Photoshop scripts from memory, which is
 * exactly what this whole feature exists to avoid.
 *
 * `reasoningSummary` asks Codex to put its thinking summaries into the event stream.
 * `streaming` makes Grok and Antigravity print one event per step instead of one answer at
 * the end, so thoughts and tool calls can be watched while the agent works. Both default to
 * off, which keeps the command lines every existing caller relies on.
 *
 * @param {object} params - { cli, model, effort, prompt, sessionId, cwd, outputFile,
 *   reasoningSummary, streaming }.
 * @returns {{binary: string, args: string[], parse: 'claude'|'codex'|'grok'|'agy'|'grok-stream'|'agy-stream'}}
 */
function buildArgs({
    cli, model, effort, prompt, sessionId, cwd, outputFile,
    reasoningSummary = null, streaming = false
}) {
    switch (cli) {
        case 'claude': {
            const args = [
                '-p', prompt,
                '--output-format', 'json',
                '--permission-mode', 'dontAsk',
                // Without naming the MCP tools explicitly, a non-interactive run denies them
                // silently and the model answers that it needs permission. Agent starts the
                // sub-agents the knowledge base is meant to be read through.
                '--allowedTools', `mcp__${SERVER_NAME}__*,Read,Write,Edit,Bash,WebSearch,WebFetch,Agent`
            ];
            if (model) args.push('--model', model);
            if (effort) args.push('--effort', effort);
            if (sessionId) args.push('--resume', sessionId);
            return { binary: 'claude', args, parse: 'claude' };
        }

        case 'codex': {
            const args = ['exec'];
            // `resume` is an exec subcommand. Exec-only options such as `--color` and `-C`
            // must be parsed before that subcommand, otherwise Codex rejects a resumed run.
            args.push(
                '--dangerously-bypass-approvals-and-sandbox',
                '--skip-git-repo-check',
                '--color', 'never',
                '--json'
            );
            if (model) args.push('-m', model);
            if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
            if (reasoningSummary) args.push('-c', `model_reasoning_summary=${reasoningSummary}`);
            if (cwd) args.push('-C', cwd);
            if (outputFile) args.push('-o', outputFile);
            if (sessionId) args.push('resume', sessionId);
            args.push(prompt);
            return { binary: 'codex', args, parse: 'codex' };
        }

        case 'grok': {
            const args = [
                '--trust',
                '-p', prompt,
                '--output-format', streaming ? 'streaming-json' : 'json',
                '--always-approve'
            ];
            if (model) args.push('-m', model);
            if (cwd) args.push('--cwd', cwd);
            // Sessions are filed under the working directory. --session-id starts a new
            // one; --resume continues the one whose id came back in the JSON.
            if (sessionId) args.push('--resume', sessionId);
            return { binary: 'grok', args, parse: streaming ? 'grok-stream' : 'grok' };
        }

        case 'agy': {
            const { model: normModel, effort: normEffort } = normalizeAgyModel(model, effort);
            const args = [
                '--print-timeout', '15m',
                '--dangerously-skip-permissions'
            ];
            if (sessionId) args.push('--conversation', sessionId);
            if (normModel) args.push('--model', normModel);
            if (normEffort) args.push('--effort', normEffort);
            if (streaming) args.push('--output-format', 'stream-json');
            args.push('-p', prompt);
            return { binary: 'agy', args, parse: streaming ? 'agy-stream' : 'agy' };
        }

        default:
            throw new Error(`Helper cannot launch "${cli}".`);
    }
}

/**
 * Pull the answer and the session id out of what the CLI printed.
 *
 * @param {string} parse - Which CLI's output this is.
 * @param {string} stdout - Everything it printed.
 * @param {string|null} outputFile - Codex's -o file.
 * @returns {{text: string|null, sessionId: string|null, error?: string|null}}
 */
function parseOutput(parse, stdout, outputFile) {
    if (parse === 'grok') return parseGrokOutput(stdout);
    if (parse === 'grok-stream') return parseGrokStream(stdout);
    if (parse === 'agy-stream') return parseAgyStream(stdout);

    if (parse === 'agy') {
        const json = parseFirstJson(stdout);
        if (json && (json.response || json.text || json.result)) {
            const isError = json.status && json.status !== 'SUCCESS';
            return {
                text: json.response || json.text || json.result,
                sessionId: json.conversation_id || json.sessionId || null,
                error: isError ? (json.error || 'Antigravity run failed') : null
            };
        }
        // Fallback for plain headless output: the answer is the stdout text itself
        const trimmed = (stdout || '').trim();
        return {
            text: trimmed.length > 0 ? trimmed : null,
            sessionId: null,
            error: null
        };
    }

    if (parse === 'claude') {
        const json = parseFirstJson(stdout);
        if (!json) return { text: null, sessionId: null };
        return {
            text: json.result || json.text || json.response || null,
            sessionId: json.session_id || json.sessionId || null
        };
    }

    // Codex prints one JSON event per line and writes the final message to -o.
    let text = null;
    if (outputFile) {
        try {
            const content = fs.readFileSync(outputFile, 'utf-8').trim();
            if (content) text = content;
        } catch {
            // The file is only written on a clean finish; fall through to the events.
        }
    }

    let sessionId = null;
    const lines = stdout.split('\n').filter(line => line.trim());
    for (const line of lines) {
        try {
            const event = JSON.parse(line);
            if (event.thread_id) sessionId = event.thread_id;
            if (event.thread && event.thread.id) sessionId = event.thread.id;
            if (!text && event.type === 'item.completed' && event.item) {
                if (typeof event.item.text === 'string') {
                    text = event.item.text;
                } else if (Array.isArray(event.item.content)) {
                    const part = event.item.content.find(item => item.type === 'text');
                    if (part && part.text) text = part.text;
                }
            }
        } catch {
            // Not every line is JSON.
        }
    }

    return { text, sessionId };
}

/**
 * Read Grok's headless JSON.
 *
 * `--output-format json` prints one object and nothing else. The answer is `text` and the
 * session is `sessionId`. A failure is `{"type":"error","message":"..."}`. Parsing the
 * whole string keeps a "}" inside the answer from ending the object early.
 *
 * @param {string} stdout - Everything Grok printed.
 * @returns {{text: string|null, sessionId: string|null, error: string|null}}
 */
function parseGrokOutput(stdout) {
    let json;
    try {
        json = JSON.parse(String(stdout || '').trim());
    } catch {
        return { text: null, sessionId: null, error: null };
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return { text: null, sessionId: null, error: null };
    }

    const sessionId = typeof json.sessionId === 'string' ? json.sessionId : null;
    if (json.type === 'error') {
        const message = typeof json.message === 'string' ? json.message.trim() : '';
        return { text: null, sessionId, error: message || 'grok failed' };
    }

    return {
        text: typeof json.text === 'string' ? json.text : null,
        sessionId,
        error: null
    };
}

/**
 * Read the events Grok prints with `--output-format streaming-json`.
 *
 * The answer is every `text` piece joined, which is what the single-answer `json` mode
 * returns as `text`. The session id arrives with the closing `end` event.
 *
 * @param {string} stdout - Everything Grok printed.
 * @returns {{text: string|null, sessionId: string|null, error: string|null}}
 */
function parseGrokStream(stdout) {
    let text = null;
    let sessionId = null;
    let error = null;

    for (const line of String(stdout || '').split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }
        if (event.type === 'text' && typeof event.data === 'string') {
            text = (text || '') + event.data;
        } else if (event.type === 'end' && typeof event.sessionId === 'string') {
            sessionId = event.sessionId;
        } else if (event.type === 'error') {
            error = (typeof event.message === 'string' && event.message.trim())
                || (typeof event.data === 'string' && event.data.trim())
                || 'grok failed';
        }
    }

    return { text: error ? null : text, sessionId, error };
}

/**
 * Read the events Antigravity prints with `--output-format stream-json`.
 *
 * The closing `result` event carries the same fields as the `json` mode. When it is missing
 * the answer is rebuilt from the pieces of the agent's last reply.
 *
 * @param {string} stdout - Everything Antigravity printed.
 * @returns {{text: string|null, sessionId: string|null, error: string|null}}
 */
function parseAgyStream(stdout) {
    let result = null;
    let sessionId = null;
    const replies = new Map();

    for (const line of String(stdout || '').split(/\r?\n/)) {
        if (!line.trim().startsWith('{')) continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }
        if (event.event === 'init' && event.conversation_id) sessionId = event.conversation_id;
        if (event.event === 'result' && event.result) result = event.result;
        const step = event.event === 'step_update' ? event.step_update : null;
        if (step && step.step_type === 'agent_response' && typeof step.text_delta === 'string') {
            replies.set(step.step_index, (replies.get(step.step_index) || '') + step.text_delta);
        }
    }

    if (result && (result.response || result.text)) {
        const failed = result.status && result.status !== 'SUCCESS';
        return {
            text: result.response || result.text,
            sessionId: result.conversation_id || sessionId,
            error: failed ? (result.error || 'Antigravity run failed') : null
        };
    }

    const lastReply = [...replies.entries()].sort((a, b) => a[0] - b[0]).pop();
    const rebuilt = lastReply ? lastReply[1].trim() : '';
    return {
        text: rebuilt || null,
        sessionId: (result && result.conversation_id) || sessionId,
        error: result && result.status && result.status !== 'SUCCESS'
            ? (result.error || 'Antigravity run failed')
            : null
    };
}

/**
 * Find the first complete JSON object in a string that may have noise around it.
 *
 * @param {string} text - Raw output.
 * @returns {object|null}
 */
function parseFirstJson(text) {
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    for (let index = start; index < text.length; index++) {
        if (text[index] === '{') depth++;
        else if (text[index] === '}') depth--;
        if (depth === 0) {
            try {
                return JSON.parse(text.slice(start, index + 1));
            } catch {
                return null;
            }
        }
    }
    return null;
}

/**
 * Remove anything that looks like a secret before text reaches a caller or log.
 *
 * @param {string} text - Raw text.
 * @returns {string}
 */
function sanitize(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***')
        .replace(/Bearer\s+\S+/g, 'Bearer ***')
        .replace(/[a-f0-9]{40,}/gi, '***');
}

/**
 * Open the OS null device for stdin redirection.
 * On Windows, passing this handle guarantees EOF rather than blocking on stdin.
 *
 * @returns {number|'ignore'} File descriptor or 'ignore' on fallback.
 */
function getDevNullFd() {
    try {
        return fs.openSync(process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null', 'r');
    } catch {
        return 'ignore';
    }
}

/**
 * Create the runner.
 *
 * @param {object} options
 * @param {string} options.workDir - Default working folder for CLI runs.
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {object} The runner.
 */
function createCliRunner({ workDir, logger = console }) {
    let running = null;

    /**
     * @returns {string} The agent's working folder, created if needed.
     */
    function ensureWorkDir() {
        const dir = readAgentConfig().workDir || workDir;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    /**
     * @returns {object|null} What is running right now, without the process handle.
     */
    function getRunning() {
        if (!running) return null;
        return {
            runId: running.runId,
            cli: running.cli,
            startedAt: running.startedAt,
            stopping: Boolean(running.stopping)
        };
    }

    /**
     * Run one prompt and wait for the CLI result.
     *
     * @param {object} params
     * @param {string} params.prompt - What to say to the agent.
     * @param {string|null} [params.sessionId] - Existing CLI session to resume.
     * @param {string|null} [params.runId] - Caller-owned identifier for diagnostics.
     * @returns {Promise<{ok: boolean, text: string, sessionId: string|null, error?: string}>}
     */
    function run({ prompt, sessionId = null, runId = null }) {
        const config = readAgentConfig();
        if (!config.configured) {
            return Promise.resolve({
                ok: false,
                text: '',
                sessionId: null,
                error: config.problems.join(' ')
            });
        }

        if (running) {
            return Promise.resolve({
                ok: false,
                text: '',
                sessionId: null,
                error: 'A command-line agent is already running. Wait for it or stop that run.'
            });
        }

        const cwd = ensureWorkDir();
        const outputFile = config.cli === 'codex'
            ? path.join(os.tmpdir(), `ps-agent-${crypto.randomUUID()}.txt`)
            : null;

        const { binary, args, parse } = buildArgs({
            cli: config.cli,
            model: config.model,
            effort: config.effort || null,
            prompt,
            sessionId,
            cwd,
            outputFile
        });

        const effectiveRunId = runId || `run-${crypto.randomUUID()}`;
        logger.info(`[agent-cli] Launching ${binary} for ${effectiveRunId}`
            + `${sessionId ? ' (resuming a session)' : ''}`);

        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let settled = false;

            // A visible window is a setting, not a problem: there is nothing wrong with the
            // person seeing the agent's window and using it directly. Helper cannot read
            // what a detached console prints, so the returned text explains that limitation.
            const stdinMode = config.cli === 'codex' ? getDevNullFd() : 'ignore';
            let child;
            try {
                child = config.window === 'visible' && process.platform === 'win32'
                    ? spawn('cmd', ['/c', 'start', '', '/wait', binary, ...args], {
                        cwd,
                        shell: false,
                        env: { ...process.env },
                        stdio: 'ignore',
                        windowsHide: false
                    })
                    : spawn(binary, args, {
                        cwd,
                        shell: false,
                        env: { ...process.env },
                        // Avoid blocking on stdin (especially Codex on Windows).
                        stdio: [stdinMode, 'pipe', 'pipe'],
                        windowsHide: true
                    });
            } finally {
                if (typeof stdinMode === 'number') {
                    try { fs.closeSync(stdinMode); } catch { /* ignore */ }
                }
            }

            running = {
                child,
                runId: effectiveRunId,
                cli: config.cli,
                startedAt: Date.now(),
                stopping: false,
                visible: config.window === 'visible'
            };

            const timer = setTimeout(() => {
                logger.warn('[agent-cli] The agent ran past its time limit; stopping it.');
                stop('it ran past its time limit');
            }, DEFAULT_TIMEOUT_MS);

            if (child.stdout) child.stdout.on('data', chunk => { stdout += chunk.toString('utf-8'); });
            if (child.stderr) child.stderr.on('data', chunk => { stderr += chunk.toString('utf-8'); });

            /**
             * @param {object} outcome - What to hand back to the caller.
             */
            function finish(outcome) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                running = null;
                if (outputFile) {
                    try { fs.unlinkSync(outputFile); } catch { /* it may never have been written */ }
                }
                resolve(outcome);
            }

            child.on('error', (error) => {
                finish({
                    ok: false,
                    text: '',
                    sessionId: null,
                    error: `Could not start "${binary}": ${sanitize(error.message)}. `
                        + 'Check that it is installed and on the PATH.'
                });
            });

            child.on('close', () => {
                const stopped = running && running.stopping ? running.stopReason : null;
                const parsed = parseOutput(parse, stdout, outputFile);

                if (stopped) {
                    finish({
                        ok: false,
                        text: sanitize(parsed.text || ''),
                        sessionId: parsed.sessionId || sessionId || null,
                        error: `The agent was stopped: ${stopped}.`
                    });
                    return;
                }

                if (running && running.visible) {
                    finish({
                        ok: true,
                        text: 'The agent ran in its own window. Helper cannot read what a separate '
                            + 'console prints, so its answer remains in that window.',
                        sessionId: sessionId || null
                    });
                    return;
                }

                if (parsed.error) {
                    finish({
                        ok: false,
                        text: '',
                        sessionId: parsed.sessionId,
                        error: sanitize(parsed.error)
                    });
                    return;
                }

                // An empty string is a real answer. Only a missing one means the CLI said nothing.
                if (typeof parsed.text === 'string') {
                    finish({ ok: true, text: sanitize(parsed.text), sessionId: parsed.sessionId });
                    return;
                }

                finish({
                    ok: false,
                    text: '',
                    sessionId: parsed.sessionId,
                    error: `${config.cli} answered with nothing. ${sanitize(stderr.slice(0, 400))}`.trim()
                });
            });
        });
    }

    /**
     * Stop the agent.
     *
     * A running command-line agent has no Escape key the way a live session does. What we
     * can do is end this run and return whichever session id is available to the caller.
     * The process is asked to close first and only killed if it ignores that.
     *
     * @param {string} [reason] - What to tell the person.
     * @returns {boolean} True when something was running.
     */
    function stop(reason = 'the person pressed Stop') {
        if (!running) return false;

        running.stopping = true;
        running.stopReason = reason;
        const { child } = running;

        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/pid', String(child.pid), '/T'], {
                    shell: false, windowsHide: true, stdio: 'ignore'
                });
            } else {
                child.kill('SIGINT');
            }
        } catch (error) {
            logger.warn(`[agent-cli] Could not ask the agent to stop: ${error.message}`);
        }

        setTimeout(() => {
            if (!running || running.child !== child) return;
            try {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                        shell: false, windowsHide: true, stdio: 'ignore'
                    });
                } else {
                    child.kill('SIGKILL');
                }
            } catch { /* it is already gone */ }
        }, FORCE_KILL_AFTER_MS);

        return true;
    }

    return { run, stop, getRunning, readAgentConfig, ensureWorkDir };
}

module.exports = {
    createCliRunner,
    readAgentConfig,
    // Exported for testing only; production code goes through the runner.
    buildArgs,
    parseOutput,
    sanitize,
    // Exported solely for testing purposes
    normalizeAgyModel
};
