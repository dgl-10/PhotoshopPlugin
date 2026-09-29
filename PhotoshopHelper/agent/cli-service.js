'use strict';

/**
 * Data layer for the CLI agent system.
 *
 * This module is the single entry point for all CLI-related functionality:
 *   - Detecting which CLI binaries are installed on the machine.
 *   - Reading the user's CLI configuration from user-settings.
 *   - Running a prompt using the tier settings (Light / Medium / High).
 *   - Fetching the list of available models from a specific CLI and caching it.
 *
 * Production code that needs to run something through the CLI should call
 * runWithTier() instead of reaching into cli-runner.js directly.
 *
 * The module deliberately does not import anything from Electron so that unit
 * tests can require it without the Electron environment being present. All
 * Electron-specific work (IPC, BrowserWindow) lives in the window modules.
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { buildArgs, parseOutput, sanitize } = require('./cli-runner');
const { createTranscript } = require('./cli-transcript');
const { openCliWindow } = require('./cli-window');
const { buildModelListPrompt } = require('./cli-prompts');
const { readCache, writeCache } = require('./cli-models-cache');
const {
    getCliSettings,
    setCliEnabled,
    setCliNativeImageGen,
    setCliTier,
    setCliTiers
} = require('../user-settings');

/** The four CLI identifiers the UI manages (includes agy which is not launchable). */
const ALL_CLIS = ['claude', 'codex', 'grok', 'agy'];

/** How long to wait for a one-shot CLI call (model-list fetch). */
const FETCH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ── Install detection ──────────────────────────────────────────────────────

/**
 * Check whether a CLI binary can be found on PATH.
 *
 * Uses `where` on Windows, `which` elsewhere.
 *
 * @param {string} cliName - Binary name to look up.
 * @returns {boolean}
 */
function detectInstalled(cliName) {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    try {
        const result = spawnSync(cmd, [cliName], {
            windowsHide: true,
            encoding: 'utf-8',
            timeout: 3000
        });
        return result.status === 0;
    } catch {
        return false;
    }
}

/**
 * Return an install-status map for all four CLIs.
 *
 * @returns {{ claude: boolean, codex: boolean, grok: boolean, agy: boolean }}
 */
function detectAllInstalled() {
    const result = {};
    for (const cli of ALL_CLIS) {
        result[cli] = detectInstalled(cli);
    }
    return result;
}

// ── Config access ──────────────────────────────────────────────────────────

/**
 * Return the merged view of CLI settings + install status for all four CLIs.
 *
 * @returns {Promise<object>} Keys are CLI names; each value is:
 *   { installed, enabled, nativeImageGen, tiers: { light, medium, high } }
 */
async function getCliConfig() {
    const settings = await getCliSettings();
    const installed = detectAllInstalled();
    const result = {};

    for (const cli of ALL_CLIS) {
        const s = (settings && settings[cli]) || {};
        const cache = getCachedModels(cli);
        const nativeSupport = cache?.data?.supports_native_image_generation;
        const nativeSupported = nativeSupport === true;
        const nativeNotSupported = nativeSupport === false;

        // If from cache/config we know the CLI does NOT support native image gen,
        // force nativeImageGen to false and persist it if it was previously true.
        let nativeImageGen = Boolean(s.nativeImageGen);
        if (nativeNotSupported && nativeImageGen) {
            nativeImageGen = false;
            void setCliNativeImageGen(cli, false);
        }

        result[cli] = {
            installed: installed[cli] === true,
            enabled: Boolean(s.enabled),
            nativeImageGen,
            nativeImageGenSupported: nativeSupported,
            nativeImageGenNotSupported: nativeNotSupported,
            nativeImageGenKnown: typeof nativeSupport === 'boolean',
            tiers: {
                light: { model: s.tiers?.light?.model || '', effort: s.tiers?.light?.effort || '' },
                medium: { model: s.tiers?.medium?.model || '', effort: s.tiers?.medium?.effort || '' },
                high: { model: s.tiers?.high?.model || '', effort: s.tiers?.high?.effort || '' }
            }
        };
    }

    return result;
}

// ── One-shot CLI runner ────────────────────────────────────────────────────

/**
 * Effort flag names per CLI binary.
 *
 * These are the actual CLI flags used to set reasoning effort / thinking depth.
 * A null value means the CLI does not support an effort flag (model name alone
 * is enough, or the flag is unknown — extend this map when confirmed).
 *
 * @type {Record<string, string|null>}
 */
