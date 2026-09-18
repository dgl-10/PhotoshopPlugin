'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

// ── Valid configuration enums ────────────────────────────────────────────────

const VALID_MODES = new Set(['api', 'cli']);
const VALID_API_PROVIDERS = new Set(['openai']);
const VALID_CLI_TYPES = new Set(['codex', 'claude', 'agy', 'grok']);

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Read and validate LLM configuration from environment variables.
 * Never returns API keys or secrets.
 *
 * @returns {{ mode: string|null, apiProvider: string|null, apiModel: string|null,
 *             cliType: string|null, cliModel: string|null, configured: boolean,
 *             errors: string[] }}
 */
function getLlmConfig() {
    const mode = (process.env.LLM_MODE || '').toLowerCase().trim() || null;
    const apiProvider = (process.env.LLM_API_PROVIDER || '').toLowerCase().trim() || null;
    const apiModel = (process.env.LLM_API_MODEL || '').trim() || null;
    const cliType = (process.env.LLM_CLI_TYPE || '').toLowerCase().trim() || null;
    const cliModel = (process.env.LLM_CLI_MODEL || '').trim() || null;

    const errors = [];

    if (!mode) {
        return {
            mode: null, apiProvider, apiModel, cliType, cliModel,
            configured: false, errors: ['LLM_MODE is not set.']
        };
    }

    if (!VALID_MODES.has(mode)) {
        errors.push(`LLM_MODE must be "api" or "cli", got "${mode}".`);
    }

    if (mode === 'api') {
        if (!apiProvider) {
            errors.push('LLM_API_PROVIDER is required when LLM_MODE=api.');
        } else if (!VALID_API_PROVIDERS.has(apiProvider)) {
            errors.push(
                `LLM_API_PROVIDER must be one of: ${[...VALID_API_PROVIDERS].join(', ')}. Got "${apiProvider}".`
            );
        }
        if (!apiModel) {
            errors.push('LLM_API_MODEL is required when LLM_MODE=api.');
        }
        if (apiProvider === 'openai' && !process.env.OPENAI_API_KEY) {
            errors.push('OPENAI_API_KEY is not set (required for LLM_API_PROVIDER=openai).');
        }
    }

    if (mode === 'cli') {
        if (!cliType) {
            errors.push('LLM_CLI_TYPE is required when LLM_MODE=cli.');
        } else if (!VALID_CLI_TYPES.has(cliType)) {
            errors.push(
                `LLM_CLI_TYPE must be one of: ${[...VALID_CLI_TYPES].join(', ')}. Got "${cliType}".`
            );
        }
        if (!cliModel) {
            errors.push('LLM_CLI_MODEL is required when LLM_MODE=cli.');
        }
    }

    return { mode, apiProvider, apiModel, cliType, cliModel, configured: errors.length === 0, errors };
}

/**
 * Return capabilities of the current LLM configuration.
 * Known statically per provider/CLI type.
 *
 * @returns {{ supportsImages: boolean, supportsSessionResume: boolean,
 *             requiresUserSubscription: boolean, mode: string|null }}
 */
function getLlmCapabilities() {
    const config = getLlmConfig();
    if (!config.configured) {
        return {
            supportsImages: false, supportsSessionResume: false,
            requiresUserSubscription: false, mode: null
        };
    }

    if (config.mode === 'api') {
        return {
            supportsImages: true,
            supportsSessionResume: false,
            requiresUserSubscription: false,
            mode: 'api'
        };
    }

    // CLI capabilities vary by type
    const cliCaps = {
        codex:  { supportsImages: true,  supportsSessionResume: true, requiresUserSubscription: true },
        claude: { supportsImages: true,  supportsSessionResume: true, requiresUserSubscription: true },
        agy:    { supportsImages: true,  supportsSessionResume: true, requiresUserSubscription: true },
        grok:   { supportsImages: true,  supportsSessionResume: true, requiresUserSubscription: true }
    };

    const caps = cliCaps[config.cliType] || {
        supportsImages: false, supportsSessionResume: false, requiresUserSubscription: false
    };
    return { ...caps, mode: 'cli' };
}

