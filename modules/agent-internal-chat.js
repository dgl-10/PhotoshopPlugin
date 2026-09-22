/**
 * The chat with the agent Helper launches itself for the person — the "internal agent"
 * path, kept apart from an outside agent the person connects over MCP from their own
 * terminal (the "external agent" path). This module owns rendering and wiring for the
 * dialog's `assistant-agent-only` elements (the chat list, the message log, the input
 * box and its buttons); modules/agent-panel.js owns everything shared between the two
 * paths — the badge, the task line, progress, confirmation — and calls into this module
 * for the rest.
 *
 * STATUS: parked. Work right now goes into the external-agent path, so this module has
 * not been exercised against a real build recently — treat it as unapproved until the
 * internal path is picked back up.
 */

let currentChatId = null;
let lastRenderedMessageCount = -1;

/**
 * @returns {string|null}
 */
function getCurrentChatId() {
    return currentChatId;
}

/**
 * Drop the selected chat so the next render starts a fresh conversation.
 */
function forgetChat() {
    currentChatId = null;
    lastRenderedMessageCount = -1;
}

/**
 * Force the next renderChat() to redraw even if the message count did not change — used
 * when something other than a new message needs to appear (a panel note).
 */
function invalidateRender() {
    lastRenderedMessageCount = -1;
}

/**
 * Pick up the most recent chat when nothing is selected yet. Called once per /chats
 * answer, before the list is drawn.
 *
 * @param {object[]} chats - Answer from /api/agent/chats.
 */
function pickDefaultChat(chats) {
    if (!currentChatId && chats.length > 0) {
        currentChatId = chats[0].id;
        lastRenderedMessageCount = -1;
    }
}

/**
 * @param {object[]} chats - Answer from /api/agent/chats.
 * @param {(id: string) => HTMLElement|null} byId
 */
function renderChatList(chats, byId) {
    const menu = document.querySelector('#assistant-chat-list sp-menu');
    if (!menu) return;

    menu.textContent = '';
    for (const chat of chats) {
        const item = document.createElement('sp-menu-item');
        item.setAttribute('value', chat.id);
        item.textContent = chat.title;
        if (chat.id === currentChatId) item.setAttribute('selected', '');
        menu.appendChild(item);
    }
}

/**
 * @param {object} chat - Answer from /api/agent/chats/:id.
 * @param {string[]} panelNotes - Things the panel itself has to say, drawn after the chat.
 * @param {(id: string) => HTMLElement|null} byId
 */
function renderChat(chat, panelNotes, byId) {
    const list = byId('assistant-messages');
    if (!list || !chat) return;

    // Redrawing every poll would fight with the person scrolling.
    if (chat.messages.length === lastRenderedMessageCount) return;
    lastRenderedMessageCount = chat.messages.length;

    list.textContent = '';
    for (const message of chat.messages) {
        const item = document.createElement('div');
        item.className = `assistant-message assistant-message-${message.role}`;
        item.textContent = message.text;
        list.appendChild(item);
    }

    for (const note of panelNotes) {
        const item = document.createElement('div');
        item.className = 'assistant-message assistant-message-system';
        item.textContent = note;
        list.appendChild(item);
    }

    list.scrollTop = list.scrollHeight;
}

/**
 * The Stop button only makes sense while something is running.
 *
 * @param {object} state - Answer from /api/agent/state.
 * @param {(id: string) => HTMLElement|null} byId
 */
function renderControls(state, byId) {
    const stopButton = byId('assistant-stop');
    if (stopButton) stopButton.disabled = !state.agentRunning && !state.task;
}

/**
 * Make sure there is a chat to write into.
 *
 * @param {Function} callHelper
 * @returns {Promise<string|null>} The chat id.
 */
async function ensureChat(callHelper) {
    if (currentChatId) return currentChatId;

    const answer = await callHelper('/chats', { method: 'POST', body: {} });
    if (!answer || !answer.chat) return null;

    currentChatId = answer.chat.id;
    lastRenderedMessageCount = -1;
    return currentChatId;
}

/**
 * Attach the buttons that belong to the built-in chat: new chat, the chat picker, send,
 * stop, roll back, and "Connect agent" (an outside agent's setup text, offered from
 * inside an already-working internal chat).
 *
 * @param {object} deps
 * @param {(id: string) => HTMLElement|null} deps.byId
 * @param {Function} deps.callHelper
 * @param {(text: string) => void} deps.showNote - Also triggers a refresh, as before.
 * @param {() => void} deps.clearNotes
 * @param {() => Promise<void>} deps.refresh
 */
function wireControls({ byId, callHelper, showNote, clearNotes, refresh }) {
    async function doSend() {
        const input = byId('assistant-input');
        if (!input) return;

        const text = String(input.value || '').trim();
        if (!text) return;

        const chatId = await ensureChat(callHelper);
        if (!chatId) {
            showNote('PhotoshopHelper is not answering. Start it and try again.');
            return;
        }

        input.value = '';
        clearNotes();
        const answer = await callHelper(`/chats/${chatId}/messages`, { method: 'POST', body: { text } });

        if (!answer) {
            showNote('PhotoshopHelper is not answering.');
            return;
        }
        if (answer.error) {
            showNote(answer.error);
        }

        await refresh();
    }

    const send = byId('assistant-send');
    if (send) send.addEventListener('click', () => { void doSend(); });

    const stop = byId('assistant-stop');
    if (stop) {
        stop.addEventListener('click', async () => {
            const answer = await callHelper('/stop', { method: 'POST', body: {} });
            if (answer && answer.message) showNote(answer.message);
            await refresh();
        });
    }

    const rollback = byId('assistant-rollback');
    if (rollback) {
        rollback.addEventListener('click', async () => {
            const answer = await callHelper('/rollback', { method: 'POST', body: {} });
            showNote(answer && answer.message ? answer.message : 'Could not roll back.');
        });
    }

    const newChat = byId('assistant-new-chat');
    if (newChat) {
        newChat.addEventListener('click', async () => {
            forgetChat();
            clearNotes();
            await ensureChat(callHelper);
            await refresh();
        });
    }

    const chatList = byId('assistant-chat-list');
    if (chatList) {
        chatList.addEventListener('change', async (event) => {
            const value = event.target.value;
            if (value && value !== currentChatId) {
                currentChatId = value;
                lastRenderedMessageCount = -1;
                clearNotes();
                await refresh();
            }
        });
    }

    const setup = byId('assistant-setup');
    if (setup) {
        setup.addEventListener('click', async () => {
            const answer = await callHelper('/mcp-setup');
            if (!answer || !answer.commands) {
                showNote('PhotoshopHelper is not answering.');
                return;
            }
            showNote(
                'Paste this to your agent, and it registers the MCP server for you:\n\n'
                + answer.instructionsForAnAgent
                + '\n\nOr run a command yourself, then restart your agent:\n\n'
                + answer.commands.map(entry => `${entry.label}:\n${entry.copyCommand || entry.command}`).join('\n\n')
            );
        });
    }
}

module.exports = {
    getCurrentChatId,
    forgetChat,
    invalidateRender,
    pickDefaultChat,
    renderChatList,
    renderChat,
    renderControls,
    ensureChat,
    wireControls
};
