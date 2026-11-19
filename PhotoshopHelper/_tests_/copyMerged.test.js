'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const {
    isHighBitDepth,
    buildGetPixelsOptions,
    normalizeToUint8Pixels,
    alignCompositeFrame,
    captureMergedSelection
} = require('../../modules/copy-merged.js');

const repositoryRoot = path.resolve(__dirname, '..', '..');

/**
 * Decode a PNG produced by copy-merged.js using Node's zlib to verify headers,
 * chunk CRCs, Sub filter reversal, and exact pixel values.
 *
 * @param {Buffer|Uint8Array} pngBytes
 * @returns {{width: number, height: number, colorType: number, pixels: Uint8Array}}
 */
function decodePng(pngBytes) {
    const buf = Buffer.from(pngBytes);
    assert.deepEqual(
        Array.from(buf.subarray(0, 8)),
        [137, 80, 78, 71, 13, 10, 26, 10],
        'PNG signature mismatch'
    );

    let offset = 8;
    let width = 0;
    let height = 0;
    let colorType = 0;
    const idatChunks = [];

    while (offset < buf.length) {
        const len = buf.readUInt32BE(offset);
        const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
        const data = buf.subarray(offset + 8, offset + 8 + len);
        const expectedCrc = buf.readUInt32BE(offset + 8 + len);
        const actualCrc = zlib.crc32(buf.subarray(offset + 4, offset + 8 + len)) >>> 0;
        assert.equal(actualCrc, expectedCrc, `CRC mismatch for chunk ${type}`);

        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            assert.equal(data[8], 8, 'bit depth must be 8');
            colorType = data[9];
        } else if (type === 'IDAT') {
            idatChunks.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset += 12 + len;
    }

    const components = colorType === 6 ? 4 : 3;
    const rawScanlines = zlib.inflateSync(Buffer.concat(idatChunks));
    const rowBytes = width * components;
    assert.equal(rawScanlines.length, (rowBytes + 1) * height);

    const pixels = new Uint8Array(width * height * components);
    for (let y = 0; y < height; y++) {
        const srcOff = y * (rowBytes + 1);
        const dstOff = y * rowBytes;
        const filterType = rawScanlines[srcOff];
        assert.equal(filterType, 1, 'expected Sub filter');
        for (let x = 0; x < rowBytes; x++) {
            const left = x >= components ? pixels[dstOff + x - components] : 0;
            pixels[dstOff + x] = (rawScanlines[srcOff + 1 + x] + left) & 0xff;
        }
    }

    return { width, height, colorType, pixels };
}

test('isHighBitDepth detects 16-bit and 32-bit numeric and enum values', () => {
    assert.equal(isHighBitDepth({ bitsPerChannel: 8 }), false);
    assert.equal(isHighBitDepth({ bitsPerChannel: 'bitDepth8' }), false);
    assert.equal(isHighBitDepth({}), false);
    assert.equal(isHighBitDepth({ bitsPerChannel: 16 }), true);
    assert.equal(isHighBitDepth({ bitsPerChannel: 'bitDepth16' }), true);
    assert.equal(isHighBitDepth({ bitsPerChannel: 32 }), true);
    assert.equal(isHighBitDepth({ bitsPerChannel: 'bitDepth32' }), true);
});

test('buildGetPixelsOptions omits layerID, disables applyAlpha, and omits componentSize for 16/32-bit docs', () => {
    const targetBounds = { left: 10, top: 20, right: 110, bottom: 120 };

    const opts8 = buildGetPixelsOptions({
        doc: { id: 42, bitsPerChannel: 'bitDepth8' },
        targetBounds
    });
    assert.equal(opts8.documentID, 42);
    assert.equal('layerID' in opts8, false);
    assert.equal(opts8.applyAlpha, false);
    assert.equal(opts8.colorSpace, 'RGB');
    assert.equal(opts8.colorProfile, 'sRGB IEC61966-2.1');
    assert.equal(opts8.componentSize, 8);
    assert.deepEqual(opts8.sourceBounds, targetBounds);

    const opts16 = buildGetPixelsOptions({
        doc: { id: 43, bitsPerChannel: 'bitDepth16' },
        targetBounds
    });
    assert.equal('componentSize' in opts16, false);
    assert.equal(opts16.applyAlpha, false);

    const opts32 = buildGetPixelsOptions({
        doc: { id: 44, bitsPerChannel: 32 },
        targetBounds
    });
    assert.equal('componentSize' in opts32, false);
});

