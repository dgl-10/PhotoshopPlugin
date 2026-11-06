'use strict';

/**
 * Worker engine for calculating multi-formula skin texture recipes.
 *
 * Implements the calculation stage of recipe 'skin_pair_v1':
 * - Runs in a Worker thread (Node only, no DOM or Electron dependencies).
 * - Computes Formula 1 and Formula 2 sequentially.
 * - Releases intermediate working maps (Float32 height arrays, horizontal sum buffers)
 *   between formulas to minimize peak memory consumption.
 * - Encodes each of the 4 component outputs into the SKTX0002 exchange format
 *   with unique component identifiers ('formula_1_pores', 'formula_1_furrows',
 *   'formula_2_pores', 'formula_2_furrows').
 * - Computes independent cryptographic checksums (CRC-32 and FNV-1a) for each component.
 */

const SkinTextureFormulas = require('./skin-core-formulas.js');
const SkinExchange = require('./exchange.js');

const now = () => performance.now();
const round = value => Math.round(value * 1000) / 1000;

/**
 * Execute sequential recipe computation for skin_pair_v1.
 *
 * @param {object} workerData
 * @param {object} workerData.formulaParams - { formula_1: object, formula_2: object }
 * @param {object} workerData.meta - Exchange metadata shared by outputs
 * @param {Function} postProgress - (stage: string) => void
 * @returns {{files: object, checksums: object, stats: object, timings: object, transfer: ArrayBuffer[]}}
 */
function computeSkinPairV1(workerData, postProgress) {
    const { formulaParams, meta } = workerData;
    const timings = {};
    const files = {};
    const checksums = {};
    const stats = {};
    const transfer = [];

    // --- Formula 1 ---
    postProgress('prepare formula_1');
    let t = now();
    let state1 = SkinTextureFormulas.prepare(formulaParams.formula_1);
    timings.formula1PrepareMs = round(now() - t);

    postProgress('heights formula_1');
    t = now();
    SkinTextureFormulas.buildHeights(state1);
    timings.formula1HeightsMs = round(now() - t);

    // Formula 1: pores
    postProgress('shade formula_1 pores');
    t = now();
    SkinTextureFormulas.shade(state1, 'pores');
    const gray1Pores = SkinTextureFormulas.finish(state1, 'pores');
    timings.formula1PoresMs = round(now() - t);

    t = now();
    const bytes1Pores = SkinExchange.encode(
        { ...meta, output: 'formula_1_pores', formula_id: 'formula_1', formula_version: 1 },
        gray1Pores
    );
    timings.formula1PoresEncodeMs = round(now() - t);
    files.formula_1_pores = bytes1Pores;
    checksums.formula_1_pores = SkinExchange.checksums(gray1Pores);
    transfer.push(bytes1Pores.buffer);

    // Formula 1: furrows
    postProgress('shade formula_1 furrows');
    t = now();
    SkinTextureFormulas.shade(state1, 'furrows');
    const gray1Furrows = SkinTextureFormulas.finish(state1, 'furrows');
    timings.formula1FurrowsMs = round(now() - t);

    t = now();
    const bytes1Furrows = SkinExchange.encode(
        { ...meta, output: 'formula_1_furrows', formula_id: 'formula_1', formula_version: 1 },
        gray1Furrows
    );
    timings.formula1FurrowsEncodeMs = round(now() - t);
    files.formula_1_furrows = bytes1Furrows;
    checksums.formula_1_furrows = SkinExchange.checksums(gray1Furrows);
    transfer.push(bytes1Furrows.buffer);

    stats.formula_1 = state1.stats;

    // Explicitly release intermediate maps of Formula 1 before Formula 2
    state1 = null;

    // --- Formula 2 ---
    postProgress('prepare formula_2');
    t = now();
    let state2 = SkinTextureFormulas.prepare(formulaParams.formula_2);
    timings.formula2PrepareMs = round(now() - t);

    postProgress('heights formula_2');
    t = now();
    SkinTextureFormulas.buildHeights(state2);
    timings.formula2HeightsMs = round(now() - t);

    // Formula 2: pores
    postProgress('shade formula_2 pores');
    t = now();
    SkinTextureFormulas.shade(state2, 'pores');
    const gray2Pores = SkinTextureFormulas.finish(state2, 'pores');
    timings.formula2PoresMs = round(now() - t);

    t = now();
    const bytes2Pores = SkinExchange.encode(
        { ...meta, output: 'formula_2_pores', formula_id: 'formula_2', formula_version: 1 },
        gray2Pores
    );
    timings.formula2PoresEncodeMs = round(now() - t);
    files.formula_2_pores = bytes2Pores;
    checksums.formula_2_pores = SkinExchange.checksums(gray2Pores);
    transfer.push(bytes2Pores.buffer);

    // Formula 2: furrows
    postProgress('shade formula_2 furrows');
    t = now();
    SkinTextureFormulas.shade(state2, 'furrows');
    const gray2Furrows = SkinTextureFormulas.finish(state2, 'furrows');
    timings.formula2FurrowsMs = round(now() - t);

    t = now();
    const bytes2Furrows = SkinExchange.encode(
        { ...meta, output: 'formula_2_furrows', formula_id: 'formula_2', formula_version: 1 },
        gray2Furrows
    );
    timings.formula2FurrowsEncodeMs = round(now() - t);
    files.formula_2_furrows = bytes2Furrows;
    checksums.formula_2_furrows = SkinExchange.checksums(gray2Furrows);
    transfer.push(bytes2Furrows.buffer);

    stats.formula_2 = state2.stats;

    // Explicitly release intermediate maps of Formula 2
    state2 = null;

    return { files, checksums, stats, timings, transfer };
}

module.exports = {
    computeSkinPairV1
};