const EFFORT_FLAGS = {
    claude: '--effort',  // Claude Code CLI: --effort low|medium|high
    codex: null,        // OpenAI Codex CLI: uses -c model_reasoning_effort=...
    grok: null,        // Grok CLI: no explicit effort flag yet
    agy: '--effort'     // Antigravity CLI: --effort low|medium|high (only if model slug has no suffix)
};

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
 * Run a single prompt through a CLI and return the text response.
 *
 * This is a lower-level helper used by fetchModelsForCli(). It does not
 * read from process.env — all parameters are explicit.
 *
 * @param {object} params
 * @param {string}      params.cli     - CLI binary name.
 * @param {string}      params.prompt  - Prompt text.
 * @param {string|null} params.model   - Model override (null = CLI default).
 * @param {string|null} params.effort  - Effort level (null or '' = not passed).
 * @param {string}      params.cwd     - Working directory for the process.
 * @param {number}      [params.timeoutMs] - Optional per-call timeout.
 * @param {boolean}     [params.showWindow] - Show a console window that follows the run.
 *   The CLI is still started with pipes and its answer is read the usual way; Grok and
 *   Antigravity switch to their streaming output so there is something to watch.
 * @param {string|null} [params.reasoningSummary] - Ask Codex for thinking summaries.
 * @returns {Promise<{ ok: boolean, text: string, transcript: string, error?: string }>}
 *   `transcript` is everything the agent showed while it worked: thoughts, remarks between
 *   steps, tool calls and their output.
 */
function runOneShotCli({
    cli, prompt, model, effort, cwd, timeoutMs = FETCH_TIMEOUT_MS,
    showWindow = false, reasoningSummary = null
}) {
    const viewer = showWindow
        ? openCliWindow({ title: `Photoshop Helper - ${cli}` })
        : null;
    // Use a temporary outputFile for Codex so it writes the final response via -o.
    const outputFile = cli === 'codex'
        ? path.join(os.tmpdir(), `ps-models-${crypto.randomUUID()}.txt`)
        : null;

    // buildArgs expects (cli, model, effort, prompt, sessionId, cwd, outputFile).
    const { binary, args, parse } = buildArgs({
        cli,
        model: model && model.trim() ? model.trim() : null,
        effort: effort && typeof effort === 'string' && effort.trim() ? effort.trim() : null,
        prompt,
        sessionId: null,
        cwd,
        outputFile,
        reasoningSummary,
        // Streaming output is only switched on when there is a window to show it in.
        streaming: Boolean(viewer)
    });
    const transcript = createTranscript(parse, { onAppend: viewer ? viewer.append : undefined });

    const cleanupOutputFile = () => {
        if (outputFile) {
            try { fs.unlinkSync(outputFile); } catch { /* ignore if already unlinked */ }
        }
    };

    return new Promise((resolveRun) => {
        let stdout = '';
        let stderr = '';
        let settled = false;

        // Every outcome carries the record of what the agent showed, so a failed run can
        // still be understood. The window, if any, is told the run is over.
        const resolve = (outcome) => {
            transcript.finish(stdout, stderr);
            if (viewer) viewer.close();
            resolveRun({ ...outcome, transcript: sanitize(transcript.getText()) });
        };

        const stdinMode = cli === 'codex' ? getDevNullFd() : 'ignore';
        let child;
        try {
            child = spawn(binary, args, {
                cwd,
                shell: false,
                env: { ...process.env },
                stdio: [stdinMode, 'pipe', 'pipe'],
                windowsHide: true
            });
        } catch (spawnError) {
            cleanupOutputFile();
            resolve({
                ok: false,
                text: '',
                error: `Could not start "${binary}": ${sanitize(spawnError.message)}`
            });
            return;
        } finally {
            if (typeof stdinMode === 'number') {
                try { fs.closeSync(stdinMode); } catch { /* ignore */ }
            }
        }

        let timedOut = false;
        const timer = setTimeout(() => {
            if (!settled) {
                timedOut = true;
                cleanupOutputFile();
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
            }
        }, timeoutMs);

        child.stdout.on('data', chunk => {
            const piece = chunk.toString('utf-8');
            stdout += piece;
            transcript.push('stdout', piece);
        });
        child.stderr.on('data', chunk => {
            const piece = chunk.toString('utf-8');
            stderr += piece;
            transcript.push('stderr', piece);
        });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanupOutputFile();
            resolve({
                ok: false,
                text: '',
                error: `Could not start "${binary}": ${sanitize(err.message)}`
            });
        });

        child.on('close', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            if (timedOut) {
                const timeoutMins = Math.max(1, Math.round(timeoutMs / 60000));
                resolve({
                    ok: false,
                    text: '',
                    error: `Query timed out after ${timeoutMins} minutes. The CLI did not finish in time.`
                });
                return;
            }

            const parsed = parseOutput(parse, stdout, outputFile);
            cleanupOutputFile();

            if (parsed.error) {
                resolve({ ok: false, text: '', error: sanitize(parsed.error) });
                return;
            }

            if (typeof parsed.text === 'string') {
                resolve({ ok: true, text: sanitize(parsed.text) });
                return;
            }

            resolve({
                ok: false,
                text: '',
                error: `${cli} returned no output. ${sanitize(stderr.slice(0, 400))}`.trim()
            });
        });
    });
}