test('normalizeToUint8Pixels converts 16-bit [0..32768] and 32-bit [0..1] pixels and handles stride padding', () => {
    // 16-bit 2x1 RGBA with 2-element (4-byte) padding per row
    const u16 = new Uint16Array([
        0, 16384, 32768, 16384,   999, 999,
        32768, 0, 8192, 32768,    999, 999
    ]);
    // 1 row = 4 elements * 2 bytes = 8 bytes + 4 bytes padding = 12 bytes
    const norm16 = normalizeToUint8Pixels(u16, {
        width: 1,
        height: 2,
        components: 4,
        componentSize: 16,
        rowBytes: 12
    });
    assert.equal(norm16.rowBytes, 4);
    assert.deepEqual(Array.from(norm16.pixels), [
        0, 128, 255, 128,
        255, 0, 64, 255
    ]);

    // 16-bit passed as ArrayBuffer
    const buf16 = new Uint16Array([32768, 16384, 0, 16384]).buffer;
    const normBuf16 = normalizeToUint8Pixels(buf16, {
        width: 1,
        height: 1,
        components: 4,
        componentSize: 16
    });
    assert.deepEqual(Array.from(normBuf16.pixels), [255, 128, 0, 128]);

    // 32-bit Float32Array with clamping for out-of-range and NaN
    const f32 = new Float32Array([-0.2, 0.5, 1.4, Number.NaN]);
    const norm32 = normalizeToUint8Pixels(f32, {
        width: 1,
        height: 1,
        components: 4,
        componentSize: 32
    });
    assert.deepEqual(Array.from(norm32.pixels), [0, 128, 255, 0]);
});

test('alignCompositeFrame aligns cropped sourceBounds, expands 3-component opaque pixels, and strips 8-bit stride', () => {
    const targetBounds = { left: 10, top: 20, right: 14, bottom: 24, width: 4, height: 4 };

    // Cropped 2x2 RGBA patch at [11..13, 21..23] with 2 bytes row padding
    const padded = new Uint8Array([
        10, 20, 30, 128,  40, 50, 60, 255,  99, 99,
        70, 80, 90, 64,   100, 110, 120, 200,  99, 99
    ]);
    const aligned = alignCompositeFrame({
        targetBounds,
        sourceBounds: { left: 11, top: 21, right: 13, bottom: 23 },
        pixels: padded,
        width: 2,
        height: 2,
        components: 4,
        rowBytes: 10
    });
    assert.equal(aligned.width, 4);
    assert.equal(aligned.height, 4);
    assert.equal(aligned.components, 4);
    // Corner (0, 0) outside sourceBounds must be transparent
    assert.deepEqual(Array.from(aligned.pixels.subarray(0, 4)), [0, 0, 0, 0]);
    // Local (1, 1) corresponds to first pixel of patch
    const px11 = (1 * 4 + 1) * 4;
    assert.deepEqual(Array.from(aligned.pixels.subarray(px11, px11 + 4)), [10, 20, 30, 128]);
    // Local (2, 2) corresponds to bottom-right pixel of patch
    const px22 = (2 * 4 + 2) * 4;
    assert.deepEqual(Array.from(aligned.pixels.subarray(px22, px22 + 4)), [100, 110, 120, 200]);

    // 3-component opaque buffer becomes 4-component RGBA with alpha=255
    const rgb = new Uint8Array(4 * 4 * 3).fill(77);
    const opaque = alignCompositeFrame({
        targetBounds,
        sourceBounds: targetBounds,
        pixels: rgb,
        width: 4,
        height: 4,
        components: 3,
        rowBytes: 12
    });
    assert.equal(opaque.components, 4);
    assert.deepEqual(Array.from(opaque.pixels.subarray(0, 4)), [77, 77, 77, 255]);
});

