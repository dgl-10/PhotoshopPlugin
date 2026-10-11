/**
 * The working document of an agent task.
 *
 * A task is bound to the document it started on. The work takes minutes and the person
 * carries on with their own in the meantime, so switching documents must not move the
 * agent's work with them.
 *
 * Everything in the plugin that needs "which document am I working on" goes through
 * `resolveWorkingDocument` and nothing else, so that later this can be changed in one
 * place — for instance when a task is allowed to span several documents.
 */

const { app, core } = require('photoshop');

// Photoshop hands out one modal scope at a time and gives up after a second by default.
// The person is working in the same document, so it is worth queuing for longer.
const MODAL_TIMEOUT_MS = 10_000;

// One entry per task. Only one task runs at a time, but keying by id keeps a stale
// answer from a finished task out of a new one.
const taskContexts = new Map();

// Prefix that lets Helper recognise "the document went away" in an error that crossed the
// channel as plain text, and close the task rather than wait for it to time out.
const DOCUMENT_CLOSED_MARKER = '[document-closed]';

/**
 * The version of Photoshop we are running inside.
 *
 * @returns {string} For example "26.0.0", or "unknown" when the host will not say.
 */
function readHostVersion() {
    try {
        return require('uxp').host.version || 'unknown';
    } catch (error) {
        console.warn('[agent-document] Could not read the Photoshop version:', error.message);
        return 'unknown';
    }
}

/**
 * @param {number} id - Document id.
 * @returns {object|null} The open document with that id.
 */
function findDocumentById(id) {
    for (const doc of app.documents) {
        if (doc.id === id) return doc;
    }
    return null;
}

/**
 * Read the current history step without throwing on an older Photoshop.
 *
 * @param {object} doc - Document.
 * @returns {{id: number|null, name: string, count: number}}
 */
function readHistoryPosition(doc) {
    try {
        const state = doc.activeHistoryState;
        return {
            id: state ? state.id : null,
            name: state ? state.name : '',
            count: doc.historyStates ? doc.historyStates.length : 0
        };
    } catch (error) {
        console.warn('[agent-document] Could not read the history position:', error.message);
        return { id: null, name: '', count: 0 };
    }
}

/**
 * Compare the history now against where we left it, and say in words what the person did.
 *
 * Reading the current step on every call is the way that is known to work. Subscribing to
 * Photoshop's own events would be tidier and is worth trying later; it is not worth
 * risking the whole state line on.
 *
 * @param {object} context - Task context.
 * @param {object} doc - Working document.
 * @returns {string[]} Sentences for the state line.
 */
function describeChangesSinceLastCall(context, doc) {
    const position = readHistoryPosition(doc);
    const previous = context.lastSeenHistory;
    const notes = [];

    if (!previous) {
        context.lastSeenHistory = position;
        return notes;
    }

    if (position.id !== previous.id || position.count !== previous.count) {
        const added = position.count - previous.count;

        if (added > 0 && position.id !== context.lastOwnHistoryId) {
            notes.push(
                `the person did ${added === 1 ? 'something' : `${added} things`} by hand `
                + `(the history is now at "${position.name}")`
            );
        } else if (added < 0) {
            notes.push(
                `the history got shorter and now stands at "${position.name}" — the person `
                + 'stepped back or selected an earlier state. Do not repeat your work blindly: work '
                + 'out what happened or ask.'
            );
        } else if (position.id !== previous.id && position.id !== context.lastOwnHistoryId) {
            notes.push(
                `the history moved to "${position.name}" without new steps — that is an undo. `
                + 'Do not repeat your work blindly: work out what happened or ask.'
            );
        }
    }

    context.lastSeenHistory = position;
    return notes;
}

/**
 * Bind a task to the document that is active right now.
 *
 * Nothing is written to the document here. A task that only looks — describing a picture,
 * reading a layer — or one that turned out to be a plain question leaves the History panel
 * exactly as it found it. Later mutations are grouped into named history steps by the
 * script command itself.
 *
 * @param {object} params
 * @param {string} params.taskId - Task id issued by Helper.
 * @returns {Promise<object>} Document facts and the state line.
 */
