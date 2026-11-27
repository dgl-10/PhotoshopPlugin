'use strict';

/**
 * Recipe entry point shared by request validation, workers and Photoshop assembly.
 * Parameter resolution constructs contract requests only: no Wasm computation or large
 * allocation belongs on Helper's main thread.
 */
const { DEFAULT_RECIPE, FORMULA_DEFINITIONS, RECIPE_COMPONENTS } = require('./formula-definitions');
const { AREOLA_RECIPE, AREOLA_COMPONENTS } = require('./areola-definitions');
const wasmLoader = require('./wasm-loader');

// task20: areola_v1 computes the two areola variants only, without the skin formulas.
const RECIPES = Object.freeze([DEFAULT_RECIPE, AREOLA_RECIPE]);
const ALLOWED_RECIPE_PARAMS = Object.freeze(['seed', 'azimuthDeg', 'elevationDeg']);
const DEFAULT_RECIPE_PARAMS = Object.freeze({ seed: 1, azimuthDeg: 315, elevationDeg: 45 });

/** Return an ordered, immutable recipe layout; reject obsolete recipe identifiers. */
function getRecipeComponents(recipe) {
    if (!RECIPES.includes(recipe)) throw new Error(`Unsupported recipe: ${recipe}`);
    return recipe === AREOLA_RECIPE ? AREOLA_COMPONENTS : RECIPE_COMPONENTS;
}

/**
 * task31: the zone a formula receives for a body part, by the SkinBench rule (bench/README.md,
 * "The zone rule"): a formula whose definition lists `zones` gets the body part word when it
 * is in that list; every other formula gets "cheek", as before. No formula lists zones yet.
 */
function zoneFor(formula, bodyPart = null) {
    return bodyPart && Array.isArray(formula.zones) && formula.zones.includes(bodyPart) ? bodyPart : 'cheek';
}

/**
 * Build one SkinBench VariantRequest without invoking the formula.
 * Face coordinates describe the document and are copied unchanged for every patch.
 * Only a formula declaring face fields receives them (contract 1.3).
 */
function resolveFormulaParams(formulaId, document, rect, pxPerMm, commonParams = {}, fields = null, bodyPart = null) {
    const formula = FORMULA_DEFINITIONS[formulaId];
    if (!formula) throw new Error(`Unknown formulaId: ${formulaId}`);
    const params = { ...DEFAULT_RECIPE_PARAMS, ...commonParams };
    const request = {
        width: rect.width, height: rect.height,
        document: { width: document.width, height: document.height }, rect: { ...rect },
        pxPerMm, seed: params.seed,
        lighting: { azimuthDeg: params.azimuthDeg, elevationDeg: params.elevationDeg },
        zone: zoneFor(formula, bodyPart)
    };
    // Only the member the formula declared: a face formula never sees fields.areolas (task20),
    // and a request with a face alone gives the same { face } object as before.
    if (formula.fields && formula.fields.face && fields && fields.face) {
        request.fields = { face: JSON.parse(JSON.stringify(fields.face)) };
    }
    return request;
}

module.exports = {
    RECIPES, DEFAULT_RECIPE, ALLOWED_RECIPE_PARAMS, DEFAULT_RECIPE_PARAMS,
    FORMULA_DEFINITIONS, RECIPE_COMPONENTS, getRecipeComponents, resolveFormulaParams, zoneFor,
    isRecipe: recipe => RECIPES.includes(recipe),
    getFormulasCoreIdentity: wasmLoader.getWasmCoreIdentity
};