'use strict';

/**
 * Public recipe metadata for the second generation of skin formulas.
 * The binaries remain private local assets; this module contains no formula mathematics.
 * Component order is the Photoshop panel order, from top to bottom, and sourceLayerId
 * connects each product component to the unchanged SkinBench ABI response.
 */
const DEFAULT_RECIPE = 'skin_three_v2';
const FORMULA_DEFINITIONS = Object.freeze({
    formula_1: Object.freeze({
        id: 'formula_1', version: 2, name: 'Formula 1', visible: true,
        variant: 'fable_flecks_v2', variantVersion: '2.0.0', fileName: 'fable_flecks2.wasm',
        sha256: 'cca4fe93625cbd8549bb4a28a8f4c5004e912632ab1e73d32790e6787abee824',
        fields: Object.freeze({ face: true }),
        layers: Object.freeze([
            Object.freeze({ output: 'pores', sourceLayerId: 'flecks_pores', layerName: 'Pores', blendMode: 'linear_light', opacity: 0.5 }),
            Object.freeze({ output: 'unevenness', sourceLayerId: 'flecks_unevenness', layerName: 'Unevenness', blendMode: 'linear_light', opacity: 0.5 })
        ])
    }),
    formula_2: Object.freeze({
        id: 'formula_2', version: 2, name: 'Formula 2', visible: false,
        variant: 'gpt6_dermis_v1', variantVersion: '1.0.0', fileName: 'dermis.wasm',
        sha256: 'ac9807d1ca3b2b5c21153d7c561f952c85b34f39b1f0618bd89e3cce0c9253ec',
        layers: Object.freeze([
            Object.freeze({ output: 'dermis', sourceLayerId: 'gpt6_dermis_texture', layerName: 'Dermis', blendMode: 'linear_light', opacity: 0.5 })
        ])
    }),
    formula_3: Object.freeze({
        id: 'formula_3', version: 2, name: 'Formula 3', visible: false,
        variant: 'gemini4_stratum_v1', variantVersion: '1.0.0', fileName: 'gemini4_stratum.wasm',
        sha256: '2e93b4bd889b1c8f553b3f843fed413a6bf435a541b6dab6bda5beeb2c51ebd8',
        layers: Object.freeze([
            Object.freeze({ output: 'pores', sourceLayerId: 'gemini4_stratum_pores', layerName: 'Pores', blendMode: 'linear_light', opacity: 0.5 }),
            Object.freeze({ output: 'furrows', sourceLayerId: 'gemini4_stratum_furrows', layerName: 'Furrows', blendMode: 'linear_light', opacity: 0.5 })
        ])
    })
});

// Flatten once so validation, exchange encoding and Photoshop assembly share one contract.
const RECIPE_COMPONENTS = Object.freeze(Object.values(FORMULA_DEFINITIONS).flatMap(formula =>
    formula.layers.map(layer => Object.freeze({
        ...layer, formulaId: formula.id, formulaName: formula.name,
        formulaVersion: formula.version, componentKey: `${formula.id}_${layer.output}`,
        subfolder: formula.name, visible: formula.visible
    }))));

module.exports = { DEFAULT_RECIPE, FORMULA_DEFINITIONS, RECIPE_COMPONENTS };
