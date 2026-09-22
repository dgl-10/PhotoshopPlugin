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

const { app, action, core } = require('photoshop');

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
 * Descriptor recorded from the Actions panel ("Copy As JavaScript") for New Snapshot.
 * Photoshop's scripting documentation does not cover snapshot creation, and the DOM has
 * no call for it, so this is the one place in the agent code that depends on a recorded
 * descriptor. Everything still works without it: the rollback point is the history state
 * captured through the documented DOM property, and the snapshot is what makes that point
 * survive Photoshop trimming the history and visible in the History panel.
 *
 * @param {string} name - Snapshot name shown in the History panel.
 * @returns {object} A batchPlay descriptor.
 */
function makeSnapshotDescriptor(name) {
    return {
        _obj: 'make',
        _target: [{ _ref: 'snapshotClass' }],
        from: { _ref: 'historyState', _property: 'currentHistoryState' },
        name,
        using: { _enum: 'historyState', _value: 'fullDocument' }
    };
}

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
                + 'stepped back or went to a snapshot. Do not repeat your work blindly: work '
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
 * reading a layer — or one that turned out to be a plain question must leave the History
 * panel exactly as it found it. A Photoshop snapshot stays until the document is closed
 * and has to be deleted by hand, so putting one there for a question is litter in the
 * person's own work.
 *
 * @param {object} params
 * @param {string} params.taskId - Task id issued by Helper.
 * @param {string} params.intent - What the agent is about to do, used for the snapshot name.
 * @returns {Promise<object>} Document facts and the state line.
 */
