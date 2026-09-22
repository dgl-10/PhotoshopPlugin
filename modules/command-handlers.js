/**
 * What the plugin does when the agent calls a tool.
 *
 * Helper receives the MCP call, sends one command over the channel, and one of these
 * handlers runs it in Photoshop. Every handler works on the task's own document through
 * agent-document.js and ends its answer with the same state block, so the agent always
 * sees which document it touched and what the person did in the meantime.
 */

const photoshop = require('photoshop');
const { app, action, core, imaging, constants } = photoshop;
const agentDocument = require('./agent-document.js');
const agentCapture = require('./agent-capture.js');
const batchPlayWatch = require('./batchplay-watch.js');
const { describeError } = require('./error-text.js');

// Photoshop lets only one plugin hold a modal scope at a time, and by default a request
// gives up after one second. The person is working in the same document, so a second or
// two of waiting is normal; ten seconds of queuing turns a spurious failure into a pause.
const MODAL_TIMEOUT_MS = 10_000;

// The channel's own ceiling is 100 MiB per message: above it the message is dropped and
// the connection closes. Refusing well short of that keeps a greedy capture from taking
// the channel down, while still leaving room to find out what agents actually accept.
const MAX_IMAGE_BASE64_BYTES = 60 * 1024 * 1024;

/**
 * Run something in a modal scope, with a message the agent can act on when Photoshop
 * refuses to give us one.
 *
 * @param {Function} body - Target function for executeAsModal.
 * @param {string} commandName - Name shown in Photoshop's progress bar.
 * @param {object} [options]
 * @param {boolean} [options.interactive] - Run in executeAsModal's interactive mode
 *   (Photoshop 23.3+): no blocking progress dialog, and the person may work in a dialog the
 *   body opens (a filter dialog, Select and Mask). They cancel through Plugins → Cancel
 *   Plugin Command. The option is passed only when set, so the ordinary call is unchanged.
 * @returns {Promise<*>} Whatever body returned.
 */
async function inModalScope(body, commandName, { interactive = false } = {}) {
    const modalOptions = { commandName, timeOut: MODAL_TIMEOUT_MS };
    if (interactive) modalOptions.interactive = true;
    try {
        return await core.executeAsModal(body, modalOptions);
    } catch (error) {
        // Error 9 is Photoshop saying another plugin is already modal.
        if (error && error.number === 9) {
            throw new Error(
                'Photoshop would not let the plugin work right now: another plugin is holding it, '
                + 'or a dialog is open. Tell the person, wait, and try again.'
            );
        }
        throw error;
    }
}

/**
 * Describe one layer at the depth asked for.
 *
 * @param {object} layer - Layer.
 * @param {number} depth - How many more levels of groups to open.
 * @returns {object}
 */
function describeLayer(layer, depth) {
    const described = {
        id: layer.id,
        name: layer.name,
        kind: layer.kind ? String(layer.kind) : 'unknown',
        visible: layer.visible,
        opacity: layer.opacity,
        blendMode: layer.blendMode ? String(layer.blendMode) : 'normal',
        locked: layer.locked
    };

    try {
        const bounds = layer.bounds;
        if (bounds) {
            described.bounds = {
                left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom
            };
        }
    } catch {
        // A layer kind without bounds is not a problem worth failing the read over.
    }

    if (layer.layers && layer.layers.length > 0) {
        described.childCount = layer.layers.length;
        if (depth > 0) {
            described.children = Array.from(layer.layers).map(child => describeLayer(child, depth - 1));
        }
    }

    return described;
}

/**
 * Whether there is a selection, read without disturbing it.
 *
 * @param {object} doc - Document.
 * @returns {Promise<boolean>}
 */
async function hasSelection(doc) {
    try {
        const [descriptor] = await action.batchPlay([{
            _obj: 'get',
            _target: [
                { _property: 'selection' },
                { _ref: 'document', _id: doc.id }
            ]
        }], { synchronousExecution: false });
        return Boolean(descriptor) && descriptor.selection !== undefined;
    } catch {
        return false;
    }
}

/**
 * ps_start_task: bind the task to the open document and put a snapshot in the History panel.
 *
 * @param {object} payload - { taskId, intent }.
 * @returns {Promise<object>}
 */
async function agentStartTask(payload) {
    const started = await agentDocument.startTask({
        taskId: payload.taskId,
        intent: payload.intent
    });

    if (!started.document) {
        return { document: null };
    }

    return started;
}

/**
 * Rebind a suspended task after the UXP runtime was recreated. Helper supplies only the
 * document identity and rollback metadata it received earlier; the plugin validates all
 * of it against the documents and History snapshots that are actually open now.
 *
 * @param {object} payload - Persisted task metadata from Helper.
 * @returns {Promise<object>} Recovery status and current document facts.
 */
