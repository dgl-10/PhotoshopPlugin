/**
 * Copy Layer Capture Module
 * Captures the active Photoshop layer within the requested document bounds,
 * preserving its exact position, dimensions, masks, and smart filters while
 * excluding layer effects, opacity/fill, clipping bases, and clipped layers.
 *
 * Pure helpers (validation, pixel compositing, PNG encoding) have no top-level
 * Photoshop dependency so they can be unit-tested in Node.
 */

const { isHighBitDepth, normalizeToUint8Pixels } = require('./pixel-depth.js');

// Allowlist of layer kinds whose pixels can be captured directly via imaging.getPixels.
// Shape layers report as solidColor, gradientFill, or pattern depending on fill type.
const SUPPORTED_LAYER_KINDS = new Set([
    'pixel',
    'smartObject',
    'text',
    'solidColor',
    'gradientFill',
    'pattern'
]);

const UNSUPPORTED_KIND_LABELS = {
    group: 'group',
    blackAndWhite: 'Black & White adjustment layer',
    brightnessContrast: 'Brightness/Contrast adjustment layer',
    channelMixer: 'Channel Mixer adjustment layer',
    clarity: 'Clarity adjustment layer',
    colorBalance: 'Color Balance adjustment layer',
    colorLookup: 'Color Lookup adjustment layer',
    curves: 'Curves adjustment layer',
    exposure: 'Exposure adjustment layer',
    gradientMap: 'Gradient Map adjustment layer',
    grainAdjustment: 'Grain adjustment layer',
    hueSaturation: 'Hue/Saturation adjustment layer',
    inversion: 'Invert adjustment layer',
    levels: 'Levels adjustment layer',
    photoFilter: 'Photo Filter adjustment layer',
    posterize: 'Posterize adjustment layer',
    selectiveColor: 'Selective Color adjustment layer',
    threshold: 'Threshold adjustment layer',
    vibrance: 'Vibrance adjustment layer',
    threeD: '3D layer',
    video: 'video layer'
};

const MAX_LAYER_NAME_IN_ERROR = 40;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

// Precomputed RFC 1951 fixed Huffman tables and CRC-32 table (built lazily once).
let deflateTables = null;
let pngCrcTable = null;

/**
 * Format a Photoshop layer kind string into a readable label for error messages.
 * @param {string} kind
 * @returns {string}
 */
function formatLayerTypeLabel(kind) {
    if (!kind) return 'unknown layer type';
    return UNSUPPORTED_KIND_LABELS[kind] || `${kind} layer`;
}

/**
 * Validate that the active layer can be captured by Copy layer.
 * Throws a user-facing error naming the layer, its type, and suggesting Copy merged.
 * @param {object|null|undefined} layer
 */
function assertSupportedLayer(layer) {
    if (!layer) {
        throw new Error('No active layer selected. Select a layer or use Copy merged.');
    }

    const kind = layer.kind ? String(layer.kind) : '';
    if (SUPPORTED_LAYER_KINDS.has(kind)) {
        return;
    }

    const rawName = typeof layer.name === 'string' && layer.name.trim()
        ? layer.name.trim()
        : 'Unnamed layer';
    const displayName = rawName.length > MAX_LAYER_NAME_IN_ERROR
        ? `${rawName.slice(0, MAX_LAYER_NAME_IN_ERROR - 3)}...`
        : rawName;

    throw new Error(
        `Layer "${displayName}" (${formatLayerTypeLabel(kind)}) isn't supported by Copy layer — use Copy merged.`
    );
}

/**
 * Normalize target bounds into integer document pixel coordinates.
 * @param {object} bounds - { left, top, right?, bottom?, width?, height? }
 * @returns {{left: number, top: number, right: number, bottom: number, width: number, height: number}}
 */
function normalizeTargetBounds(bounds) {
    if (!bounds || typeof bounds !== 'object') {
        throw new Error('Invalid capture bounds for Copy layer.');
    }

    const left = Math.round(bounds.left);
    const top = Math.round(bounds.top);
    const rawWidth = bounds.width !== undefined ? bounds.width : (bounds.right - left);
    const rawHeight = bounds.height !== undefined ? bounds.height : (bounds.bottom - top);
    const width = Math.max(1, Math.round(rawWidth));
    const height = Math.max(1, Math.round(rawHeight));

    return {
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height
    };
}

