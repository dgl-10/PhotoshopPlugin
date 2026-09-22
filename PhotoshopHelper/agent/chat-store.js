'use strict';

/**
 * Chats with the agent, and the CLI session behind each one.
 *
 * A chat is one conversation with its own number. Helper remembers which CLI it was
 * started with and what session that CLI gave it, so every message the person sends is a
 * continuation of the same session rather than a fresh agent that knows nothing. The
 * plugin keeps none of this: the panel asks Helper.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { writeFileAtomic } = require('../atomic-write');

// Enough to come back to what was being worked on yesterday, not enough to become an
// archive nobody asked for.
const MAX_CHATS = 20;

// A long conversation is trimmed from the front. The CLI keeps its own session, so this
// only limits what the panel shows.
const MAX_MESSAGES_PER_CHAT = 200;

/**
 * Create the chat store.
 *
 * @param {object} options
 * @param {string} options.filePath - Where the chats are kept.
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {object} The store.
 */
function createChatStore({ filePath, logger = console }) {
    /** @type {object[]} */
    let chats = [];
    let loaded = false;

    /**
     * Read the chats from disk once.
     */
    function load() {
        if (loaded) return;
        loaded = true;

        try {
            if (!fs.existsSync(filePath)) return;
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (Array.isArray(parsed && parsed.chats)) chats = parsed.chats;
        } catch (error) {
            logger.warn(`[agent-chats] Could not read ${filePath}: ${error.message}`);
        }
    }

    /**
     * Write the chats back.
     */
    function save() {
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            writeFileAtomic(filePath, JSON.stringify({ chats }, null, 2));
        } catch (error) {
            logger.warn(`[agent-chats] Could not write ${filePath}: ${error.message}`);
        }
    }

    /**
     * @param {object} params - { cli, model, title }.
     * @returns {object} The new chat.
     */
    function createChat({ cli, model, title } = {}) {
        load();

        const chat = {
            id: `chat-${crypto.randomBytes(4).toString('hex')}`,
            title: title || 'New chat',
            cli: cli || null,
            model: model || null,
            sessionId: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: []
        };

        chats.unshift(chat);
        if (chats.length > MAX_CHATS) chats.length = MAX_CHATS;
        save();
        return chat;
    }

    /**
     * @param {string} id - Chat id.
     * @returns {object|null}
     */
    function getChat(id) {
        load();
        return chats.find(chat => chat.id === id) || null;
    }

    /**
     * @returns {object[]} Chats without their messages, newest first.
     */
    function listChats() {
        load();
        return chats.map(chat => ({
            id: chat.id,
            title: chat.title,
            cli: chat.cli,
            model: chat.model,
            hasSession: Boolean(chat.sessionId),
            messageCount: chat.messages.length,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt
        }));
    }

    /**
     * @param {string} id - Chat id.
     * @param {object} message - { role: 'user'|'agent'|'system', text }.
     * @returns {object|null} The stored message.
     */
    function addMessage(id, message) {
        const chat = getChat(id);
        if (!chat) return null;

        const entry = { role: message.role, text: message.text, at: Date.now() };
        chat.messages.push(entry);
        if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
            chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
        }

        // The first thing the person says names the chat, so the list is readable.
        if (chat.title === 'New chat' && message.role === 'user') {
            chat.title = message.text.slice(0, 60);
        }

        chat.updatedAt = entry.at;
        save();
        return entry;
    }

    /**
     * Remember the session the CLI reported, so the next message continues it.
     *
     * @param {string} id - Chat id.
     * @param {object} session - { sessionId, cli, model }.
     */
    function setSession(id, session) {
        const chat = getChat(id);
        if (!chat) return;

        if (session.sessionId) chat.sessionId = session.sessionId;
        if (session.cli) chat.cli = session.cli;
        if (session.model) chat.model = session.model;
        chat.updatedAt = Date.now();
        save();
    }

    /**
     * @param {string} id - Chat id.
     * @returns {boolean} True when it existed.
     */
    function deleteChat(id) {
        load();
        const before = chats.length;
        chats = chats.filter(chat => chat.id !== id);
        if (chats.length !== before) {
            save();
            return true;
        }
        return false;
    }

    return { createChat, getChat, listChats, addMessage, setSession, deleteChat, MAX_CHATS };
}

module.exports = { createChatStore, MAX_CHATS };
