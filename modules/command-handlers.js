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
const ps = require('./ps.js');
const settings = require('./settings.js');
const { describeError } = require('./error-text.js');

// Photoshop lets only one plugin hold a modal scope at a time, and by default a request
// gives up after one second. The person is working in the same document, so a second or
// two of waiting is normal; ten seconds of queuing turns a spurious failure into a pause.
const MODAL_TIMEOUT_MS = 10_000;

// The channel's own ceiling is 100 MiB per message: above it the message is dropped and
// the connection closes. Refusing well short of that keeps a greedy capture from taking
// the channel down, while still leaving room to find out what agents actually accept.
const MAX_IMAGE_BASE64_BYTES = 60 * 1024 * 1024;

// The agent's names for the panel's capture sources and place back modes. They are the
// same operations as the panel's "Copy merged" / "Copy layer" picker and Place Back menu.
const CAPTURE_SOURCES = {
    visible: 'copyMerged',
    current_layer: 'currentLayer'
};
const PLACE_BACK_MODES = {
    smart_object: 'so',
    editable_smart_object: 'editableSo',
    inpaint_mask: 'mask',
    selection_only: 'selection'
};
// The panel's Feather buttons: Outward, Center, Inward.
const FEATHER_BIAS = {
    outward: 1.0,
    center: 0.0,
    inward: -1.0
};

// The FromPS / ToPS cards of the panel, handed over by index.js at start-up. A capture made
// by the agent lands in the same list the person drags from, and its place back uses the
// image the person put into the ToPS card.
let panel = null;

/**
 * @param {object} link - The panel's side, see createPanelLink in index.js.
 */
function connectPanel(link) {
    panel = link;
}

/**
 * @returns {object} The panel link.
 * @throws {Error} When the panel has not handed it over yet.
 */
function requirePanel() {
    if (!panel) {
        throw new Error(
            'The FromPS / ToPS panel is not ready yet. Ask the person to open it, then try again.'
        );
    }
    return panel;
}

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
 * ps_start_task: bind the task to the open document without modifying it.
 *
 * @param {object} payload - { taskId, intent }.
 * @returns {Promise<object>}
 */
async function agentStartTask(payload) {
    const started = await agentDocument.startTask({
        taskId: payload.taskId
    });

    if (!started.document) {
        return { document: null };
    }

    return started;
}

/**
 * Rebind a suspended task after the UXP runtime was recreated. Helper supplies the
 * original document identity; the plugin accepts it only when it can find that document
 * unambiguously among the documents that are actually open now.
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
 * from_ps_capture: press the panel's Capture button on the current selection of the
 * working document — the same padding, the same choice of aspect ratio — and put the piece
 * into the FromPS card, where the person drags it out as usual. Neither the document nor
 * its selection is changed.
 *
 * @param {object} payload - { taskId, source, fullDocument, keepTransparency, padding }.
 * @returns {Promise<object>} The capture's id, number and box, and the status.
 */
async function agentFromPsCapture(payload) {
    const link = requirePanel();

    return agentDocument.withWorkingDocument(payload.taskId, async (doc) => {
        if (!(await hasSelection(doc))) {
            throw new Error(
                `There is no selection in "${doc.name}". Select the area first — with `
                + 'ps_execute_script, or ask the person to — then capture again.'
            );
        }

        const sourceMode = CAPTURE_SOURCES[payload.source] || CAPTURE_SOURCES.visible;

        // The agent's own margin around the selection, or the button's default.
        const padding = Number.isFinite(payload.padding) && payload.padding >= 0
            ? Math.round(payload.padding)
            : ps.CAPTURE_PADDING;

        // A plain capture, exactly as the button makes it: this is what goes to the generator,
        // so it is never reduced. The agent looks at it separately, with ps_get_image.
        const captured = await inModalScope(
            executionContext => ps.captureSelectionInModal(
                executionContext,
                sourceMode,
                payload.keepTransparency === true,
                payload.fullDocument === true,
                padding
            ),
            'Agent: capture'
        );

        const added = await link.addCapture(captured);
        const bounds = captured.bounds;

        return {
            capture: {
                id: added.id,
                number: added.number,
                bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
                width: bounds.width,
                height: bounds.height,
                aspectRatio: captured.aspectRatio,
                source: payload.source || 'visible',
                padding,
                fullDocument: payload.fullDocument === true,
                keepTransparency: payload.keepTransparency === true
            },
            status: agentDocument.buildStatus(payload.taskId)
        };
    });
}