/**
 * Check whether an error from imaging.getPixels means the layer has no pixels
 * inside the requested bounds (as opposed to an unsupported type or fatal error).
 * @param {*} error
 * @returns {boolean}
 */
function isNoPixelsError(error) {
    const message = error && error.message ? String(error.message) : String(error || '');
    return /no pixels/i.test(message);
}

/**
 * Composite cropped layer pixels into a full-frame RGB (white bg) or RGBA (transparent bg) buffer
 * matching targetBounds pixel-for-pixel in document coordinates.
 *
 * @param {object} params
 * @param {object} params.targetBounds - Full capture frame in document coordinates
 * @param {object|null} [params.sourceBounds] - Actual bounds returned by getPixels
 * @param {Uint8Array|null} [params.sourcePixels] - Raw interleaved pixels from getPixels (null if empty)
 * @param {number} [params.sourceWidth=0]
 * @param {number} [params.sourceHeight=0]
 * @param {number} [params.sourceComponents=0]
 * @param {number} [params.sourceRowBytes=0]
 * @param {boolean} [params.preserveTransparency=false]
 * @returns {{pixels: Uint8Array, width: number, height: number, components: number}}
 */
function compositeLayerPixels({
    targetBounds,
    sourceBounds = null,
    sourcePixels = null,
    sourceWidth = 0,
    sourceHeight = 0,
    sourceComponents = 0,
    sourceRowBytes = 0,
    preserveTransparency = false
}) {
    const target = normalizeTargetBounds(targetBounds);
    const destComponents = preserveTransparency ? 4 : 3;
    const dest = new Uint8Array(target.width * target.height * destComponents);

    if (!preserveTransparency) {
        dest.fill(255);
    }

    if (!sourcePixels || sourceWidth <= 0 || sourceHeight <= 0 || sourceComponents <= 0) {
        return { pixels: dest, width: target.width, height: target.height, components: destComponents };
    }

    const srcLeft = sourceBounds && sourceBounds.left !== undefined
        ? Math.round(sourceBounds.left)
        : target.left;
    const srcTop = sourceBounds && sourceBounds.top !== undefined
        ? Math.round(sourceBounds.top)
        : target.top;
    const effectiveRowBytes = sourceRowBytes && sourceRowBytes >= sourceWidth * sourceComponents
        ? sourceRowBytes
        : sourceWidth * sourceComponents;

    // Intersect returned pixel bounds with requested frame to stay strictly in-bounds.
    const copyLeft = Math.max(target.left, srcLeft);
    const copyTop = Math.max(target.top, srcTop);
    const copyRight = Math.min(target.right, srcLeft + sourceWidth);
    const copyBottom = Math.min(target.bottom, srcTop + sourceHeight);

    if (copyRight <= copyLeft || copyBottom <= copyTop) {
        return { pixels: dest, width: target.width, height: target.height, components: destComponents };
    }

    const copyWidth = copyRight - copyLeft;
    const srcOffsetX = copyLeft - srcLeft;
    const dstOffsetX = copyLeft - target.left;

    for (let docY = copyTop; docY < copyBottom; docY++) {
        const srcY = docY - srcTop;
        const dstY = docY - target.top;
        const srcRowStart = srcY * effectiveRowBytes + srcOffsetX * sourceComponents;
        const dstRowStart = (dstY * target.width + dstOffsetX) * destComponents;

        if (sourceComponents === destComponents) {
            const copyBytes = copyWidth * destComponents;
            dest.set(sourcePixels.subarray(srcRowStart, srcRowStart + copyBytes), dstRowStart);
        } else if (sourceComponents === 3 && destComponents === 4) {
            // Opaque layers without an alpha channel (e.g. Background) return 3 components even
            // when applyAlpha is false; write full alpha (255) over the transparent frame.
            for (let x = 0; x < copyWidth; x++) {
                const s = srcRowStart + x * 3;
                const d = dstRowStart + x * 4;
                dest[d] = sourcePixels[s];
                dest[d + 1] = sourcePixels[s + 1];
                dest[d + 2] = sourcePixels[s + 2];
                dest[d + 3] = 255;
            }
        } else if (sourceComponents === 4 && destComponents === 3) {
            // Defensive fallback: composite RGBA over white if applyAlpha: true returned 4 channels.
            for (let x = 0; x < copyWidth; x++) {
                const s = srcRowStart + x * 4;
                const d = dstRowStart + x * 3;
                const a = sourcePixels[s + 3] / 255;
                const inv = 255 * (1 - a);
                dest[d] = Math.round(sourcePixels[s] * a + inv);
                dest[d + 1] = Math.round(sourcePixels[s + 1] * a + inv);
                dest[d + 2] = Math.round(sourcePixels[s + 2] * a + inv);
            }
        } else if (sourceComponents === 1) {
            for (let x = 0; x < copyWidth; x++) {
                const g = sourcePixels[srcRowStart + x];
                const d = dstRowStart + x * destComponents;
                dest[d] = g;
                dest[d + 1] = g;
                dest[d + 2] = g;
                if (destComponents === 4) dest[d + 3] = 255;
            }
        }
    }

    return { pixels: dest, width: target.width, height: target.height, components: destComponents };
}

