'use strict';

/**
 * Everything Helper needs to know about skin texture request validation and normalization.
 *
 * Under task07, the standard recipe "skin_pair_v1" is the default and only MCP path.
 * Computing old single-core task01 "main" layers is removed from runtime.
 * Requests without recipe automatically normalize to "skin_pair_v1".
 * Legacy outputs and old parameters (relief, pores, furrows) are rejected with clear errors.
 */

const recipeCatalog = require('./recipe-catalog');

// Size limits of one request. Areas up to 4096 x 4096 were measured in task02 (Node 36-54 s,
// about 0.5-0.7 GB peak). The working-area limit and the high-pass radius limit mirror the
// checks inside the formulas core's prepare(), so a request the core would refuse is refused here,
// before a worker allocates anything.
const MAX_RECT_PIXELS = 4096 * 4096;
const MAX_RECT_SIDE = 8192;
const MAX_WORK_AREA_PIXELS = 25_000_000;
const MAX_HIGH_PASS_RADIUS = 4096;

// Components produced by the standard recipe (Formula 2 first, then Formula 1)
const OUTPUTS = recipeCatalog.RECIPE_COMPONENTS_SKIN_PAIR_V1.map(c => c.componentKey);

/**
 * Error for a request the tool refuses. The code is stable; the message is for the agent.
 */
class SkinRequestError extends Error {
    /**
     * @param {string} code - Machine-readable reason.
     * @param {string} message - Text for the agent.
     */
    constructor(code, message) {
        super(message);
        this.name = 'SkinRequestError';
        this.code = code;
    }
}

/**
 * @param {*} value - Anything.
 * @returns {boolean} True for a plain object (not null, not an array).
 */
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check the rect argument on its own.
 *
 * @param {*} rect - The rect the agent passed.
 * @returns {{x: number, y: number, width: number, height: number}} A copy.
 * @throws {SkinRequestError}
 */