async function agentResumeTask(payload) {
    return agentDocument.resumeTask(payload);
}

/**
 * ps_finish_task: let go of the task's document.
 *
 * @param {object} payload - { taskId }.
 * @returns {Promise<object>}
 */
async function agentFinishTask(payload) {
    const status = agentDocument.buildStatus(payload.taskId);
    agentDocument.finishTask(payload.taskId);
    return { status };
}

/**
 * ps_get_document: the working document, plus a line for every other open one.
 *
 * @param {object} payload - { taskId, includeLayers, maxDepth }.
 * @returns {Promise<object>}
 */
async function agentGetDocument(payload) {
    return agentDocument.withWorkingDocument(payload.taskId, async (doc) => {
        const described = agentDocument.describeDocumentBriefly(doc);
        described.hasSelection = await hasSelection(doc);

        try {
            described.activeLayers = Array.from(doc.activeLayers).map(layer => ({
                id: layer.id, name: layer.name
            }));
        } catch {
            described.activeLayers = [];
        }

        if (payload.includeLayers !== false) {
            const depth = Number.isFinite(payload.maxDepth) ? payload.maxDepth : 3;
            described.layers = Array.from(doc.layers).map(layer => describeLayer(layer, depth - 1));
        }

        const openDocuments = Array.from(app.documents).map(other => ({
            id: other.id,
            name: other.name,
            width: other.width,
            height: other.height,
            isWorkingDocument: other.id === doc.id
        }));

        return {
            document: described,
            openDocuments,
            status: agentDocument.buildStatus(payload.taskId)
        };
    });
}

/**
 * ps_get_layer: one layer in full.
 *
 * @param {object} payload - { taskId, layerId }.
 * @returns {Promise<object>}
 */
async function agentGetLayer(payload) {
    return agentDocument.withWorkingDocument(payload.taskId, async (doc) => {
        // The action descriptor of a layer carries what the DOM does not: text settings,
        // adjustment values, effects. It is read with a plain `get`, which changes nothing.
        let descriptor = null;
        try {
            const [result] = await action.batchPlay([{
                _obj: 'get',
                _target: [{ _ref: 'layer', _id: payload.layerId }, { _ref: 'document', _id: doc.id }]
            }], { synchronousExecution: false });
            descriptor = result;
        } catch (error) {
            throw new Error(`Could not read layer ${payload.layerId}: ${describeError(error)}`);
        }

        if (!descriptor) {
            throw new Error(`There is no layer with id ${payload.layerId} in "${doc.name}".`);
        }

        const layer = {
            id: payload.layerId,
            name: descriptor.name,
            kind: descriptor.layerKind,
            visible: descriptor.visible,
            opacity: descriptor.opacity && descriptor.opacity._value !== undefined
                ? descriptor.opacity._value
                : descriptor.opacity,
            fillOpacity: descriptor.fillOpacity,
            blendMode: descriptor.mode && descriptor.mode._value ? descriptor.mode._value : descriptor.mode,
            bounds: descriptor.bounds || null,
            hasUserMask: Boolean(descriptor.hasUserMask),
            hasVectorMask: Boolean(descriptor.hasVectorMask),
            hasFilterMask: Boolean(descriptor.hasFilterMask),
            effects: descriptor.layerEffects || null,
            text: descriptor.textKey || null,
            adjustment: descriptor.adjustment || null,
            smartObject: descriptor.smartObject || null
        };

        return { layer, status: agentDocument.buildStatus(payload.taskId) };
    });
}

/**
 * ps_get_image: look at the document.
 *
 * @param {object} payload - Capture request from the agent.
 * @returns {Promise<object>}
 */
async function agentGetImage(payload) {
    return agentDocument.withWorkingDocument(payload.taskId, async (doc) => {
        const shot = await inModalScope(
            executionContext => agentCapture.capture({
                doc,
                target: payload.target || 'document',
                layerId: payload.layerId,
                maskKind: payload.maskKind,
                channel: payload.channel,
                bounds: payload.bounds,
                maxSize: payload.maxSize,
                fullSize: payload.fullSize,
                executionContext
            }),
            'Agent: take a look'
        );

        // The channel drops a message over 100 MiB and closes the connection with it, so a
        // capture that big is refused here instead. Base64 is about a third larger than the
        // bytes it carries, which is why the ceiling is well under the channel's own.
        if (shot.base64 && shot.base64.length > MAX_IMAGE_BASE64_BYTES) {
            const megabytes = Math.round(shot.base64.length / (1024 * 1024));
            throw new Error(
                `That capture came to about ${megabytes} MB, which is more than the channel to `
                + 'Photoshop carries in one message. Ask for a smaller max_size, or for a region '
                + 'instead of the whole document.'
            );
        }

        return { ...shot, status: agentDocument.buildStatus(payload.taskId) };
    });
}

