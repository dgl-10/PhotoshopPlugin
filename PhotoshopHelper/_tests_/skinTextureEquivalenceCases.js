'use strict';

/** Independent oracle mappings transcribed from SkinBench manifests, without product imports. */
const FORMULAS = [
    { id: 'formula_1', variant: 'fable_flecks_v2', fileName: 'fable_flecks2.wasm', version: '2.0.0',
        sha256: '1c62615bfd94decceabd025561c4967645e05905f8ff12b0b36bb1cba17d12ad',
        layers: { formula_1_pores: 'flecks_pores', formula_1_unevenness: 'flecks_unevenness' } },
    { id: 'formula_2', variant: 'gemini4_stratum_v2', fileName: 'gemini4_stratum_v2.wasm', version: '2.0.0',
        sha256: '819d5cb9c8f6ae3ab1084d21762c7101188063007446764ed9372f1ef6eb5899',
        layers: { formula_2_pores: 'gemini4_stratum_pores', formula_2_furrows: 'gemini4_stratum_furrows' } },
    { id: 'formula_3', variant: 'gpt6_dermis_v2', fileName: 'dermis.wasm', version: '2.0.1',
        sha256: '7ad7e2c9d2497513a0a07636ac2c3345deda7b410d90de055a2ed59d518394e7',
        layers: { formula_3_dermis: 'gpt6_dermis_texture' } }
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
function independentRequest(config, _formulaId) {
    return {
        width: config.rect.width, height: config.rect.height,
        document: { ...config.document }, rect: { ...config.rect }, pxPerMm: config.pxPerMm,
        seed: config.params.seed,
        lighting: { azimuthDeg: config.params.azimuthDeg, elevationDeg: config.params.elevationDeg },
        zone: 'cheek',
        // task25: all three face-aware v2 formulas receive the same fields.face payload.
        ...(config.fields ? { fields: JSON.parse(JSON.stringify(config.fields)) } : {})
    };
}

module.exports = { FORMULAS, CASES, independentRequest };
