'use strict';

/**
 * MCP tools for the procedural skin texture: ps_skin_texture_start, _status, _apply and
 * _cancel. They work on the task's Photoshop document, so they carry the ps_ prefix and need
 * the task id like every other ps_ tool.
 *
 * This file only describes the tools and translates between MCP arguments and the job
 * manager (skin-texture/job-manager.js), which owns the computation, the files and the
 * write. The checks every ps_ tool goes through come from mcp-tools.js: the task registry,
 * the refusal while an interactive dialog is pending, the plugin transport (callPlugin) and
 * the progress notes. call() in mcp-tools.js still wraps every handler, so the journal, the
 * refusal texts for a missing or paused task and the "[document-closed]" handling are the
 * same as for the other tools.
 *
 * Answers are compact JSON, so an agent can read them without guessing; there are never
 * pixels or base64 in them.
 */

const { SkinRequestError } = require('../skin-texture/core-adapter');
const { RECIPES, DEFAULT_RECIPE } = require('../skin-texture/recipe-catalog');
const { buildToolDescriptions, buildFaceFieldsSchema } = require('../skin-texture/recipe-tool-contract');
// task20: areolas extend the start schema and add ps_skin_texture_find_areolas.
const areolaContract = require('../skin-texture/areola-tool-contract');
// task31: body part folders extend start and apply and add ps_skin_texture_body_parts.
const bodyPartContract = require('../skin-texture/body-part-tool-contract');

/**
 * @param {string} text - Text for the agent.
 * @param {boolean} [isError] - Whether this is a refusal.
 * @returns {object} An MCP tool result.
 */
function textResult(text, isError = false) {
    const result = { content: [{ type: 'text', text }] };
    if (isError) result.isError = true;
    return result;
}

/**
 * @param {object} value - Answer object.
 * @param {boolean} [isError] - Whether the call did not do what was asked.
 * @returns {object} An MCP tool result with the JSON as its text.
 */
function jsonResult(value, isError = false) {
    return textResult(JSON.stringify(value, null, 2), isError);
}

/**
 * Build the skin texture tool layer.
 *
 * @param {object} options
 * @param {object} options.jobs - The job manager (createSkinTextureJobs).
 * @param {object} options.tasks - Task registry.
 * @param {Function} options.callPlugin - (action, payload, timeoutMs) => Promise, from mcp-tools.js.
 * @param {() => boolean} options.isChannelOpen - Whether the plugin's AI line is connected.
 * @param {string} options.channelClosedMessage - What to tell the agent when it is not.
 * @param {Function} options.note - (taskId, text, tool) progress note, from mcp-tools.js.
 * @param {Function} options.refuseWhileDialogPending - (task, toolName) => refusal|null.
 * @param {{documentClosed: string, photoshopBusy: string}} options.markers - The plugin's
 *   error markers, as mcp-tools.js knows them.
 * @returns {{definitions: object[], handlers: object}}
 */