test('captureMergedSelection produces transparent PNGs, disposes imageData, and surfaces errors loudly', async () => {
    let disposedCount = 0;

    // 1. 8-bit composite capture
    const url8 = await captureMergedSelection({
        doc: { id: 10, bitsPerChannel: 'bitDepth8' },
        bounds: { left: 0, top: 0, right: 2, bottom: 2, width: 2, height: 2 },
        imaging: {
            async getPixels(opts) {
                assert.equal(opts.documentID, 10);
                assert.equal('layerID' in opts, false);
                assert.equal(opts.applyAlpha, false);
                assert.equal(opts.componentSize, 8);
                return {
                    sourceBounds: { left: 0, top: 0, right: 2, bottom: 2 },
                    imageData: {
                        width: 2,
                        height: 2,
                        components: 4,
                        componentSize: 8,
                        async getData() {
                            return new Uint8Array([
                                255, 0, 0, 255,    0, 255, 0, 128,
                                0, 0, 255, 16,     255, 255, 255, 0
                            ]);
                        },
                        dispose() { disposedCount++; }
                    }
                };
            }
        }
    });
    assert.equal(disposedCount, 1);
    const dec8 = decodePng(Buffer.from(url8.split(',')[1], 'base64'));
    assert.equal(dec8.colorType, 6);
    assert.deepEqual(Array.from(dec8.pixels), [
        255, 0, 0, 255,    0, 255, 0, 128,
        0, 0, 255, 16,     255, 255, 255, 0
    ]);

    // 2. 16-bit composite capture omits componentSize and normalizes Uint16Array
    const url16 = await captureMergedSelection({
        doc: { id: 11, bitsPerChannel: 'bitDepth16' },
        bounds: { left: 5, top: 5, right: 7, bottom: 6, width: 2, height: 1 },
        imaging: {
            async getPixels(opts) {
                assert.equal('componentSize' in opts, false);
                return {
                    sourceBounds: { left: 5, top: 5, right: 7, bottom: 6 },
                    imageData: {
                        width: 2,
                        height: 1,
                        components: 4,
                        componentSize: 16,
                        async getData() {
                            return new Uint16Array([32768, 16384, 0, 16384,  0, 0, 32768, 0]);
                        },
                        dispose() { disposedCount++; }
                    }
                };
            }
        }
    });
    assert.equal(disposedCount, 2);
    const dec16 = decodePng(Buffer.from(url16.split(',')[1], 'base64'));
    assert.deepEqual(Array.from(dec16.pixels), [255, 128, 0, 128, 0, 0, 255, 0]);

    // 3. "No pixels" returns empty transparent PNG
    const urlEmpty = await captureMergedSelection({
        doc: { id: 12, bitsPerChannel: 'bitDepth8' },
        bounds: { left: 0, top: 0, width: 3, height: 2 },
        imaging: {
            async getPixels() {
                throw new Error('No pixels in the requested area');
            }
        }
    });
    const decEmpty = decodePng(Buffer.from(urlEmpty.split(',')[1], 'base64'));
    assert.equal(decEmpty.width, 3);
    assert.equal(decEmpty.height, 2);
    assert.equal(decEmpty.colorType, 6);
    assert.ok(decEmpty.pixels.every(v => v === 0));

    // 4. Fatal error propagates without being hidden; dispose still runs if getData fails
    await assert.rejects(
        () => captureMergedSelection({
            doc: { id: 13, bitsPerChannel: 'bitDepth8' },
            bounds: { left: 0, top: 0, width: 2, height: 2 },
            imaging: {
                async getPixels() {
                    return {
                        imageData: {
                            width: 2,
                            height: 2,
                            components: 4,
                            async getData() {
                                throw new Error('Simulated getData failure');
                            },
                            dispose() { disposedCount++; }
                        }
                    };
                }
            }
        }),
        /Simulated getData failure/
    );
    assert.equal(disposedCount, 3);
});

test('ps.js defaults FAST_COPY_MERGED_TRANSPARENCY to false and leaves legacy path intact', () => {
    const psJs = fs.readFileSync(path.join(repositoryRoot, 'modules', 'ps.js'), 'utf8');
    assert.match(psJs, /^const FAST_COPY_MERGED_TRANSPARENCY = false;/m);
    assert.match(psJs, /if \(FAST_COPY_MERGED_TRANSPARENCY\) \{[\s\S]*copyMerged\.captureMergedSelection\(/);
    assert.match(psJs, /async function captureSelectionAsBase64PNG\(/);
});