// ── Model list fetching ────────────────────────────────────────────────────

/**
 * Parse the first complete JSON object out of a string that may have noise
 * around it (e.g. CLI startup messages before the JSON payload).
 *
 * @param {string} text
 * @returns {object|null}
 */
function extractJson(text) {
    if (!text || typeof text !== 'string') return null;
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        if (depth === 0) {
            try { return JSON.parse(text.slice(start, i + 1)); }
            catch { return null; }
        }
    }
    return null;
}

/**
 * Validate that a parsed model-list response has the expected shape.
 *
 * @param {object} data - Parsed JSON from the CLI response.
 * @returns {boolean}
 */
function isValidModelListResponse(data) {
    if (!data || typeof data !== 'object') return false;
    if (!data.recommended_tiers || typeof data.recommended_tiers !== 'object') return false;
    if (!data.all_available_models || typeof data.all_available_models !== 'object') return false;
    return true;
}

/**
 * Determine the working directory used for one-shot CLI calls.
 * Falls back to the OS temp directory if no other path is available.
 *
 * @returns {string}
 */
function resolveWorkDir() {
    const envDir = (process.env.AGENT_WORK_DIR || '').trim();
    if (envDir) return envDir;
    return process.cwd();
}

/**
 * Fetch the list of available models for a CLI by running the model-list prompt.
 *
 * Execution rules (as specified):
 *   1. If the medium tier has a model configured → run with that model + effort.
 *   2. Otherwise → run with no --model flag (CLI default).
 *   3. If step 1 fails → retry with no --model flag (fallback).
 *   4. If all attempts fail → return { error }.
 *   5. On success → validate JSON shape, write to disk cache, return { data, fromCache: false }.
 *
 * @param {string} cli - One of: claude, codex, grok (not agy — not launchable).
 * @returns {Promise<{ data: object, fromCache: false } | { error: string }>}
 */
async function fetchModelsForCli(cli) {
    const settings = await getCliSettings();
    const cliConfig = (settings && settings[cli]) || {};
    const medium = cliConfig.tiers?.medium || {};
    const prompt = buildModelListPrompt();
    const cwd = resolveWorkDir();

    // Attempt 1: use the medium tier model + effort if configured.
    let result;
    const hasMediumModel = medium.model && typeof medium.model === 'string' && medium.model.trim();
    if (hasMediumModel) {
        result = await runOneShotCli({
            cli,
            prompt,
            model: medium.model.trim(),
            effort: medium.effort || null,
            cwd
        });
    }

    // Attempt 2 (fallback): no --model flag — let the CLI use its default.
    if (!result || !result.ok) {
        result = await runOneShotCli({ cli, prompt, model: null, effort: null, cwd });
    }

    if (!result.ok) {
        return { error: result.error || `${cli} returned an error.` };
    }

    // Extract and validate the JSON payload from the CLI's text response.
    const data = extractJson(result.text);
    if (!data || !isValidModelListResponse(data)) {
        return { error: `${cli} returned a response that does not match the expected JSON schema.` };
    }

    writeCache(cli, data);
    if (data.supports_native_image_generation === false) {
        await setCliNativeImageGen(cli, false);
    } else if (data.supports_native_image_generation === true) {
        await setCliNativeImageGen(cli, true);
    }
    return { data, fromCache: false };
}

/**
 * Return the cached model list for a CLI without triggering a fetch.
 *
 * @param {string} cli
 * @returns {{ data: object, fetchedAt: string, ageMs: number } | null}
 */
function getCachedModels(cli) {
    return readCache(cli);
}

// ── Tier-based runner ──────────────────────────────────────────────────────

