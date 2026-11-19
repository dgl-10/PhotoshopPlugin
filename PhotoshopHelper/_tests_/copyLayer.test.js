'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');

const {
    SUPPORTED_LAYER_KINDS,
    assertSupportedLayer,
    compositeLayerPixels,
    encodePngBytes,
    encodePngDataUrl,
    captureLayerSelection
} = require('../../modules/copy-layer.js');
const { readImagePixelSize } = require('../../modules/image-size.js');

/**
 * Decode a PNG produced by copy-layer.js using Node's zlib to verify headers,
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

test('assertSupportedLayer accepts pixel, smartObject, text, solidColor, gradientFill, and pattern', () => {
    for (const kind of ['pixel', 'smartObject', 'text', 'solidColor', 'gradientFill', 'pattern']) {
        assert.ok(SUPPORTED_LAYER_KINDS.has(kind));
        assert.doesNotThrow(() => assertSupportedLayer({ name: `Layer ${kind}`, kind }));
    }
});

test('assertSupportedLayer rejects missing layer, groups, adjustment layers, and unknown kinds with layer name, type, and Copy merged hint', () => {
    assert.throws(
        () => assertSupportedLayer(null),
        /No active layer.*Copy merged/i
    );

    assert.throws(
        () => assertSupportedLayer({ name: 'Hero Group', kind: 'group' }),
        err => /"Hero Group"/.test(err.message)
            && /group/i.test(err.message)
            && /Copy merged/.test(err.message)
    );

    assert.throws(
        () => assertSupportedLayer({ name: 'Tone Curves', kind: 'curves' }),
        err => /"Tone Curves"/.test(err.message)
            && /Curves adjustment layer/i.test(err.message)
            && /Copy merged/.test(err.message)
    );

    assert.throws(
        () => assertSupportedLayer({ name: 'FutureFX', kind: 'customAlien' }),
        err => /"FutureFX"/.test(err.message)
            && /customAlien layer/i.test(err.message)
            && /Copy merged/.test(err.message)
    );
});

test('compositeLayerPixels places cropped layer pixels at exact document offsets on white (Fast) and transparent (Slow)', () => {
    const targetBounds = { left: 100, top: 200, right: 110, bottom: 208, width: 10, height: 8 };
    // Layer only exists at [104..107, 202..205] -> 3x3 patch
    const srcBounds = { left: 104, top: 202, right: 107, bottom: 205 };

    // Fast (3-component RGB on white)
    const srcRgb = new Uint8Array([
        10, 20, 30, 11, 21, 31, 12, 22, 32,
        40, 50, 60, 41, 51, 61, 42, 52, 62,
        70, 80, 90, 71, 81, 91, 72, 82, 92
    ]);
    const fast = compositeLayerPixels({
        targetBounds,
        sourceBounds: srcBounds,
        sourcePixels: srcRgb,
        sourceWidth: 3,
        sourceHeight: 3,
        sourceComponents: 3,
        preserveTransparency: false
    });
    assert.equal(fast.width, 10);
    assert.equal(fast.height, 8);
    assert.equal(fast.components, 3);
    // Top-left empty corner (doc 100, 200 -> local 0, 0) must be white
    assert.deepEqual(Array.from(fast.pixels.subarray(0, 3)), [255, 255, 255]);
    // Doc (105, 203) -> local (5, 3), which is src (1, 1) -> [41, 51, 61]
    const fastIdx = (3 * 10 + 5) * 3;
    assert.deepEqual(Array.from(fast.pixels.subarray(fastIdx, fastIdx + 3)), [41, 51, 61]);

    // Slow (4-component RGBA on transparent)
    const srcRgba = new Uint8Array([
        10, 20, 30, 128, 11, 21, 31, 200, 12, 22, 32, 255,
        40, 50, 60, 128, 41, 51, 61, 200, 42, 52, 62, 255,
        70, 80, 90, 128, 71, 81, 91, 200, 72, 82, 92, 255
    ]);
    const slow = compositeLayerPixels({
        targetBounds,
        sourceBounds: srcBounds,
        sourcePixels: srcRgba,
        sourceWidth: 3,
        sourceHeight: 3,
        sourceComponents: 4,
        preserveTransparency: true
    });
    assert.equal(slow.width, 10);
    assert.equal(slow.height, 8);
    assert.equal(slow.components, 4);
    assert.deepEqual(Array.from(slow.pixels.subarray(0, 4)), [0, 0, 0, 0]);
    const slowIdx = (3 * 10 + 5) * 4;
    assert.deepEqual(Array.from(slow.pixels.subarray(slowIdx, slowIdx + 4)), [41, 51, 61, 200]);
});

test('compositeLayerPixels handles opaque 3-component layer in Slow mode and sourceRowBytes stride', () => {
    const targetBounds = { left: 0, top: 0, width: 4, height: 4 };
    const srcBounds = { left: 1, top: 1, right: 3, bottom: 3 };
    // 2x2 RGB with rowBytes = 8 (2 bytes padding per row)
    const paddedRgb = new Uint8Array([
        1, 2, 3, 4, 5, 6, 99, 99,
        7, 8, 9, 10, 11, 12, 99, 99
    ]);

    const slow = compositeLayerPixels({
        targetBounds,
        sourceBounds: srcBounds,
        sourcePixels: paddedRgb,
        sourceWidth: 2,
        sourceHeight: 2,
        sourceComponents: 3,
        sourceRowBytes: 8,
        preserveTransparency: true
    });

    // Outside (0, 0) is transparent
    assert.deepEqual(Array.from(slow.pixels.subarray(0, 4)), [0, 0, 0, 0]);
    // Inside (1, 1) gets RGB + A=255
    const idx11 = (1 * 4 + 1) * 4;
    assert.deepEqual(Array.from(slow.pixels.subarray(idx11, idx11 + 4)), [1, 2, 3, 255]);
    // Inside (2, 2) gets RGB from second row + A=255 (skipping stride padding)
    const idx22 = (2 * 4 + 2) * 4;
    assert.deepEqual(Array.from(slow.pixels.subarray(idx22, idx22 + 4)), [10, 11, 12, 255]);
});

test('encodePngBytes round-trips RGB, RGBA, and incompressible random pixels cleanly through zlib.inflateSync', () => {
    // 1. RGBA with mostly transparent + colored block
    const w = 64, h = 48;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 10; y < 30; y++) {
        for (let x = 15; x < 45; x++) {
            const i = (y * w + x) * 4;
            rgba[i] = (x * 4) & 255;
            rgba[i + 1] = (y * 5) & 255;
            rgba[i + 2] = 200;
            rgba[i + 3] = 180;
        }
    }
    const pngRgba = encodePngBytes(rgba, w, h, 4);
    assert.deepEqual(readImagePixelSize(pngRgba), { width: w, height: h });
    const decodedRgba = decodePng(pngRgba);
    assert.equal(decodedRgba.colorType, 6);
    assert.deepEqual(decodedRgba.pixels, rgba);

    // 2. Noisy incompressible RGB (triggers stored-block fallback if compressed > stored)
    const nw = 120, nh = 90;
    const noisy = new Uint8Array(nw * nh * 3);
    let seed = 0x12345678;
    for (let i = 0; i < noisy.length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        noisy[i] = (seed >>> 24) & 255;
    }
    const pngNoisy = encodePngBytes(noisy, nw, nh, 3);
    assert.deepEqual(readImagePixelSize(pngNoisy), { width: nw, height: nh });
    const decodedNoisy = decodePng(pngNoisy);
    assert.equal(decodedNoisy.colorType, 2);
    assert.deepEqual(decodedNoisy.pixels, noisy);
});

test('captureLayerSelection returns white/transparent empty PNG when Photoshop reports "No pixels in the requested area"', async () => {
    let disposedCount = 0;
    const fakeImagingNoPixels = {
        async getPixels() {
            const err = new Error('No pixels in the requested area');
            err.number = 1;
            throw err;
        }
    };

    const fastUrl = await captureLayerSelection({
        doc: { id: 1 },
        layer: { id: 2, name: 'EmptySpot', kind: 'pixel' },
        bounds: { left: 10, top: 20, right: 26, bottom: 32, width: 16, height: 12 },
        preserveTransparency: false,
        imaging: fakeImagingNoPixels
    });
    assert.ok(fastUrl.startsWith('data:image/png;base64,'));
    const decodedFast = decodePng(Buffer.from(fastUrl.split(',')[1], 'base64'));
    assert.equal(decodedFast.width, 16);
    assert.equal(decodedFast.height, 12);
    assert.equal(decodedFast.colorType, 2);
    assert.ok(decodedFast.pixels.every(v => v === 255));

    const slowUrl = await captureLayerSelection({
        doc: { id: 1 },
        layer: { id: 2, name: 'EmptySpot', kind: 'pixel' },
        bounds: { left: 10, top: 20, right: 26, bottom: 32, width: 16, height: 12 },
        preserveTransparency: true,
        imaging: fakeImagingNoPixels
    });
    const decodedSlow = decodePng(Buffer.from(slowUrl.split(',')[1], 'base64'));
    assert.equal(decodedSlow.width, 16);
    assert.equal(decodedSlow.height, 12);
    assert.equal(decodedSlow.colorType, 6);
    assert.ok(decodedSlow.pixels.every(v => v === 0));

    // Also verify imageData.dispose() is always called on normal capture
    const fakeImagingWithData = {
        async getPixels(opts) {
            assert.equal(opts.documentID, 1);
            assert.equal(opts.layerID, 2);
            assert.equal(opts.componentSize, 8);
            assert.equal(opts.colorSpace, 'RGB');
            assert.equal(opts.colorProfile, 'sRGB IEC61966-2.1');
            assert.equal(opts.applyAlpha, false);
            return {
                sourceBounds: { left: 12, top: 22, right: 14, bottom: 24 },
                imageData: {
                    width: 2,
                    height: 2,
                    components: 4,
                    async getData() {
                        return new Uint8Array([
                            10, 20, 30, 255, 40, 50, 60, 128,
                            70, 80, 90, 64, 100, 110, 120, 255
                        ]);
                    },
                    dispose() {
                        disposedCount++;
                    }
                }
            };
        }
    };
    const dataUrl = await captureLayerSelection({
        doc: { id: 1 },
        layer: { id: 2, name: 'Patch', kind: 'smartObject' },
        bounds: { left: 10, top: 20, width: 8, height: 6 },
        preserveTransparency: true,
        imaging: fakeImagingWithData
    });
    assert.equal(disposedCount, 1);
    const decoded = decodePng(Buffer.from(dataUrl.split(',')[1], 'base64'));
    assert.equal(decoded.width, 8);
    assert.equal(decoded.height, 6);
    const px = (2 * 8 + 2) * 4;
    assert.deepEqual(Array.from(decoded.pixels.subarray(px, px + 4)), [10, 20, 30, 255]);
});

test('encodePngDataUrl encodes valid data URL prefix', () => {
    const url = encodePngDataUrl(new Uint8Array([255, 0, 0, 255]), 1, 1, 4);
    assert.ok(url.startsWith('data:image/png;base64,'));
});