async function startTask({ taskId }) {
    const doc = app.activeDocument;
    if (!doc) {
        return { document: null };
    }

    const context = {
        taskId,
        documentId: doc.id,
        documentName: doc.name,
        lastOwnHistoryId: null,
        lastSeenHistory: readHistoryPosition(doc),
        activeDocumentChangedLastCall: false
    };
    context.lastOwnHistoryId = context.lastSeenHistory.id;
    taskContexts.set(taskId, context);

    return {
        document: describeDocumentBriefly(doc),
        // Stamped onto every article the task writes. A recipe that works in one version
        // of Photoshop can be wrong in the next, so this is the one piece of an article's
        // header that must not be left to the agent to type from memory.
        photoshopVersion: readHostVersion(),
        status: buildStatus(taskId, { skipChangeCheck: true })
    };
}

/**
 * Find the document a suspended task used after the UXP JavaScript runtime restarted.
 * Document ids are preferred because they are unambiguous while Photoshop remains open.
 * A saved path is the next-best identity. A name is used only when exactly one open
 * document has that name, so a recovery never silently binds work to the wrong file.
 *
 * @param {object} params - { documentId, documentPath, documentName }.
 * @returns {object|null} The unambiguous open document, or null.
 */
function findDocumentForResume(params) {
    const byId = findDocumentById(params.documentId);
    if (byId) return byId;

    const documents = Array.from(app.documents);
    if (params.documentPath) {
        const byPath = documents.filter(doc => {
            try {
                return doc.path === params.documentPath;
            } catch {
                return false;
            }
        });
        if (byPath.length === 1) return byPath[0];
    }

    if (params.documentName) {
        const byName = documents.filter(doc => doc.name === params.documentName);
        if (byName.length === 1) return byName[0];
    }
    return null;
}

/**
 * Rebuild the plugin-side context for a task after the whole UXP runtime was unloaded.
 * Helper supplies the original document identity. Once it is matched unambiguously, the
 * current history position becomes the comparison baseline and the agent is told to
 * inspect the document before it repeats any interrupted operation.
 *
 * @param {object} params - Persisted task metadata from Helper.
 * @returns {Promise<object>} Rebound document facts and recovery status.
 */
async function resumeTask(params) {
    const existing = taskContexts.get(params.taskId);
    if (existing) {
        const existingDocument = findDocumentById(existing.documentId);
        if (!existingDocument) {
            return {
                document: null,
                error: `The task document "${existing.documentName}" is no longer open.`
            };
        }
        return {
            document: describeDocumentBriefly(existingDocument),
            status: buildStatus(params.taskId, { skipChangeCheck: true })
        };
    }

    const doc = findDocumentForResume(params);
    if (!doc) {
        return {
            document: null,
            error: `The task document "${params.documentName || 'unknown'}" is not open, or its name is ambiguous.`
        };
    }

    const position = readHistoryPosition(doc);
    taskContexts.set(params.taskId, {
        taskId: params.taskId,
        documentId: doc.id,
        documentName: doc.name,
        lastOwnHistoryId: position.id,
        lastSeenHistory: position,
        activeDocumentChangedLastCall: false
    });

    return {
        document: describeDocumentBriefly(doc),
        status: buildStatus(params.taskId, { skipChangeCheck: true })
    };
}

/**
 * Forget a task's context.
 *
 * @param {string} taskId - Task id.
 */
function finishTask(taskId) {
    taskContexts.delete(taskId);
}

/**
 * The single place that answers "which document is this task working on".
 *
 * @param {string} taskId - Task id.
 * @returns {{context: object, doc: object}}
 * @throws {Error} When the task is unknown here, or its document has been closed.
 */
function resolveWorkingDocument(taskId) {
    const context = taskContexts.get(taskId);
    if (!context) {
        throw new Error(
            'This task is not bound to a document in Photoshop. Call ps_start_task again.'
        );
    }

    const doc = findDocumentById(context.documentId);
    if (!doc) {
        // The marker is how Helper recognises this on the other side of the channel, where
        // only the message survives, and closes the task instead of leaving it hanging.
        throw new Error(
            `${DOCUMENT_CLOSED_MARKER} The document "${context.documentName}" is closed, so the `
            + 'task cannot continue. Tell the person, and start a new task when they have a '
            + 'document open.'
        );
    }

    return { context, doc };
}

