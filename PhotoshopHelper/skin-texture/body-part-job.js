'use strict';

/**
 * What a body part job (task31) means for the job manager: the checks before computing, where
 * its folder goes in the Photoshop write, how the write's answer is checked, and how the job is
 * described to the agent. Kept out of job-manager.js, which calls these at a few fixed points;
 * a job without body_part (and without skin_group_id) goes through exactly the earlier values.
 */

const adapter = require('./core-adapter');
const recipeCatalog = require('./recipe-catalog');
const bodyParts = require('./body-parts');

/** Name of the common root group a first body part creates. */
const COMMON_SKIN_NAME = 'Skin';
/** Folder name of an areola-only job placed into the common Skin. */
const AREOLA_FOLDER_NAME = 'Areolas';

const isAreolaOnly = job => Boolean(job.request.layout) && !job.request.layout.skin;

/**
 * Refuse a body part request that must not be computed yet: the guide was not read in this
 * task, or the scale is below the limit without the person's yes.
 *
 * @param {object} request - checkRequestShape result.
 * @param {object} store - The task's store in the job manager.
 * @param {number} minPxPerMm - Scale limit.
 * @throws {adapter.SkinRequestError}
 */
function checkStart(request, store, minPxPerMm) {
    if (!request.bodyPart) return;
    if (!store.bodyGuideReadAt) {
        throw new adapter.SkinRequestError('BODY_PARTS_GUIDE_NOT_READ',
            'Call ps_skin_texture_body_parts once in this task first: it says how to split the body into folders, '
            + 'how to build their masks and what to ask the person. Then call ps_skin_texture_start again. Nothing was computed.');
    }
    const small = bodyParts.smallScaleRefusal(request.bodyPart, request.pxPerMm, request.smallScaleConfirmed, minPxPerMm);
    if (small) throw new adapter.SkinRequestError('SMALL_SCALE_NOT_CONFIRMED', small);
}

/**
 * Widen a body part's rect by the margin, once the document size is known. The agent's rect is
 * kept as requestedRect and the margin as rectMargin; request.rect becomes the widened rect, so
 * the computation, the write and the job view all use it. The margin stops at the document edge
 * and shrinks, never the agent's own rect, when the widened rect would pass the size limits.
 * A rect that does not fit the document is left for normalizeForDocument to refuse.
 *
 * @param {object} request - checkRequestShape result; changed in place.
 * @param {{width: number, height: number}} document - Document size.
 * @param {{marginMm: number, minMarginPx: number}} margin - Job manager options.
 */
function widenRect(request, document, { marginMm, minMarginPx }) {
    if (!request.bodyPart) return;
    // A retried probe starts again from the agent's rect, never from a rect widened before.
    const base = request.requestedRect || request.rect;
    if (base.x + base.width > document.width || base.y + base.height > document.height) return;
    const wanted = Math.max(Math.ceil(marginMm * request.pxPerMm), minMarginPx);
    const widen = m => {
        const x0 = Math.max(0, base.x - m), y0 = Math.max(0, base.y - m);
        const x1 = Math.min(document.width, base.x + base.width + m), y1 = Math.min(document.height, base.y + base.height + m);
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    };
    const fits = r => r.width <= adapter.MAX_RECT_SIDE && r.height <= adapter.MAX_RECT_SIDE && r.width * r.height <= adapter.MAX_RECT_PIXELS;
    let used = wanted;
    if (!fits(widen(used))) {
        // The agent's own rect fits (checked at start), so the largest fitting margin is found by bisection.
        let low = 0, high = wanted;
        while (high - low > 1) {
            const mid = Math.floor((low + high) / 2);
            if (fits(widen(mid))) low = mid; else high = mid;
        }
        used = low;
    }
    request.requestedRect = { ...base };
    request.rect = widen(used);
    request.rectMargin = { wanted_px: wanted, used_px: used, mm: marginMm, min_px: minMarginPx, reduced: used < wanted };
}

/**
 * Check skin_group_id of an apply call.
 *
 * @returns {number|null} The group id, or null when the write makes its own groups.
 * @throws {adapter.SkinRequestError}
 */
function checkPlacement(job, skinGroupId) {
    if (skinGroupId === undefined || skinGroupId === null) return null;
    if (!Number.isInteger(skinGroupId)) {
        throw new adapter.SkinRequestError('INVALID_SKIN_GROUP', 'skin_group_id must be the integer id of the common Skin group.');
    }
    if (!job.request.bodyPart && !isAreolaOnly(job)) {
        throw new adapter.SkinRequestError('INVALID_SKIN_GROUP',
            'skin_group_id places a body part folder into the common Skin group, but this job was started without body_part. '
            + 'Apply it without skin_group_id, or start a new request with body_part.');
    }
    return skinGroupId;
}

