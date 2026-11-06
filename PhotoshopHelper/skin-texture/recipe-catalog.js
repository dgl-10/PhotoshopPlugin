'use strict';

/**
 * Catalog and definitions for skin texture recipes and fixed formulas.
 *
 * Implements recipe definitions for task06, beginning with 'skin_pair_v1':
 * - Dual-formula generation (Formula 1 and Formula 2) using fixed presets
 *   from skin-core-formulas.js (candidate1 and candidate2 respectively).
 * - Component composition: exactly two outputs per formula ('pores' -> Pores,
 *   'furrows' -> Microrelief).
 * - Layer layout: Main group 'Skin' (Pass Through, Opacity 100%, user mask),
 *   subfolders 'Formula 2' (Pass Through, Opacity 100%, visible) and
 *   'Formula 1' (Pass Through, Opacity 100%, hidden), with texture layers
 *   set to Linear Light, Opacity 50%, Fill 100%.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMULAS_CORE_FILE = path.join(__dirname, 'skin-core-formulas.js');
const PINNED_FORMULAS_CORE_SHA256 = '385f49f559c05f823c2c79a2ccf782a58c18e72c857d4e12bc08d18eb216229b';

const RECIPES = ['skin_pair_v1'];
const RECIPE_SKIN_PAIR_V1 = 'skin_pair_v1';

const ALLOWED_RECIPE_PARAMS = ['mode', 'seed', 'azimuthDeg', 'elevationDeg'];

const DEFAULT_RECIPE_PARAMS = Object.freeze({
    mode: 'lines',
    seed: 1,
    azimuthDeg: 315,
    elevationDeg: 45
});

const FORMULA_DEFINITIONS = Object.freeze({
    formula_1: {
        id: 'formula_1',
        version: 1,
        name: 'Formula 1',
        preset: 'candidate1',
        visible: false,
        outputs: ['pores', 'furrows']
    },
    formula_2: {
        id: 'formula_2',
        version: 1,
        name: 'Formula 2',
        preset: 'candidate2',
        visible: true,
        outputs: ['pores', 'furrows']
    }
});

// Component keys and target layer names in writing order:
// Formula 2 first (top), then Formula 1 (bottom).
// Inside each formula: Pores on top, Microrelief below.
const RECIPE_COMPONENTS_SKIN_PAIR_V1 = Object.freeze([
    {
        formulaId: 'formula_2',
        formulaName: 'Formula 2',
        formulaVersion: 1,
        output: 'pores',
        layerName: 'Pores',
        componentKey: 'formula_2_pores',
        subfolder: 'Formula 2',
        visible: true
    },
    {
        formulaId: 'formula_2',
        formulaName: 'Formula 2',
        formulaVersion: 1,
        output: 'furrows',
        layerName: 'Microrelief',
        componentKey: 'formula_2_furrows',
        subfolder: 'Formula 2',
        visible: true
    },
    {
        formulaId: 'formula_1',
        formulaName: 'Formula 1',
        formulaVersion: 1,
        output: 'pores',
        layerName: 'Pores',
        componentKey: 'formula_1_pores',
        subfolder: 'Formula 1',
        visible: false
    },
    {
        formulaId: 'formula_1',
        formulaName: 'Formula 1',
        formulaVersion: 1,
        output: 'furrows',
        layerName: 'Microrelief',
        componentKey: 'formula_1_furrows',
        subfolder: 'Formula 1',
        visible: false
    }
]);

let formulasCoreModule = null;
let formulasCoreIdentity = null;

/**
 * Load the experimental formulas core.
 *
 * @returns {object}
 */
function loadFormulasCore() {
    if (!formulasCoreModule) {
        formulasCoreModule = require('./skin-core-formulas.js');
    }
    return formulasCoreModule;
}

/**
 * Retrieve cryptographic identity of the formulas core.
 *
 * @returns {{version: string, sha256: string, matchesPinned: boolean}}
 */
function getFormulasCoreIdentity() {
    if (!formulasCoreIdentity) {
        const bytes = fs.readFileSync(FORMULAS_CORE_FILE);
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        formulasCoreIdentity = {
            version: loadFormulasCore().version,
            sha256,
            matchesPinned: sha256 === PINNED_FORMULAS_CORE_SHA256
        };
    }
    return formulasCoreIdentity;
}

/**
 * Check whether a recipe name is recognized.
 *
 * @param {string} recipe
 * @returns {boolean}
 */
function isRecipe(recipe) {
    return RECIPES.includes(recipe);
}

/**
 * Get ordered components for a recipe.
 *
 * @param {string} recipe
 * @returns {object[]}
 */
function getRecipeComponents(recipe) {
    if (recipe === RECIPE_SKIN_PAIR_V1) {
        return RECIPE_COMPONENTS_SKIN_PAIR_V1;
    }
    throw new Error(`Unsupported recipe: ${recipe}`);
}

/**
 * Resolve parameters for a specific formula in the recipe.
 *
 * @param {string} formulaId - 'formula_1' or 'formula_2'
 * @param {{width: number, height: number}} document
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @param {number} pxPerMm
 * @param {object} commonParams - User-provided recipe params (mode, seed, azimuthDeg, elevationDeg)
 * @returns {object} Fully resolved core parameters for skin-core-formulas.js
 */
function resolveFormulaParams(formulaId, document, rect, pxPerMm, commonParams) {
    const core = loadFormulasCore();
    const formulaDef = FORMULA_DEFINITIONS[formulaId];
    if (!formulaDef) {
        throw new Error(`Unknown formulaId: ${formulaId}`);
    }
    const mergedOverrides = {
        ...DEFAULT_RECIPE_PARAMS,
        ...commonParams,
        width: document.width,
        height: document.height,
        rect: { ...rect },
        pxPerMm
    };
    const preset = core.presetParams(formulaDef.preset, mergedOverrides);
    return core.resolveParams(preset);
}

module.exports = {
    RECIPES,
    RECIPE_SKIN_PAIR_V1,
    PINNED_FORMULAS_CORE_SHA256,
    FORMULAS_CORE_FILE,
    ALLOWED_RECIPE_PARAMS,
    DEFAULT_RECIPE_PARAMS,
    FORMULA_DEFINITIONS,
    RECIPE_COMPONENTS_SKIN_PAIR_V1,
    loadFormulasCore,
    getFormulasCoreIdentity,
    isRecipe,
    getRecipeComponents,
    resolveFormulaParams
};