/**
 * Reverse the lowest `bitCount` bits of `value` for DEFLATE Huffman bitstreams.
 * @param {number} value
 * @param {number} bitCount
 * @returns {number}
 */
function reverseBits(value, bitCount) {
    let reversed = 0;
    for (let i = 0; i < bitCount; i++) {
        reversed = (reversed << 1) | (value & 1);
        value >>>= 1;
    }
    return reversed;
}

/**
 * Lazily build static RFC 1951 fixed Huffman lookup tables.
 */
function getDeflateTables() {
    if (deflateTables) return deflateTables;

    const litCodes = new Uint16Array(288);
    const litLens = new Uint8Array(288);
    for (let i = 0; i <= 143; i++) { litCodes[i] = reverseBits(0x30 + i, 8); litLens[i] = 8; }
    for (let i = 144; i <= 255; i++) { litCodes[i] = reverseBits(0x190 + (i - 144), 9); litLens[i] = 9; }
    for (let i = 256; i <= 279; i++) { litCodes[i] = reverseBits(i - 256, 7); litLens[i] = 7; }
    for (let i = 280; i <= 287; i++) { litCodes[i] = reverseBits(0xc0 + (i - 280), 8); litLens[i] = 8; }

    const lenBase = [
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27,
        31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
    ];
    const lenExtra = [
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2,
        2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
    ];
    const lenSym = new Uint16Array(259);
    const lenExBits = new Uint8Array(259);
    const lenExVal = new Uint8Array(259);
    for (let idx = 0; idx < lenBase.length; idx++) {
        const base = lenBase[idx];
        const next = idx + 1 < lenBase.length ? lenBase[idx + 1] : 259;
        for (let length = base; length < next; length++) {
            lenSym[length] = 257 + idx;
            lenExBits[length] = lenExtra[idx];
            lenExVal[length] = length - base;
        }
    }

    const distBase = [
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129,
        193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
        6145, 8193, 12289, 16385, 24577
    ];
    const distExtra = [
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6,
        6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
    ];
    const distRev = new Uint8Array(30);
    for (let d = 0; d < 30; d++) {
        distRev[d] = reverseBits(d, 5);
    }

    deflateTables = { litCodes, litLens, lenSym, lenExBits, lenExVal, distBase, distExtra, distRev };
    return deflateTables;
}

/**
 * Compute Adler-32 checksum for a zlib stream.
 * @param {Uint8Array} data
 * @returns {number}
 */
function calculateAdler32(data) {
    const MOD_ADLER = 65521;
    let a = 1;
    let b = 0;

    for (let start = 0; start < data.length; start += 5552) {
        const end = Math.min(start + 5552, data.length);
        for (let i = start; i < end; i++) {
            a += data[i];
            b += a;
        }
        a %= MOD_ADLER;
        b %= MOD_ADLER;
    }

    return ((b << 16) | a) >>> 0;
}

/**
 * Encode uncompressed DEFLATE stored blocks wrapped in a zlib stream.
 * Used as fallback if compressed output would exceed stored size on noisy images.
 * @param {Uint8Array} data
 * @param {number} adler
 * @returns {Uint8Array}
 */
