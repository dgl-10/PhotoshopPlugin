'use strict';

/**
 * Geometry of the areolas in a skin texture job (task20). Pure functions, no host dependencies,
 * so the same code is used by request validation, by the compute worker and by the tests.
 *
 * Contract section 10 (SkinBench variants/CONTRACT.md): an areola record describes the document,
 * not the patch. Its outline is an ellipse with centre, two half-axes and the turn of the first
 * half-axis from the x axis towards y (y points down). A variant promises that outside its
 * transition band (outline scaled by outerScale) every byte of every layer is exactly 128 and that
 * a part of a document equals the same place of the whole. Helper relies on both promises: it
 * computes the variants only on a sub-rectangle around the areolas and verifies afterwards that
 * the variant kept its promise there, instead of trusting it.
 *
 * Coordinates: pixel (x, y) covers [x, x + 1) x [y, y + 1); its centre is (x + 0.5, y + 0.5).
 */

/** At most this many areolas per request: the GPT-6 variant documents one or two. */
const MAX_AREOLAS = 2;

/**
 * The computed region reaches this many outline scales from each centre. Every current variant
 * reports outerScale near 1.04-1.07; a reported outerScale above this value is refused after the
 * computation, never silently cut (see checkTransition).
 */
const AREOLA_BOX_SCALE = 1.5;

/** Extra pixels around the box, so rounding never puts a non-neutral pixel on its frame. */
const BOX_MARGIN_PX = 2;

/** Default nipple radius as a share of the long half-axis (the Fable variant's own default). */
const DEFAULT_NIPPLE_SHARE = 0.3;

/** A stable refusal code is separate from the explanation shown to the agent. */
class AreolaGeometryError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AreolaGeometryError';
        this.code = code;
    }
}

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

/**
 * Canonicalize the areola records of a request without moving or clipping them.
 * Missing optional members are filled with explicit values, so the three variants receive the
 * same geometry: each variant has its own default nipple radius, and leaving it out would let
 * the three comparisons draw different nipples.
 *
 * @param {*} raw - fields.areolas as the agent sent it.
 * @returns {{ areolas: object[], defaulted: object[] }} Canonical contract records, and per
 *   record which members Helper filled in.
 * @throws {AreolaGeometryError} INVALID_FIELDS with the member that is wrong.
 */
function normalizeAreolas(raw) {
    const fail = message => { throw new AreolaGeometryError('INVALID_FIELDS', message); };
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_AREOLAS) {
        fail(`fields.areolas must be an array of 1 to ${MAX_AREOLAS} areola records.`);
    }
    const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    const point = (value, label) => {
        if (!Array.isArray(value) || value.length !== 2 || !value.every(n => isFiniteNumber(n) && Math.abs(n) <= 1e7)) {
            fail(`${label} must be [x, y]: finite document pixel coordinates.`);
        }
        return [value[0], value[1]];
    };
    const areolas = [], defaulted = [];
    raw.forEach((item, index) => {
        const label = `fields.areolas[${index}]`;
        if (!isObject(item)) fail(`${label} must be an object.`);
        const unknown = Object.keys(item).filter(key => !['areola', 'nipple', 'nippleRadiusPx'].includes(key));
        if (unknown.length) fail(`${label} has unknown fields: ${unknown.join(', ')}.`);
        const outline = item.areola;
        if (!isObject(outline)) fail(`${label}.areola is required: { center, radii, angleDeg }.`);
        const unknownOutline = Object.keys(outline).filter(key => !['center', 'radii', 'angleDeg'].includes(key));
        if (unknownOutline.length) fail(`${label}.areola has unknown fields: ${unknownOutline.join(', ')}.`);
        const center = point(outline.center, `${label}.areola.center`);
        const radii = outline.radii;
        if (!Array.isArray(radii) || radii.length !== 2 || !radii.every(r => isFiniteNumber(r) && r >= 1 && r <= 1e6)) {
            fail(`${label}.areola.radii must be [rx, ry]: half-axes in pixels, each from 1 to 1000000.`);
        }
        let angleDeg = 0;
        if (outline.angleDeg !== undefined) {
            if (!isFiniteNumber(outline.angleDeg) || Math.abs(outline.angleDeg) > 3600) fail(`${label}.areola.angleDeg must be finite degrees.`);
            angleDeg = outline.angleDeg;
        }
        const filled = {};
        let nipple = center.slice();
        if (item.nipple !== undefined) nipple = point(item.nipple, `${label}.nipple`);
        else filled.nipple = 'centre of the areola';
        const longest = Math.max(radii[0], radii[1]);
        let nippleRadiusPx = Math.round(DEFAULT_NIPPLE_SHARE * longest * 100) / 100;
        if (item.nippleRadiusPx !== undefined) {
            if (!isFiniteNumber(item.nippleRadiusPx) || item.nippleRadiusPx < 0.25 || item.nippleRadiusPx > longest) {
                fail(`${label}.nippleRadiusPx must be from 0.25 pixels up to the longer half-axis (${longest}).`);
            }
            nippleRadiusPx = item.nippleRadiusPx;
        } else {
            filled.nippleRadiusPx = `${DEFAULT_NIPPLE_SHARE} of the longer half-axis`;
        }
        // Fixed member order keeps request keys independent of the agent's JSON order.
        areolas.push({ areola: { center, radii: [radii[0], radii[1]], angleDeg }, nipple, nippleRadiusPx });
        defaulted.push(filled);
    });
    return { areolas, defaulted };
}