/**
 * ps_execute_script: run the agent's code as one named step of the History panel.
 *
 * The suspension is what makes a whole script — however many batchPlay calls it contains —
 * a single step the person can read and undo. It only holds inside one modal scope, so
 * separate tool calls stay separate steps; that is why the agent is asked to name each one.
 *
 * batchPlay does not throw when Photoshop rejects a command, so the script's batchPlay —
 * both the `action` in scope and require("photoshop").action — goes through a watch that
 * returns the result unchanged and notes every rejection. They travel back with the answer,
 * or at the end of the error text when the script throws.
 *
 * With `interactive` the modal scope is opened in executeAsModal's interactive mode, so a
 * command the script plays with `dialogOptions: "display"` can put its dialog in front of
 * the person and wait while they work in it. This is an experiment: the history suspension
 * is kept, although Adobe's documentation says nothing about how it behaves around a dialog
 * the person works in. The owner's test in Photoshop is what answers that.
 *
 * @param {object} payload - { taskId, code, historyName, interactive }.
 * @returns {Promise<object>}
 */
async function agentExecuteScript(payload) {
    return agentDocument.withWorkingDocument(payload.taskId, async (doc) => {
        const historyName = `Agent: ${payload.historyName}`;
        let scriptOutput = null;
        const watch = batchPlayWatch.createBatchPlayWatch({ photoshop, realRequire: require });

        // The first change of the task is what earns the snapshot. A task that only looked,
        // or turned out to be a question, leaves the History panel untouched.
        const snapshot = await agentDocument.ensureRollbackPoint(payload.taskId, doc);

        try {
            await inModalScope(async (executionContext) => {
                const suspensionId = await executionContext.hostControl.suspendHistory({
                    documentID: doc.id,
                    name: historyName
                });

                try {
                    // `require` is a parameter so that it shadows the global one inside the
                    // script: require("photoshop") then hands back the watched action too.
                    const fn = new Function(
                        'app', 'action', 'core', 'imaging', 'constants', 'doc', 'require',
                        `return (async () => {
                            let result;
                            let returnedValue = await (async () => {
                                ${payload.code}
                            })();
                            return returnedValue !== undefined ? returnedValue : result;
                        })()`
                    );
                    scriptOutput = await fn(app, watch.action, core, imaging, constants, doc, watch.require);
                } finally {
                    await executionContext.hostControl.resumeHistory(suspensionId);
                }
            }, historyName, { interactive: payload.interactive === true });
        } catch (error) {
            const snippet = String(payload.code || '').slice(0, 300);
            throw new Error(
                `The script failed: ${describeError(error)}\nFirst lines of it:\n${snippet}`
                + batchPlayWatch.formatForErrorText(watch.report())
            );
        }

        agentDocument.noteOwnHistoryStep(payload.taskId);

        const answer = {
            result: scriptOutput === undefined ? null : scriptOutput,
            snapshot,
            status: agentDocument.buildStatus(payload.taskId)
        };
        const rejected = watch.report();
        if (rejected) answer.rejectedCommands = rejected;
        return answer;
    });
}

/**
 * The panel's "back to the snapshot" button.
 *
 * @param {object} payload - { taskId }.
 * @returns {Promise<object>}
 */
async function agentRollback(payload) {
    const outcome = await agentDocument.rollbackToStart(payload.taskId);
    return { ...outcome, status: agentDocument.buildStatus(payload.taskId) };
}

/**
 * Cheap liveness check used by the panel and by Helper.
 *
 * @returns {Promise<object>}
 */
async function agentPing() {
    return {
        ok: true,
        openDocuments: Array.from(app.documents).map(doc => ({ id: doc.id, name: doc.name }))
    };
}

const HANDLERS = {
    agent_start_task: agentStartTask,
    agent_resume_task: agentResumeTask,
    agent_finish_task: agentFinishTask,
    agent_get_document: agentGetDocument,
    agent_get_layer: agentGetLayer,
    agent_get_image: agentGetImage,
    agent_execute_script: agentExecuteScript,
    agent_rollback: agentRollback,
    agent_ping: agentPing
};

/**
 * Run one command that came over the channel.
 *
 * @param {string} name - Command name.
 * @param {object} payload - Command payload.
 * @returns {Promise<object>} The answer for Helper.
 * @throws {Error} When the command is unknown or the work failed.
 */
async function handleCommand(name, payload = {}) {
    const handler = HANDLERS[name];
    if (!handler) {
        throw new Error(`Unknown command: ${name}`);
    }
    return handler(payload);
}

module.exports = {
    handleCommand,
    // Exported for testing only; production code dispatches through handleCommand.
    describeLayer
};
