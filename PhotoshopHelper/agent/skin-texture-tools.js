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

const { SkinRequestError, OUTPUTS, MAX_RECT_PIXELS } = require('../skin-texture/core-adapter');

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
    const budgetSeconds = Math.max(1, Math.round(jobs.options.responseBudgetMs / 1000));

    const definitions = [
        {
            name: 'ps_skin_texture_start',
            description:
                'Start computing a procedural skin micro-relief (pores, fine furrows and roughness) for '
                + 'a rectangle of the task\'s document. Helper computes it in the background and this '
                + `answers within ${budgetSeconds} seconds with a job_id; it writes nothing to the `
                + 'document. Then call ps_skin_texture_status until phase is "ready", and write the result '
                + 'with ps_skin_texture_apply. The result is a gray layer around 128 (neutral) meant for '
                + 'Linear Light or Soft Light; you set that afterwards. '
                + 'rect: integers in real document pixels, x and y from the top-left corner, inside the '
                + 'document; the texture is made for exactly that area at the document\'s own pixel scale, '
                + 'never resized. There is no default area: for the whole document pass { x: 0, y: 0, '
                + `width, height } of the document explicitly. At most ${MAX_RECT_PIXELS} pixels (4096 x 4096). `
                + 'px_per_mm (required): how many document pixels one millimetre of skin covers. For a face, '
                + 'estimate it as the distance between the pupils in pixels divided by about 63 mm (an adult '
                + 'average, an approximation). Details that come out smaller than about 2 px are not drawn, '
                + 'so at a small px_per_mm the layer can be almost flat; status.diagnostics.notes say which '
                + 'details were suppressed. Do not raise px_per_mm only to make the texture show more, unless '
                + 'the person wants that look. '
                + 'params (optional): other core parameters by their exact names, for example mode ("lines" '
                + 'or "cells": two ways of drawing the furrow network), seed (an integer: another variant of '
                + 'the same skin), azimuthDeg (light direction in degrees, default 225), elevationDeg (light '
                + 'height above the skin, 5-90, default 45; lower is stronger relief), relief (strength of '
                + 'the relief before lighting), pores/furrows/roughness (true/false). Unknown names and '
                + 'out-of-range values are refused; status shows every parameter as used. '
                + `outputs (optional): any of ${OUTPUTS.join(', ')}; default ["main"]. "main" is the full `
                + 'relief; "pores" and "furrows" are the same light on the pores alone or on the furrows with '
                + 'the fine roughness alone, for separate control. '
                + 'request_id (required): your own key for this request, unique in the task. Calling start '
                + 'again with the same request_id and the same arguments returns the same job instead of '
                + 'computing again; the same request_id with different arguments is refused. A request_id '
                + `stays used for the whole task: a task keeps its last ${jobs.options.maxJobsPerTask} job records, `
                + 'and once an old record is dropped, repeating its request_id is refused '
                + '("REQUEST_ALREADY_USED", with the old job_id and how it ended) and is never computed or '
                + `written again. One task accepts at most ${jobs.options.maxRequestsPerTask} different `
                + 'request_ids; after that start refuses ("REQUEST_LIMIT_REACHED"): finish the task and '
                + 'start a new one. '
                + 'One computation runs per task at a time. Supported: RGB documents, 8 or 16 bits per '
                + 'channel (16-bit only with a colour profile).',
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
                            width: { type: 'integer', minimum: 1 },
                            height: { type: 'integer', minimum: 1 }
                        },
                        required: ['x', 'y', 'width', 'height'],
                        additionalProperties: false
                    },
                    px_per_mm: {
                        type: 'number',
                        description: 'Document pixels per millimetre of skin, for example pupil distance in px / 63.'
                    },
                    params: {
                        type: 'object',
                        description: 'Other core parameters by name (mode, seed, azimuthDeg, elevationDeg, relief, ...). '
                            + 'Not allowed here: width, height, rect, pxPerMm.'
                    },
                    outputs: {
                        type: 'array',
                        items: { type: 'string', enum: OUTPUTS },
                        description: 'Which layers to make. Default ["main"].'
                    }
                },
                required: ['task_id', 'request_id', 'rect', 'px_per_mm'],
                additionalProperties: false
            }
        },
        {
            name: 'ps_skin_texture_status',
            description:
                'Report a skin texture job. Answers at once and never waits for the computation. It gives '
                + 'the phase, the next allowed step, the parameters as used, timings, diagnostics and, after '
                + 'a write, the ids of the layers it created. Phases: "checking_document" and "computing", '
                + 'then "ready" (call ps_skin_texture_apply), "preparing_write" (apply is handing the file '
                + 'over; nothing has been sent to Photoshop yet, cancel still stops it), "applying" (the write '
                + 'was sent), "applied"; can_cancel_without_change says whether cancel can still stop the job '
                + 'with the document guaranteed unchanged. '
                + 'Also "cancelled", "failed" (see error), "invalidated" (the document or the plugin changed '
                + 'since start, so the result is no longer written), "discarded" (the task ended, the result '
                + 'expired, or a newer one replaced it) and "apply_unknown" (a write was sent but its outcome '
                + 'could not be established: look at the document before anything else). '
                + 'diagnostics.notes explain in words which details were too small to draw at this '
                + 'px_per_mm and whether a layer came out nearly flat 128; diagnostics.layers give min, max '
                + 'and mean of each layer and diagnostics.suppressed the fade factors (0 = not drawn, 1 = '
                + 'full strength). It also works while the Photoshop connection is paused and for the task '
                + 'that just ended.',
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
            description:
                'Write a ready skin texture job into the task\'s document: one ordinary pixel layer per '
                + 'requested output, blend mode Normal, Opacity and Fill 100%, gray (R = G = B) around 128, '
                + 'exactly over the job\'s rect and transparent outside it. The layers are named '
                + '"Skin texture <output> [<job_id>]" and go above the active layer; with several outputs '
                + 'main is the lowest and furrows the top one. One apply is one History step, so one Undo '
                + 'removes all its layers. A job is written at most once: calling apply again returns what '
                + 'happened the first time and never creates the layers again, not even after the person '
                + 'undid them; for another texture start a new request. If the write takes longer than '
                + `about ${budgetSeconds} seconds the answer says "applying" (or "preparing_write" while the `
                + 'file is still being handed over); then call ps_skin_texture_status. Before writing it checks '
                + 'that the document still has the same size, depth and colour profile; otherwise nothing is '
                + 'written. Right before sending it checks again that the task still runs on the same document '
                + 'and plugin runtime, the line is on and no dialog is open: a cancel, a pause of the line, a '
                + 'new runtime or the end of the task while the file was being prepared stops the write with '
                + 'nothing sent; a paused write is never sent by itself later, so call apply again once the '
                + 'line is back. Blend mode (usually Linear '
                + 'Light or Soft Light), strength (Fill or Opacity), mask and Blend If are yours to set '
                + 'afterwards with ps_execute_script — there are no defaults for them.',
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
        }
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
                note(task.id, `skin texture: writing ${job.request.outputs.join(', ')}`, 'ps_skin_texture_apply');
            }
            outcome = await jobs.apply(task, args.job_id, transportFor(task));
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

    return {
        definitions,
        handlers: {
            ps_skin_texture_start: start,
            ps_skin_texture_status: status,
            ps_skin_texture_apply: apply,
            ps_skin_texture_cancel: cancel
        }
    };
}

module.exports = { createSkinTextureTools };