/**
 * Run a prompt using the tier settings for the first enabled CLI.
 *
 * This is the high-level entry point for agent code. The caller names a
 * quality tier (light / medium / high) and the service resolves it to the
 * correct CLI binary, model, and effort flag — the caller never has to know
 * those details.
 *
 * NOTE: Integration with the Electron agent runner (agent/index.js) is a
 * separate step. Currently this function locates the correct parameters but
 * the actual spawn uses runOneShotCli() the same way fetchModelsForCli() does.
 * When the full agent pipeline is wired up, the spawn path can be replaced with
 * createCliRunner() from cli-runner.js.
 *
 * @param {string} prompt - Prompt text to send to the agent.
 * @param {'light'|'medium'|'high'} tier - Quality tier.
 * @returns {Promise<{ ok: boolean, text: string, sessionId: string|null, error?: string }>}
 */
async function runWithTier(prompt, tier) {
    const config = await getCliConfig();

    // Find the first enabled + installed CLI.
    const cliName = ALL_CLIS.find(c => config[c].enabled && config[c].installed);
    if (!cliName) {
        return {
            ok: false, text: '', sessionId: null,
            error: 'No enabled and installed CLI found. Enable at least one CLI in CLI Settings.'
        };
    }

    const tierConfig = config[cliName].tiers[tier] || {};
    const model = tierConfig.model || null;
    const effort = tierConfig.effort || null;
    const cwd = resolveWorkDir();

    const result = await runOneShotCli({ cli: cliName, prompt, model, effort, cwd });
    return {
        ok: result.ok,
        text: result.text || '',
        sessionId: null,
        error: result.error
    };
}

/**
 * Run a prompt through one explicitly selected CLI and tier.
 *
 * WebHelper exposes a CLI dropdown, so selecting the first enabled CLI (the behavior of
 * runWithTier()) would be incorrect here. This entry point re-reads live settings, verifies
 * the selected executable, and then delegates to the same one-shot runner used elsewhere.
 * A configured model is required: image generation must use the user's actual Medium model
 * rather than silently falling back to a CLI-specific default.
 *
 * @param {string} cliName - One of the CLI identifiers managed by this service.
 * @param {string} prompt - Complete prompt sent to the command-line agent.
 * @param {'light'|'medium'|'high'} tier - User-configured quality tier.
 * @param {object} [options] - Per-run process options.
 * @param {string} [options.cwd] - Working directory; defaults to resolveWorkDir().
 * @param {number} [options.timeoutMs] - Optional timeout in milliseconds.
 * @param {boolean} [options.showWindow] - Show a console window that follows the run.
 * @param {string} [options.reasoningSummary] - Ask Codex for thinking summaries (e.g. "detailed").
 * @returns {Promise<{ ok: boolean, text: string, transcript?: string, error?: string }>}
 */
async function runWithSelectedCli(cliName, prompt, tier, options = {}) {
    if (!ALL_CLIS.includes(cliName)) {
        return { ok: false, text: '', error: `Unknown CLI "${cliName}".` };
    }

    if (!['light', 'medium', 'high'].includes(tier)) {
        return { ok: false, text: '', error: `Unknown CLI tier "${tier}".` };
    }

    const config = await getCliConfig();
    const selected = config[cliName];
    if (!selected?.installed || !selected?.enabled) {
        return {
            ok: false,
            text: '',
            error: `CLI "${cliName}" is not installed and enabled.`
        };
    }

    const tierConfig = selected.tiers?.[tier] || {};
    const model = typeof tierConfig.model === 'string' ? tierConfig.model.trim() : '';
    if (!model) {
        return {
            ok: false,
            text: '',
            error: `CLI "${cliName}" does not have a model configured for the ${tier} tier.`
        };
    }

    return runOneShotCli({
        cli: cliName,
        prompt,
        model,
        effort: tierConfig.effort || null,
        cwd: options.cwd || resolveWorkDir(),
        timeoutMs: options.timeoutMs,
        showWindow: options.showWindow === true,
        reasoningSummary: options.reasoningSummary || null
    });
}

// ── Public API ─────────────────────────────────────────────────────────────

module.exports = {
    // Config
    ALL_CLIS,
    detectInstalled,
    detectAllInstalled,
    getCliConfig,
    // Settings passthrough (windows use this so they only import cli-service)
    setCliEnabled,
    setCliNativeImageGen,
    setCliTier,
    setCliTiers,
    // Model fetching
    fetchModelsForCli,
    getCachedModels,
    // Tier-based execution
    runWithTier,
    runWithSelectedCli
};