function checkRectShape(rect) {
    if (!isPlainObject(rect)) {
        throw new SkinRequestError('INVALID_RECT', 'rect is required: { x, y, width, height } in document pixels.');
    }
    const keys = Object.keys(rect);
    const allowed = ['x', 'y', 'width', 'height'];
    const extra = keys.filter(key => !allowed.includes(key));
    if (extra.length) {
        throw new SkinRequestError('INVALID_RECT', `rect has unknown fields: ${extra.join(', ')}. Use x, y, width, height.`);
    }
    for (const key of allowed) {
        if (!Number.isInteger(rect[key])) {
            throw new SkinRequestError('INVALID_RECT', `rect.${key} must be an integer number of document pixels.`);
        }
    }
    if (rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1) {
        throw new SkinRequestError('INVALID_RECT', 'rect needs x, y >= 0 and width, height >= 1.');
    }
    if (rect.width > MAX_RECT_SIDE || rect.height > MAX_RECT_SIDE || rect.width * rect.height > MAX_RECT_PIXELS) {
        throw new SkinRequestError(
            'RECT_TOO_LARGE',
            `rect ${rect.width}x${rect.height} is too large: at most ${MAX_RECT_PIXELS} pixels `
            + `(4096 x 4096) and ${MAX_RECT_SIDE} pixels per side. Cover only the skin that needs `
            + 'the texture, or split it into separate requests.'
        );
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Check everything about a start request that does not depend on the document.
 * Recipe defaults to 'skin_pair_v1'; omitted recipe and explicit 'skin_pair_v1' produce
 * the identical normalized request and key.
 *
 * @param {object} args - { recipe, rect, px_per_mm, params, outputs } as the agent sent them.
 * @returns {{recipe: string, rect: object, pxPerMm: number, params: object, outputs: string[], key: string}}
 * @throws {SkinRequestError}
 */
function checkRequestShape(args) {
    const rect = checkRectShape(args.rect);

    const pxPerMm = args.px_per_mm;
    if (typeof pxPerMm !== 'number' || !Number.isFinite(pxPerMm) || pxPerMm <= 0) {
        throw new SkinRequestError(
            'INVALID_SCALE',
            'px_per_mm is required: a finite positive number, document pixels per millimetre of skin.'
        );
    }

    if (args.outputs !== undefined) {
        throw new SkinRequestError(
            'INVALID_OUTPUTS',
            'outputs is no longer supported: separate old "main" layer is removed. '
            + 'Omit outputs to compute the standard Skin structure (Formula 1 and Formula 2), '
            + 'then apply it with mask_source.'
        );
    }

    const recipe = args.recipe === undefined ? recipeCatalog.DEFAULT_RECIPE : args.recipe;
    if (recipe !== recipeCatalog.DEFAULT_RECIPE) {
        throw new SkinRequestError(
            'INVALID_RECIPE',
            `Unknown recipe: "${recipe}". Supported recipe: ${recipeCatalog.RECIPES.join(', ')}.`
        );
    }

    const params = args.params === undefined ? {} : args.params;
    if (!isPlainObject(params)) {
        throw new SkinRequestError('INVALID_PARAMS', 'params must be an object of recipe parameters by name.');
    }
    const unknown = Object.keys(params).filter(k => !recipeCatalog.ALLOWED_RECIPE_PARAMS.includes(k));
    if (unknown.length) {
        throw new SkinRequestError(
            'INVALID_PARAMS',
            `Recipe ${recipe} only allows parameters: ${recipeCatalog.ALLOWED_RECIPE_PARAMS.join(', ')}. `
            + `Unknown parameter(s): ${unknown.join(', ')}.`
        );
    }
    if (params.mode !== undefined && params.mode !== 'lines' && params.mode !== 'cells') {
        throw new SkinRequestError('INVALID_PARAMS', 'params.mode must be "lines" or "cells".');
    }
    if (params.seed !== undefined && !Number.isInteger(params.seed)) {
        throw new SkinRequestError('INVALID_PARAMS', 'params.seed must be an integer.');
    }
    if (params.azimuthDeg !== undefined && !Number.isFinite(params.azimuthDeg)) {
        throw new SkinRequestError('INVALID_PARAMS', 'params.azimuthDeg must be a finite number.');
    }
    if (params.elevationDeg !== undefined && (!Number.isFinite(params.elevationDeg) || params.elevationDeg < 5 || params.elevationDeg > 90)) {
        throw new SkinRequestError('INVALID_PARAMS', 'params.elevationDeg must be between 5 and 90 degrees.');
    }

    const components = recipeCatalog.getRecipeComponents(recipe);
    const outputs = components.map(c => c.componentKey);

    const sortedParams = {};
    for (const key of Object.keys(params).sort()) sortedParams[key] = params[key];
    const key = JSON.stringify({ recipe, rect, pxPerMm, params: sortedParams });
    return { recipe, rect, pxPerMm, params: { ...params }, outputs, key };
}

/**
 * The core's working rectangles, computed the way prepare() computes them.
 *
 * @param {object} p - Resolved core parameters.
 * @returns {object} { radius, shadeRect, heightRect }
 */
function workingArea(p) {
    const radius = Math.ceil(p.highPassCells * p.spacingMm * p.pxPerMm);
    const expand = (r, amount) => {
        const x = Math.max(0, r.x - amount);
        const y = Math.max(0, r.y - amount);
        return {
            x,
            y,
            width: Math.min(p.width, r.x + r.width + amount) - x,
            height: Math.min(p.height, r.y + r.height + amount) - y
        };
    };
    const shadeRect = expand(p.rect, radius);
    const heightRect = expand(shadeRect, 1);
    return { radius, shadeRect, heightRect };
}

/**
 * Validate a request against the real document and estimate the worker's memory.
 *
 * @param {object} request - Result of checkRequestShape.
 * @param {{width: number, height: number}} document - Size Photoshop reported.
 * @returns {{coreParams: object, work: object}}
 * @throws {SkinRequestError}
 */
function normalizeForDocument(request, document) {
    if (request.rect.x + request.rect.width > document.width || request.rect.y + request.rect.height > document.height) {
        throw new SkinRequestError(
            'RECT_OUTSIDE_DOCUMENT',
            `rect ${JSON.stringify(request.rect)} does not fit the document, which is `
            + `${document.width}x${document.height} pixels. Pass a rect inside it; for the whole `
            + `document pass { "x": 0, "y": 0, "width": ${document.width}, "height": ${document.height} }.`
        );
    }

    const f1Params = recipeCatalog.resolveFormulaParams('formula_1', document, request.rect, request.pxPerMm, request.params);
    const f2Params = recipeCatalog.resolveFormulaParams('formula_2', document, request.rect, request.pxPerMm, request.params);

    const area1 = workingArea(f1Params);
    const area2 = workingArea(f2Params);
    const maxRadius = Math.max(area1.radius, area2.radius);
    if (maxRadius > MAX_HIGH_PASS_RADIUS) {
        throw new SkinRequestError('WORK_AREA_TOO_LARGE', 'The neutralising blur radius is too large at this scale; reduce px_per_mm or highPassCells.');
    }
    const heightPixels1 = area1.heightRect.width * area1.heightRect.height;
    const heightPixels2 = area2.heightRect.width * area2.heightRect.height;
    const maxWorkPixels = Math.max(heightPixels1, heightPixels2);
    if (maxWorkPixels > MAX_WORK_AREA_PIXELS) {
        throw new SkinRequestError(
            'WORK_AREA_TOO_LARGE',
            `The working area with its margin is ${maxWorkPixels} pixels, above the core's limit of `
            + `${MAX_WORK_AREA_PIXELS}. Use a smaller rect.`
        );
    }
    const rectPixels = request.rect.width * request.rect.height;
    const maxShadePixels = Math.max(area1.shadeRect.width * area1.shadeRect.height, area2.shadeRect.width * area2.shadeRect.height);
    // Working maps of one formula at a time in memory + 4 final encoded/raw outputs
    const estimatedBytes = maxWorkPixels * 8 + maxShadePixels * 4 + maxShadePixels * 8 + rectPixels * 4 * 2;
    return {
        coreParams: { formula_1: f1Params, formula_2: f2Params, common: request.params },
        work: { radius: maxRadius, heightPixels: maxWorkPixels, shadePixels: maxShadePixels, rectPixels, estimatedBytes }
    };
}

/**
 * The resolved parameters as shown to the agent: everything except the document size and
 * the rect, which status shows separately.
 *
 * @param {object} p - Resolved core parameters.
 * @returns {object}
 */
function publicParams(p) {
    const out = {};
    for (const [key, value] of Object.entries(p)) {
        if (key === 'width' || key === 'height' || key === 'rect') continue;
        out[key] = value;
    }
    return out;
}

/**
 * @param {number} value - A number.
 * @returns {number} Rounded to two decimals.
 */
function round2(value) {
    return Math.round(value * 100) / 100;
}

/**
 * Explain, in words, what the scale did to the texture. The core draws nothing that comes
 * out smaller than about 2 pixels and fades details between 2 and 3 pixels (its fade()
 * rule), so at a small px_per_mm a layer can be almost flat gray. The agent reads this
 * instead of guessing why the texture is faint.
 *
 * @param {object} p - Resolved core parameters.
 * @param {object} stats - Stats from the worker (the core's state.stats).
 * @param {string[]} outputs - Computed outputs.
 * @returns {string[]} Notes.
 */
function visibilityNotes(p, stats, outputs) {
    const notes = [];
    const px = mm => mm * p.pxPerMm;
    const describe = (name, pixels, factor) => {
        if (factor <= 0) return `${name}: about ${round2(pixels)} px at this scale — not drawn (details under ~2 px are skipped).`;
        if (factor < 1) return `${name}: about ${round2(pixels)} px — drawn at ${round2(factor)} of full strength (fades between 2 and 3 px).`;
        return null;
    };
    const s = stats && stats.suppressed;
    if (p.furrows && s) {
        const primary = describe('primary furrows (spacing)', px(p.spacingMm), s.primary);
        const secondary = describe('secondary furrows (spacing)', px(p.spacingMm / p.secondaryRatio), s.secondary);
        if (primary) notes.push(primary);
        if (secondary) notes.push(secondary);
    } else if (!p.furrows) {
        notes.push('furrows are switched off (params.furrows = false).');
    }
    if (p.roughness && s && Array.isArray(s.roughness)) {
        const off = s.roughness.filter(factor => factor <= 0).length;
        if (off > 0) {
            notes.push(`fine roughness: ${off} of ${s.roughness.length} octaves are below ~2 px and not drawn.`);
        }
    } else if (!p.roughness) {
        notes.push('fine roughness is switched off (params.roughness = false).');
    }
    if (!p.pores) {
        notes.push('pores are switched off (params.pores = false).');
    } else if (stats && stats.pores) {
        const counts = stats.pores.counts || [0, 0];
        const visible = stats.pores.visible || [0, 0];
        notes.push(
            `pores in the rect: ${visible[0]} of ${counts[0]} large and ${visible[1]} of ${counts[1]} small ones are `
            + `drawn; median diameters about ${round2(px(2 * p.poreRadiusMm))} px and `
            + `${round2(px(2 * p.smallPoreRadiusMm))} px.`
        );
    }
    for (const output of outputs) {
        const layer = stats && stats.layers && stats.layers[output];
        if (layer && layer.max - layer.min <= 2) {
            notes.push(`layer "${output}" is nearly flat 128 (values ${layer.min}..${layer.max}): at this scale it adds almost nothing.`);
        }
    }
    if ((outputs.includes('pores') && !p.pores) || (outputs.includes('furrows') && !p.furrows && !p.roughness)) {
        notes.push('a requested layer has its component switched off, so it comes out flat 128.');
    }
    if (notes.length > 0) {
        notes.push(
            'A larger px_per_mm makes every detail larger; it should match the real scale of the skin '
            + 'in the picture, so change it for looks only if the person wants that.'
        );
    }
    return notes;
}

module.exports = {
    RECIPES: recipeCatalog.RECIPES,
    DEFAULT_RECIPE: recipeCatalog.DEFAULT_RECIPE,
    recipeCatalog,
    OUTPUTS,
    MAX_RECT_PIXELS,
    MAX_RECT_SIDE,
    MAX_WORK_AREA_PIXELS,
    SkinRequestError,
    getCoreIdentity: recipeCatalog.getFormulasCoreIdentity,
    getFormulasCoreIdentity: recipeCatalog.getFormulasCoreIdentity,
    checkRequestShape,
    normalizeForDocument,
    publicParams,
    visibilityNotes,
    workingArea
};