function createSkinTextureTools({
    jobs,
    tasks,
    callPlugin,
    isChannelOpen,
    channelClosedMessage,
    note,
    refuseWhileDialogPending,
    markers
}) {
    const descriptions = bodyPartContract.extendDescriptions(
        areolaContract.extendDescriptions(buildToolDescriptions(jobs.options)), jobs.options);

    const definitions = [
        {
            name: 'ps_skin_texture_start',
            description: descriptions.start,
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    request_id: {
                        type: 'string',
                        description: 'Your own key for this request, unique within the task (letters, digits, . _ : -).'
                    },
                    rect: {
                        type: 'object',
                        description: 'Area in real document pixels: integers, inside the document.',
                        properties: {
                            x: { type: 'integer', minimum: 0 },
                            y: { type: 'integer', minimum: 0 },
                            width: { type: 'integer', minimum: 1, maximum: 8192 },
                            height: { type: 'integer', minimum: 1, maximum: 8192 }
                        },
                        required: ['x', 'y', 'width', 'height'],
                        additionalProperties: false
                    },
                    px_per_mm: {
                        type: 'number',
                        minimum: 0.25,
                        maximum: 400,
                        description: 'Document pixels per millimetre of skin, for example pupil distance in px / 63.'
                    },
                    params: {
                        type: 'object', description: descriptions.params,
                        properties: {
                            seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
                            azimuthDeg: { type: 'number' },
                            elevationDeg: { type: 'number', minimum: 5, maximum: 90 },
                            areolaStrength: { type: 'number', minimum: 0, maximum: 20 }
                        }, additionalProperties: false
                    },
                    fields: areolaContract.buildFieldsSchema(descriptions, buildFaceFieldsSchema(descriptions)),
                    sources: areolaContract.SOURCES_SCHEMA,
                    recipe: { type: 'string', enum: [...RECIPES], description: descriptions.recipe },
                    ...bodyPartContract.buildStartProperties(jobs.options)
                },
                required: ['task_id', 'request_id', 'rect', 'px_per_mm'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_skin_texture_status',
            description: descriptions.status,
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    job_id: { type: 'string' }
                },
                required: ['task_id', 'job_id'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_skin_texture_apply',
            description: descriptions.apply,
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    job_id: { type: 'string' },
                    mask_source: {
                        type: 'object',
                        description: 'Source for the single common Skin group mask (required for the first apply of a job). '
                            + 'Evaluated in the document at the time ps_skin_texture_apply is called, not at start. Either '
                            + '{ "kind": "selection" } (active document selection) or { "kind": "layer_mask", "layer_id": <id> } '
                            + '(existing pixel mask of a layer/group in this document). For a body part it is the mask of that part folder.',
                        properties: {
                            kind: { type: 'string', enum: ['selection', 'layer_mask'] },
                            layer_id: { type: 'integer' }
                        },
                        required: ['kind'],
                        additionalProperties: false
                    },
                    skin_group_id: bodyPartContract.SKIN_GROUP_ID_SCHEMA,
                    seed_change_confirmed: bodyPartContract.SEED_CHANGE_CONFIRMED_SCHEMA
                },
                required: ['task_id', 'job_id'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_skin_texture_cancel',
            description:
                'Stop a skin texture job that has not been written: a running computation stops, a ready '
                + 'result and its files are discarded, and a write still in "preparing_write" (file being '
                + 'handed over, nothing sent yet) is stopped before it is sent. Safe to call again. Once '
                + 'ps_skin_texture_apply has sent the write ("applying" and later), cancel cannot take it back '
                + 'and does not promise that nothing changed: the answer says so, and status reports the '
                + 'outcome. Written layers are removed with Undo or by deleting them. Also works while the '
                + 'Photoshop connection is paused.',
            inputSchema: {
                type: 'object',
                properties: {
                    task_id: { type: 'string' },
                    job_id: { type: 'string' }
                },
                required: ['task_id', 'job_id'],
                additionalProperties: false
            }
        },
        areolaContract.buildFindTool(descriptions.find),
        bodyPartContract.buildGuideTool(descriptions.bodyParts)
    ];

    /**
     * The transport the job manager uses for this task: the plugin's existing
     * agent_execute_script, which binds the call to the task's document.
     *
     * @param {object} task - The running task.
     * @returns {object}
     */
    function transportFor(task) {
        return {
            run: (code, historyName, timeoutMs) => callPlugin('agent_execute_script', {
                taskId: task.id,
                code,
                historyName,
                interactive: false
            }, timeoutMs),
            markers,
            // Same as call() in mcp-tools.js does for a "[document-closed]" error: the task
            // cannot continue, so it is closed rather than left to time out.
            onDocumentClosed: () => tasks.abort('the document was closed'),
            // Asked by the job manager right before it sends a prepared write, after the
            // files are on disk: the checks this layer made when apply was called may be out
            // of date by then. Synchronous, and reads the live state.
            checkBeforeSend: () => {
                if (!isChannelOpen()) return { code: 'PHOTOSHOP_UNAVAILABLE', message: channelClosedMessage };
                const dialog = refuseWhileDialogPending(task, 'ps_skin_texture_apply');
                if (dialog) return { code: 'DIALOG_PENDING', message: dialog.content[0].text };
                return null;
            }
        };
    }

    /**
     * A task whose jobs may be read or cancelled locally: the running task (counts as
     * activity), a paused one, or the task that has just ended. Never used for apply.
     *
     * @param {string} taskId - Task id from the agent.
     * @returns {object} The task.
     * @throws {TaskError} The registry's usual refusal for any other id.
     */
    function taskForLocalCall(taskId) {
        const current = tasks.getCurrent();
        if (current && current.id === taskId) {
            return current.state === 'running' ? tasks.require(taskId) : current;
        }
        const last = tasks.getLastClosed();
        if (last && taskId && last.id === taskId) return last;
        return tasks.require(taskId);
    }

    /**
     * @param {SkinRequestError} error - A refused request.
     * @returns {object} MCP refusal.
     */
    function refusal(error) {
        const body = { code: error.code, message: error.message };
        // A few facts some refusals carry, such as the original job of a used request_id.
        if (error.details) body.details = error.details;
        return jsonResult({ error: body }, true);
    }

    async function start(args) {
        const task = tasks.require(args.task_id);
        const refused = refuseWhileDialogPending(task, 'ps_skin_texture_start');
        if (refused) return refused;
        if (!isChannelOpen()) return textResult(channelClosedMessage, true);

        note(task.id, 'skin texture: starting a computation', 'ps_skin_texture_start');
        let outcome;
        try {
            outcome = await jobs.start(task, args, transportFor(task));
        } catch (error) {
            if (error instanceof SkinRequestError) return refusal(error);
            throw error;
        }
        const view = jobs.describe(outcome.job);
        if (outcome.repeated) view.repeated_request = true;
        return jsonResult(view, outcome.job.phase === 'failed' || outcome.job.phase === 'invalidated');
    }

    async function status(args) {
        const task = taskForLocalCall(args.task_id);
        try {
            const { job } = jobs.status(task.id, args.job_id);
            return jsonResult(jobs.describe(job));
        } catch (error) {
            if (error instanceof SkinRequestError) return refusal(error);
            throw error;
        }
    }

    async function apply(args) {
        const task = tasks.require(args.task_id);
        const refused = refuseWhileDialogPending(task, 'ps_skin_texture_apply');
        if (refused) return refused;
        let outcome;
        try {
            const job = jobs.status(task.id, args.job_id).job;
            // A closed line is refused before an attempt is made, so no files are written for
            // nothing. A write already sent is reported whatever the line does now.
            const newAttempt = !job.apply || job.apply.state === 'not_applied';
            if (newAttempt && job.phase === 'ready' && !isChannelOpen()) return textResult(channelClosedMessage, true);
            if (!job.apply || job.apply.state === 'not_applied') {
                const writingDesc = `recipe ${(job.request && job.request.recipe) || DEFAULT_RECIPE}`;
                note(task.id, `skin texture: writing ${writingDesc}`, 'ps_skin_texture_apply');
            }
            outcome = await jobs.apply(task, args.job_id, transportFor(task), args.mask_source,
                { skinGroupId: args.skin_group_id, seedChangeConfirmed: args.seed_change_confirmed });
        } catch (error) {
            if (error instanceof SkinRequestError) return refusal(error);
            throw error;
        }
        const view = jobs.describe(outcome.job, { withParams: false });
        if (outcome.refusal) {
            view.refused = outcome.refusal;
            return jsonResult(view, true);
        }
        const failed = !['applied', 'applying', 'preparing_write', 'ready'].includes(outcome.job.phase)
            || (outcome.job.apply && outcome.job.apply.state === 'not_applied');
        if (outcome.job.phase === 'applied') note(task.id, 'skin texture: layers written', 'ps_skin_texture_apply');
        return jsonResult(view, failed);
    }

    async function cancel(args) {
        const task = taskForLocalCall(args.task_id);
        try {
            const { job, note: what } = await jobs.cancel(task.id, args.job_id);
            const view = jobs.describe(job, { withParams: false });
            view.cancel = what;
            if (task.state === 'running') note(task.id, `skin texture: cancel ${job.id} (${job.phase})`, 'ps_skin_texture_cancel');
            return jsonResult(view);
        } catch (error) {
            if (error instanceof SkinRequestError) return refusal(error);
            throw error;
        }
    }

    /** task20: measure areolas locally in Helper; numbers only, nothing written to the document. */
    async function findAreolas(args) {
        const task = tasks.require(args.task_id);
        const refused = refuseWhileDialogPending(task, 'ps_skin_texture_find_areolas');
        if (refused) return refused;
        if (!isChannelOpen()) return textResult(channelClosedMessage, true);
        note(task.id, 'skin texture: measuring areolas', 'ps_skin_texture_find_areolas');
        try {
            return jsonResult(await jobs.findAreolas(task, args, transportFor(task)));
        } catch (error) {
            if (error instanceof SkinRequestError) return refusal(error);
            throw error;
        }
    }

    /** task31: the body part guide; remembered for the task, nothing touches the document. */
    async function bodyPartsGuide(args) {
        const task = tasks.require(args.task_id);
        try {
            return jsonResult(jobs.bodyPartsGuide(task));
        } catch (error) {
            if (error instanceof SkinRequestError) return refusal(error);
            throw error;
        }
    }

    return {
        definitions,
        handlers: {
            ps_skin_texture_start: start,
            ps_skin_texture_status: status,
            ps_skin_texture_apply: apply,
            ps_skin_texture_cancel: cancel,
            ps_skin_texture_find_areolas: findAreolas,
            ps_skin_texture_body_parts: bodyPartsGuide
        }
    };
}

module.exports = { createSkinTextureTools };
