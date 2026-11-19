'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const {
    SUPPORTED_LAYER_KINDS,
    assertSupportedLayer,
    compositeLayerPixels,
    encodePngBytes,
    encodePngDataUrl,
    buildLayerGetPixelsOptions,
    captureLayerSelection
} = require('../../modules/copy-layer.js');
const { readImagePixelSize } = require('../../modules/image-size.js');

const modulesDir = path.resolve(__dirname, '..', '..', 'modules');

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

/**
 * Build an `imaging` override that records every getPixels request and returns one fixed
 * result whose imageData counts dispose() calls.
 */
function createFakeImaging({ sourceBounds, imageData, data }) {
    const state = { requests: [], disposed: 0 };
    return {
        state,
        async getPixels(opts) {
            state.requests.push(opts);
            return {
                sourceBounds,
                imageData: {
                    ...imageData,
                    async getData() { return data; },
                    dispose() { state.disposed++; }
                }
            };
        }
    };
}

function decodeDataUrl(dataUrl) {
    assert.ok(dataUrl.startsWith('data:image/png;base64,'));
    return decodePng(Buffer.from(dataUrl.split(',')[1], 'base64'));
}

function pixelAt(decoded, x, y) {
    const components = decoded.colorType === 6 ? 4 : 3;
    const idx = (y * decoded.width + x) * components;
    return Array.from(decoded.pixels.subarray(idx, idx + components));
}

test('buildLayerGetPixelsOptions omits componentSize only for Slow mode on 16-bit/32-bit documents', () => {
    const targetBounds = { left: 10, top: 20, right: 110, bottom: 120 };
    const layer = { id: 5 };
    const depths = [undefined, 8, 'bitDepth8', 16, 'bitDepth16', 32, 'bitDepth32'];
    const highDepths = new Set([16, 'bitDepth16', 32, 'bitDepth32']);

    for (const bitsPerChannel of depths) {
        const doc = { id: 3, bitsPerChannel };

        const fast = buildLayerGetPixelsOptions({ doc, layer, targetBounds, preserveTransparency: false });
        assert.deepEqual(fast, {
            documentID: 3,
            layerID: 5,
            sourceBounds: targetBounds,
            componentSize: 8,
            colorSpace: 'RGB',
            colorProfile: 'sRGB IEC61966-2.1',
            applyAlpha: true
        }, `Fast request must be unchanged for bitsPerChannel=${bitsPerChannel}`);

        const slow = buildLayerGetPixelsOptions({ doc, layer, targetBounds, preserveTransparency: true });
        assert.equal(slow.applyAlpha, false);
        assert.equal(slow.layerID, 5);
        if (highDepths.has(bitsPerChannel)) {
            assert.equal('componentSize' in slow, false, `Slow request must omit componentSize for ${bitsPerChannel}`);
        } else {
            assert.equal(slow.componentSize, 8, `Slow request must keep componentSize: 8 for ${bitsPerChannel}`);
        }
    }
});

