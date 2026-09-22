/**
 * The AI assistant dialog.
 *
 * The person stays in Photoshop: the conversation, the progress and the buttons all live
 * in this dialog, and it is non-modal — the canvas, the tools and every other panel keep
 * working while it is open. Helper does everything the UXP sandbox cannot — launching the
 * agent, keeping the chats — so this file is a view over Helper's /api/agent routes plus
 * the lifetime of the channel.
 *
 * The dialog is also the switch for that channel: it is open exactly while the dialog is
 * open. Closing the dialog drops the socket and stops every reconnect attempt at once.
 * Helper aborts a task that is still running when the last client goes away.
 */

const helper = require('./helper.js');
const { createWsBridgeClient } = require('./ws-bridge.js');
const commandHandlers = require('./command-handlers.js');
const { describeError } = require('./error-text.js');
const internalChat = require('./agent-internal-chat.js');

const WS_BRIDGE_PORT = 18346;

// This identity lives exactly as long as the UXP JavaScript runtime. Reopening only the
// assistant dialog keeps it; unloading the whole plugin creates a new one. Helper uses the
// distinction to avoid replaying a possibly completed Photoshop mutation after a hard reload.
const PLUGIN_RUNTIME_ID = `uxp-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// The panel asks Helper how things are going while it is on screen. The agent works for
// minutes, so this is about keeping a person informed, not about latency.
const POLL_INTERVAL_MS = 1500;

let bridgeClient = null;
let pollTimer = null;
let panelVisible = false;

// What the single badge at the top is built from: whether Helper answers over HTTP at all
// (null until the first answer), and the state of the socket to it.
let helperReachable = null;
let channelStatus = 'disconnected';

// What the card offers when there is no built-in agent: one entry per way of connecting an
// outside agent, { label, hint, text }. It does not change while Helper runs, so it is read
// once. `setupChoiceIndex` is the entry the person has picked.
let setupChoices = [];
let setupChoicesLoading = false;
let setupChoiceIndex = 0;

// Things the panel itself has to say — a registration command, why something failed. They
// are not part of the conversation, so they are kept apart and redrawn after it; otherwise
// the next poll would wipe a command the person was in the middle of copying.
let panelNotes = [];

/**
 * @param {string} id - Element id.
 * @returns {HTMLElement|null}
 */
function byId(id) {
    return document.getElementById(id);
}

/**
 * Call one of Helper's agent routes.
 *
 * @param {string} path - Path under /api/agent.
 * @param {object} [options] - { method, body }.
 * @returns {Promise<object|null>} Parsed answer, or null when Helper is unreachable.
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

        if (!response.ok) {
            return { error: `HTTP ${response.status}` };
        }
        return await response.json();
    } catch (error) {
        return null;
    }
}

// ── The channel ──────────────────────────────────────────────────────────────

/**
 * Open the channel to Helper, if it is not open already.
 *
 * @returns {Promise<void>}
 */
async function connectChannel() {
    if (bridgeClient) {
        bridgeClient.connect();
        return;
    }

    const token = await helper.getHelperToken();
    // The dialog may have been closed while the token was being fetched.
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
        renderHelperBadge();
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

// ── Drawing ──────────────────────────────────────────────────────────────────

/**
 * The one badge for Helper: not running, connecting, or connected.
 */
function renderHelperBadge() {
    const element = byId('assistant-channel');
    if (!element) return;

    let text = 'Helper: connecting...';
    let level = 'warn';
    if (helperReachable === false) {
        text = 'Helper: not running';
        level = 'error';
    } else if (helperReachable && channelStatus === 'connected') {
        text = 'Helper: connected';
        level = 'ok';
    }

    element.textContent = text;
    element.className = `assistant-badge assistant-badge-${level}`;
}

/**
 * Show or hide an element. The inline style is used rather than the `hidden` attribute:
 * the elements here get `display: flex` from their classes, and the attribute did not hide
 * them in the dialog.
 *
 * @param {HTMLElement|null} element
 * @param {boolean} shown
 */
function setShown(element, shown) {
    if (element) element.style.display = shown ? '' : 'none';
}

/**
 * What the dialog shows depends on whether Helper answers and whether it can launch an
 * agent of its own.
 *
 *   'unknown' - no answer yet: only the badge.
 *   'offline' - Helper is not running: only how to start it.
 *   'noAgent' - Helper runs but has no built-in agent. The person can still work through an
 *               outside agent connected over MCP, so progress and the report stay; the chat,
 *               the message box and its buttons are gone, replaced by how to set things up.
 *   'agent'   - the whole assistant.
 *
 * @param {string} mode
 */
function renderAvailability(mode) {
    const online = mode === 'agent' || mode === 'noAgent';

    for (const element of document.querySelectorAll('.assistant-online-only')) {
        setShown(element, online);
    }
    for (const element of document.querySelectorAll('.assistant-agent-only')) {
        setShown(element, mode === 'agent');
    }
    for (const element of document.querySelectorAll('.assistant-noagent-only')) {
        setShown(element, mode === 'noAgent');
    }
    setShown(byId('assistant-offline'), mode === 'offline');
}

/**
 * @param {object} state - Answer from /api/agent/state.
 */
function renderState(state) {
    helperReachable = Boolean(state);
    renderHelperBadge();
    if (!state) {
        renderAvailability('offline');
        return;
    }

    const hasAgent = Boolean(state.cli && state.cli.configured);
    renderAvailability(hasAgent ? 'agent' : 'noAgent');

    // The line under the badge says what is going on right now. With nothing going on and
    // no built-in agent there is nothing to say, so the line goes away.
    let taskText = '';
    if (state.task) {
        const from = state.task.origin === 'panel' ? '' : ' (your own agent)';
        if (state.task.state === 'suspended') {
            const reason = state.task.suspension && state.task.suspension.reason
                ? state.task.suspension.reason
                : 'the Photoshop connection was lost';
            taskText = `Paused on "${state.task.documentName}"${from}: ${reason}. `
                + (state.channel && state.channel.connected
                    ? 'Type "continue" to resume safely.'
                    : 'Reopen AI Assist and type "continue".');
        } else {
            taskText = `Working on "${state.task.documentName}"${from}: ${state.task.intent}`;
        }
    } else if (state.agentRunning) {
        taskText = 'The agent is thinking...';
    } else if (hasAgent) {
        taskText = `Ready. ${state.cli.cli}${state.cli.model ? `, ${state.cli.model}` : ''}.`;
    }
    const taskElement = byId('assistant-task');
    if (taskElement) {
        taskElement.textContent = taskText;
        setShown(taskElement, Boolean(taskText));
    }

    if (!hasAgent) void loadSetupChoices();

    const progressElement = byId('assistant-progress');
    if (progressElement) {
        progressElement.textContent = '';
        for (const step of (state.progress || []).slice(-12)) {
            const line = document.createElement('div');
            line.className = 'assistant-step';
            line.textContent = step.text;
            progressElement.appendChild(line);
        }
    }

    renderConfirmation(state.lastFinishedTask);

    internalChat.renderControls(state, byId);
}

/**
 * The report of the task that just ended, and the person's answer to it.
 *
 * @param {object|null} finished - state.lastFinishedTask.
 */
function renderConfirmation(finished) {
    const box = byId('assistant-confirm');
    if (!box) return;

    if (!finished || finished.confirmed !== null) {
        setShown(box, false);
        return;
    }

    setShown(box, true);
    const text = byId('assistant-confirm-text');
    if (text) {
        const report = finished.report || {};
        text.textContent = [
            report.summary || '(the agent left no summary)',
            report.issues ? `Not happy with: ${report.issues}` : '',
            report.suggestions ? `You may want to tune: ${report.suggestions}` : ''
        ].filter(Boolean).join('\n');
    }
}

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<object|null>} { commands, instructionsForAnAgent } from Helper, or null
 *     when Helper does not answer.
 */
async function fetchSetup() {
    const answer = await callHelper('/mcp-setup');
    return answer && answer.commands ? answer : null;
}

/**
 * Put text on the clipboard.
 *
 * Older UXP versions reject a plain string in writeText() — "invalid DataTransferProviders
 * parameter" — and want the object form; UXP 8.0.1 and newer take the string. write() with
 * the object form is not deprecated and exists since UXP 6.0, so it goes first.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
async function copyText(text) {
    try {
        await navigator.clipboard.write({ 'text/plain': text });
    } catch (error) {
        await navigator.clipboard.writeText(text);
    }
}

/**
 * Show the text of one entry of the card's list.
 *
 * @param {number} index - Position in `setupChoices`.
 */
function showSetupChoice(index) {
    const choice = setupChoices[index];
    if (!choice) return;

    setupChoiceIndex = index;

    const hint = byId('assistant-setup-hint');
    const text = byId('assistant-setup-text');
    if (hint) hint.textContent = choice.hint;
    if (text) text.textContent = choice.text;
    setShown(byId('assistant-setup-output'), true);
}

/**
 * Fill the card's list with the ways to connect an outside agent, once. The first one — a
 * text to paste to an agent so it does the setup itself — is the easy way and is preselected;
 * the terminal commands, one per CLI, come after it.
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
                label: 'Any agent: ask it to set itself up',
                hint: 'Paste this to your agent, then restart it:',
                text: setup.instructionsForAnAgent
            });
        }
        for (const entry of setup.commands) {
            choices.push({
                label: `${entry.label}: terminal command`,
                hint: 'Run this in a terminal, then restart the agent:',
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

/**
 * @param {string} text - Something to tell the person in the panel.
 */
function showNote(text) {
    panelNotes.push(text);
    if (panelNotes.length > 5) panelNotes.shift();

    // Force the conversation to be drawn again so the note lands below it and survives
    // the next poll.
    internalChat.invalidateRender();
    void refresh();
}

/**
 * Empty the panel's own notes without forcing an immediate refresh — used right before an
 * action whose own answer will trigger one.
 */
function clearNotes() {
    panelNotes = [];
}

/**
 * Read everything the panel shows.
 *
 * @returns {Promise<void>}
 */
async function refresh() {
    const state = await callHelper('/state');
    renderState(state);
    if (!state) return;

    const chats = await callHelper('/chats');
    if (chats && chats.chats) {
        internalChat.pickDefaultChat(chats.chats);
        internalChat.renderChatList(chats.chats, byId);
    }

    const chatId = internalChat.getCurrentChatId();
    if (chatId) {
        const answer = await callHelper(`/chats/${chatId}`);
        if (answer && answer.chat) internalChat.renderChat(answer.chat, panelNotes, byId);
    }
}

/**
 * Attach the buttons once.
 */
function wireControls() {
    const closeButton = byId('assistant-dialog-close');
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            const dialog = byId('assistant-dialog');
            if (dialog) dialog.close();
        });
    }

    const confirmYes = byId('assistant-confirm-yes');
    if (confirmYes) {
        confirmYes.addEventListener('click', async () => {
            const answer = await callHelper('/confirm', { method: 'POST', body: { confirmed: true } });
            if (answer && answer.message) showNote(answer.message);
            await refresh();
        });
    }

    const confirmNo = byId('assistant-confirm-no');
    if (confirmNo) {
        confirmNo.addEventListener('click', async () => {
            const answer = await callHelper('/confirm', { method: 'POST', body: { confirmed: false } });
            if (answer && answer.message) showNote(answer.message);
            await refresh();
        });
    }

    // Without one there is no conversation: the card has a list of agents and the text for
    // the one picked.
    const setupChoice = byId('assistant-setup-choice');
    if (setupChoice) {
        setupChoice.addEventListener('change', (event) => {
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
            setTimeout(() => { setupCopy.textContent = 'Copy'; }, 1500);
        });
    }

    internalChat.wireControls({ byId, callHelper, showNote, clearNotes, refresh });
}

// ── Panel lifetime ───────────────────────────────────────────────────────────

let wired = false;

/**
 * The panel came on screen.
 */
function onShow() {
    panelVisible = true;

    if (!wired) {
        wireControls();
        wired = true;
    }

    helperReachable = null;
    renderHelperBadge();
    renderAvailability('unknown');
    void connectChannel();

    if (!pollTimer) {
        pollTimer = setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    }
    void refresh();
}

/**
 * The dialog was closed. The socket goes with it and nothing tries to reconnect.
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
            ? 'Assistant panel closed'
            : 'FromPS / ToPS plugin panel closed';
        bridgeClient.disconnect({ reason, reasonCode, intentional: true });
    }
}

/**
 * The panel is being destroyed.
 */
function onDestroy(reasonCode = 'plugin-runtime-destroyed') {
    onHide(reasonCode);
}

module.exports = {
    onShow,
    onHide,
    onDestroy,
    // Exported for testing and for the DevTools console; the panel drives these itself.
    connectChannel,
    refresh
};
