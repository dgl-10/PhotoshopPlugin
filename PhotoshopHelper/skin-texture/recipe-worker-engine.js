'use strict';

/**
 * Worker engine for calculating multi-formula skin texture recipes via WebAssembly.
 *
 * Implements the calculation stage of recipe 'skin_pair_v1':
 * - Runs in a Worker thread (Node only, no DOM or Electron dependencies).
 * - Computes Formula 1 and Formula 2 sequentially via formulas.wasm.
 * - Releases intermediate working maps between formulas to minimize peak memory consumption.
 * - Encodes each of the 4 component outputs into the SKTX0002 exchange format
 *   with unique component identifiers ('formula_1_pores', 'formula_1_furrows',
 *   'formula_2_pores', 'formula_2_furrows').
 * - Computes independent cryptographic checksums (CRC-32 and FNV-1a) for each component.
 */

const wasmLoader = require('./wasm-loader.js');
const SkinExchange = require('./exchange.js');

const now = () => performance.now();
const round = value => Math.round(value * 1000) / 1000;

/**
 * Execute sequential recipe computation for skin_pair_v1 via WebAssembly.
 *
 * @param {object} workerData
 * @param {object} workerData.formulaParams - { formula_1: object, formula_2: object, common: object }
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

    const wasmInstance = wasmLoader.createWasmInstance();

    const rect = meta.rect;
    const document = meta.document;
    const common = formulaParams.common || {};

    // --- Formula 1 ---
    postProgress('compute formula_1');
    let t = now();
    const req1 = {
        width: rect.width,
        height: rect.height,
        document: { width: document.width, height: document.height },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        pxPerMm: formulaParams.formula_1.pxPerMm,
        seed: common.seed !== undefined ? common.seed : formulaParams.formula_1.seed,
        lighting: {
            azimuthDeg: common.azimuthDeg !== undefined ? common.azimuthDeg : formulaParams.formula_1.azimuthDeg,
            elevationDeg: common.elevationDeg !== undefined ? common.elevationDeg : formulaParams.formula_1.elevationDeg
        },
        zone: 'cheek',
        params: {
            mode: common.mode || formulaParams.formula_1.mode || 'lines',
            ...common
        },
        presets: ['candidate1'],
        outputs: ['pores', 'furrows']
    };
    const res1 = wasmLoader.executeWasm(req1, wasmInstance);
    timings.formula1ComputeMs = round(now() - t);

    // Formula 1: pores
    postProgress('encode formula_1 pores');
    t = now();
    const gray1Pores = res1.layers.formula_1_pores;
    const bytes1Pores = SkinExchange.encode(
        { ...meta, output: 'formula_1_pores', formula_id: 'formula_1', formula_version: 1 },
        gray1Pores
    );
    timings.formula1PoresEncodeMs = round(now() - t);
    files.formula_1_pores = bytes1Pores;
    checksums.formula_1_pores = SkinExchange.checksums(gray1Pores);
    transfer.push(bytes1Pores.buffer);

    // Formula 1: furrows
    postProgress('encode formula_1 furrows');
    t = now();
    const gray1Furrows = res1.layers.formula_1_furrows;
    const bytes1Furrows = SkinExchange.encode(
        { ...meta, output: 'formula_1_furrows', formula_id: 'formula_1', formula_version: 1 },
        gray1Furrows
    );
    timings.formula1FurrowsEncodeMs = round(now() - t);
    files.formula_1_furrows = bytes1Furrows;
    checksums.formula_1_furrows = SkinExchange.checksums(gray1Furrows);
    transfer.push(bytes1Furrows.buffer);

    stats.formula_1 = res1.diagnostics.formula_1.stats;

    // --- Formula 2 ---
    postProgress('compute formula_2');
    t = now();
    const req2 = {
        width: rect.width,
        height: rect.height,
        document: { width: document.width, height: document.height },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        pxPerMm: formulaParams.formula_2.pxPerMm,
        seed: common.seed !== undefined ? common.seed : formulaParams.formula_2.seed,
        lighting: {
            azimuthDeg: common.azimuthDeg !== undefined ? common.azimuthDeg : formulaParams.formula_2.azimuthDeg,
            elevationDeg: common.elevationDeg !== undefined ? common.elevationDeg : formulaParams.formula_2.elevationDeg
        },
        zone: 'cheek',
        params: {
            mode: common.mode || formulaParams.formula_2.mode || 'lines',
            ...common
        },
        presets: ['candidate2'],
        outputs: ['pores', 'furrows']
    };
    const res2 = wasmLoader.executeWasm(req2, wasmInstance);
    timings.formula2ComputeMs = round(now() - t);

    // Formula 2: pores
    postProgress('encode formula_2 pores');
    t = now();
    const gray2Pores = res2.layers.formula_2_pores;
    const bytes2Pores = SkinExchange.encode(
        { ...meta, output: 'formula_2_pores', formula_id: 'formula_2', formula_version: 1 },
        gray2Pores
    );
    timings.formula2PoresEncodeMs = round(now() - t);
    files.formula_2_pores = bytes2Pores;
    checksums.formula_2_pores = SkinExchange.checksums(gray2Pores);
    transfer.push(bytes2Pores.buffer);

    // Formula 2: furrows
    postProgress('encode formula_2 furrows');
    t = now();
    const gray2Furrows = res2.layers.formula_2_furrows;
    const bytes2Furrows = SkinExchange.encode(
        { ...meta, output: 'formula_2_furrows', formula_id: 'formula_2', formula_version: 1 },
        gray2Furrows
    );
    timings.formula2FurrowsEncodeMs = round(now() - t);
    files.formula_2_furrows = bytes2Furrows;
    checksums.formula_2_furrows = SkinExchange.checksums(gray2Furrows);
    transfer.push(bytes2Furrows.buffer);

    stats.formula_2 = res2.diagnostics.formula_2.stats;

    return { files, checksums, stats, timings, transfer };
}

module.exports = {
    computeSkinPairV1
};
