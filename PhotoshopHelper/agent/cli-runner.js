'use strict';

/**
 * Path 1: Helper launches the person's own CLI agent.
 *
 * The MCP server is already registered on this machine (see mcp-setup.js) — it is not
 * handed over on every launch, and the person's other MCP servers are left switched on.
 * What this module does is start the CLI on the person's subscription, with permissions
 * wide enough that it does not stop to ask about every step, and keep the session so the
 * next message in the same chat continues the same conversation.
 *
 * Only the CLI path lives here. The path through an API key is a separate stage, and this
 * module refuses to run when Helper is configured for API mode, so that a button in the
 * panel can never turn into a paid request.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { SERVER_NAME } = require('./mcp-setup');

// Helper launches this CLI. Antigravity is not included in LAUNCHABLE_CLIS yet because automated
// programmatic launch from the assistant panel is still pending implementation. Note that while
// Antigravity does not support passing ephemeral per-run MCP servers on the command line, it works
// persistently once registered via `agy mcp add` in the user's terminal or IDE.
const LAUNCHABLE_CLIS = new Set(['claude', 'codex', 'grok']);

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
    const window = (process.env.AGENT_CLI_WINDOW || 'hidden').toLowerCase().trim();
    const workDir = (process.env.AGENT_WORK_DIR || '').trim();

    const problems = [];
    if (mode !== 'cli') {
        problems.push(
            'LLM_MODE must be "cli" to run the agent from the panel. The path through an API '
            + 'key is not part of this feature yet.'
        );
    }
    if (!LAUNCHABLE_CLIS.has(cli)) {
        problems.push(
            `LLM_CLI_TYPE must be one of: ${[...LAUNCHABLE_CLIS].join(', ')}. Antigravity cannot `
            + 'be launched from Helper; connect it yourself and talk to it in your own terminal.'
        );
    }

    return {
        cli,
        model: model || null,
        window: window === 'visible' ? 'visible' : 'hidden',
        workDir: workDir || null,
        configured: problems.length === 0,
        problems
    };
}

/**
 * Build the command line for one CLI.
 *
 * Permissions are deliberately wide. Without a web search and without being able to run
 * things in its own folder, the agent writes Photoshop scripts from memory, which is
 * exactly what this whole feature exists to avoid.
 *
 * @param {object} params - { cli, model, prompt, sessionId, cwd, outputFile }.
 * @returns {{binary: string, args: string[], parse: 'claude'|'codex'|'grok'}}
 */
function buildArgs({ cli, model, prompt, sessionId, cwd, outputFile }) {
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
            if (sessionId) args.push('--resume', sessionId);
            return { binary: 'claude', args, parse: 'claude' };
        }

        case 'codex': {
            const args = ['exec'];
            // `resume` is an exec subcommand. Exec-only options such as `--color` and `-C`
            // must be parsed before that subcommand, otherwise Codex rejects a continued chat.
            args.push(
                '--dangerously-bypass-approvals-and-sandbox',
                '--skip-git-repo-check',
                '--color', 'never',
                '--json'
            );
            if (model) args.push('-m', model);
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
                '--output-format', 'json',
                '--always-approve'
            ];
            if (model) args.push('-m', model);
            if (cwd) args.push('--cwd', cwd);
            // Sessions are filed under the working directory. --session-id starts a new
            // one; --resume continues the one whose id came back in the JSON.
            if (sessionId) args.push('--resume', sessionId);
            return { binary: 'grok', args, parse: 'grok' };
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
            if (!text && event.type === 'item.completed' && event.item && event.item.content) {
                const part = event.item.content.find(item => item.type === 'text');
                if (part && part.text) text = part.text;
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
 * Remove anything that looks like a secret from text on its way to the panel.
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
 * Create the runner.
 *
 * @param {object} options
 * @param {string} options.workDir - The agent's own folder, shared by every task.
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
            chatId: running.chatId,
            cli: running.cli,
            startedAt: running.startedAt,
            stopping: Boolean(running.stopping)
        };
    }

    /**
     * Send one message to the agent and wait for its answer.
     *
     * @param {object} params
     * @param {object} params.chat - The chat this belongs to.
     * @param {string} params.prompt - What to say to the agent.
     * @returns {Promise<{ok: boolean, text: string, sessionId: string|null, error?: string}>}
     */
    function send({ chat, prompt }) {
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
                error: 'The agent is already working. Wait for it, or press Stop.'
            });
        }

        const cwd = ensureWorkDir();
        const outputFile = config.cli === 'codex'
            ? path.join(os.tmpdir(), `ps-agent-${crypto.randomUUID()}.txt`)
            : null;

        const { binary, args, parse } = buildArgs({
            cli: config.cli,
            model: config.model,
            prompt,
            sessionId: chat.sessionId,
            cwd,
            outputFile
        });

        logger.info(`[agent-cli] Launching ${binary} for chat ${chat.id}`
            + `${chat.sessionId ? ' (continuing its session)' : ''}`);

        return new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            let settled = false;

            // A visible window is a setting, not a problem: there is nothing wrong with the
            // person seeing the agent's window and talking to it themselves. Helper cannot
            // read what a detached console prints, so in that mode the panel shows the
            // progress that comes back through MCP and not the agent's own words.
            const child = config.window === 'visible' && process.platform === 'win32'
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
                    // Codex blocks on an open stdin, waiting for more input.
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true
                });

            running = {
                child,
                chatId: chat.id,
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
                        sessionId: parsed.sessionId || chat.sessionId || null,
                        error: `The agent was stopped: ${stopped}. Its conversation is kept — `
                            + 'the next message continues it.'
                    });
                    return;
                }

                if (running && running.visible) {
                    finish({
                        ok: true,
                        text: 'The agent ran in its own window. Helper cannot read what a separate '
                            + 'console prints, so its answer is in that window; the steps it took '
                            + 'through Photoshop are in the progress list.',
                        sessionId: chat.sessionId || null
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
     * can do is end this run while keeping the session id, so the conversation is not lost
     * and the person's next message picks it up where it left off. The process is asked to
     * close first and only killed if it ignores that.
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

    return { send, stop, getRunning, readAgentConfig, ensureWorkDir };
}

module.exports = {
    createCliRunner,
    readAgentConfig,
    LAUNCHABLE_CLIS,
    // Exported for testing only; production code goes through the runner.
    buildArgs,
    parseOutput,
    sanitize
};