// ── Connection Check ─────────────────────────────────────────────────────────

/**
 * Check that the configured LLM connection is available.
 *
 * For API mode: verifies the API key is present and optionally pings the API.
 * For CLI mode: verifies the binary exists in PATH and responds to --version.
 *
 * @param {{ probe?: boolean }} [options] - If probe=true, performs a lightweight
 *   real request (API) or headless prompt (CLI) to verify end-to-end connectivity.
 * @returns {Promise<{ ok: boolean, message: string, details?: object }>}
 */
async function checkConnection(options = {}) {
    const config = getLlmConfig();
    if (!config.configured) {
        return { ok: false, message: `LLM is not configured: ${config.errors.join(' ')}` };
    }

    if (config.mode === 'api') {
        return _checkApiConnection(config, options);
    }

    return _checkCliConnection(config, options);
}

/**
 * @private
 */
async function _checkApiConnection(config, options) {
    const details = { provider: config.apiProvider, model: config.apiModel };

    if (!options.probe) {
        return { ok: true, message: 'API key is configured.', details };
    }

    // Probe: lightweight models endpoint call
    try {
        const response = await fetch('https://api.openai.com/v1/models', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(10_000)
        });

        if (response.status === 401) {
            return {
                ok: false, details,
                message: 'OpenAI API key not accepted. Check OPENAI_API_KEY in .env and restart Helper.'
            };
        }
        if (response.status === 429) {
            return { ok: false, details, message: 'OpenAI rate limit reached. Try again later.' };
        }
        if (!response.ok) {
            return { ok: false, details, message: `OpenAI API returned HTTP ${response.status}.` };
        }

        return { ok: true, message: 'OpenAI API connection verified.', details };
    } catch (err) {
        const safeMessage = err.name === 'TimeoutError'
            ? 'Connection to OpenAI timed out. Check your network.'
            : 'Could not reach OpenAI API. Check your network connection.';
        return { ok: false, message: safeMessage, details };
    }
}

/**
 * @private
 */
async function _checkCliConnection(config, options) {
    const binaryName = config.cliType;
    const details = { cliType: config.cliType, model: config.cliModel, binary: binaryName };

    // Check binary exists in PATH
    try {
        const found = await findBinary(binaryName);
        if (!found) {
            return { ok: false, message: `CLI "${binaryName}" not found in PATH.`, details };
        }
    } catch {
        return { ok: false, message: `Could not verify CLI "${binaryName}".`, details };
    }

    // Check --version responds
    try {
        const version = await getCliVersion(binaryName);
        details.version = version;
    } catch {
        return {
            ok: false, details,
            message: `CLI "${binaryName}" found but --version failed.`
        };
    }

    if (!options.probe) {
        return { ok: true, message: `${config.cliType} CLI found (${details.version}).`, details };
    }

    // Probe: minimal headless prompt
    try {
        const result = await sendCliQuery({
            prompt: 'Reply with exactly: CONNECTION_OK',
            cliType: config.cliType,
            model: config.cliModel,
            timeoutMs: 30_000
        });

        if (result.ok) {
            return { ok: true, message: `${config.cliType} CLI responded successfully.`, details };
        }
        return {
            ok: false, details,
            message: result.error || `${config.cliType} CLI did not respond.`
        };
    } catch (err) {
        return {
            ok: false, details,
            message: `${config.cliType} CLI probe failed: ${sanitizeError(err.message)}`
        };
    }
}

// ── Query Execution ──────────────────────────────────────────────────────────

/**
 * Send a query to the configured LLM and return the response.
 *
 * @param {{ prompt: string, systemPrompt?: string, images?: string[],
 *           mode?: 'api'|'cli', model?: string, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, text?: string, error?: string,
 *           usage?: object, model?: string, mode: string }>}
 */
