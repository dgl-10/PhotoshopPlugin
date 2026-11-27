'use strict';

/**
 * Validate the common input contract before starting any worker.
 * Main-thread work is intentionally limited to small JSON structures. Kernel-specific
 * validation and all image allocations stay in the disposable formula workers.
 */
const recipeCatalog = require('./recipe-catalog');
const areolaRequest = require('./areola-request');
const areolaGeometry = require('./areola-geometry');
const bodyParts = require('./body-parts');
const MAX_RECT_PIXELS = 4096 * 4096;
const MAX_RECT_SIDE = 8192;
const OUTPUTS = Object.freeze(recipeCatalog.RECIPE_COMPONENTS.map(c => c.componentKey));

/** A stable refusal code is separate from the explanation shown to the agent. */
class SkinRequestError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SkinRequestError';
        this.code = code;
    }
}

/** Accept JSON objects only, with no implicit conversion of arrays or null. */
function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Reject misspelled contract members rather than silently dropping user intent. */
function checkKeys(value, allowed, code, label) {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key));
    if (unknown.length) throw new SkinRequestError(code, `${label} has unknown fields: ${unknown.join(', ')}.`);
}

/** Keep the established patch limits; coordinates must also be safe JS integers. */
function checkRectShape(rect) {
    if (!isObject(rect)) throw new SkinRequestError('INVALID_RECT', 'rect is required: { x, y, width, height } in document pixels.');
    const keys = ['x', 'y', 'width', 'height'];
    checkKeys(rect, keys, 'INVALID_RECT', 'rect');
    if (keys.some(key => !Number.isSafeInteger(rect[key])) || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1) {
        throw new SkinRequestError('INVALID_RECT', 'rect needs integer document pixels: x, y >= 0; width, height >= 1.');
    }
    if (rect.width > MAX_RECT_SIDE || rect.height > MAX_RECT_SIDE || rect.width * rect.height > MAX_RECT_PIXELS) {
        throw new SkinRequestError('RECT_TOO_LARGE', `rect is too large: at most ${MAX_RECT_PIXELS} pixels (4096 x 4096) and ${MAX_RECT_SIDE} per side. Use smaller rectangles.`);
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Canonicalize the one supported face representation without clipping its coordinates.
 * Facial landmarks refer to the document, so points outside a patch or document are valid.
 * Fixed property order makes idempotency independent of JSON object member order.
 */
function normalizeFields(fields) {
    if (fields === undefined || fields === null) return null;
    const fail = message => { throw new SkinRequestError('INVALID_FIELDS', message); };
    if (!isObject(fields)) fail('fields must be an object containing face and/or areolas.');
    checkKeys(fields, ['face', 'areolas'], 'INVALID_FIELDS', 'fields');
    if (fields.face === undefined && fields.areolas === undefined) fail('fields needs face or areolas when it is supplied.');
    // task20: areolas (contract section 10) are canonicalized by their own module. The face path
    // below is unchanged, and a request without areolas yields exactly the old { face } object.
    let areolas;
    if (fields.areolas !== undefined) {
        try {
            areolas = areolaGeometry.normalizeAreolas(fields.areolas).areolas;
        } catch (error) {
            if (error instanceof areolaGeometry.AreolaGeometryError) throw new SkinRequestError(error.code, error.message);
            throw error;
        }
    }
    if (fields.face === undefined) return { areolas };
    const withFace = normalizeFace(fields.face, fail);
    return areolas ? { ...withFace, areolas } : withFace;
}

/** The single-face representation of contract 1.3 section 9, as accepted since task15. */
function normalizeFace(face, fail) {
    if (!isObject(face)) fail('fields.face is required when fields is supplied.');
    checkKeys(face, ['eyes', 'noseTip', 'mouth', 'chin', 'yawDeg', 'pitchDeg'], 'INVALID_FIELDS', 'fields.face');
    const point = (value, label) => {
        if (!Array.isArray(value) || value.length !== 2 || value.some(n => typeof n !== 'number' || !Number.isFinite(n))) {
            fail(`${label} must be [x, y] with finite document pixel coordinates.`);
        }
        return value.slice();
    };
    const pair = (value, label) => {
        if (!Array.isArray(value) || value.length !== 2) fail(`${label} must contain two points.`);
        return value.map((p, index) => point(p, `${label}[${index}]`));
    };
    const canonical = {
        eyes: pair(face.eyes, 'fields.face.eyes'), noseTip: point(face.noseTip, 'fields.face.noseTip'),
        mouth: pair(face.mouth, 'fields.face.mouth'), chin: point(face.chin, 'fields.face.chin')
    };
    // This is the variant's explicit geometry precondition, not an anatomical fit heuristic.
    const distance = Math.hypot(canonical.eyes[0][0] - canonical.eyes[1][0], canonical.eyes[0][1] - canonical.eyes[1][1]);
    if (!Number.isFinite(distance) || distance < 4) fail('fields.face: the eyes must be at least 4 pixels apart.');
    for (const key of ['yawDeg', 'pitchDeg']) {
        if (face[key] === undefined) continue;
        if (typeof face[key] !== 'number' || !Number.isFinite(face[key])) fail(`fields.face.${key} must be finite degrees.`);
        canonical[key] = face[key];
    }
    return { face: canonical };
}

/**
 * Validate the independent request and construct its canonical idempotency key.
 *
 * @param {object} args - Tool arguments.
 * @param {object} [defaults]
 * @param {number} [defaults.seed] - Seed for a request that names none (task31: the job manager
 *   passes the task's random seed). Left out, the recipe default applies.
 */
function checkRequestShape(args, { seed: defaultSeed } = {}) {
    const rect = checkRectShape(args.rect);
    const pxPerMm = args.px_per_mm;
    // The variants support different ranges; this is their common intersection.
    if (typeof pxPerMm !== 'number' || !Number.isFinite(pxPerMm) || pxPerMm < 0.25 || pxPerMm > 400) {
        throw new SkinRequestError('INVALID_SCALE', 'px_per_mm is required: a finite number between 0.25 and 400 document pixels per millimetre of skin.');
    }
    if (args.outputs !== undefined) throw new SkinRequestError('INVALID_OUTPUTS', 'Omit outputs: the recipe computes all four components of Formula 1 and Formula 2.');
    const recipe = args.recipe === undefined ? recipeCatalog.DEFAULT_RECIPE : args.recipe;
    if (!recipeCatalog.isRecipe(recipe)) throw new SkinRequestError('INVALID_RECIPE', `Unknown recipe: "${recipe}". Supported recipes: ${recipeCatalog.RECIPES.join(', ')}.`);
    const supplied = args.params === undefined ? {} : args.params;
    if (!isObject(supplied)) throw new SkinRequestError('INVALID_PARAMS', 'params must be an object of recipe parameters by name.');
    const allowedParams = [...recipeCatalog.ALLOWED_RECIPE_PARAMS, 'areolaStrength'];
    checkKeys(supplied, allowedParams, 'INVALID_PARAMS', `params (allowed: ${allowedParams.join(', ')})`);
    const { areolaStrength: suppliedAreolaStrength, ...recipeParams } = supplied;
    const params = { ...recipeCatalog.DEFAULT_RECIPE_PARAMS, ...(defaultSeed === undefined ? {} : { seed: defaultSeed }), ...recipeParams };
    const seedGiven = recipeParams.seed !== undefined;
    if (!Number.isInteger(params.seed) || params.seed < 0 || params.seed > 0xffffffff) throw new SkinRequestError('INVALID_PARAMS', 'params.seed must be an unsigned 32-bit integer (0..4294967295).');
    if (typeof params.azimuthDeg !== 'number' || !Number.isFinite(params.azimuthDeg)) throw new SkinRequestError('INVALID_PARAMS', 'params.azimuthDeg must be a finite number.');
    if (typeof params.elevationDeg !== 'number' || !Number.isFinite(params.elevationDeg) || params.elevationDeg < 5 || params.elevationDeg > 90) throw new SkinRequestError('INVALID_PARAMS', 'params.elevationDeg must be between 5 and 90 degrees.');
    const fields = normalizeFields(args.fields);
    // task20: areolas, their strength and the stated origin of the parameters. A request
    // without them builds exactly the task15 key, outputs and parameters.
    const fail = (code, message) => { throw new SkinRequestError(code, message); };
    const hasAreolas = Boolean(fields && fields.areolas);
    if (recipe === areolaRequest.AREOLA_RECIPE && !hasAreolas) fail('INVALID_FIELDS', `recipe ${recipe} needs fields.areolas.`);
    if (recipe === areolaRequest.AREOLA_RECIPE && fields.face) fail('INVALID_FIELDS', `fields.face is used only by the skin formulas, which recipe ${recipe} does not compute.`);
    const areolaStrength = areolaRequest.checkAreolaStrength({ areolaStrength: suppliedAreolaStrength }, hasAreolas, fail);
    const sources = areolaRequest.normalizeSources(args.sources, supplied, fail, hasAreolas);
    const layout = areolaRequest.layoutFor(recipe, hasAreolas, recipeCatalog.RECIPE_COMPONENTS);
    // task31: the body part and its folder name. The person's yes for a small scale is not part
    // of the key: it does not change what is computed. Without body_part the key is unchanged.
    const { bodyPart, smallScaleConfirmed } = bodyParts.normalizeBodyPart(args,
        { recipe, areolaRecipe: areolaRequest.AREOLA_RECIPE, fields }, fail);
    const keyParts = { recipe, rect, pxPerMm, params, fields };
    if (hasAreolas) keyParts.areolaStrength = areolaStrength;
    if (args.sources !== undefined) keyParts.sources = sources;
    if (bodyPart) keyParts.bodyPart = bodyPart;
    const key = JSON.stringify(keyParts);
    const out = { recipe, rect, pxPerMm, params, fields, outputs: areolaRequest.outputsOf(layout), key, layout, seedGiven };
    if (hasAreolas) out.areolaStrength = areolaStrength;
    if (sources) out.sources = sources;
    if (bodyPart) {
        out.bodyPart = bodyPart;
        out.smallScaleConfirmed = smallScaleConfirmed;
    }
    return out;
}

/** Build the small contract requests after Photoshop confirms document dimensions. */
function normalizeForDocument(request, document) {
    if (request.rect.x + request.rect.width > document.width || request.rect.y + request.rect.height > document.height) {
        throw new SkinRequestError('RECT_OUTSIDE_DOCUMENT', `rect ${JSON.stringify(request.rect)} does not fit the document, which is ${document.width}x${document.height} pixels.`);
    }
    const coreParams = { common: request.params };
    const layout = request.layout || areolaRequest.layoutFor(request.recipe, false, recipeCatalog.RECIPE_COMPONENTS);
    if (layout.skin) {
        for (const id of Object.keys(recipeCatalog.FORMULA_DEFINITIONS)) {
            coreParams[id] = recipeCatalog.resolveFormulaParams(id, document, request.rect, request.pxPerMm, request.params, request.fields,
                request.bodyPart ? request.bodyPart.code : null);
        }
    }
    const rectPixels = request.rect.width * request.rect.height;
    // This is the exact retained gray payload size, not a prediction of kernel peak RSS.
    // Peak process memory is measured separately because variants have different workspaces.
    let retainedOutputBytes = layout.skin ? rectPixels * OUTPUTS.length : 0;
    let areola = null;
    if (layout.areolas) {
        try {
            const built = areolaRequest.buildAreolaRequests(request.fields.areolas, document, request.rect,
                request.pxPerMm, request.params, request.areolaStrength);
            areola = { region: built.region, requests: built.requests, cutout: layout.cutout };
        } catch (error) {
            if (error instanceof areolaGeometry.AreolaGeometryError) throw new SkinRequestError(error.code, error.message);
            throw error;
        }
        const regionPixels = areola.region.rect.width * areola.region.rect.height;
        retainedOutputBytes += regionPixels * (layout.components.length - (layout.skin ? OUTPUTS.length : 0) + (layout.cutout ? 1 : 0));
    }
    const out = { coreParams, work: { rectPixels, retainedOutputBytes } };
    if (areola) out.areola = areola;
    return out;
}

/** Omit document geometry already shown elsewhere in the public job view. */
function publicParams(p) {
    const { width, height, rect, document, ...out } = p;
    return out;
}

/** Report actual layer statistics without imposing the retired kernel's fade model. */
function visibilityNotes(p, stats) {
    return Object.entries((stats && stats.layers) || {}).filter(([, layer]) => layer.max - layer.min <= 2)
        .map(([output, layer]) => `Layer "${output}" is nearly flat (values ${layer.min}..${layer.max}) at ${p.pxPerMm} px/mm.`);
}

module.exports = {
    RECIPES: recipeCatalog.RECIPES, DEFAULT_RECIPE: recipeCatalog.DEFAULT_RECIPE, recipeCatalog,
    OUTPUTS, MAX_RECT_PIXELS, MAX_RECT_SIDE, SkinRequestError, checkRectShape, normalizeFields,
    checkRequestShape, normalizeForDocument, publicParams, visibilityNotes,
    getCoreIdentity: recipeCatalog.getFormulasCoreIdentity,
    getFormulasCoreIdentity: recipeCatalog.getFormulasCoreIdentity
};