/**
 * Elliptic radius of a point: the scale of the outline that passes through it (1 on the outline).
 *
 * @param {object} record - Canonical areola record.
 * @param {number} px - Document x.
 * @param {number} py - Document y.
 * @returns {number}
 */
function outlineScaleAt(record, px, py) {
    const { center, radii, angleDeg } = record.areola;
    const t = angleDeg * Math.PI / 180;
    const c = Math.cos(t), s = Math.sin(t);
    const dx = px - center[0], dy = py - center[1];
    const u = (dx * c + dy * s) / radii[0];
    const v = (-dx * s + dy * c) / radii[1];
    return Math.sqrt(u * u + v * v);
}

/**
 * Pixel box of the outline scaled by `scale`, before clipping: { x0, y0, x1, y1 }, x1 and y1
 * exclusive. Uses the exact half-extents of a turned ellipse.
 */
function outlineBox(record, scale = AREOLA_BOX_SCALE) {
    const { center, radii, angleDeg } = record.areola;
    const t = angleDeg * Math.PI / 180;
    const a = radii[0] * scale, b = radii[1] * scale;
    const hx = Math.hypot(a * Math.cos(t), b * Math.sin(t));
    const hy = Math.hypot(a * Math.sin(t), b * Math.cos(t));
    return {
        x0: Math.floor(center[0] - hx) - BOX_MARGIN_PX, y0: Math.floor(center[1] - hy) - BOX_MARGIN_PX,
        x1: Math.ceil(center[0] + hx) + BOX_MARGIN_PX, y1: Math.ceil(center[1] + hy) + BOX_MARGIN_PX
    };
}

const toRect = box => ({ x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 });

/**
 * The single sub-rectangle all three variants are computed on, and the rule that the areolas lie
 * inside the job's rect. The rect is the area the job may write, for the skin formulas and for the
 * areolas alike: an areola cut by the rect inside the document would end in a straight seam, so
 * it is refused with the rectangle that would contain it. The document edge cuts nothing that
 * exists, so an areola partly outside the document is accepted.
 *
 * @param {object[]} areolas - Canonical records.
 * @param {{width: number, height: number}} document - Document size.
 * @param {{x: number, y: number, width: number, height: number}} rect - The job rect.
 * @returns {{ rect: object, boxes: object[] }} The sub-rectangle (inside rect) and each
 *   areola's clipped box as a rect.
 * @throws {AreolaGeometryError} AREOLA_OUTSIDE_DOCUMENT or AREOLA_OUTSIDE_RECT.
 */
function areolaRegion(areolas, document, rect) {
    const boxes = areolas.map((record, index) => {
        const box = outlineBox(record);
        const clipped = { x0: Math.max(0, box.x0), y0: Math.max(0, box.y0),
            x1: Math.min(document.width, box.x1), y1: Math.min(document.height, box.y1) };
        if (clipped.x1 <= clipped.x0 || clipped.y1 <= clipped.y0) {
            throw new AreolaGeometryError('AREOLA_OUTSIDE_DOCUMENT',
                `fields.areolas[${index}] lies outside the ${document.width}x${document.height} document.`);
        }
        return clipped;
    });
    const r = { x0: rect.x, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + rect.height };
    const outside = boxes.map((box, index) => ({ box, index }))
        .filter(({ box }) => box.x0 < r.x0 || box.y0 < r.y0 || box.x1 > r.x1 || box.y1 > r.y1);
    if (outside.length) {
        const need = boxes.reduce((acc, box) => ({ x0: Math.min(acc.x0, box.x0), y0: Math.min(acc.y0, box.y0),
            x1: Math.max(acc.x1, box.x1), y1: Math.max(acc.y1, box.y1) }), r);
        throw new AreolaGeometryError('AREOLA_OUTSIDE_RECT',
            `${outside.map(({ index }) => `fields.areolas[${index}]`).join(' and ')} with its edge band reaches outside rect `
            + `${JSON.stringify(rect)}, where it would end in a straight seam. Use a rect that contains it, for example `
            + `${JSON.stringify(toRect(need))}, or the whole document.`);
    }
    const union = boxes.reduce((acc, box) => ({ x0: Math.min(acc.x0, box.x0), y0: Math.min(acc.y0, box.y0),
        x1: Math.max(acc.x1, box.x1), y1: Math.max(acc.y1, box.y1) }));
    return { rect: toRect(union), boxes: boxes.map(toRect) };
}