async function startTask({ taskId, intent }) {
    const doc = app.activeDocument;
    if (!doc) {
        return { document: null };
    }

    const context = {
        taskId,
        documentId: doc.id,
        documentName: doc.name,
        // Named now, created on the first change. See ensureRollbackPoint.
        // The task id keeps recovery unambiguous when several tasks have the same intent.
        plannedSnapshotName: `Before task ${taskId}: ${String(intent || '').slice(0, 40)}`,
        snapshotName: null,
        snapshotHistoryId: null,
        startHistoryId: null,
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
        snapshot: { created: false, deferred: true, name: context.plannedSnapshotName },
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
 * The named History snapshot is the durable rollback point: unlike this module's maps,
 * it lives in the Photoshop document. If no change happened before the disconnect there
 * is no snapshot to recover and rebinding at the current History state is safe.
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
            recoveredSnapshot: Boolean(existing.snapshotHistoryId),
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

    let snapshotHistoryId = null;
    if (params.snapshotName) {
        try {
            for (const state of doc.historyStates) {
                if (state.snapshot && state.name === params.snapshotName) {
                    snapshotHistoryId = state.id;
                    break;
                }
            }
        } catch (error) {
            console.warn('[agent-document] Could not inspect History snapshots while resuming:', error.message);
        }
    }

    if (params.snapshotCreated && snapshotHistoryId === null) {
        return {
            document: describeDocumentBriefly(doc),
            error: `The rollback snapshot "${params.snapshotName}" is no longer in the History panel. `
                + 'The task was not rebound automatically because its safe starting point cannot be verified.'
        };
    }

    const position = readHistoryPosition(doc);
    taskContexts.set(params.taskId, {
        taskId: params.taskId,
        documentId: doc.id,
        documentName: doc.name,
        plannedSnapshotName: params.snapshotName
            || `Before task ${params.taskId}: ${String(params.intent || '').slice(0, 40)}`,
        snapshotName: snapshotHistoryId === null ? null : params.snapshotName,
        snapshotHistoryId,
        // When no mutation was confirmed before the disconnect, the current state is the
        // correct deferred rollback point. A recovered snapshot takes precedence later.
        startHistoryId: snapshotHistoryId === null ? null : position.id,
        lastOwnHistoryId: position.id,
        lastSeenHistory: position,
        activeDocumentChangedLastCall: false
    });

    return {
        document: describeDocumentBriefly(doc),
        recoveredSnapshot: snapshotHistoryId !== null,
        status: buildStatus(params.taskId, { skipChangeCheck: true })
    };
}

/**
 * Put the rollback point in place, once, just before the task's first change.
 *
 * Doing it here rather than at the start of the task is also more correct than it looks:
 * anything the person did by hand between starting the task and this first change is
 * inside the snapshot, so rolling back removes the agent's work and keeps theirs.
 *
 * @param {string} taskId - Task id.
 * @param {object} doc - The task's working document.
 * @returns {Promise<object|null>} The snapshot that was just created, or null if there
 *   already was one or Photoshop refused.
 */
async function ensureRollbackPoint(taskId, doc) {
    const context = taskContexts.get(taskId);
    if (!context || context.startHistoryId !== null) return null;

    const name = context.plannedSnapshotName;
    let created = false;

    await core.executeAsModal(async () => {
        const before = readHistoryPosition(doc);
        context.startHistoryId = before.id;

        try {
            await action.batchPlay([makeSnapshotDescriptor(name)], {});
            created = true;
        } catch (error) {
            // Not fatal: the rollback point is the history state read above.
            console.warn('[agent-document] Could not create a History snapshot:', error.message);
        }

        if (created) {
            try {
                for (const state of doc.historyStates) {
                    if (state.snapshot && state.name === name) {
                        context.snapshotHistoryId = state.id;
                    }
                }
            } catch (error) {
                console.warn('[agent-document] Could not find the new snapshot:', error.message);
            }
            context.snapshotName = name;
        }

        context.lastSeenHistory = readHistoryPosition(doc);
        context.lastOwnHistoryId = context.lastSeenHistory.id;
    }, { commandName: 'Agent: before the task', timeOut: MODAL_TIMEOUT_MS });

    return { created, name, historyStateId: context.snapshotHistoryId };
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

/**
 * Go back to the point the task started from.
 *
 * Uses the snapshot when there is one, because a snapshot survives Photoshop dropping old
 * history steps; otherwise the history state read at the start.
 *
 * @param {string} taskId - Task id.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function rollbackToStart(taskId) {
    const context = taskContexts.get(taskId);
    if (!context) {
        return { ok: false, message: 'There is nothing to roll back: this task is not known here.' };
    }

    const doc = findDocumentById(context.documentId);
    if (!doc) {
        return { ok: false, message: `The document "${context.documentName}" is closed.` };
    }

    const targetId = context.snapshotHistoryId !== null ? context.snapshotHistoryId : context.startHistoryId;
    if (targetId === null) {
        // Nothing was ever changed, so no rollback point was laid down and none is needed.
        return { ok: false, message: 'This task has not changed anything, so there is nothing to roll back.' };
    }

    let done = false;
    await core.executeAsModal(async () => {
        for (const state of doc.historyStates) {
            if (state.id === targetId) {
                doc.activeHistoryState = state;
                done = true;
                break;
            }
        }
    }, { commandName: 'Agent: back to the start of the task', timeOut: MODAL_TIMEOUT_MS });

    if (done) noteOwnHistoryStep(taskId);

    return done
        ? { ok: true, message: `"${context.documentName}" is back where the task started.` }
        : {
            ok: false,
            message: 'The starting point is no longer in the History panel. Photoshop keeps a '
                + 'limited number of steps; go back by hand.'
        };
}

module.exports = {
    DOCUMENT_CLOSED_MARKER,
    startTask,
    resumeTask,
    ensureRollbackPoint,
    finishTask,
    resolveWorkingDocument,
    withWorkingDocument,
    buildStatus,
    noteOwnHistoryStep,
    rollbackToStart,
    describeDocumentBriefly,
    // Exported for testing only; the rest of the plugin goes through the functions above.
    _taskContexts: taskContexts
};
