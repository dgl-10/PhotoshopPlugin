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
        sha256: '182d5ffced5d9de556100a30d20c306956205a8328aab9088a1ef06a98ca672d',
        fields: Object.freeze({ face: true }),
        layers: Object.freeze([
            Object.freeze({ output: 'pores', sourceLayerId: 'flecks_pores', layerName: 'Pores', blendMode: 'linear_light', opacity: 0.5 }),
            Object.freeze({ output: 'unevenness', sourceLayerId: 'flecks_unevenness', layerName: 'Unevenness', blendMode: 'linear_light', opacity: 0.5 })
        ])
    }),
    formula_2: Object.freeze({
        id: 'formula_2', version: 2, name: 'Formula 2', visible: false,
        variant: 'gemini4_stratum_v2', variantVersion: '2.0.0', fileName: 'gemini4_stratum_v2.wasm',
        sha256: '1619598688b10c986a098c5eb298378af4767f18ee8d46ef9c2da0f5bd49ed15',
        // task25: all three face-aware v2 formulas receive the same six-point fields.face input.
        fields: Object.freeze({ face: true }),
        layers: Object.freeze([
            Object.freeze({ output: 'pores', sourceLayerId: 'gemini4_stratum_pores', layerName: 'Pores', blendMode: 'linear_light', opacity: 0.5 }),
            Object.freeze({ output: 'furrows', sourceLayerId: 'gemini4_stratum_furrows', layerName: 'Furrows', blendMode: 'linear_light', opacity: 0.5 })
        ])
    }),
    formula_3: Object.freeze({
        id: 'formula_3', version: 2, name: 'Formula 3', visible: false,
        variant: 'gpt6_dermis_v2', variantVersion: '2.0.1', fileName: 'dermis.wasm',
        sha256: '2053aaeecb5ff613b47ec92903f7f27478f0c18d400f461ffac541c196ece809',
        // task25: all three face-aware v2 formulas receive the same six-point fields.face input.
        fields: Object.freeze({ face: true }),
        layers: Object.freeze([
            Object.freeze({ output: 'dermis', sourceLayerId: 'gpt6_dermis_texture', layerName: 'Dermis', blendMode: 'linear_light', opacity: 0.5 })
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