/** C1-continuous step from 0 at t <= 0 to 1 at t >= 1. */
function smoothstep(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
}

/**
 * Check one variant's reported transition bands before anything is built from them.
 *
 * @param {*} transitions - Per areola, { innerScale, outerScale } as the variant reported them.
 * @param {number} count - Number of areolas in the request.
 * @param {string} who - Variant name for the message.
 * @returns {{innerScale: number, outerScale: number}[]}
 */
function checkTransitions(transitions, count, who) {
    if (!Array.isArray(transitions) || transitions.length !== count) {
        throw new Error(`${who}: diagnostics.areola.areolas must report one transition per areola (contract section 10).`);
    }
    return transitions.map((item, index) => {
        const inner = item && item.innerScale, outer = item && item.outerScale;
        if (!isFiniteNumber(inner) || !isFiniteNumber(outer) || inner <= 0 || outer <= inner) {
            throw new Error(`${who}: areola ${index} reported an invalid transition band ${JSON.stringify(item)}.`);
        }
        if (outer > AREOLA_BOX_SCALE - 0.05) {
            throw new Error(`${who}: areola ${index} reports outerScale ${outer}, beyond the ${AREOLA_BOX_SCALE} outline scales Helper computes. Nothing was cut; this variant needs a wider region.`);
        }
        return { innerScale: inner, outerScale: outer };
    });
}

/**
 * Verify the contract promise "outside the transition band every byte is 128" on the computed
 * sub-rectangle. A pixel counts as outside when its centre lies beyond outerScale by more than
 * one pixel along the shorter half-axis, which absorbs the variants' anti-aliasing of the edge.
 *
 * @returns {null|string} null when kept, otherwise a description of the first violation.
 */
function findNeutralViolation(gray, rect, areolas, transitions) {
    for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
            const value = gray[y * rect.width + x];
            if (value === 128) continue;
            const px = rect.x + x + 0.5, py = rect.y + y + 0.5;
            const inside = areolas.some((record, k) => {
                const slack = 1 / Math.min(record.areola.radii[0], record.areola.radii[1]);
                return outlineScaleAt(record, px, py) <= transitions[k].outerScale + slack;
            });
            if (!inside) return `byte ${value} at document pixel ${rect.x + x},${rect.y + y}, outside every transition band`;
        }
    }
    return null;
}

/**
 * Soft cut-out of the general skin texture under the areolas, as an 8-bit mask over `rect`:
 * 255 keeps the general texture, 0 removes it.
 *
 * Each variant fades its own relief in over the band it reports: whole inside innerScale, zero
 * outside outerScale. The general texture has to fade out over the same band, so the two cross
 * over instead of overlapping (double texture) or leaving a ring with no texture. The three
 * variants report slightly different bands and the person switches between them with the group
 * eyes, without a recomputation, so one mask has to serve all three. It follows whichever variant
 * is strongest at each point: weight = max over variants and areolas of that variant's areola
 * weight 1 - smoothstep((rho - inner) / (outer - inner)), mask = 255 * (1 - weight). Inside every
 * band's inner edge the general texture is gone; beyond every band's outer edge the mask is 255,
 * so the picture there is exactly what it is without areolas.
 *
 * @param {object[]} areolas - Canonical records.
 * @param {{innerScale: number, outerScale: number}[][]} bandsByVariant - Per variant, per areola.
 * @param {{x: number, y: number, width: number, height: number}} rect - Region of the mask.
 * @returns {Uint8Array}
 */
function buildCutout(areolas, bandsByVariant, rect) {
    const out = new Uint8Array(rect.width * rect.height);
    for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
            const px = rect.x + x + 0.5, py = rect.y + y + 0.5;
            let weight = 0;
            for (let k = 0; k < areolas.length && weight < 1; k++) {
                const rho = outlineScaleAt(areolas[k], px, py);
                for (const bands of bandsByVariant) {
                    const { innerScale, outerScale } = bands[k];
                    const w = 1 - smoothstep((rho - innerScale) / (outerScale - innerScale));
                    if (w > weight) weight = w;
                }
            }
            out[y * rect.width + x] = Math.round(255 * (1 - weight));
        }
    }
    return out;
}

module.exports = {
    MAX_AREOLAS, AREOLA_BOX_SCALE, BOX_MARGIN_PX, DEFAULT_NIPPLE_SHARE, AreolaGeometryError,
    normalizeAreolas, outlineScaleAt, outlineBox, areolaRegion, smoothstep, checkTransitions,
    findNeutralViolation, buildCutout
};