async function sendLlmQuery(options) {
    const config = getLlmConfig();
    if (!config.configured) {
        return { ok: false, error: `LLM is not configured: ${config.errors.join(' ')}`, mode: 'none' };
    }

    const mode = options.mode || config.mode;
    const model = options.model || (mode === 'api' ? config.apiModel : config.cliModel);

    if (!options.prompt || typeof options.prompt !== 'string') {
        return { ok: false, error: 'Prompt is required and must be a string.', mode };
    }

    try {
        if (mode === 'api') {
            return await sendApiQuery({ ...options, model, provider: config.apiProvider });
        }
        return await sendCliQuery({ ...options, model, cliType: config.cliType });
    } catch (err) {
        return { ok: false, error: sanitizeError(err.message), mode };
    }
}

// ── API Driver (OpenAI) ──────────────────────────────────────────────────────

/**
 * Execute an OpenAI Chat Completions API request.
 *
 * @param {{ prompt: string, systemPrompt?: string, images?: string[],
 *           model: string, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, text?: string, error?: string,
 *           usage?: object, model?: string, mode: 'api' }>}
 */
async function sendApiQuery({ prompt, systemPrompt, images, model, timeoutMs = 60_000 }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return { ok: false, error: 'OPENAI_API_KEY is not set.', mode: 'api' };
    }

    // Build messages array
    const messages = [];

    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }

    // User message: text-only or multimodal (text + images)
    if (images && images.length > 0) {
        const contentParts = [{ type: 'text', text: prompt }];

        for (const imagePath of images) {
            const base64 = fs.readFileSync(imagePath, 'base64');
            const ext = path.extname(imagePath).toLowerCase();
            const mime = ext === '.png' ? 'image/png'
                       : ext === '.webp' ? 'image/webp'
                       : 'image/jpeg';
            contentParts.push({
                type: 'image_url',
                image_url: { url: `data:${mime};base64,${base64}` }
            });
        }
        messages.push({ role: 'user', content: contentParts });
    } else {
        messages.push({ role: 'user', content: prompt });
    }

    const body = { model, messages };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    });

    if (response.status === 401) {
        return {
            ok: false, mode: 'api',
            error: 'OpenAI API key not accepted. Check OPENAI_API_KEY in .env and restart Helper.'
        };
    }
    if (response.status === 429) {
        return { ok: false, mode: 'api', error: 'OpenAI rate limit reached. Try again later.' };
    }
    if (!response.ok) {
        let errorDetail = `HTTP ${response.status}`;
        try {
            const errBody = await response.json();
            if (errBody.error?.message) errorDetail = errBody.error.message;
        } catch { /* ignore parse errors */ }
        return { ok: false, error: `OpenAI API error: ${sanitizeError(errorDetail)}`, mode: 'api' };
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;

    if (text === undefined || text === null) {
        return { ok: false, error: 'OpenAI returned an incomplete response.', mode: 'api' };
    }

    return {
        ok: true,
        text,
        usage: data.usage || null,
        model: data.model || model,
        mode: 'api'
    };
}

// ── CLI Driver ───────────────────────────────────────────────────────────────

/**
 * Build the argument array for a given CLI type.
 * Uses only verified flags from CLI-EXECUTORS.md.
 *
 * @param {string} cliType
 * @param {{ prompt: string, model?: string, cwd?: string,
 *           outputFile?: string, images?: string[] }} opts
 * @returns {{ binary: string, args: string[], parseMode: 'json'|'file' }}
 */