test('captureLayerSelection Slow on a 16-bit document omits componentSize and normalizes Uint16Array at exact offsets with stride', async () => {
    // 2x2 RGBA layer patch at doc [12..14, 21..23]; each row has 2 padding elements (rowBytes = 10 * 2).
    const data = new Uint16Array([
        32768, 16384, 0, 32768,        8192, 24576, 32768, 16384,        7777, 7777,
        0, 0, 0, 0,                    1000, 2000, 3000, 4000,           7777, 7777
    ]);
    const fake = createFakeImaging({
        sourceBounds: { left: 12, top: 21, right: 14, bottom: 23 },
        imageData: { width: 2, height: 2, components: 4, componentSize: 16, rowBytes: 20 },
        data
    });

    const url = await captureLayerSelection({
        doc: { id: 7, bitsPerChannel: 'bitDepth16' },
        layer: { id: 2, name: 'Deep', kind: 'pixel' },
        bounds: { left: 10, top: 20, width: 6, height: 4 },
        preserveTransparency: true,
        imaging: fake
    });

    assert.equal(fake.state.requests.length, 1);
    assert.deepEqual(fake.state.requests[0], {
        documentID: 7,
        layerID: 2,
        sourceBounds: { left: 10, top: 20, right: 16, bottom: 24 },
        colorSpace: 'RGB',
        colorProfile: 'sRGB IEC61966-2.1',
        applyAlpha: false
    });
    assert.equal('componentSize' in fake.state.requests[0], false);
    assert.equal(fake.state.disposed, 1);

    const decoded = decodeDataUrl(url);
    assert.equal(decoded.width, 6);
    assert.equal(decoded.height, 4);
    assert.equal(decoded.colorType, 6);
    assert.deepEqual(pixelAt(decoded, 2, 1), [255, 128, 0, 255]);
    assert.deepEqual(pixelAt(decoded, 3, 1), [64, 191, 255, 128]);
    assert.deepEqual(pixelAt(decoded, 2, 2), [0, 0, 0, 0]);
    assert.deepEqual(pixelAt(decoded, 3, 2), [8, 16, 23, 31]);

    // Everything outside the 2x2 patch must stay fully transparent (no stride padding leaking in).
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 6; x++) {
            if (x >= 2 && x <= 3 && y >= 1 && y <= 2) continue;
            assert.deepEqual(pixelAt(decoded, x, y), [0, 0, 0, 0], `pixel (${x}, ${y}) must be transparent`);
        }
    }
});

test('captureLayerSelection Slow on a 32-bit document omits componentSize and normalizes Float32Array (opaque RGB, stride) at exact offsets', async () => {
    // 2x2 RGB (no alpha, e.g. Background) patch at doc [101..103, 51..53]; 1 padding element per row.
    const data = new Float32Array([
        0, 0.5, 1,                 0.2, 1.4, -0.3,   9,
        Number.NaN, 0.25, 0.75,    1, 1, 1,          9
    ]);
    const fake = createFakeImaging({
        sourceBounds: { left: 101, top: 51, right: 103, bottom: 53 },
        imageData: { width: 2, height: 2, components: 3, componentSize: 32, rowBytes: 28 },
        data
    });

    const url = await captureLayerSelection({
        doc: { id: 8, bitsPerChannel: 32 },
        layer: { id: 4, name: 'HDR', kind: 'smartObject' },
        bounds: { left: 100, top: 50, width: 5, height: 4 },
        preserveTransparency: true,
        imaging: fake
    });

    assert.equal('componentSize' in fake.state.requests[0], false);
    assert.equal(fake.state.requests[0].applyAlpha, false);
    assert.equal(fake.state.requests[0].layerID, 4);
    assert.equal(fake.state.disposed, 1);

    const decoded = decodeDataUrl(url);
    assert.equal(decoded.width, 5);
    assert.equal(decoded.height, 4);
    assert.equal(decoded.colorType, 6);
    assert.deepEqual(pixelAt(decoded, 1, 1), [0, 128, 255, 255]);
    assert.deepEqual(pixelAt(decoded, 2, 1), [51, 255, 0, 255]);
    assert.deepEqual(pixelAt(decoded, 1, 2), [0, 64, 191, 255]);
    assert.deepEqual(pixelAt(decoded, 2, 2), [255, 255, 255, 255]);
    assert.deepEqual(pixelAt(decoded, 0, 0), [0, 0, 0, 0]);
    assert.deepEqual(pixelAt(decoded, 3, 1), [0, 0, 0, 0]);
    assert.deepEqual(pixelAt(decoded, 4, 3), [0, 0, 0, 0]);
});

