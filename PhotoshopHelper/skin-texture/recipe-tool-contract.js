'use strict';

/**
 * Tool descriptions approved by the author for task15 on 15 November 2026 and updated
 * for task25 (both formulas receive fields.face) on 21 November 2026, and for task31 on
 * 27 November 2026 (a seed left out is random once per task; agents never make one up).
 * Runtime limits are substituted from the existing job manager options; their values
 * are not changed by the new recipe. Keep these strings separate from tool handlers.
 *
 * Hardcoded switch controlling whether agents are asked to toggle and compare Formula 1/2
 * (and Areola Formula 1/2) themselves. Set to false by the author on 21 November 2026 so
 * Formula 1 stays visible and Formula 2 stays hidden for the person to compare; flip back
 * to true to restore the original agent-comparison guidance.
 */
const ALLOW_AGENT_FORMULA_COMPARISON = false;

const COMPARISON_GUIDANCE = Object.freeze({
    enabled: Object.freeze({
        start: 'Compare formulas by showing exactly one formula group at a time; adjust strength with layer opacity in Photoshop.',
        apply: 'Show exactly one formula group at a time to compare; change layer opacity to adjust strength.',
        appliedNextStep: 'Compare by showing exactly one formula group; adjust strength with layer opacity using the returned IDs.'
    }),
    disabled: Object.freeze({
        start: 'Leave Formula 1 visible and Formula 2 hidden as created: do not toggle formula groups, compare variants, or choose between them yourself — the person will compare variants and adjust opacity themselves.',
        apply: 'Leave Formula 1 visible and Formula 2 hidden as created: do not toggle formula groups, compare variants, or choose between them yourself — the person will compare variants and adjust opacity themselves.',
        appliedNextStep: 'Leave Formula 1 visible and Formula 2 hidden as created; do not toggle, compare, or choose between formula variants yourself unless the person explicitly asked — let the person compare them and adjust opacity.'
    })
});

const APPROVED_DESCRIPTIONS = Object.freeze({
    "start": "Start computing two procedural skin formulas (generation 2) for a rectangle of the task's document. Helper computes Formula 1 and Formula 2 sequentially in the background. This answers within {budgetSeconds} seconds with a job_id and writes nothing to the document. Poll ps_skin_texture_status until phase is \"ready\", then use ps_skin_texture_apply with mask_source ({ kind: \"selection\" } or { kind: \"layer_mask\", layer_id: <id> }). The result is a \"Skin\" group (Pass Through, Opacity 100%) with one common mask. Formula 1 is visible and contains \"Pores\" and \"Unevenness\"; Formula 2 is hidden and contains \"Pores\" and \"Furrows\". All four texture layers use Linear Light, Opacity 50%, Fill 100%. {compareStart} rect is required: integer document pixels from the top-left corner, inside the document, at most 16777216 pixels and 8192 pixels per side. For the whole document pass its rectangle explicitly. Texture is generated at the document's pixel scale and never resized. px_per_mm is required (0.25-400): document pixels per millimetre of skin. For a face estimate pupil distance in pixels / 63 mm (an approximate adult average). Keep the physical scale; do not increase it only to make the texture more visible unless the person asks for that look. params accepts seed (unsigned 32-bit integer; left out, Helper picks a random seed once per task and every job of the task shares it), azimuthDeg (finite light direction in degrees, default 315), elevationDeg (light height, 5-90 degrees, default 45). Unknown names, mode and old relief/pores/furrows controls are refused. The seed decides where pores and furrows lie, so never make one up: pass params.seed only when you copy it from the name of a Skin group or folder already in this document (\"seed N\"), for example to redo or add a part of the same picture, or when the person named one. Optional fields.face supplies six facial points in document pixels: eyes [[x,y],[x,y]], noseTip [x,y], mouth [[x,y],[x,y]], chin [x,y]; yawDeg and pitchDeg are optional head angles. Leave them out unless they were measured: the map reads the turn from the nose, and a guessed angle, pitchDeg above all, moves the nose, upper-lip and chin zones off their places. Coordinates may be fractional or outside the requested rectangle. Reuse the same face coordinates for every rectangle of the same document. Both formulas receive these fields and vary skin by facial location, surface compression and local light using the shared face map; without fields each uses uniform cheek parameters with scalar scale and light. Only one face is supported by this tool. recipe is optional; omit it or pass \"skin_v2\". request_id is required and unique within the task. The same request_id and same arguments return the same job; different arguments with the same request_id are refused. A task keeps its last {maxJobsPerTask} job records. Once an old record is dropped, reusing its request_id is refused as REQUEST_ALREADY_USED with the old job_id and outcome, and never recomputed or written again. At most {maxRequestsPerTask} different request_ids are accepted per task; after REQUEST_LIMIT_REACHED finish the task and start another. One computation runs per task at a time. Supported documents: RGB, 8 or 16 bits/channel (16-bit requires a colour profile). Status includes the variant, version and SHA-256 for each formula.",
    "status": "Report a skin texture job immediately, without waiting for computation. Returns phase, next allowed step, parameters as used, per-formula variant/version/SHA-256, timings, layer statistics and, after apply, layer IDs. Phases: checking_document, computing, ready (call ps_skin_texture_apply), preparing_write (files are being prepared; nothing sent yet), applying (write sent), applied; also cancelled, failed (see error), invalidated (document or plugin changed), discarded (task ended, result expired or newer results replaced it), and apply_unknown (write sent but outcome unknown: inspect the document). can_cancel_without_change says whether cancellation can still guarantee an unchanged document. diagnostics.layers reports min/max/mean/clippedFraction per component; diagnostics.notes identifies nearly flat components and a face whose points imply a scale more than 25% away from px_per_mm (check the face points or px_per_mm before apply). Diagnostics describe each variant's results; no common pore-suppression model is assumed. Works while the Photoshop connection is paused and for the task that just ended.",
    "apply": "Write a ready skin texture job into the task's document as a \"Skin\" group (Pass Through, Opacity 100%) with one common mask from mask_source. Formula 1 is visible with \"Pores\" and \"Unevenness\"; Formula 2 is hidden with \"Pores\" and \"Furrows\". All four layers use Linear Light, Opacity 50%, Fill 100%. {compareApply} One apply is one Photoshop History step, so one Undo removes all its layers. A job is written at most once: repeated apply returns the first outcome and never recreates layers, even after Undo; repeated apply on an already applied job needs no mask_source. For another texture start a new request. If writing takes longer than about {budgetSeconds} seconds, the response says applying (or preparing_write while files are prepared); poll ps_skin_texture_status. Before writing, checks document size, depth and colour profile. Immediately before sending, checks the task, document, plugin runtime, connection and absence of a dialog. A cancel, pause, new runtime or task end during preparation stops the write before sending. A paused write is never sent automatically; call apply again after reconnecting.",
    "params": "Recipe parameters: seed (uint32), azimuthDeg (finite degrees), elevationDeg (5-90 degrees). Defaults: a random seed chosen once per task, 315, 45. No mode or strength control; change layer opacity in Photoshop.",
    "recipe": "Optional recipe. Default \"skin_v2\": two generation-2 formulas and four texture layers, assembled into Skin by apply.",
    "fields": "Optional face fields. Only fields.face is accepted; Formula 1 and Formula 2 both receive it. Use the same document coordinates for all rectangles of one face.",
    "face": "Six facial landmarks in document pixels: two eye centres, nose tip, two mouth corners and chin. Coordinates may be fractional or outside rect/document. yawDeg and pitchDeg are optional head angles. Leave them out unless they were measured: the map reads the turn from the nose, and a guessed angle, pitchDeg above all, moves the nose, upper-lip and chin zones off their places. In a profile put the hidden eye and mouth corner where they would be seen through the head; do not move them to fit the scale: towards a profile the face size also comes from the eye-to-chin distance. The face surface is limited to 60 degrees of yaw and 45 of pitch; larger angles are accepted and limited."
});

