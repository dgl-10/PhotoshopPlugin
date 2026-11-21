'use strict';

/**
 * Public metadata for the three nipple and areola micro-relief variants (task20).
 *
 * The binaries are private local assets, exactly like the skin formulas: they are not kept in
 * git and not packed into the installer. This module contains no formula mathematics, only the
 * pins and the presentation the Photoshop write has to reproduce:
 * - which SkinBench variant, version and SHA-256 each Photoshop group is computed by;
 * - the variant's own layer ids, names, blend mode and opacity (contract section 10), top first.
 *
 * The first trial uses the builds named in task19.01. A rebuilt variant gets a new pin here,
 * never a silent replacement: a different file on disk is refused by its SHA-256.
 *
 * Group names follow the face formulas, by the author's decision of 21 November 2026: "Areola
 * Formula 1/2/3" in the same order and with the same authors as Formula 1/2/3 of the skin recipe
 * (formula-definitions.js): 1 is Fable (Claude), 2 is GPT-6 ("Astra" to the author), 3 is Gemini 4.
 * Variant, version and SHA-256 of each group are in the job result and the job log. Labels name the
 * models in messages, in Latin letters like the layer names.
 */

/** Recipe id of a job that computes areolas only, without the general skin formulas. */
const AREOLA_RECIPE = 'areola_three_v1';

/**
 * Generation of the areola groups in the product, independent of each variant's own version.
 * It plays the role formula_version plays for the skin formulas.
 */
const AREOLA_GENERATION = 1;

/** Parameters every variant receives besides the shared strength (the SkinBench page defaults). */
const FIXED_AREOLA_PARAMS = Object.freeze({ nippleStrength: 1, tubercleStrength: 1, skinStrength: 1, wrinkle: 1 });

const STANDARD_LAYERS = Object.freeze([
    Object.freeze({ output: 'nipple', sourceLayerId: 'areola_nipple', layerName: 'Nipple', blendMode: 'linear_light', opacity: 0.5 }),
    Object.freeze({ output: 'tubercles', sourceLayerId: 'areola_tubercles', layerName: 'Areola Tubercles', blendMode: 'linear_light', opacity: 0.5 }),
    Object.freeze({ output: 'skin', sourceLayerId: 'areola_skin', layerName: 'Areola Skin', blendMode: 'linear_light', opacity: 0.5 })
]);

// Order is the Photoshop panel order, top to bottom, and the order of computation.
const AREOLA_DEFINITIONS = Object.freeze({
    areola_fable: Object.freeze({
        id: 'areola_fable', version: AREOLA_GENERATION, name: 'Areola Formula 1', label: 'Fable', visible: true,
        variant: 'fable_areola_v1', variantVersion: '1.0.0', fileName: 'fable_areola.wasm',
        sha256: 'ab076519d68e83631322db439fefce090701aa95785bf784e8625fb9d372a864',
        layers: STANDARD_LAYERS
    }),
    areola_astra: Object.freeze({
        id: 'areola_astra', version: AREOLA_GENERATION, name: 'Areola Formula 2', label: 'Astra', visible: false,
        variant: 'gpt6_areola_v1', variantVersion: '1.0.0', fileName: 'gpt6_areola.wasm',
        sha256: '169179c3f435debc8d1b6eeb98c6da9feff8c52ae12a3893b1d2218866878d0e',
        layers: Object.freeze([
            Object.freeze({ output: 'nipple', sourceLayerId: 'gpt6_areola_nipple', layerName: 'Nipple Microrelief', blendMode: 'linear_light', opacity: 0.5 }),
            Object.freeze({ output: 'tubercles', sourceLayerId: 'gpt6_areola_tubercles', layerName: 'Montgomery Tubercles', blendMode: 'linear_light', opacity: 0.5 }),
            Object.freeze({ output: 'skin', sourceLayerId: 'gpt6_areola_skin', layerName: 'Areola Folds', blendMode: 'linear_light', opacity: 0.5 })
        ])
    }),
    areola_gemini: Object.freeze({
        id: 'areola_gemini', version: AREOLA_GENERATION, name: 'Areola Formula 3', label: 'Gemini', visible: false,
        variant: 'gemini4_areola_v1', variantVersion: '1.0.0', fileName: 'gemini4_areola.wasm',
        // The author's tubercle fix of 20 November 2026 (SkinBench working tree, not committed yet;
        // rebuilt from that source with the same SHA-256), chosen by the author on 21 November in
        // place of the task19.01 build 6b51977f.... The manifest still says 1.0.0.
        sha256: 'ff544bfe40dc2899a2fbfbc177ed668cc5088c0cacd28f09bd3600f74cfb7085',
        layers: STANDARD_LAYERS
    })
});

/** Photoshop group name, the same pattern as the face formulas' "Formula 1/2/3". */
function groupNameOf(definition) {
    return definition.name;
}

// Same flat component shape as the skin recipe (formula-definitions.js), so validation,
// exchange encoding and the Photoshop hierarchy share one descriptor. formulaId names the
// Photoshop group; for an areola component it is the variant key, not a skin formula.
const AREOLA_COMPONENTS = Object.freeze(Object.values(AREOLA_DEFINITIONS).flatMap(definition =>
    definition.layers.map(layer => Object.freeze({
        ...layer, formulaId: definition.id, formulaName: groupNameOf(definition),
        formulaVersion: definition.version, componentKey: `${definition.id}_${layer.output}`,
        subfolder: groupNameOf(definition), visible: definition.visible, kind: 'areola'
    }))));

/** The exchange output that carries the soft cut-out of the general skin under the areolas. */
const CUTOUT_OUTPUT = 'areola_cutout';

module.exports = {
    AREOLA_RECIPE, AREOLA_GENERATION, FIXED_AREOLA_PARAMS, AREOLA_DEFINITIONS,
    AREOLA_COMPONENTS, CUTOUT_OUTPUT, groupNameOf
};
