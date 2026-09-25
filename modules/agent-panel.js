/**
 * The AI Assist dialog for MCP-based Photoshop work.
 *
 * The dialog keeps the plugin-to-Helper channel alive and shows one thing at a time: how to
 * connect an agent (until the first one has started a task), the task an agent is working
 * on, or the last task that ended. The window resizes itself to whatever is shown.
 *
 * Closing the dialog intentionally closes only its WebSocket. Helper keeps an unfinished
 * task in a suspended, resumable state, and reopening the dialog reconnects it. The MCP
 * client owns the person's prompts and responses; this module contains no prompt UI.
 */

const helper = require('./helper.js');
const { createWsBridgeClient } = require('./ws-bridge.js');
const commandHandlers = require('./command-handlers.js');
const { describeError } = require('./error-text.js');

const WS_BRIDGE_PORT = 18346;
const POLL_INTERVAL_MS = 1500;

// The window is resized to the content after every change of what it shows. The width is
// fixed to match .assistant's own CSS width; only the height varies with what is shown.
const DIALOG_WIDTH = 320;

// A running task whose agent has not called a tool for this long is shown as silent: the
// agent may have crashed, run out of its limits or been restarted, and Abort task is how
// the person frees Photoshop for the next one.
const SILENCE_WARNING_MS = 4 * 60 * 1000;

// How many of the agent's most recent steps the step list shows.
const VISIBLE_STEPS = 8;

// Must match ABORTED_BY_PERSON in PhotoshopHelper/agent/index.js: it is how the dialog
// tells a task the person aborted from one that ended for another reason.
const ABORTED_BY_PERSON = 'the person pressed Abort task';

// This identity lives exactly as long as the UXP JavaScript runtime. Reopening only the
// dialog keeps it; unloading the plugin creates a new one. Helper uses that distinction
// to avoid replaying a possibly completed Photoshop mutation after a hard reload.
const PLUGIN_RUNTIME_ID = `uxp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

let bridgeClient = null;
let pollTimer = null;
let panelVisible = false;

// Whether Helper answers over HTTP (null until the first answer) and the state of the
// command channel. Together they decide the status shown before any task exists.
let helperReachable = null;
let channelStatus = 'disconnected';

// The last /state answer, kept so a click can redraw the dialog without waiting for a poll.
let lastState = null;

// What the person opened or folded. The connection steps are folded away once an agent
// has started a task, and the step list is folded while a task runs and open after it
// ends, unless the person chose otherwise for that task.
let setupExpanded = false;
let setupTextShown = false;
const stepsOpenByTask = new Map();
let stepsTaskId = null;
let stepsOpen = false;

// MCP setup choices are stable for one Helper run, so they are fetched once. Each entry
// contains { label, hint, text }; setupChoiceIndex is the currently selected entry.
let setupChoices = [];
let setupChoicesLoading = false;
let setupChoiceIndex = 0;

// The height the window was last resized to, so an unchanged view does not resize again.
let fittedHeight = null;

// Whether the notice currently shows Helper refusing /state, so it can go away by itself
// once Helper answers normally again.
let stateErrorShown = false;

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

// ── Photoshop command channel ───────────────────────────────────────────────

/**
 * Open the channel to Helper, unless this dialog already owns a client.
 *
 * @returns {Promise<void>}
 */
async function connectChannel() {
    if (bridgeClient) {
        bridgeClient.connect();
        return;
    }

    const token = await helper.getHelperToken();
    // The dialog may have closed while the token request was in flight.
    if (!panelVisible) return;
    if (!token) {
        console.warn('[assistant] No pairing token yet — the channel stays closed.');
        return;
    }

    bridgeClient = createWsBridgeClient({
        url: `ws://127.0.0.1:${WS_BRIDGE_PORT}`,
        token,
        runtimeId: PLUGIN_RUNTIME_ID,
        maxReconnectDelay: 30000
    });

    bridgeClient.onStatusChange = (status) => {
        console.log(`[assistant] Channel: ${status}`);
        channelStatus = status;
        if (panelVisible) render(lastState);
    };

    bridgeClient.onCommand = async (commandId, action, payload) => {
        try {
            const result = await commandHandlers.handleCommand(action, payload);
            bridgeClient.sendResult(commandId, result);
        } catch (error) {
            const text = describeError(error);
            console.error(`[assistant] Command "${action}" failed:`, text);
            bridgeClient.sendError(commandId, text);
        }
    };

    bridgeClient.connect();
}