test('captureLayerSelection Slow on a 16-bit document crops layer pixels that extend past the capture frame', async () => {
    // 4x1 RGBA strip at doc x [8..12]; the capture frame starts at x=10, so strip columns 2 and 3
    // land at frame columns 0 and 1 and frame column 2 has no layer pixels.
    const data = new Uint16Array([
        1, 1, 1, 1,   2, 2, 2, 2,   32768, 0, 0, 32768,   0, 32768, 0, 32768
    ]);
    const fake = createFakeImaging({
        sourceBounds: { left: 8, top: 5, right: 12, bottom: 6 },
        imageData: { width: 4, height: 1, components: 4, componentSize: 16, rowBytes: 32 },
        data
    });

    const url = await captureLayerSelection({
        doc: { id: 9, bitsPerChannel: 'bitDepth16' },
        layer: { id: 1, name: 'Strip', kind: 'pixel' },
        bounds: { left: 10, top: 5, width: 3, height: 1 },
        preserveTransparency: true,
        imaging: fake
    });

    const decoded = decodeDataUrl(url);
    assert.equal(decoded.width, 3);
    assert.equal(decoded.height, 1);
    assert.deepEqual(pixelAt(decoded, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixelAt(decoded, 1, 0), [0, 255, 0, 255]);
    assert.deepEqual(pixelAt(decoded, 2, 0), [0, 0, 0, 0]);
});

test('captureLayerSelection Slow on a 16-bit document still returns a transparent empty PNG on "No pixels"', async () => {
    const requests = [];
    const url = await captureLayerSelection({
        doc: { id: 9, bitsPerChannel: 'bitDepth16' },
        layer: { id: 1, name: 'Empty', kind: 'pixel' },
        bounds: { left: 0, top: 0, width: 3, height: 2 },
        preserveTransparency: true,
        imaging: {
            async getPixels(opts) {
                requests.push(opts);
                throw new Error('No pixels in the requested area');
            }
        }
    });

    assert.equal('componentSize' in requests[0], false);
    const decoded = decodeDataUrl(url);
    assert.equal(decoded.width, 3);
    assert.equal(decoded.height, 2);
    assert.equal(decoded.colorType, 6);
    assert.ok(decoded.pixels.every(v => v === 0));
});

test('captureLayerSelection Slow on a 16-bit document surfaces missing pixel data loudly and still disposes imageData', async () => {
    const fake = createFakeImaging({
        sourceBounds: { left: 0, top: 0, right: 1, bottom: 1 },
        imageData: { width: 1, height: 1, components: 4, componentSize: 16, rowBytes: 8 },
        data: null
    });

    await assert.rejects(
        () => captureLayerSelection({
            doc: { id: 9, bitsPerChannel: 'bitDepth16' },
            layer: { id: 1, name: 'Broken', kind: 'pixel' },
            bounds: { left: 0, top: 0, width: 1, height: 1 },
            preserveTransparency: true,
            imaging: fake
        }),
        /empty pixel data for Copy layer/
    );
    assert.equal(fake.state.disposed, 1);
});

test('captureLayerSelection Fast on 16-bit and 32-bit documents keeps componentSize: 8 and the 8-bit white-background output', async () => {
    for (const bitsPerChannel of ['bitDepth16', 16, 'bitDepth32', 32]) {
        // 2x1 opaque RGB (applyAlpha: true) at doc x [11..13]; frame is 4x2 at (10, 5).
        const fake = createFakeImaging({
            sourceBounds: { left: 11, top: 5, right: 13, bottom: 6 },
            imageData: { width: 2, height: 1, components: 3, componentSize: 8, rowBytes: 6 },
            data: new Uint8Array([10, 20, 30, 40, 50, 60])
        });

        const url = await captureLayerSelection({
            doc: { id: 11, bitsPerChannel },
            layer: { id: 6, name: 'Fast', kind: 'pixel' },
            bounds: { left: 10, top: 5, width: 4, height: 2 },
            preserveTransparency: false,
            imaging: fake
        });

        assert.deepEqual(fake.state.requests[0], {
            documentID: 11,
            layerID: 6,
            sourceBounds: { left: 10, top: 5, right: 14, bottom: 7 },
            componentSize: 8,
            colorSpace: 'RGB',
            colorProfile: 'sRGB IEC61966-2.1',
            applyAlpha: true
        }, `Fast request must be unchanged for bitsPerChannel=${bitsPerChannel}`);
        assert.equal(fake.state.disposed, 1);

        const decoded = decodeDataUrl(url);
        assert.equal(decoded.width, 4);
        assert.equal(decoded.height, 2);
        assert.equal(decoded.colorType, 2);
        assert.deepEqual(pixelAt(decoded, 0, 0), [255, 255, 255]);
        assert.deepEqual(pixelAt(decoded, 1, 0), [10, 20, 30]);
        assert.deepEqual(pixelAt(decoded, 2, 0), [40, 50, 60]);
        assert.deepEqual(pixelAt(decoded, 3, 0), [255, 255, 255]);
        assert.deepEqual(pixelAt(decoded, 1, 1), [255, 255, 255]);
    }
});

test('captureLayerSelection Slow on 8-bit documents keeps componentSize: 8 and uses Uint8 data with stride unchanged', async () => {
    for (const bitsPerChannel of ['bitDepth8', 8, undefined]) {
        // 2x2 RGBA at doc [1..3, 1..3] with 2 bytes of row padding (rowBytes = 10).
        const fake = createFakeImaging({
            sourceBounds: { left: 1, top: 1, right: 3, bottom: 3 },
            imageData: { width: 2, height: 2, components: 4, componentSize: 8, rowBytes: 10 },
            data: new Uint8Array([
                10, 20, 30, 128,  40, 50, 60, 255,  99, 99,
                70, 80, 90, 64,   100, 110, 120, 200,  99, 99
            ])
        });

        const url = await captureLayerSelection({
            doc: { id: 12, bitsPerChannel },
            layer: { id: 3, name: 'Plain', kind: 'pixel' },
            bounds: { left: 0, top: 0, width: 4, height: 4 },
            preserveTransparency: true,
            imaging: fake
        });

        assert.deepEqual(fake.state.requests[0], {
            documentID: 12,
            layerID: 3,
            sourceBounds: { left: 0, top: 0, right: 4, bottom: 4 },
            componentSize: 8,
            colorSpace: 'RGB',
            colorProfile: 'sRGB IEC61966-2.1',
            applyAlpha: false
        }, `Slow request must be unchanged for bitsPerChannel=${bitsPerChannel}`);

        const decoded = decodeDataUrl(url);
        assert.equal(decoded.colorType, 6);
        assert.deepEqual(pixelAt(decoded, 0, 0), [0, 0, 0, 0]);
        assert.deepEqual(pixelAt(decoded, 1, 1), [10, 20, 30, 128]);
        assert.deepEqual(pixelAt(decoded, 2, 1), [40, 50, 60, 255]);
        assert.deepEqual(pixelAt(decoded, 1, 2), [70, 80, 90, 64]);
        assert.deepEqual(pixelAt(decoded, 2, 2), [100, 110, 120, 200]);
    }
});

test('bit-depth helpers are implemented once in pixel-depth.js and copy-layer.js does not require copy-merged.js', () => {
    const pixelDepth = require('../../modules/pixel-depth.js');
    const copyMerged = require('../../modules/copy-merged.js');

    // copy-merged.js keeps exporting the same names, backed by the single shared implementation.
    assert.equal(copyMerged.isHighBitDepth, pixelDepth.isHighBitDepth);
    assert.equal(copyMerged.normalizeToUint8Pixels, pixelDepth.normalizeToUint8Pixels);

    const copyLayerSource = fs.readFileSync(path.join(modulesDir, 'copy-layer.js'), 'utf8');
    const copyMergedSource = fs.readFileSync(path.join(modulesDir, 'copy-merged.js'), 'utf8');
    assert.doesNotMatch(copyLayerSource, /require\(\s*['"]\.\/copy-merged(\.js)?['"]\s*\)/);
    assert.doesNotMatch(copyLayerSource, /function\s+(isHighBitDepth|normalizeToUint8Pixels)\b/);
    assert.doesNotMatch(copyMergedSource, /function\s+(isHighBitDepth|normalizeToUint8Pixels)\b/);
});
