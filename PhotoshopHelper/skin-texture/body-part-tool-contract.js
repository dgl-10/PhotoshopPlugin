'use strict';

/**
 * Tool texts and schemas added by task31 (skin texture by body parts, 27 November 2026). As with
 * the areola additions (areola-tool-contract.js), the earlier approved texts are extended, not
 * rewritten: each addition is appended to its text. The guide itself is in body-parts.js.
 */

const { BODY_PARTS } = require('./body-parts');

const PART_WORDS = Object.keys(BODY_PARTS);

const ADDITIONS = Object.freeze({
    start: ' Areolas: when areolas or nipples are visible in the skin you texture, texture them too, without being asked: find them with ps_skin_texture_find_areolas and pass fields.areolas (by body parts, with body_part "chest").'
        + ' Body parts: to texture a body (more than a face alone), put each body part into its own folder inside one common Skin group. Call ps_skin_texture_body_parts once in the task first: it explains how to split the body and build the masks, and a start with body_part is refused until it was called. Then start one job per folder with body_part (' + PART_WORDS.join(', ') + ') and optional part_name (the folder name, for example "Arm L"; default from body_part); each folder has its own rect, px_per_mm and mask. Pass a rect just around your mask: Helper widens it on every side by {bodyRectMarginMm} mm of skin at px_per_mm, at least {bodyRectMinMarginPx} px, within the document, so the person can widen the mask later and still find texture under it; the job shows the widened rect and the margin (reduced, and said so, when the rect would pass 4096 x 4096 pixels). Palms, soles, lips, eyes and genitals get no texture and are refused. With body_part, fields.face goes only with "face" and fields.areolas only with "chest". Below {minBodyPxPerMm} px/mm a body part is refused until you have told the person and asked: pass small_scale_confirmed: true only after the person said yes. The formulas do not distinguish body parts yet: every part gets the base skin texture.',
    status: ' With body_part, "body_part" gives the word, the folder name, the zone each formula received, the rect you asked for (requested_rect) and the margin Helper added (rect_margin); "rect" is the widened rect.',
    apply: ' For a job started with body_part the masked group is the part folder, named by part_name, inside a common group "Skin" that has no mask: the first part creates Skin and returns its id in apply.structure.skinGroup.id; pass it as skin_group_id for every later part (also for a recipe areola_v1 job, to put its Areolas folder there). Without body_part and skin_group_id the write is as before. Every group this writes ends its name with the job marker and the seed, for example "Arm L [skt-...] seed 48213"; a new common Skin is named "Skin seed N". A part whose seed differs from the seed in the common Skin\'s name is refused as SEED_MISMATCH: start it again with that seed; pass seed_change_confirmed: true only when the person asked for a different pattern for this part.',
    bodyParts: 'Guide for texturing a body by parts with the ps_skin_texture_ tools: the body_part words and what each covers and cuts out, where no texture goes, when to make a separate folder, how to build and split the masks (seams, skin over skin), px_per_mm for each part, what to ask the person, and the order of calls. Call it once in the task before the first ps_skin_texture_start with body_part; such a start is refused until then. Reads nothing from the document and changes nothing.'
});

/**
 * Apply the task31 additions to the rendered descriptions.
 *
 * @param {object} descriptions - Descriptions after the areola additions.
 * @param {object} options - The job manager's options (minBodyPxPerMm).
 * @returns {object}
 */
function extendDescriptions(descriptions, options) {
    const fill = text => text.replace('{minBodyPxPerMm}', String(options.minBodyPxPerMm))
        .replace('{bodyRectMarginMm}', String(options.bodyRectMarginMm))
        .replace('{bodyRectMinMarginPx}', String(options.bodyRectMinMarginPx));
    return {
        ...descriptions,
        start: descriptions.start + fill(ADDITIONS.start),
        status: descriptions.status + ADDITIONS.status,
        apply: descriptions.apply + ADDITIONS.apply,
        bodyParts: ADDITIONS.bodyParts
    };
}

/** Start schema members of a body part request. */
function buildStartProperties(options) {
    return {
        body_part: {
            type: 'string', enum: PART_WORDS,
            description: 'Body part of this folder; see ps_skin_texture_body_parts. Leave it out for a face alone, written as before.'
        },
        part_name: {
            type: 'string', minLength: 1, maxLength: 40,
            description: 'Folder name in Photoshop, for example "Arms", "Arm L", "Leg R". Default: from body_part.'
        },
        small_scale_confirmed: {
            type: 'boolean',
            description: `true only after the person agreed to apply this body part below ${options.minBodyPxPerMm} px/mm.`
        }
    };
}

/** Apply schema member: the common Skin group a body part folder goes into. */
const SKIN_GROUP_ID_SCHEMA = Object.freeze({
    type: 'integer',
    description: 'Id of the common Skin group (apply.structure.skinGroup.id of the first body part). Leave it out for the first body part, which creates Skin, and for a job without body_part.'
});

/** Apply schema member: the person's yes for a part with another seed than its common Skin. */
const SEED_CHANGE_CONFIRMED_SCHEMA = Object.freeze({
    type: 'boolean',
    description: 'true only when the person asked for a different pattern for this part, so its seed may differ from the seed in the common Skin group\'s name.'
});

/** The guide tool. */
function buildGuideTool(description) {
    return {
        name: 'ps_skin_texture_body_parts',
        description,
        inputSchema: {
            type: 'object',
            properties: { task_id: { type: 'string' } },
            required: ['task_id'],
            additionalProperties: false
        }
    };
}

module.exports = { extendDescriptions, buildStartProperties, SKIN_GROUP_ID_SCHEMA, SEED_CHANGE_CONFIRMED_SCHEMA, buildGuideTool };