function buildCliArgs(cliType, { prompt, model, cwd, outputFile, images }) {
    switch (cliType) {

        case 'claude': {
            // claude -p "<prompt>" --model <model> --output-format json
            //        --permission-mode dontAsk --allowedTools Read
            const args = [
                '-p', prompt,
                '--output-format', 'json',
                '--permission-mode', 'dontAsk',
                '--allowedTools', 'Read'
            ];
            if (model) args.push('--model', model);
            return { binary: 'claude', args, parseMode: 'json' };
        }

        case 'agy': {
            // agy --model <model> --output-format json -p "<prompt>"
            const args = ['--output-format', 'json', '-p', prompt];
            if (model) args.unshift('--model', model);
            return { binary: 'agy', args, parseMode: 'json' };
        }

        case 'grok': {
            // grok -p "<prompt>" --output-format json --no-subagents
            const args = [
                '-p', prompt,
                '--output-format', 'json',
                '--no-subagents'
            ];
            if (model) args.push('-m', model);
            if (cwd) args.push('--cwd', cwd);
            return { binary: 'grok', args, parseMode: 'json' };
        }

        case 'codex': {
            // codex exec --dangerously-bypass-approvals-and-sandbox
            //   -m <model> -c model_reasoning_effort=low
            //   -C <cwd> --skip-git-repo-check --color never --json
            //   -o <outputFile> "<prompt>"
            const args = [
                'exec',
                '--dangerously-bypass-approvals-and-sandbox',
                '--skip-git-repo-check',
                '--color', 'never',
                '--json'
            ];
            if (model) args.push('-m', model);
            args.push('-c', 'model_reasoning_effort=low');
            if (cwd) args.push('-C', cwd);
            if (outputFile) args.push('-o', outputFile);
            if (images && images.length > 0) {
                // Codex supports single image via -i
                args.push('-i', images[0]);
            }
            args.push(prompt);
            return { binary: 'codex', args, parseMode: 'file' };
        }

        default:
            throw new Error(`Unknown CLI type: ${cliType}`);
    }
}

/**
 * Execute a CLI query and return the parsed response.
 *
 * @param {{ prompt: string, model?: string, cliType: string,
 *           images?: string[], timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, text?: string, error?: string,
 *           model?: string, mode: 'cli' }>}
 */
async function sendCliQuery({ prompt, model, cliType, images, timeoutMs = 120_000 }) {
    const tmpDir = os.tmpdir();
    // Codex requires a temporary file for -o (output-last-message)
    const outputFile = cliType === 'codex'
        ? path.join(tmpDir, `llm-codex-out-${crypto.randomUUID()}.txt`)
        : null;

    const cwd = process.cwd();
    const { binary, args, parseMode } = buildCliArgs(cliType, {
        prompt, model, cwd, outputFile, images
    });

    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const child = spawn(binary, args, {
            cwd,
            shell: false,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
            // On Windows SIGTERM may not work; use taskkill for the process tree
            if (process.platform === 'win32') {
                try {
                    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                        shell: false, windowsHide: true, stdio: 'ignore'
                    });
                } catch { /* ignore */ }
            }
        }, timeoutMs);

        child.stdout.on('data', (data) => { stdout += data.toString('utf-8'); });
        child.stderr.on('data', (data) => { stderr += data.toString('utf-8'); });

        child.on('error', (err) => {
            clearTimeout(timer);
            _cleanupOutputFile(outputFile);
            resolve({ ok: false, error: sanitizeError(err.message), mode: 'cli' });
        });

        child.on('close', () => {
            clearTimeout(timer);

            if (timedOut) {
                _cleanupOutputFile(outputFile);
                resolve({
                    ok: false, mode: 'cli',
                    error: `${cliType} CLI timed out after ${timeoutMs}ms.`
                });
                return;
            }

            try {
                const text = parseCliOutput(cliType, parseMode, stdout, outputFile);
                _cleanupOutputFile(outputFile);

                if (text) {
                    resolve({ ok: true, text, model: model || 'default', mode: 'cli' });
                } else {
                    const safeStderr = sanitizeError(stderr.slice(0, 500));
                    resolve({
                        ok: false, mode: 'cli',
                        error: `${cliType} CLI returned empty response.${safeStderr ? ' ' + safeStderr : ''}`
                    });
                }
            } catch (parseErr) {
                _cleanupOutputFile(outputFile);
                resolve({
                    ok: false, mode: 'cli',
                    error: `Failed to parse ${cliType} output: ${sanitizeError(parseErr.message)}`
                });
            }
        });
    });
}

/**
 * Parse CLI output according to the CLI type and parse mode.
 *
 * @param {string} cliType
 * @param {'json'|'file'} parseMode
 * @param {string} stdout - Raw stdout content.
 * @param {string|null} outputFile - Path to Codex -o output file, if any.
 * @returns {string|null}
 */