function encodeStoredZlib(data, adler) {
    const blockCount = Math.max(1, Math.ceil(data.length / 65535));
    const output = new Uint8Array(2 + data.length + blockCount * 5 + 4);
    let outPos = 0;
    let inPos = 0;

    output[outPos++] = 0x78;
    output[outPos++] = 0x01;

    do {
        const len = Math.min(65535, data.length - inPos);
        const isFinal = inPos + len === data.length;
        const invLen = (~len) & 0xffff;

        output[outPos++] = isFinal ? 0x01 : 0x00;
        output[outPos++] = len & 0xff;
        output[outPos++] = (len >>> 8) & 0xff;
        output[outPos++] = invLen & 0xff;
        output[outPos++] = (invLen >>> 8) & 0xff;
        output.set(data.subarray(inPos, inPos + len), outPos);

        outPos += len;
        inPos += len;
    } while (inPos < data.length);

    output[outPos++] = (adler >>> 24) & 0xff;
    output[outPos++] = (adler >>> 16) & 0xff;
    output[outPos++] = (adler >>> 8) & 0xff;
    output[outPos++] = adler & 0xff;

    return output;
}

/**
 * Compress bytes into a valid zlib stream using Fixed Huffman LZ77 DEFLATE,
 * falling back to stored blocks if the data is incompressible.
 * @param {Uint8Array} scanlines
 * @returns {Uint8Array}
 */
function compressZlib(scanlines) {
    const scanLen = scanlines.length;
    const adler = calculateAdler32(scanlines);
    const storedLimit = 2 + scanLen + Math.max(1, Math.ceil(scanLen / 65535)) * 5 + 4;

    const { litCodes, litLens, lenSym, lenExBits, lenExVal, distBase, distExtra, distRev } = getDeflateTables();

    const out = new Uint8Array(storedLimit + 16);
    let pos = 0;
    out[pos++] = 0x78;
    out[pos++] = 0x01;

    let bitBuf = 0;
    let bitCnt = 0;
    const writeBits = (val, count) => {
        bitBuf |= (val << bitCnt);
        bitCnt += count;
        while (bitCnt >= 8) {
            out[pos++] = bitBuf & 0xff;
            bitBuf >>>= 8;
            bitCnt -= 8;
        }
    };

    writeBits(1, 1); // BFINAL = 1
    writeBits(1, 2); // BTYPE = 01 (Fixed Huffman)

    const head = new Int32Array(32768).fill(-1);
    const maxSafePos = storedLimit - 8;

    let i = 0;
    while (i < scanLen) {
        if (pos >= maxSafePos) {
            return encodeStoredZlib(scanlines, adler);
        }

        let matchLen = 0;
        let matchDist = 0;
        if (i + 3 <= scanLen) {
            const hash = ((scanlines[i] << 10) ^ (scanlines[i + 1] << 5) ^ scanlines[i + 2]) & 32767;
            const prev = head[hash];
            head[hash] = i;

            if (prev >= 0) {
                const dist = i - prev;
                if (
                    dist >= 1 && dist <= 32768 &&
                    scanlines[prev] === scanlines[i] &&
                    scanlines[prev + 1] === scanlines[i + 1] &&
                    scanlines[prev + 2] === scanlines[i + 2]
                ) {
                    const maxLen = Math.min(258, scanLen - i);
                    let len = 3;
                    while (len < maxLen && scanlines[prev + len] === scanlines[i + len]) {
                        len++;
                    }
                    // Long-distance 3-byte matches are slightly larger than 3 literals in fixed Huffman.
                    if (len >= 4 || dist <= 2048) {
                        matchLen = len;
                        matchDist = dist;
                    }
                }
            }
        }

        if (matchLen >= 3) {
            const sym = lenSym[matchLen];
            writeBits(litCodes[sym], litLens[sym]);
            const extraBits = lenExBits[matchLen];
            if (extraBits) writeBits(lenExVal[matchLen], extraBits);

            let dIdx = matchDist > 256 ? 16 : 0;
            while (dIdx + 1 < 30 && distBase[dIdx + 1] <= matchDist) dIdx++;
            writeBits(distRev[dIdx], 5);
            const distEx = distExtra[dIdx];
            if (distEx) writeBits(matchDist - distBase[dIdx], distEx);

            i += matchLen;
        } else {
            const byte = scanlines[i++];
            writeBits(litCodes[byte], litLens[byte]);
        }
    }

    writeBits(litCodes[256], litLens[256]); // End of block
    if (bitCnt > 0) out[pos++] = bitBuf & 0xff;

    if (pos + 4 >= storedLimit) {
        return encodeStoredZlib(scanlines, adler);
    }

    out[pos++] = (adler >>> 24) & 0xff;
    out[pos++] = (adler >>> 16) & 0xff;
    out[pos++] = (adler >>> 8) & 0xff;
    out[pos++] = adler & 0xff;

    return out.subarray(0, pos);
}