/**
 * from_ps_get_capture: hand over a capture of the FromPS card — its image, and its mask when
 * asked — for the agent to look at. Helper reduces the copy; the card is not switched and
 * nothing in Photoshop changes.
 *
 * @param {object} payload - { taskId, captureId, includeMask }.
 * @returns {Promise<object>} The capture's facts and pixels, the list of captures, and the status.
 */
async function agentFromPsGetCapture(payload) {
    const link = requirePanel();
    // Bound to the task like every other command, although the document itself is not read.
    agentDocument.resolveWorkingDocument(payload.taskId);

    const id = Number.isInteger(payload.captureId) ? payload.captureId : null;
    const capture = await link.readCapture(id, payload.includeMask === true);
    if (!capture) {
        const ids = link.listCaptures().map(item => item.id);
        throw new Error(
            id === null
                ? 'The FromPS card shows no capture right now. '
                + (ids.length > 0 ? `It holds ids ${ids.join(', ')}; name one with capture_id.` : 'It is empty.')
                : `There is no capture with id ${id} in the FromPS card. `
                + (ids.length > 0 ? `It holds ids ${ids.join(', ')}.` : 'The card is empty.')
        );
    }

    const size = (capture.imageBase64 || '').length + (capture.maskBase64 || '').length;
    if (size > MAX_IMAGE_BASE64_BYTES) {
        throw new Error(
            `Capture ${capture.id} came to about ${Math.round(size / (1024 * 1024))} MB, more than `
            + 'the channel to Photoshop carries in one message. Ask for it without the mask.'
        );
    }

    const { imageBase64, maskBase64, ...facts } = capture;
    return {
        capture: facts,
        imageBase64,
        maskBase64,
        captures: link.listCaptures(),
        status: agentDocument.buildStatus(payload.taskId)
    };
}

/**
 * The feather options for the agent's own choice of the panel's Feather buttons.
 *
 * @param {string} choice - 'outward', 'center', 'inward', or anything else for off.
 * @param {boolean} isSelectAll - The capture was Select All; its mask says nothing.
 * @returns {object} Feather options for ps.placeBackInModal.
 */
function featherFor(choice, isSelectAll) {
    const bias = FEATHER_BIAS[choice];
    const enabled = bias !== undefined;
    return Object.assign({}, settings.getFeatherSettings(), {
        enabled,
        bias: enabled ? bias : 1.0,
        skip: Boolean(isSelectAll)
    });
}

/**
 * @param {object} options - Feather options handed to ps.placeBackInModal.
 * @returns {string} The name of the Feather button they amount to.
 */
function describeFeather(options) {
    if (!options.enabled || options.skip) return 'off';
    const name = Object.keys(FEATHER_BIAS).find(key => FEATHER_BIAS[key] === options.bias);
    return name || `bias ${options.bias}`;
}

/**
 * to_ps_place_back: put the image from the ToPS card back into the task's document over a
 * capture of the FromPS card, the way the panel's Place Back does. The capture is named by
 * its id, never taken as "whatever the card shows now": the person may have switched it
 * while the agent was thinking.
 *
 * @param {object} payload - { taskId, captureId, mode, feather, layerName }.
 * @returns {Promise<object>} What was placed and where, and the status.
 */