function parseCliOutput(cliType, parseMode, stdout, outputFile) {
    if (parseMode === 'file' && outputFile) {
        // Codex: read the result from the -o file first
        try {
            const content = fs.readFileSync(outputFile, 'utf-8').trim();
            if (content) return content;
        } catch { /* file may not exist; fall through to JSONL parsing */ }

        // Fallback: try parsing stdout JSONL for text
        return parseCodexJsonl(stdout);
    }

    if (parseMode === 'json') {
        const json = parseFirstJson(stdout);
        if (!json) return null;

        // Each CLI stores the response text in a different field
        switch (cliType) {
            case 'claude': return json.result || null;
            case 'agy':    return json.response || null;
            case 'grok':   return json.text || null;
            default:       return json.result || json.response || json.text || null;
        }
    }

    // Fallback: plain text
    return stdout.trim() || null;
}

/**
 * Extract the first valid JSON object from a string that may contain
 * leading/trailing text or multiple JSON objects.
 *
 * @param {string} str
 * @returns {object|null}
 */
function parseFirstJson(str) {
    const start = str.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    for (let i = start; i < str.length; i++) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}') depth--;
        if (depth === 0) {
            try {
                return JSON.parse(str.substring(start, i + 1));
            } catch {
                return null;
            }
        }
    }
    return null;
}

/**
 * Parse Codex JSONL output to extract the last message text.
 * Codex --json outputs one event per line; look for item.completed.
 *
 * @param {string} stdout
 * @returns {string|null}
 */
function parseCodexJsonl(stdout) {
    const lines = stdout.split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const event = JSON.parse(lines[i]);
            if (event.type === 'item.completed' && event.item?.content) {
                const textContent = event.item.content.find(c => c.type === 'text');
                if (textContent?.text) return textContent.text;
            }
        } catch { /* skip non-JSON lines */ }
    }
    return null;
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Find a binary in PATH.
 *
 * @param {string} name - Binary name (e.g. 'codex', 'claude').
 * @returns {Promise<boolean>}
 */
function findBinary(name) {
    return new Promise((resolve) => {
        const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
        const child = spawn(cmd, [name], {
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        let found = false;
        child.stdout.on('data', () => { found = true; });
        child.on('close', () => resolve(found));
        child.on('error', () => resolve(false));
    });
}

/**
 * Get a CLI's version string.
 *
 * @param {string} binary - Binary name.
 * @returns {Promise<string>}
 */
function getCliVersion(binary) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        const child = spawn(binary, ['--version'], {
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        child.stdout.on('data', (data) => { stdout += data.toString('utf-8'); });
        child.on('close', () => {
            const version = stdout.trim().split('\n')[0];
            if (version) resolve(version);
            else reject(new Error(`${binary} --version returned empty output`));
        });
        child.on('error', (err) => reject(err));
    });
}

/**
 * Remove potential secrets (API keys, tokens) from error messages.
 *
 * @param {string} message
 * @returns {string}
 */
function sanitizeError(message) {
    if (!message || typeof message !== 'string') return '';
    return message
        .replace(/sk-[a-zA-Z0-9_-]{20,}/g, 'sk-***')
        .replace(/Bearer\s+\S+/g, 'Bearer ***')
        .replace(/[a-f0-9]{40,}/gi, '***')
        .slice(0, 500);
}

/**
 * Remove a temporary output file if it exists.
 *
 * @param {string|null} filePath
 */
function _cleanupOutputFile(filePath) {
    if (filePath) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    getLlmConfig,
    getLlmCapabilities,
    checkConnection,
    sendLlmQuery,
    // Exported only for testing; should otherwise be considered internal.
    _internal: {
        sendApiQuery,
        sendCliQuery,
        buildCliArgs,
        parseCliOutput,
        parseFirstJson,
        parseCodexJsonl,
        findBinary,
        getCliVersion,
        sanitizeError,
        VALID_MODES,
        VALID_API_PROVIDERS,
        VALID_CLI_TYPES
    }
};
