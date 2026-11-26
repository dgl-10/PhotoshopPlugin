'use strict';

/**
 * The areola part of a skin texture request (task20): validation on Helper's main thread,
 * the contract requests, and the list of components a job writes.
 *
 * Only small JSON structures are handled here; the variants run in disposable workers
 * (areola-engine.js). Every variant receives the same geometry, scale, light, seed and strength,
 * exactly as the SkinBench comparison page builds them (bench/skinbench/areola.py build_request:
 * no `zone`, the shared strengths and wrinkle), so a job can be compared with the bench byte
 * for byte on the same request.
 */

const { AREOLA_RECIPE, AREOLA_DEFINITIONS, AREOLA_COMPONENTS, CUTOUT_OUTPUT, FIXED_AREOLA_PARAMS } = require('./areola-definitions');
const geometry = require('./areola-geometry');

/** Kinds of origin a parameter can have; the job result repeats them so nobody mistakes an estimate for a measurement. */
const SOURCE_KINDS = Object.freeze(['measured', 'given', 'estimated', 'default']);
const SOURCE_KEYS = Object.freeze(['geometry', 'nipple', 'scale', 'light']);

/**
 * Validate the optional `sources` member: where the agent got each parameter.
 * Helper cannot know whether a scale was measured or guessed; the agent says it, and the job
 * result shows it next to the numbers. The light is marked "default" automatically when the
 * request leaves the light parameters out and the agent said nothing about it.
 *
 * @param {*} raw - args.sources.
 * @param {object} suppliedParams - params as the agent sent them (before defaults).
 * @param {Function} fail - (code, message) => never.
 * @param {boolean} [hasAreolas] - A request without areolas and without sources keeps the old
 *   job view exactly: nothing is added for it.
 * @returns {object|null}
 */
function normalizeSources(raw, suppliedParams, fail, hasAreolas = true) {
    if ((raw === undefined || raw === null) && !hasAreolas) return null;
    if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
        fail('INVALID_SOURCES', 'sources must be an object: { geometry, nipple, scale, light }, each { kind, note }.');
    }
    const out = {};
    for (const [key, value] of Object.entries(raw || {})) {
        if (!SOURCE_KEYS.includes(key)) fail('INVALID_SOURCES', `sources has unknown member "${key}" (allowed: ${SOURCE_KEYS.join(', ')}).`);
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SOURCES', `sources.${key} must be { kind, note }.`);
        const unknown = Object.keys(value).filter(k => !['kind', 'note'].includes(k));
        if (unknown.length) fail('INVALID_SOURCES', `sources.${key} has unknown fields: ${unknown.join(', ')}.`);
        if (!SOURCE_KINDS.includes(value.kind)) fail('INVALID_SOURCES', `sources.${key}.kind must be one of ${SOURCE_KINDS.join(', ')}.`);
        if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 300)) {
            fail('INVALID_SOURCES', `sources.${key}.note must be text of at most 300 characters.`);
        }
        out[key] = value.note === undefined ? { kind: value.kind } : { kind: value.kind, note: value.note };
    }
    const lightGiven = suppliedParams && (suppliedParams.azimuthDeg !== undefined || suppliedParams.elevationDeg !== undefined);
    if (!out.light && !lightGiven) out.light = { kind: 'default', note: 'Helper default: azimuth 315, elevation 45' };
    const ordered = {};
    for (const key of SOURCE_KEYS) if (out[key]) ordered[key] = out[key];
    return Object.keys(ordered).length ? ordered : null;
}

/**
 * Validate the areola strength. It is the variants' own `strength` (0-20, 1 is the bench default)
 * and is only meaningful with areolas.
 */
function checkAreolaStrength(params, hasAreolas, fail) {
    if (params.areolaStrength === undefined) return hasAreolas ? 1 : undefined;
    if (!hasAreolas) fail('INVALID_PARAMS', 'params.areolaStrength needs fields.areolas.');
    const value = params.areolaStrength;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 20) {
        fail('INVALID_PARAMS', 'params.areolaStrength must be a number from 0 to 20 (1 is the variants\' default).');
    }
    return value;
}

/**
 * Components a job computes and writes, top to bottom in the Photoshop panel.
 * Skin recipe without areolas: exactly the four components of skin_v2, unchanged.
 * With areolas: the two areola groups first, then the skin formulas, plus the cut-out mask.
 * Areola recipe: the two areola groups only.
 *
 * @param {string} recipe
 * @param {boolean} hasAreolas
 * @param {object[]} skinComponents - RECIPE_COMPONENTS of skin_v2.
 * @returns {{ components: object[], cutout: boolean, skin: boolean, areolas: boolean }}
 */
function layoutFor(recipe, hasAreolas, skinComponents) {
    const skin = recipe !== AREOLA_RECIPE;
    const components = [...(hasAreolas ? AREOLA_COMPONENTS : []), ...(skin ? skinComponents : [])];
    return { components, cutout: skin && hasAreolas, skin, areolas: hasAreolas };
}

/** Output keys a job must return: one per layer component, plus the cut-out when there is one. */
function outputsOf(layout) {
    const keys = layout.components.map(c => c.componentKey);
    if (layout.cutout) keys.push(CUTOUT_OUTPUT);
    return keys;
}

/**
 * Build the contract requests on the shared sub-rectangle once the document is known.
 *
 * @param {object[]} areolas - Canonical records.
 * @param {{width: number, height: number}} document
 * @param {object} rect - The job rect.
 * @param {number} pxPerMm
 * @param {{seed: number, azimuthDeg: number, elevationDeg: number}} params - Resolved recipe params.
 * @param {number} strength - Areola strength.
 * @returns {{ region: object, requests: object }}
 * @throws {AreolaGeometryError} When an areola is outside the document or crosses rect.
 */
function buildAreolaRequests(areolas, document, rect, pxPerMm, params, strength) {
    const region = geometry.areolaRegion(areolas, document, rect);
    const requests = {};
    for (const id of Object.keys(AREOLA_DEFINITIONS)) {
        requests[id] = {
            width: region.rect.width, height: region.rect.height,
            document: { width: document.width, height: document.height },
            rect: { ...region.rect },
            pxPerMm, seed: params.seed,
            lighting: { azimuthDeg: params.azimuthDeg, elevationDeg: params.elevationDeg },
            fields: { areolas: JSON.parse(JSON.stringify(areolas)) },
            params: { strength, ...FIXED_AREOLA_PARAMS }
        };
    }
    return { region, requests };
}

module.exports = {
    AREOLA_RECIPE, SOURCE_KINDS, SOURCE_KEYS, normalizeSources, checkAreolaStrength,
    layoutFor, outputsOf, buildAreolaRequests
};
