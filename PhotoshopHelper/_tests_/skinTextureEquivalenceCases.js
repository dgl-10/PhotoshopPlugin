'use strict';

/** Independent oracle mappings transcribed from SkinBench manifests, without product imports. */
const FORMULAS = [
    { id: 'formula_1', variant: 'fable_flecks_v2', fileName: 'fable_flecks2.wasm', version: '2.0.0',
        sha256: 'cca4fe93625cbd8549bb4a28a8f4c5004e912632ab1e73d32790e6787abee824',
        layers: { formula_1_pores: 'flecks_pores', formula_1_unevenness: 'flecks_unevenness' } },
    { id: 'formula_2', variant: 'gpt6_dermis_v1', fileName: 'dermis.wasm', version: '1.0.0',
        sha256: 'ac9807d1ca3b2b5c21153d7c561f952c85b34f39b1f0618bd89e3cce0c9253ec',
        layers: { formula_2_dermis: 'gpt6_dermis_texture' } },
    { id: 'formula_3', variant: 'gemini4_stratum_v1', fileName: 'gemini4_stratum.wasm', version: '1.0.0',
        sha256: '2e93b4bd889b1c8f553b3f843fed413a6bf435a541b6dab6bda5beeb2c51ebd8',
        layers: { formula_3_pores: 'gemini4_stratum_pores', formula_3_furrows: 'gemini4_stratum_furrows' } }
];

// Each scale exercises both face paths; origins, lighting, seeds and pose also vary.
const CASES = [1.6, 2.7, 4, 8].flatMap((scale, index) => [false, true].map(withFace => ({
    id: `scale_${scale}_${withFace ? 'face' : 'uniform'}`,
    document: { width: 180 + index * 7, height: 150 + index * 5 },
    rect: { x: 32 + index * 3, y: 42 + index * 2, width: 40, height: 32 },
    pxPerMm: scale,
    params: { seed: [0, 42, 4294967295, 173][index], azimuthDeg: [315, 25, 180, -45][index], elevationDeg: [45, 12, 80, 30][index] },
    ...(withFace ? { fields: { face: {
        eyes: [[30, 25], [108, 28]], noseTip: [70, 66],
        mouth: [[43, 97], [96, 95]], chin: [71, 133],
        yawDeg: index * 9 - 12, pitchDeg: index * 4 - 6
    } } } : {})
})));

/** Construct the reference contract directly, without product normalization or defaults. */
function independentRequest(config, formulaId) {
    return {
        width: config.rect.width, height: config.rect.height,
        document: { ...config.document }, rect: { ...config.rect }, pxPerMm: config.pxPerMm,
        seed: config.params.seed,
        lighting: { azimuthDeg: config.params.azimuthDeg, elevationDeg: config.params.elevationDeg },
        zone: 'cheek',
        ...(formulaId === 'formula_1' && config.fields ? { fields: JSON.parse(JSON.stringify(config.fields)) } : {})
    };
}

module.exports = { FORMULAS, CASES, independentRequest };