async function agentToPsPlaceBack(payload) {
    const link = requirePanel();

    if (!Number.isInteger(payload.captureId)) {
        throw new Error('to_ps_place_back needs capture_id: the id from_ps_capture gave you.');
    }

    return agentDocument.withWorkingDocument(payload.taskId, async (doc) => {
        const modeName = PLACE_BACK_MODES[payload.mode] ? payload.mode : 'smart_object';
        const mode = PLACE_BACK_MODES[modeName];

        const current = await link.useCapture(payload.captureId);
        if (!current) {
            const ids = link.listCaptures().map(item => item.id);
            throw new Error(
                `There is no capture with id ${payload.captureId} in the FromPS card. `
                + (ids.length > 0 ? `It holds ids ${ids.join(', ')}. ` : 'The card is empty. ')
                + 'Clear All in the panel removes every capture; if yours is gone, capture again.'
            );
        }

        const capture = current.payload;
        if (!capture.context || capture.context.documentId !== doc.id) {
            const otherName = capture.context ? capture.context.documentName : 'another document';
            throw new Error(
                `Capture ${payload.captureId} was taken from "${otherName}", not from "${doc.name}", `
                + 'the document of this task. Name a capture of this document, or capture again.'
            );
        }

        const result = link.getResult();
        if (mode !== 'selection' && !result) {
            throw new Error(
                'The ToPS card of the FromPS / ToPS panel is empty. Load the finished image into '
                + 'it with to_ps_load_file, or ask the person to put it there (Paste or Load File) '
                + 'and to tell you when it is in; then call again.'
            );
        }

        // Without the agent's own choice, the feather is what the person's Place Back would use.
        const feather = payload.feather
            ? featherFor(payload.feather, capture.isSelectAll)
            : link.getFeatherOptions(capture.isSelectAll);

        // The agent's own name for the new layer; without it the layer keeps the file's name.
        const layerName = typeof payload.layerName === 'string' && payload.layerName.trim()
            ? payload.layerName.trim()
            : null;

        // The History panel is read by the person, who knows the capture by its number in the list.
        const historyName = mode === 'selection'
            ? `Agent: restore selection of capture ${current.number}`
            : `Agent: place back over capture ${current.number}`;

        const report = await inModalScope(
            executionContext => ps.placeBackInModal(
                executionContext,
                mode,
                result ? result.token : null,
                capture.bounds,
                capture.maskData,
                feather,
                historyName,
                layerName
            ),
            historyName
        );
        agentDocument.noteOwnHistoryStep(payload.taskId);

        link.showInfo('tops', mode === 'selection' ? 'Agent restored the selection' : 'Agent placed it back');

        const bounds = capture.bounds;
        // What Place Back actually did — the layer, the mask edge, the blur — so the agent
        // does not mistake the smart filter or the mask feather for someone else's work.
        const done = report || {};
        return {
            placed: {
                mode: modeName,
                captureId: payload.captureId,
                captureNumber: current.number,
                bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
                feather: describeFeather(feather),
                featherFromPanel: !payload.feather,
                layer: done.layer || null,
                mask: done.mask || null,
                gaussianBlur: done.gaussianBlur === undefined ? null : done.gaussianBlur
            },
            status: agentDocument.buildStatus(payload.taskId)
        };
    });
}

/**
 * to_ps_load_file: put an image into the ToPS card, as the panel's Load File does, from a
 * file Helper has already read — so there is no dialog. The document is not touched.
 *
 * @param {object} payload - { taskId, base64, fileName }.
 * @returns {Promise<object>} What was loaded, and the status.
 */
async function agentToPsLoadFile(payload) {
    const link = requirePanel();
    // Bound to the task like every other command, although the document itself is not touched.
    agentDocument.resolveWorkingDocument(payload.taskId);

    if (!payload.base64) {
        throw new Error('The file came through empty, so nothing was loaded into the ToPS card.');
    }

    await link.loadResult(payload.base64, payload.fileName || 'image.png');

    return {
        loaded: { fileName: payload.fileName },
        status: agentDocument.buildStatus(payload.taskId)
    };
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
            status: agentDocument.buildStatus(payload.taskId)
        };
        const rejected = watch.report();
        if (rejected) answer.rejectedCommands = rejected;
        return answer;
    });
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
    agent_from_ps_capture: agentFromPsCapture,
    agent_from_ps_get_capture: agentFromPsGetCapture,
    agent_to_ps_place_back: agentToPsPlaceBack,
    agent_to_ps_load_file: agentToPsLoadFile,
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
    connectPanel,
    // Exported for testing only; production code dispatches through handleCommand.
    describeLayer
};
