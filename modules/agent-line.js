/**
 * The FromPS / ToPS AI line: a fixed-height status line at the bottom of the panel.
 *
 * It replaces the old AI Assist dialog (see ui02.00 in the PreRelease docs): UXP cannot
 * draw a window that resizes itself to long, changing text, so this line shows only the
 * bare minimum — connection, task name, one line of current step, Abort task, and a button
 * that asks Helper to open its own AI Assist window for everything long (connection setup,
 * the running step list, the full report).
 *
 * The line owns the Photoshop command channel exactly as the old dialog did: the channel
 * opens when the line is turned on and closes when it is turned off, when an hour passes
 * without any task, or when the panel/plugin goes away. It is never open just because the
 * plugin started.
 */

const helper = require('./helper.js');
const { createWsBridgeClient } = require('./ws-bridge.js');
const commandHandlers = require('./command-handlers.js');
const { describeError } = require('./error-text.js');

const WS_BRIDGE_PORT = 18346;
const POLL_INTERVAL_MS = 1500;

// A running task whose agent has not called a tool for this long is shown as silent: the
// agent may have crashed, run out of its limits or been restarted, and Abort task is how
// the person frees Photoshop for the next one.
const SILENCE_WARNING_MS = 4 * 60 * 1000;

// Used until Helper's own value arrives in /state (idleWithoutTaskMs). Kept in sync with
// agent/index.js's DEFAULT_IDLE_WITHOUT_TASK_MS; a mismatch only affects the line briefly,
// before the first poll answers.
const DEFAULT_IDLE_WITHOUT_TASK_MS = 60 * 60 * 1000;

// Must match ABORTED_BY_PERSON in PhotoshopHelper/agent/index.js: it is how the line tells
// a task the person aborted from one that ended for another reason.
const ABORTED_BY_PERSON = 'the person pressed Abort task';

// This identity lives exactly as long as the UXP JavaScript runtime. Turning the line off
// and back on keeps it; unloading the plugin creates a new one. Helper uses that
// distinction to avoid replaying a possibly completed Photoshop mutation after a reload.
const PLUGIN_RUNTIME_ID = `uxp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

let bridgeClient = null;
let pollTimer = null;
let idleTimer = null;
let lineOn = false;

// Told by index.js at init() time so this module never touches UXP entrypoints directly.
let setMenuChecked = () => {};

// Whether Helper answers over HTTP (null until the first answer) and the state of the
// command channel. Together they decide what the line shows before any task exists.
let helperReachable = null;
let channelStatus = 'disconnected';
let hasConnectedOnce = false;

// The last /state answer, so a redraw (e.g. after the channel's own status changes) does
// not have to wait for the next poll — render() always redraws from this single source.
let lastState = null;

// When the line last had no task, so the "an hour without tasks" clock can be measured
// against it. Reset to null while a task exists.
let noTaskSince = null;
let idleWithoutTaskMs = DEFAULT_IDLE_WITHOUT_TASK_MS;

/**
 * @param {string} id - Element id.
 * @returns {HTMLElement|null} Matching element.
 */
function byId(id) {
    return document.getElementById(id);
}

/**
 * Call one of Helper's protected document-agent routes.
 *
 * @param {string} path - Path under /api/agent.
 * @param {object} [options] - Optional { method, body } request settings.
 * @returns {Promise<object|null>} Parsed response, or null when Helper is unreachable.
 */
async function callHelper(path, options = {}) {
    try {
        const headers = await helper.buildHeaders(
            options.body ? { 'Content-Type': 'application/json' } : {}
        );
        const response = await fetch(`${helper.HELPER_URL}/api/agent${path}`, {
            method: options.method || 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined
        });

        if (!response.ok) return { error: `HTTP ${response.status}` };
        return await response.json();
    } catch {
        return null;
    }
}

/**
 * Ask Helper to open or focus the AI Assist window.
 *
 * @param {string} [section] - 'connect' opens straight to the connect-an-agent step.
 * @returns {Promise<void>}
 */
function openAssistWindow(section) {
    void callHelper('/open-window', { method: 'POST', body: section ? { section } : {} });
}

// ── Photoshop command channel ───────────────────────────────────────────────

/**
 * Open the channel to Helper, unless this line already owns a client.
 *
 * @returns {Promise<void>}
 */
async function connectChannel() {
    if (bridgeClient) {
        bridgeClient.connect();
        return;
    }

    const token = await helper.getHelperToken();
    // The line may have been turned off while the token request was in flight.
    if (!lineOn) return;
    if (!token) {
        console.warn('[agent-line] No pairing token yet — the channel stays closed.');
        return;
    }

    bridgeClient = createWsBridgeClient({
        url: `ws://127.0.0.1:${WS_BRIDGE_PORT}`,
        token,
        runtimeId: PLUGIN_RUNTIME_ID,
        maxReconnectDelay: 30000
    });

    bridgeClient.onStatusChange = (status) => {
        console.log(`[agent-line] Channel: ${status}`);
        if (status === 'connected') hasConnectedOnce = true;
        channelStatus = status;
        if (lineOn) render(lastState);
    };

    bridgeClient.onCommand = async (commandId, action, payload) => {
        try {
            const result = await commandHandlers.handleCommand(action, payload);
            bridgeClient.sendResult(commandId, result);
        } catch (error) {
            const text = describeError(error);
            console.error(`[agent-line] Command "${action}" failed:`, text);
            bridgeClient.sendError(commandId, text);
        }
    };

    bridgeClient.connect();
}

