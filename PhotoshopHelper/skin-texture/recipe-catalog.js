'use strict';

/**
 * Recipe entry point shared by request validation, workers and Photoshop assembly.
 * Parameter resolution constructs contract requests only: no Wasm computation or large
 * allocation belongs on Helper's main thread.
 */
const { DEFAULT_RECIPE, FORMULA_DEFINITIONS, RECIPE_COMPONENTS } = require('./formula-definitions');
const wasmLoader = require('./wasm-loader');

const RECIPES = Object.freeze([DEFAULT_RECIPE]);
const ALLOWED_RECIPE_PARAMS = Object.freeze(['seed', 'azimuthDeg', 'elevationDeg']);
const DEFAULT_RECIPE_PARAMS = Object.freeze({ seed: 1, azimuthDeg: 315, elevationDeg: 45 });

/** Return an ordered, immutable recipe layout; reject obsolete recipe identifiers. */
function getRecipeComponents(recipe) {
    if (!RECIPES.includes(recipe)) throw new Error(`Unsupported recipe: ${recipe}`);
    return RECIPE_COMPONENTS;
}

/**
 * Build one SkinBench VariantRequest without invoking the formula.
 * Face coordinates describe the document and are copied unchanged for every patch.
 * Only a formula declaring face fields receives them (contract 1.3).
 */
function resolveFormulaParams(formulaId, document, rect, pxPerMm, commonParams = {}, fields = null) {
    const formula = FORMULA_DEFINITIONS[formulaId];
    if (!formula) throw new Error(`Unknown formulaId: ${formulaId}`);
    const params = { ...DEFAULT_RECIPE_PARAMS, ...commonParams };
    const request = {
        width: rect.width, height: rect.height,
        document: { width: document.width, height: document.height }, rect: { ...rect },
        pxPerMm, seed: params.seed,
        lighting: { azimuthDeg: params.azimuthDeg, elevationDeg: params.elevationDeg },
        zone: 'cheek'
    };
    if (formula.fields && formula.fields.face && fields) {
        request.fields = JSON.parse(JSON.stringify(fields));
    }
    return request;
}

module.exports = {
    RECIPES, DEFAULT_RECIPE, ALLOWED_RECIPE_PARAMS, DEFAULT_RECIPE_PARAMS,
    FORMULA_DEFINITIONS, RECIPE_COMPONENTS, getRecipeComponents, resolveFormulaParams,
    isRecipe: recipe => RECIPES.includes(recipe),
    getFormulasCoreIdentity: wasmLoader.getWasmCoreIdentity
};