/**
 * Run something against the task's document, making it the active one for the duration.
 *
 * Many Photoshop actions only work on the active document, so the plugin switches to it
 * and switches back. The answer always says which document was worked on.
 *
 * @param {string} taskId - Task id.
 * @param {(doc: object, context: object) => Promise<*>} body - What to run.
 * @returns {Promise<*>} Whatever body returned.
 */
async function withWorkingDocument(taskId, body) {
    const { context, doc } = resolveWorkingDocument(taskId);

    let previous = null;
    try {
        previous = app.activeDocument;
    } catch {
        previous = null;
    }

    const needsSwitch = !previous || previous.id !== doc.id;
    context.activeDocumentChangedLastCall = needsSwitch;

    if (needsSwitch) {
        await setActiveDocument(doc);
    }

    try {
        return await body(doc, context);
    } finally {
        if (needsSwitch && previous) {
            try {
                // The person was looking at another document; put them back.
                if (findDocumentById(previous.id)) await setActiveDocument(previous);
            } catch (error) {
                console.warn('[agent-document] Could not restore the active document:', error.message);
            }
        }
    }
}

/**
 * Make a document the active one.
 *
 * Plain assignment is the documented way and works in most versions. Some versions refuse
 * it outside a modal scope, so the fallback opens a short one — which is cheap, and much
 * better than a call failing because the person happened to be looking elsewhere.
 *
 * @param {object} doc - Document to bring to the front.
 * @returns {Promise<void>}
 */
async function setActiveDocument(doc) {
    try {
        app.activeDocument = doc;
        return;
    } catch (error) {
        console.warn('[agent-document] Switching documents needs a modal scope:', error.message);
    }

    await core.executeAsModal(async () => {
        app.activeDocument = doc;
    }, { commandName: 'Agent: switch document', timeOut: MODAL_TIMEOUT_MS });
}

/**
 * Short facts about a document, the ones worth repeating in every answer.
 *
 * @param {object} doc - Document.
 * @returns {object}
 */
function describeDocumentBriefly(doc) {
    return {
        id: doc.id,
        name: doc.name,
        width: doc.width,
        height: doc.height,
        resolution: doc.resolution,
        colorMode: doc.mode ? String(doc.mode) : 'unknown',
        bitsPerChannel: doc.bitsPerChannel,
        layerCount: doc.layers ? doc.layers.length : 0,
        saved: doc.saved,
        path: doc.path || null
    };
}

/**
 * Build the state line that closes every answer.
 *
 * @param {string} taskId - Task id.
 * @param {object} [options]
 * @param {boolean} [options.skipChangeCheck] - Skip the "since your last call" part.
 * @returns {object|null} Status block, or null when the document is gone.
 */
function buildStatus(taskId, options = {}) {
    const context = taskContexts.get(taskId);
    if (!context) return null;

    const doc = findDocumentById(context.documentId);
    if (!doc) {
        return {
            documentId: context.documentId,
            documentName: context.documentName,
            documentClosed: true,
            historyStep: null,
            sinceLastCall: ['the document was closed, the task cannot continue'],
            activeDocumentChanged: false
        };
    }

    const sinceLastCall = options.skipChangeCheck ? [] : describeChangesSinceLastCall(context, doc);
    const position = context.lastSeenHistory || readHistoryPosition(doc);

    return {
        documentId: doc.id,
        documentName: doc.name,
        documentClosed: false,
        historyStep: position.name,
        sinceLastCall,
        activeDocumentChanged: Boolean(context.activeDocumentChangedLastCall)
    };
}

/**
 * Remember the history step we just created, so the next call does not read our own work
 * as something the person did by hand.
 *
 * @param {string} taskId - Task id.
 */
function noteOwnHistoryStep(taskId) {
    const context = taskContexts.get(taskId);
    if (!context) return;

    const doc = findDocumentById(context.documentId);
    if (!doc) return;

    const position = readHistoryPosition(doc);
    context.lastSeenHistory = position;
    context.lastOwnHistoryId = position.id;
}

module.exports = {
    DOCUMENT_CLOSED_MARKER,
    startTask,
    resumeTask,
    finishTask,
    resolveWorkingDocument,
    withWorkingDocument,
    buildStatus,
    noteOwnHistoryStep,
    describeDocumentBriefly,
    // Exported for testing only; the rest of the plugin goes through the functions above.
    _taskContexts: taskContexts
};