/**
 * Close the channel this line owns, if any.
 *
 * @param {string} reasonCode - Structured reason sent to Helper.
 * @param {string} reason - Human-readable reason, shown to the agent by Helper.
 */
function disconnectChannel(reasonCode, reason) {
    if (!bridgeClient) return;
    bridgeClient.disconnect({ reason, reasonCode, intentional: true });
}

// ── Small helpers for drawing ────────────────────────────────────────────────

/**
 * @param {HTMLElement|null} element - Element to update.
 * @param {boolean} shown - Whether it should be visible.
 */
function setShown(element, shown) {
    if (element) element.style.display = shown ? '' : 'none';
}

/**
 * @param {string} id - Element id.
 * @param {string} text - Text to put into it.
 */
function setText(id, text) {
    const element = byId(id);
    if (element) element.textContent = text;
}

/**
 * @param {number} ms - How long ago something happened.
 * @returns {number} Whole minutes, never negative.
 */
function minutesOf(ms) {
    return Math.max(0, Math.round(ms / 60000));
}

/**
 * @param {number} ms - Time since something started or last happened.
 * @returns {string} "12 s", "4 min", "2 h" — compact, no "ago": the line has no room for it.
 */
function formatElapsed(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.round(minutes / 60)} h`;
}

/**
 * @param {number} ms - How long a task took.
 * @returns {string} "Took 6 min", or "Took under a minute".
 */
function formatTook(ms) {
    const minutes = Math.round(Math.max(0, ms) / 60000);
    return minutes < 1 ? 'Took under a minute' : `Took ${minutes} min`;
}

/**
 * @param {string} text - A sentence fragment.
 * @returns {string} The same with a capital first letter.
 */
function capitalize(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// Exact markup from the design canvas (ui02.00's mockup, "Строка агента · все состояния").
const GLYPH = {
    check: '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6.5l2.5 2.5L10 3" fill="none" stroke="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor" aria-hidden="true">'
        + '<rect x="1.5" y="1" width="2.4" height="8" rx="0.6" fill="currentColor"/>'
        + '<rect x="6.1" y="1" width="2.4" height="8" rx="0.6" fill="currentColor"/></svg>',
    aborted: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" '
        + 'stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor"/>'
        + '<path d="M3.9 3.9L12.1 12.1" fill="none" stroke="currentColor"/></svg>',
    cursor: '<svg viewBox="0 0 10 10" width="10" height="10" fill="currentColor" aria-hidden="true">'
        + '<path d="M2 1V8.5L4 6.6L5.6 9.4L6.8 8.8L5.3 6.1L8 6Z" fill="currentColor"/></svg>'
};

/**
 * @param {'glyph1'|'glyph2'} which - Which row's glyph slot to set.
 * @param {string|null} name - A key of GLYPH, or null/empty to hide it.
 * @param {string} [color] - CSS color for the glyph; defaults to the row's text color.
 */
function setGlyph(which, name, color) {
    const el = byId(`agent-line-${which}`);
    if (!el) return;
    if (!name) {
        el.classList.remove('shown');
        el.innerHTML = '';
        el.style.color = '';
        return;
    }
    el.innerHTML = GLYPH[name] || '';
    el.style.color = color || '';
    el.classList.add('shown');
}

/**
 * @param {'yellow'|'green'|'red'} color - Connection state colour.
 */
function setConnColor(color) {
    const el = byId('agent-line-conn');
    if (!el) return;
    el.className = `agent-line-conn agent-line-conn-${color}`;
}

/**
 * Row 1: connection-stage texts (yellow "connecting"/"reconnecting" or red "not reachable")
 * that have no task to show at all. Neither Abort task nor the window button exist yet —
 * the window button only appears once the channel is actually connected (green).
 *
 * @param {'yellow'|'red'} color - Connection colour.
 * @param {string} text1 - Row 1 text.
 * @param {string} text2 - Row 2 text.
 * @param {boolean} [isError] - Whether row 1 should use the error colour.
 */
function renderPlain(color, text1, text2, isError) {
    setConnColor(color);
    setGlyph('glyph1', null);
    setGlyph('glyph2', null);
    setText('agent-line-text1', text1);
    byId('agent-line-text1').classList.toggle('agent-line-error', Boolean(isError));
    byId('agent-line-text1').classList.remove('agent-line-muted');
    setText('agent-line-text2', text2);
    byId('agent-line-text2').classList.remove('agent-line-warn', 'agent-line-bright');
    setShown(byId('agent-line-link2'), false);
    setShown(byId('agent-line-text2'), true);
    setShown(byId('agent-line-abort'), false);
    setShown(byId('agent-line-window'), false);
}

/**
 * @param {object} state - /api/agent/state answer.
 * @param {object} task - state.task, state === 'running'.
 */
function renderRunningTask(state, task) {
    const now = Date.now();
    const steps = (state.progress || []).filter(step => step.taskId === task.id);
    const last = steps[steps.length - 1];
    const lastActivity = task.lastActivityAt || (last && last.at) || task.startedAt;
    const silent = !task.waitingForPerson && now - lastActivity >= SILENCE_WARNING_MS;

    setConnColor('green');
    setGlyph('glyph1', null);
    setText('agent-line-text1', task.intent);
    byId('agent-line-text1').classList.remove('agent-line-error', 'agent-line-muted');

    const abort = byId('agent-line-abort');
    setShown(abort, true);
    if (abort) abort.classList.toggle('agent-line-btn-warn', silent);
    setShown(byId('agent-line-window'), true);
    setShown(byId('agent-line-link2'), false);
    setShown(byId('agent-line-text2'), true);

    if (silent) {
        setGlyph('glyph2', null);
        setText('agent-line-text2', `No activity for ${minutesOf(now - lastActivity)} min — abort if the agent crashed`);
        byId('agent-line-text2').classList.add('agent-line-warn');
        byId('agent-line-text2').classList.remove('agent-line-bright');
        return;
    }
    byId('agent-line-text2').classList.remove('agent-line-warn');

    if (task.waitingForPerson) {
        setGlyph('glyph2', 'cursor', '#e0e0e0');
        setText('agent-line-text2', 'Your turn: finish in the Photoshop dialog');
        byId('agent-line-text2').classList.add('agent-line-bright');
        return;
    }
    byId('agent-line-text2').classList.remove('agent-line-bright');

    setGlyph('glyph2', null);
    const stepText = last ? last.text : 'Starting…';
    setText('agent-line-text2', `${stepText} · ${formatElapsed(now - lastActivity)}`);
}

/**
 * @param {object} task - state.task, state === 'suspended'.
 */
function renderSuspendedTask(task) {
    setConnColor('green');
    setGlyph('glyph1', 'pause', '#f0a54a');
    setText('agent-line-text1', `Paused: ${task.intent}`);
    byId('agent-line-text1').classList.remove('agent-line-error', 'agent-line-muted');

    setGlyph('glyph2', null);
    byId('agent-line-text2').classList.remove('agent-line-warn', 'agent-line-bright');
    const restarted = task.suspension && task.suspension.requiresRebind;
    setText('agent-line-text2', restarted
        ? 'Ask your agent to continue'
        : 'The link to Photoshop was interrupted');
    setShown(byId('agent-line-text2'), true);
    setShown(byId('agent-line-link2'), false);

    setShown(byId('agent-line-abort'), true);
    if (byId('agent-line-abort')) byId('agent-line-abort').classList.remove('agent-line-btn-warn');
    setShown(byId('agent-line-window'), true);
}

/**
 * @param {object} finished - state.lastFinishedTask.
 */
function renderFinishedTask(finished) {
    setConnColor('green');
    byId('agent-line-text1').classList.remove('agent-line-error');
    setShown(byId('agent-line-abort'), false);
    setShown(byId('agent-line-window'), true);
    setShown(byId('agent-line-link2'), false);
    setShown(byId('agent-line-text2'), true);
    byId('agent-line-text2').classList.remove('agent-line-warn', 'agent-line-bright');

    if (finished.state === 'finished') {
        byId('agent-line-text1').classList.remove('agent-line-muted');
        setGlyph('glyph1', 'check', '#6fd3aa');
        setText('agent-line-text1', `Done: ${finished.intent}`);
        const took = finished.startedAt && finished.finishedAt
            ? formatTook(finished.finishedAt - finished.startedAt)
            : 'Done';
        setGlyph('glyph2', null);
        setText('agent-line-text2', `${took} · report in the AI Assist window`);
        return;
    }

    byId('agent-line-text1').classList.add('agent-line-muted');
    setGlyph('glyph1', 'aborted', '#a8a8a8');
    setText('agent-line-text1', `Aborted: ${finished.intent}`);
    setGlyph('glyph2', null);
    setText('agent-line-text2', finished.abortReason === ABORTED_BY_PERSON
        ? 'A new task can start now'
        : capitalize(finished.abortReason || 'the task ended'));
}

/**
 * @param {object} state - /api/agent/state answer.
 */
function renderConnectedIdle(state) {
    setConnColor('green');

    setGlyph('glyph1', null);
    byId('agent-line-text1').classList.remove('agent-line-error', 'agent-line-muted');
    setGlyph('glyph2', null);
    byId('agent-line-text2').classList.remove('agent-line-warn', 'agent-line-bright');
    setShown(byId('agent-line-abort'), false);
    setShown(byId('agent-line-window'), true);

    if (!state.agentSeen) {
        setText('agent-line-text1', 'Connected');
        setShown(byId('agent-line-text2'), false);
        const link = byId('agent-line-link2');
        if (link) {
            link.textContent = 'How to connect an agent';
            setShown(link, true);
        }
        return;
    }

    setShown(byId('agent-line-link2'), false);
    setShown(byId('agent-line-text2'), true);
    setText('agent-line-text1', 'Waiting for a task');
    const remainingMs = noTaskSince === null
        ? idleWithoutTaskMs
        : Math.max(0, idleWithoutTaskMs - (Date.now() - noTaskSince));
    setText('agent-line-text2', `Turns off in ${minutesOf(remainingMs)} min without tasks`);
}

/**
 * Draw the whole line from a /api/agent/state answer, or from nothing at all.
 *
 * @param {object|null} state - Helper state, or null/error when Helper cannot be reached.
 */
function render(state) {
    lastState = state;
    if (!lineOn) return;

    if (helperReachable === null) {
        renderPlain('yellow', 'Connecting…', 'Opening the link to Photoshop');
        return;
    }
    if (!state) {
        renderPlain('red', 'PhotoshopHelper is not running', 'Start it — the line connects by itself', true);
        return;
    }
    if (state.error) {
        renderPlain('red', 'Helper not paired!', 'Add its token in Settings', true);
        return;
    }

    if (typeof state.idleWithoutTaskMs === 'number' && state.idleWithoutTaskMs > 0) {
        idleWithoutTaskMs = state.idleWithoutTaskMs;
    }

    if (channelStatus !== 'connected') {
        renderPlain('yellow',
            hasConnectedOnce ? 'Reconnecting…' : 'Connecting…',
            hasConnectedOnce ? 'A running task resumes by itself' : 'Opening the link to Photoshop');
        return;
    }

    if (state.task) {
        noTaskSince = null;
        if (state.task.state === 'suspended') renderSuspendedTask(state.task);
        else renderRunningTask(state, state.task);
        return;
    }

    if (noTaskSince === null) noTaskSince = Date.now();

    if (state.lastFinishedTask) {
        renderFinishedTask(state.lastFinishedTask);
        return;
    }

    renderConnectedIdle(state);
}

// ── The "an hour without tasks" clock ───────────────────────────────────────

/**
 * Check whether the line has gone long enough without a task to turn itself off. Runs on
 * its own timer so it still fires even if a poll is slow to answer.
 */
function checkIdleTimeout() {
    if (!lineOn || noTaskSince === null) return;
    if (Date.now() - noTaskSince < idleWithoutTaskMs) return;
    disable('ai-line-idle-timeout', 'No tasks for an hour');
}

// ── Controls and lifecycle ──────────────────────────────────────────────────

/**
 * Refresh the line from Helper.
 *
 * @returns {Promise<void>}
 */
async function refresh() {
    const state = await callHelper('/state');
    helperReachable = Boolean(state);
    render(state);
    checkIdleTimeout();
}

/**
 * Attach the line's controls once per plugin runtime.
 */
function wireControls() {
    const abort = byId('agent-line-abort');
    if (abort) {
        abort.addEventListener('click', async () => {
            await callHelper('/stop', { method: 'POST' });
            await refresh();
        });
    }

    const windowBtn = byId('agent-line-window');
    if (windowBtn) {
        windowBtn.addEventListener('click', () => openAssistWindow());
    }

    const link = byId('agent-line-link2');
    if (link) {
        link.addEventListener('click', () => openAssistWindow('connect'));
    }
}

let wired = false;

/**
 * Turn the line on: show it, open the channel, and start polling.
 */
function enable() {
    if (lineOn) return;
    lineOn = true;

    if (!wired) {
        wireControls();
        wired = true;
    }

    setShown(byId('agent-line'), true);
    helperReachable = null;
    channelStatus = 'disconnected';
    hasConnectedOnce = false;
    noTaskSince = Date.now();
    render(null);

    void connectChannel();
    if (!pollTimer) {
        pollTimer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    }
    if (!idleTimer) {
        idleTimer = setInterval(checkIdleTimeout, 30_000);
    }
    void refresh();

    setMenuChecked(true);
}

/**
 * Turn the line off: hide it, close the channel, and stop polling.
 *
 * This is intentionally not a task cancellation. Helper suspends an active task and keeps
 * its id so a running task resumes when the line comes back on in the same UXP runtime; the
 * explicit Abort task button is the only line action that abandons a task immediately.
 *
 * @param {string} reasonCode - Structured reason sent to Helper.
 * @param {string} [reason] - Human-readable reason, shown to the agent by Helper.
 */
function disable(reasonCode, reason) {
    if (!lineOn) return;
    lineOn = false;

    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
    }

    disconnectChannel(reasonCode, reason || 'FromPS / ToPS AI line turned off');
    setShown(byId('agent-line'), false);
    setMenuChecked(false);
}

/**
 * Toggle the line on or off. Called from the panel's "FromPS / ToPS AI..." menu item.
 */
function toggle() {
    if (lineOn) disable('ai-line-off');
    else enable();
}

/**
 * The panel that hosts the line was destroyed (closed or reloaded), or the plugin runtime
 * itself is going away. Either way, turning the line off behaves the same as the person
 * doing it from the menu: the channel closes and a running task is left resumable.
 *
 * @param {string} reasonCode - Structured shutdown reason.
 */
function onHostDestroyed(reasonCode) {
    disable(reasonCode, reasonCode === 'plugin-runtime-destroyed'
        ? 'Photoshop plugin runtime destroyed'
        : 'FromPS / ToPS plugin panel closed');
}

/**
 * @param {object} options
 * @param {(checked: boolean) => void} options.setMenuChecked - Reflects the line's on/off
 *   state on the panel's "FromPS / ToPS AI..." menu item.
 */
function init({ setMenuChecked: setChecked }) {
    setMenuChecked = typeof setChecked === 'function' ? setChecked : () => {};
}

module.exports = {
    init,
    toggle,
    onHostDestroyed,
    // Exported for manual diagnostics in UXP DevTools.
    refresh
};