/** Return the post-apply instruction matching ALLOW_AGENT_FORMULA_COMPARISON. */
function postApplyComparisonGuidance(allowAgentComparison = ALLOW_AGENT_FORMULA_COMPARISON) {
    return (allowAgentComparison ? COMPARISON_GUIDANCE.enabled : COMPARISON_GUIDANCE.disabled).appliedNextStep;
}

/** Render the approved descriptions with the current response and ledger limits. */
function buildToolDescriptions(options, allowAgentComparison = ALLOW_AGENT_FORMULA_COMPARISON) {
    const mode = allowAgentComparison ? COMPARISON_GUIDANCE.enabled : COMPARISON_GUIDANCE.disabled;
    const values = { budgetSeconds: Math.max(1, Math.round(options.responseBudgetMs / 1000)),
        maxJobsPerTask: options.maxJobsPerTask, maxRequestsPerTask: options.maxRequestsPerTask,
        compareStart: mode.start, compareApply: mode.apply };
    return Object.fromEntries(Object.entries(APPROVED_DESCRIPTIONS).map(([key, text]) => [key,
        text.replace(/\{(budgetSeconds|maxJobsPerTask|maxRequestsPerTask|compareStart|compareApply)\}/g, (_, name) => values[name])
    ]));
}

/**
 * Contract 1.3 face landmarks describe the entire document, not an individual patch.
 * The schema exposes only the single-face representation requested for the product.
 * Coordinate finiteness, landmark separation and canonicalization are also checked
 * by the request adapter before a worker is allocated.
 */
function buildFaceFieldsSchema(descriptions) {
    const point = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 };
    const pair = { type: "array", items: point, minItems: 2, maxItems: 2 };
    return { type: "object", description: descriptions.fields,
        properties: { face: { type: "object", description: descriptions.face,
            properties: { eyes: pair, noseTip: point, mouth: pair, chin: point,
                yawDeg: { type: "number" }, pitchDeg: { type: "number" } },
            required: ["eyes", "noseTip", "mouth", "chin"], additionalProperties: false
        } }, required: ["face"], additionalProperties: false
    };
}

// ALLOW_AGENT_FORMULA_COMPARISON, postApplyComparisonGuidance, and the optional
// allowAgentComparison parameters are exported so job-manager/areola modules share the
// toggle and unit tests can verify both states without mutating the constant.
module.exports = { ALLOW_AGENT_FORMULA_COMPARISON, buildToolDescriptions, buildFaceFieldsSchema, postApplyComparisonGuidance };