// ── Small helpers for drawing ───────────────────────────────────────────────

/**
 * Show or hide one element. Inline display is used because Spectrum components and the
 * dialog layout do not consistently honor the hidden attribute in older UXP versions.
 *
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
 * @param {number} ms - Time since something happened.
 * @returns {string} "12 s ago", "4 min ago", "2 h ago".
 */
function formatAge(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds} s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.round(minutes / 60)} h ago`;
}

/**
 * @param {number} ms - How long a task took.
 * @returns {string} "took 6 min", or "took under a minute".
 */
function formatDuration(ms) {
    const minutes = Math.round(Math.max(0, ms) / 60000);
    return minutes < 1 ? 'took under a minute' : `took ${minutes} min`;
}

/**
 * @param {number} ms - Time since the task started.
 * @returns {string} "3:07".
 */
function formatClock(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const rest = seconds % 60;
    return `${Math.floor(seconds / 60)}:${rest < 10 ? '0' : ''}${rest}`;
}

/**
 * @param {string} text - A sentence fragment.
 * @returns {string} The same with a capital first letter.
 */
function capitalize(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * @param {'ok'|'busy'|'warn'|'error'|'muted'} level - Colour of the status pill.
 * @param {string} text - What it says.
 */
function setStatus(level, text) {
    const pill = byId('assistant-status');
    if (pill) pill.className = `assistant-status assistant-status-${level}`;
    setText('assistant-status-text', text);
}

/**
 * Display a short message about an action that went wrong.
 *
 * @param {string} text - Text shown near the bottom of the dialog; empty hides it.
 */
function showNotice(text) {
    const notice = byId('assistant-notice');
    if (!notice) return;
    notice.textContent = text || '';
    setShown(notice, Boolean(text));
}

/**
 * The small line above the task title. A document name can be longer than the window, so
 * it is the part that gets cut, never what happened to the task.
 *
 * @param {string} documentName - Name of the task's document.
 * @param {string} what - What happened to the task, and when.
 */
function setMeta(documentName, what) {
    setText('assistant-task-document', documentName);
    setText('assistant-task-when', ` · ${what}`);
}

/**
 * @param {string} text - Explanation under the task title; empty hides it.
 */
function showMessage(text) {
    setText('assistant-message', text || '');
    setShown(byId('assistant-message'), Boolean(text));
}

// ── Resizing the window ─────────────────────────────────────────────────────

/**
 * @param {Function} callback - Run after the current layout has been applied.
 */
function nextFrame(callback) {
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(callback);
    } else {
        setTimeout(callback, 50);
    }
}

/**
 * Resize the window's height to match #assistant-root.
 *
 * resizeTo() on a shown dialog only takes effect when it runs after the content change has
 * been laid out — called in the same frame, the window keeps its old size — so the height
 * is measured and applied on the next frame. Skipped while the dialog draws its very first,
 * placeholder view before the first /state answer arrives: that view is only the header,
 * and fitting the window to it would shrink it for the instant before real content replaces
 * it, which is exactly what made the window stick at header height in an earlier version.
 */
function fitDialog() {
    if (helperReachable === null) return;

    const dialog = byId('assistant-dialog');
    if (!dialog || typeof dialog.resizeTo !== 'function') return;

    nextFrame(() => {
        const root = byId('assistant-root');
        if (!panelVisible || !root) return;

        const height = Math.ceil(root.offsetHeight);
        if (!height || height === fittedHeight) return;
        fittedHeight = height;
        try {
            dialog.resizeTo(DIALOG_WIDTH, height);
            // Trigger layout recalculation in UXP host window
            window.dispatchEvent(new Event('resize'));
        } catch (error) {
            console.warn('[assistant] Could not resize the dialog:', error.message || error);
        }
    });
}

// ── Drawing ─────────────────────────────────────────────────────────────────

/**
 * @param {object} state - /api/agent/state answer.
 * @param {string} taskId - Task whose steps are wanted.
 * @returns {object[]} That task's steps, oldest first.
 */
function stepsOf(state, taskId) {
    return (state.progress || []).filter(step => step.taskId === taskId);
}

/**
 * Draw the folded or open list of what the agent did.
 *
 * @param {string} taskId - Task the steps belong to.
 * @param {number} startedAt - When it started; step times are shown from there.
 * @param {object[]} steps - Its steps.
 * @param {boolean} openByDefault - Whether the list starts open for this task.
 * @param {boolean} markLast - Whether the last step is the one happening now.
 */
function renderSteps(taskId, startedAt, steps, openByDefault, markLast) {
    const toggle = byId('assistant-steps-toggle');
    const list = byId('assistant-steps');
    stepsTaskId = taskId;

    if (steps.length === 0) {
        setShown(toggle, false);
        setShown(list, false);
        return;
    }

    stepsOpen = stepsOpenByTask.has(taskId) ? stepsOpenByTask.get(taskId) : openByDefault;
    if (toggle) {
        toggle.textContent = stepsOpen
            ? 'Hide steps'
            : `What the agent did · ${steps.length} step${steps.length === 1 ? '' : 's'}`;
    }
    setShown(toggle, true);

    if (!stepsOpen || !list) {
        setShown(list, false);
        return;
    }

    list.textContent = '';
    const shown = steps.slice(-VISIBLE_STEPS);
    const hidden = steps.length - shown.length;
    if (hidden > 0) {
        const more = document.createElement('div');
        more.className = 'assistant-steps-more';
        more.textContent = `${hidden} earlier step${hidden === 1 ? '' : 's'}`;
        list.appendChild(more);
    }

    shown.forEach((step, index) => {
        const row = document.createElement('div');
        const isCurrent = markLast && index === shown.length - 1;
        row.className = isCurrent ? 'assistant-step-row assistant-step-current' : 'assistant-step-row';

        const time = document.createElement('span');
        time.className = 'assistant-step-time';
        time.textContent = formatClock(step.at - startedAt);

        const text = document.createElement('span');
        text.className = 'assistant-step-text';
        text.textContent = step.text;

        row.appendChild(time);
        row.appendChild(text);
        list.appendChild(row);
    });
    setShown(list, true);
}

/**
 * Draw a task that is running or paused.
 *
 * @param {object} state - /api/agent/state answer.
 * @param {object} task - state.task.
 */
function renderActiveTask(state, task) {
    const now = Date.now();
    const steps = stepsOf(state, task.id);
    const last = steps[steps.length - 1];
    const lastActivity = task.lastActivityAt || (last && last.at) || task.startedAt;
    const silent = task.state === 'running'
        && !task.waitingForPerson
        && now - lastActivity >= SILENCE_WARNING_MS;
    const documentName = task.documentName || 'document';

    setText('assistant-task-title', task.intent);
    setShown(byId('assistant-summary'), false);

    const live = byId('assistant-live');
    if (task.state === 'suspended') {
        setStatus('warn', 'Paused');
        setMeta(documentName, `paused ${formatAge(now - (task.suspendedAt || now))}`);
        setShown(live, false);
        const restarted = task.suspension && task.suspension.requiresRebind;
        showMessage(restarted
            ? 'The Photoshop plugin restarted. Ask your agent to continue the same task, or abort it.'
            : 'The link to Photoshop was interrupted. Ask your agent to continue the same task, or abort it.');
    } else {
        setStatus(silent ? 'warn' : 'busy', silent ? 'No activity' : 'Working');
        setMeta(documentName, `started ${formatAge(now - task.startedAt)}`);
        if (live) live.className = silent ? 'assistant-live assistant-live-silent' : 'assistant-live';
        setText('assistant-live-text', last ? `${silent ? 'Last: ' : ''}${last.text}` : 'Starting...');
        setText('assistant-live-age', formatAge(now - lastActivity));
        setShown(live, true);

        if (silent) {
            showMessage('If the agent crashed, ran out of limits or was restarted, abort the task so the next one can start.');
        } else if (task.waitingForPerson) {
            showMessage('Waiting for you to finish in a Photoshop dialog.');
        } else {
            showMessage('');
        }
    }

    // A silent agent is the case Abort task exists for, so the button stands out then.
    const abort = byId('assistant-abort');
    if (abort) {
        if (silent) abort.removeAttribute('quiet');
        else abort.setAttribute('quiet', '');
    }

    renderSteps(task.id, task.startedAt, steps, false, true);
}

/**
 * Draw the last task that ended: finished by the agent, or aborted.
 *
 * @param {object} state - /api/agent/state answer.
 * @param {object} finished - state.lastFinishedTask.
 */
function renderFinishedTask(state, finished) {
    const documentName = finished.documentName || 'document';
    setText('assistant-task-title', finished.intent);
    setShown(byId('assistant-live'), false);

    const steps = stepsOf(state, finished.id);
    if (finished.state === 'finished') {
        setStatus('ok', 'Done');
        const took = finished.startedAt && finished.finishedAt
            ? ` · ${formatDuration(finished.finishedAt - finished.startedAt)}`
            : '';
        setMeta(documentName, `finished${took}`);
        showMessage('');

        const summary = finished.report && finished.report.summary ? finished.report.summary : '';
        setText('assistant-summary-text', summary);
        setShown(byId('assistant-summary'), Boolean(summary));
        renderSteps(finished.id, finished.startedAt, steps, true, false);
        return;
    }

    setStatus('muted', 'Aborted');
    const byPerson = finished.abortReason === ABORTED_BY_PERSON;
    setMeta(documentName, byPerson ? 'aborted by you' : 'aborted');
    showMessage(byPerson
        ? 'A new task can start now. If the old agent is still running, Photoshop will refuse its next call.'
        : `${capitalize(finished.abortReason || 'the task ended')}. A new task can start now.`);
    setShown(byId('assistant-summary'), false);
    renderSteps(finished.id, finished.startedAt, steps, false, false);
}

/**
 * Draw the connection steps' heading: a first-time welcome, or plain instructions when an
 * agent has connected before and the person opened them again.
 *
 * @param {boolean} agentSeen - Whether an agent has ever started a task.
 */
function renderSetupHeading(agentSeen) {
    setText('assistant-setup-heading', agentSeen ? 'Connect an agent' : 'Waiting for an agent');
    setText('assistant-setup-intro', agentSeen
        ? 'Claude Code, Codex or any other agent that supports MCP.'
        : 'No agent has connected yet. Set one up once:');
    setText('assistant-setup-toggle', setupExpanded ? 'Hide connection steps' : 'How to connect an agent');
}

/**
 * Draw the whole dialog from a /api/agent/state answer.
 *
 * @param {object|null} state - Helper state, or null when Helper cannot be reached.
 */
function render(state) {
    lastState = state;

    const shown = {
        offline: false,
        idle: false,
        taskview: false,
        setup: false,
        setupLink: false,
        warning: false
    };
    let hasActiveTask = false;

    if (helperReachable === null) {
        setStatus('muted', 'Connecting...');
    } else if (!state) {
        setStatus('error', 'Not running');
        shown.offline = true;
    } else if (state.error) {
        setStatus('error', 'Error');
        showNotice(`PhotoshopHelper answered: ${state.error}`);
        stateErrorShown = true;
    } else {
        if (stateErrorShown) {
            showNotice('');
            stateErrorShown = false;
        }
        hasActiveTask = Boolean(state.task);
        const finished = state.lastFinishedTask;

        if (hasActiveTask) {
            shown.taskview = true;
            shown.warning = true;
            renderActiveTask(state, state.task);
        } else {
            if (finished) {
                shown.taskview = true;
                renderFinishedTask(state, finished);
            } else if (channelStatus === 'connected') {
                setStatus('ok', 'Connected');
            } else {
                setStatus('warn', 'Connecting...');
            }

            // The connection steps are the whole point of the window only while there is
            // no task at all — a previous task proves an agent has connected already.
            // Otherwise they fold into a link and open only on request.
            const agentSeen = Boolean(state.agentSeen) || Boolean(finished);
            if (!agentSeen) {
                shown.setup = true;
            } else {
                shown.setup = setupExpanded;
                shown.setupLink = true;
                shown.idle = !finished && !setupExpanded;
            }
        }

        renderSetupHeading(Boolean(state.agentSeen) || Boolean(state.lastFinishedTask));
        if (shown.setup) void loadSetupChoices();
    }

    setShown(byId('assistant-offline'), shown.offline);
    setShown(byId('assistant-idle'), shown.idle);
    setShown(byId('assistant-taskview'), shown.taskview);
    setShown(byId('assistant-setup'), shown.setup);
    setShown(byId('assistant-setup-link-row'), shown.setupLink);
    setShown(byId('assistant-warning'), shown.warning);
    setShown(byId('assistant-abort'), hasActiveTask);

    fitDialog();
}

// ── MCP setup ───────────────────────────────────────────────────────────────

/**
 * Fetch MCP registration commands and the ready-to-paste agent instruction.
 *
 * @returns {Promise<object|null>} Setup data, or null when Helper does not answer.
 */
async function fetchSetup() {
    const answer = await callHelper('/mcp-setup');
    return answer && answer.commands ? answer : null;
}

/**
 * Put text on the clipboard across old and new UXP clipboard implementations.
 *
 * @param {string} text - Text to copy.
 * @returns {Promise<void>}
 */
async function copyText(text) {
    try {
        await navigator.clipboard.write({ 'text/plain': text });
    } catch {
        await navigator.clipboard.writeText(text);
    }
}

/**
 * Show one MCP setup choice.
 *
 * @param {number} index - Position in setupChoices.
 */
function showSetupChoice(index) {
    const choice = setupChoices[index];
    if (!choice) return;

    setupChoiceIndex = index;
    setText('assistant-setup-hint', choice.hint);
    setText('assistant-setup-text', choice.text);
    fitDialog();
}

/**
 * Fill the setup picker once. The first choice is the simplest route: paste a complete
 * instruction into any compatible agent. CLI-specific terminal commands follow it.
 *
 * @returns {Promise<void>}
 */
async function loadSetupChoices() {
    if (setupChoices.length > 0 || setupChoicesLoading) return;

    setupChoicesLoading = true;
    try {
        const setup = await fetchSetup();
        const menu = document.querySelector('#assistant-setup-choice sp-menu');
        if (!setup || !menu) return;

        const choices = [];
        if (setup.instructionsForAnAgent) {
            choices.push({
                label: 'Any agent: paste into its chat',
                hint: 'Paste it into your agent\'s chat — the agent adds PhotoshopHelper to its settings by itself.',
                text: setup.instructionsForAnAgent
            });
        }
        for (const entry of setup.commands) {
            choices.push({
                label: `${entry.label}: terminal command`,
                hint: 'Run it in a terminal.',
                text: entry.copyCommand || entry.command
            });
        }

        menu.textContent = '';
        choices.forEach((choice, index) => {
            const item = document.createElement('sp-menu-item');
            item.setAttribute('value', String(index));
            item.textContent = choice.label;
            if (index === 0) item.setAttribute('selected', '');
            menu.appendChild(item);
        });

        setupChoices = choices;
        showSetupChoice(0);
    } finally {
        setupChoicesLoading = false;
    }
}

// ── Controls and lifecycle ──────────────────────────────────────────────────

/**
 * Refresh the dialog state from Helper.
 *
 * @returns {Promise<void>}
 */
async function refresh() {
    const state = await callHelper('/state');
    helperReachable = Boolean(state);
    render(state);
}

/**
 * Attach dialog controls once per plugin runtime.
 */
function wireControls() {
    const abort = byId('assistant-abort');
    if (abort) {
        abort.addEventListener('click', async () => {
            const answer = await callHelper('/stop', { method: 'POST' });
            showNotice(answer && answer.stopped
                ? ''
                : (answer && answer.message) || 'Could not abort the task.');
            await refresh();
        });
    }

    const stepsToggle = byId('assistant-steps-toggle');
    if (stepsToggle) {
        stepsToggle.addEventListener('click', () => {
            if (!stepsTaskId) return;
            stepsOpenByTask.set(stepsTaskId, !stepsOpen);
            render(lastState);
        });
    }

    const setupToggle = byId('assistant-setup-toggle');
    if (setupToggle) {
        setupToggle.addEventListener('click', () => {
            setupExpanded = !setupExpanded;
            render(lastState);
        });
    }

    const setupShow = byId('assistant-setup-show');
    if (setupShow) {
        setupShow.addEventListener('click', () => {
            setupTextShown = !setupTextShown;
            setupShow.textContent = setupTextShown ? 'Hide text' : 'Show text';
            setShown(byId('assistant-setup-text'), setupTextShown);
            fitDialog();
        });
    }

    const setupChoice = byId('assistant-setup-choice');
    if (setupChoice) {
        setupChoice.addEventListener('change', event => {
            showSetupChoice(Number(event.target.value));
        });
    }

    const setupCopy = byId('assistant-setup-copy');
    if (setupCopy) {
        setupCopy.addEventListener('click', async () => {
            const choice = setupChoices[setupChoiceIndex];
            if (!choice) return;

            try {
                await copyText(choice.text);
                setupCopy.textContent = 'Copied';
            } catch (error) {
                console.warn('[assistant] Could not copy the text:', error.message || error);
                setupCopy.textContent = 'Copy failed';
            }
            setTimeout(() => { setupCopy.textContent = 'Copy setup text'; }, 1500);
        });
    }
}

let wired = false;

/**
 * Start polling and open the Photoshop command channel while the dialog is visible.
 */
function onShow() {
    panelVisible = true;
    if (!wired) {
        wireControls();
        wired = true;
    }

    // A freshly shown window has the size it was shown with, whatever it had before.
    fittedHeight = null;
    helperReachable = null;
    showNotice('');
    render(null);
    void connectChannel();

    if (!pollTimer) {
        pollTimer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    }
    void refresh();
}

/**
 * Stop polling and disconnect when the dialog is closed.
 *
 * This is intentionally not a task cancellation. The GOODBYE message tells Helper why the
 * socket disappeared; Helper suspends the active task, keeps its id, and will resume it
 * when this same UXP runtime reconnects after the person reopens AI Assist. The explicit
 * Abort task button is the only dialog action that abandons the task immediately.
 *
 * @param {string} reasonCode - Structured reason sent to Helper.
 */
function onHide(reasonCode = 'assistant-dialog-closed') {
    panelVisible = false;

    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }

    if (bridgeClient) {
        console.log('[assistant] The dialog was closed; closing the channel.');
        const reason = reasonCode === 'assistant-dialog-closed'
            ? 'AI Assist closed'
            : 'FromPS / ToPS plugin panel closed';
        bridgeClient.disconnect({ reason, reasonCode, intentional: true });
    }
}

/**
 * Tear down the dialog-owned resources with the plugin runtime.
 *
 * @param {string} reasonCode - Structured shutdown reason.
 */
function onDestroy(reasonCode = 'plugin-runtime-destroyed') {
    onHide(reasonCode);
}

module.exports = {
    onShow,
    onHide,
    onDestroy,
    // Exported for manual diagnostics in UXP DevTools.
    connectChannel,
    refresh
};