/**
 * Check seed_change_confirmed of an apply call.
 *
 * @returns {boolean}
 * @throws {adapter.SkinRequestError}
 */
function checkSeedChange(value) {
    if (value === undefined || value === null) return false;
    if (typeof value !== 'boolean') throw new adapter.SkinRequestError('INVALID_SEED_CHANGE', 'seed_change_confirmed must be true or false.');
    return value;
}

/** The seed of a job as it appears in the names of the groups it writes: " seed 48213". */
function seedLabel(job) {
    return ` seed ${job.request.params.seed}`;
}

/**
 * EXPECT.part of the apply script (body-part-uxp-script.js), or null for a write as before.
 * A new common Skin is named with the seed of the part that creates it; a part placed into an
 * existing Skin is checked against the seed in that group's name (seedChangeConfirmed waives it).
 */
function applyPart(job, attempt) {
    const skinGroupId = attempt && Number.isInteger(attempt.skinGroupId) ? attempt.skinGroupId : null;
    const common = { skinGroupId, skinName: COMMON_SKIN_NAME + seedLabel(job), seed: job.request.params.seed,
        seedChangeConfirmed: Boolean(attempt && attempt.seedChangeConfirmed) };
    if (job.request.bodyPart) return { folderName: job.request.bodyPart.name, ...common };
    if (skinGroupId !== null) return { folderName: AREOLA_FOLDER_NAME, ...common };
    return null;
}

/**
 * Check the part of a successful write's answer that depends on the placement.
 *
 * @returns {boolean}
 */
function writeIsConsistent(job, attempt, structure) {
    const part = applyPart(job, attempt);
    const group = structure && structure.skinGroup;
    if (!part) return !group;
    if (!group || !Number.isInteger(group.id)) return false;
    if (part.skinGroupId !== null ? group.id !== part.skinGroupId : group.created !== true) return false;
    const main = structure.mainGroup;
    return Boolean(main) && typeof main.name === 'string' && main.name.startsWith(`${part.folderName} `);
}

/** Addition to next_step of a ready job. */
function readyText(job) {
    if (job.request.bodyPart) {
        return ` This is the body part folder "${job.request.bodyPart.name}": pass skin_group_id with the id of the common Skin group `
            + 'from an earlier body part of this picture, or leave it out for the first part to create the Skin group.';
    }
    if (isAreolaOnly(job)) return ' To put the Areolas folder into a common Skin group of body parts, pass its id as skin_group_id.';
    return '';
}

/** Addition to next_step of an applied job. */
function appliedText(job) {
    const attempt = job.apply;
    const structure = attempt && attempt.structure;
    const group = structure && structure.skinGroup;
    if (!group || !applyPart(job, attempt)) return '';
    return ` The folder "${structure.mainGroup.name}" with its own mask is inside the common group "${group.name}" (id ${group.id}`
        + `${group.created ? ', created by this write' : ''}). Pass skin_group_id: ${group.id} to ps_skin_texture_apply for every further body part of this picture, `
        + `and keep seed ${job.request.params.seed} for them (in a new task pass it as params.seed).`;
}

/**
 * The body part view of a job: the word, the folder, what the formulas received for it.
 *
 * @returns {object|null}
 */
function describe(job) {
    const part = job.request.bodyPart;
    if (!part) return null;
    const zones = Object.fromEntries(Object.values(recipeCatalog.FORMULA_DEFINITIONS).map(formula => [formula.id,
        (job.coreParams && job.coreParams[formula.id] && job.coreParams[formula.id].zone) || recipeCatalog.zoneFor(formula, part.code)]));
    const out = { body_part: part.code, folder_name: part.name, formula_zones: zones };
    if (Object.values(zones).every(zone => zone === 'cheek')) {
        out.note = 'The formulas do not distinguish body parts yet: both compute the base skin texture (zone "cheek").';
    }
    if (job.request.smallScaleConfirmed) out.small_scale_confirmed = true;
    if (job.request.requestedRect) {
        out.requested_rect = job.request.requestedRect;
        out.rect_margin = job.request.rectMargin;
        if (job.request.rectMargin.reduced) {
            out.rect_margin_note = `The margin was reduced from ${job.request.rectMargin.wanted_px} to ${job.request.rectMargin.used_px} px `
                + 'to keep the rect within 4096 x 4096 pixels and 8192 per side.';
        }
    }
    return out;
}

module.exports = {
    COMMON_SKIN_NAME, AREOLA_FOLDER_NAME,
    checkStart, widenRect, checkPlacement, checkSeedChange, seedLabel, applyPart, writeIsConsistent, readyText, appliedText, describe
};