/**
 * Write a big-endian 32-bit unsigned integer into `target` at `offset`.
 */
function writeUint32BE(target, offset, value) {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
}

/**
 * Lazily build CRC-32 lookup table for PNG chunks.
 */
function getPngCrcTable() {
    if (pngCrcTable) return pngCrcTable;

    pngCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let bit = 0; bit < 8; bit++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        pngCrcTable[n] = c >>> 0;
    }
    return pngCrcTable;
}

/**
 * Build a complete PNG chunk (length + type + data + CRC-32).
 * @param {string} type - Four ASCII characters
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function createPngChunk(type, data) {
    const typeBytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i);

    const table = getPngCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < 4; i++) {
        crc = table[(crc ^ typeBytes[i]) & 0xff] ^ (crc >>> 8);
    }
    for (let i = 0; i < data.length; i++) {
        crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    crc = (crc ^ 0xffffffff) >>> 0;

    const chunk = new Uint8Array(12 + data.length);
    writeUint32BE(chunk, 0, data.length);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    writeUint32BE(chunk, 8 + data.length, crc);
    return chunk;
}

/**
 * Encode raw interleaved RGB (3 components) or RGBA (4 components) pixels into PNG bytes.
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} components - 3 (RGB) or 4 (RGBA)
 * @returns {Uint8Array}
 */
function encodePngBytes(pixels, width, height, components) {
    if (components !== 3 && components !== 4) {
        throw new Error(`Unsupported PNG component count: ${components}`);
    }

    const rowBytes = width * components;
    const scanlines = new Uint8Array((rowBytes + 1) * height);

    // Apply PNG Sub filter (type 1) so solid/transparent regions become zero runs for LZ77.
    for (let y = 0; y < height; y++) {
        const srcRow = y * rowBytes;
        const dstRow = y * (rowBytes + 1);
        scanlines[dstRow] = 1;
        for (let x = 0; x < components; x++) {
            scanlines[dstRow + 1 + x] = pixels[srcRow + x];
        }
        for (let x = components; x < rowBytes; x++) {
            scanlines[dstRow + 1 + x] = (pixels[srcRow + x] - pixels[srcRow + x - components]) & 0xff;
        }
    }

    const ihdr = new Uint8Array(13);
    writeUint32BE(ihdr, 0, width);
    writeUint32BE(ihdr, 4, height);
    ihdr[8] = 8; // 8 bits per channel
    ihdr[9] = components === 4 ? 6 : 2; // 6 = RGBA, 2 = RGB
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const idatData = compressZlib(scanlines);
    const chunks = [
        PNG_SIGNATURE,
        createPngChunk('IHDR', ihdr),
        createPngChunk('IDAT', idatData),
        createPngChunk('IEND', new Uint8Array(0))
    ];

    const totalLen = chunks.reduce((sum, part) => sum + part.length, 0);
    const png = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of chunks) {
        png.set(part, offset);
        offset += part.length;
    }
    return png;
}

/**
 * Convert bytes to base64 in chunks to avoid argument/stack limits in UXP.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
    const CHUNK_SIZE = 0x8000;
    let binary = '';

    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
        const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
    }

    if (typeof btoa !== 'undefined') return btoa(binary);
    if (typeof window !== 'undefined' && window.btoa) return window.btoa(binary);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    throw new Error('Base64 encoding is not available in this environment');
}

/**
 * Encode RGB or RGBA pixel buffer into a PNG data URL.
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} components - 3 or 4
 * @returns {string}
 */
function encodePngDataUrl(pixels, width, height, components) {
    const pngBytes = encodePngBytes(pixels, width, height, components);
    return `data:image/png;base64,${bytesToBase64(pngBytes)}`;
}

const TARGET_COLOR_SPACE = 'RGB';
const TARGET_COLOR_PROFILE = 'sRGB IEC61966-2.1';

/**
 * Whether Slow (transparent) capture on this document must read native pixels and normalize
 * them to 8-bit in JavaScript.
 *
 * Photoshop throws error -32005 when componentSize: 8 is combined with applyAlpha: false on
 * 16-bit or 32-bit documents, so that combination is never requested. Fast mode
 * (applyAlpha: true) works with componentSize: 8 at any bit depth and is left untouched.
 *
 * @param {object} doc
 * @param {boolean} preserveTransparency
 * @returns {boolean}
 */
function needsNativePixelNormalization(doc, preserveTransparency) {
    return Boolean(preserveTransparency) && isHighBitDepth(doc);
}

/**
 * Build imaging.getPixels options for capturing a single layer in sRGB.
 * componentSize: 8 is always requested except in Slow mode on 16-bit/32-bit documents.
 *
 * @param {object} params
 * @param {object} params.doc - Active Photoshop document
 * @param {object} params.layer - Active Photoshop layer
 * @param {{left: number, top: number, right: number, bottom: number}} params.targetBounds
 * @param {boolean} [params.preserveTransparency=false]
 * @returns {object} Options object for imaging.getPixels
 */
function buildLayerGetPixelsOptions({ doc, layer, targetBounds, preserveTransparency = false }) {
    const options = {
        documentID: doc.id,
        layerID: layer.id,
        sourceBounds: {
            left: targetBounds.left,
            top: targetBounds.top,
            right: targetBounds.right,
            bottom: targetBounds.bottom
        },
        colorSpace: TARGET_COLOR_SPACE,
        colorProfile: TARGET_COLOR_PROFILE,
        applyAlpha: !preserveTransparency
    };

    if (!needsNativePixelNormalization(doc, preserveTransparency)) {
        options.componentSize = 8;
    }

    return options;
}

/**
 * Capture the active layer inside `bounds` in document coordinates and return a PNG data URL.
 * Does not modify the document, selection, active layer, active document, or history.
 *
 * @param {object} params
 * @param {object} params.doc - Active Photoshop document
 * @param {object} params.layer - Active Photoshop layer
 * @param {object} params.bounds - Target capture frame in document coordinates
 * @param {boolean} [params.preserveTransparency=false] - Transparent bg if true, white bg if false
 * @param {object} [params.imaging] - Optional imaging API override for tests
 * @returns {Promise<string>} PNG data URL matching `bounds` dimensions
 */
async function captureLayerSelection({ doc, layer, bounds, preserveTransparency = false, imaging: imagingOverride = null }) {
    assertSupportedLayer(layer);
    const targetBounds = normalizeTargetBounds(bounds);
    const imaging = imagingOverride || require('photoshop').imaging;

    let pixelResult = null;
    try {
        pixelResult = await imaging.getPixels(
            buildLayerGetPixelsOptions({ doc, layer, targetBounds, preserveTransparency })
        );
    } catch (error) {
        if (!isNoPixelsError(error)) {
            throw error;
        }
    }

    let composite;
    if (!pixelResult || !pixelResult.imageData) {
        composite = compositeLayerPixels({ targetBounds, preserveTransparency });
    } else {
        const psImageData = pixelResult.imageData;
        try {
            const rawData = await psImageData.getData();
            let sourcePixels;
            let sourceRowBytes;
            if (needsNativePixelNormalization(doc, preserveTransparency)) {
                // Native 16-bit/32-bit data; normalization also yields tightly packed 8-bit rows.
                const normalized = normalizeToUint8Pixels(rawData, {
                    width: psImageData.width,
                    height: psImageData.height,
                    components: psImageData.components,
                    componentSize: psImageData.componentSize,
                    rowBytes: psImageData.rowBytes,
                    label: 'Copy layer'
                });
                sourcePixels = normalized.pixels;
                sourceRowBytes = normalized.rowBytes;
            } else {
                sourcePixels = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
                sourceRowBytes = psImageData.rowBytes;
            }
            composite = compositeLayerPixels({
                targetBounds,
                sourceBounds: pixelResult.sourceBounds || targetBounds,
                sourcePixels,
                sourceWidth: psImageData.width,
                sourceHeight: psImageData.height,
                sourceComponents: psImageData.components,
                sourceRowBytes,
                preserveTransparency
            });
        } finally {
            try {
                if (typeof psImageData.dispose === 'function') psImageData.dispose();
            } catch {
                // Ignore disposal errors so valid capture data is not lost.
            }
        }
    }

    return encodePngDataUrl(composite.pixels, composite.width, composite.height, composite.components);
}

module.exports = {
    SUPPORTED_LAYER_KINDS,
    assertSupportedLayer,
    formatLayerTypeLabel,
    normalizeTargetBounds,
    isNoPixelsError,
    compositeLayerPixels,
    encodePngBytes,
    encodePngDataUrl,
    buildLayerGetPixelsOptions,
    captureLayerSelection
};
