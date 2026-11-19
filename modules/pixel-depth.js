/**
 * Pixel Depth Helpers
 * Shared, dependency-free helpers for reading Photoshop pixels from 16-bit and 32-bit
 * documents and converting them to 8-bit for PNG output. Used by copy-layer.js and
 * copy-merged.js; this module requires neither of them so there is no circular dependency.
 *
 * Background: Photoshop throws error -32005 ("Could not update smart object files") when
 * imaging.getPixels is called with componentSize: 8 together with applyAlpha: false on a
 * 16-bit or 32-bit document. Omitting componentSize returns native pixels (Uint16Array in
 * [0..32768] for 16-bit, Float32Array in [0..1] for 32-bit), which normalizeToUint8Pixels
 * converts to 8-bit in JavaScript.
 */

/**
 * Detect whether a Photoshop document uses 16-bit or 32-bit color depth.
 *
 * @param {object} doc
 * @returns {boolean}
 */
function isHighBitDepth(doc) {
    const bits = doc && doc.bitsPerChannel;
    if (bits === 16 || bits === 32) return true;
    const text = String(bits || '');
    return text.includes('16') || text.includes('32');
}

/**
 * Normalize raw pixel data returned by PhotoshopImageData.getData() into 8-bit values.
 * Preserves rowBytes for 8-bit buffers so downstream compositing can strip any stride
 * padding, and produces tightly packed rows when normalizing 16-bit or 32-bit buffers.
 *
 * @param {Uint8Array|Uint16Array|Float32Array|ArrayBuffer} rawData
 * @param {object} meta
 * @param {number} meta.width
 * @param {number} meta.height
 * @param {number} meta.components
 * @param {number} [meta.componentSize=8]
 * @param {number} [meta.rowBytes=0]
 * @param {string} [meta.label] - Feature name appended to the empty-data error message
 * @returns {{pixels: Uint8Array, rowBytes: number}}
 */
function normalizeToUint8Pixels(rawData, { width, height, components, componentSize = 8, rowBytes = 0, label = '' }) {
    if (!rawData) {
        throw new Error(`Photoshop returned empty pixel data${label ? ` for ${label}` : ''}.`);
    }

    const packedElements = width * components;
    const is16Bit = rawData instanceof Uint16Array || componentSize === 16;
    const is32Bit = rawData instanceof Float32Array || componentSize === 32;

    if (is16Bit) {
        const u16 = rawData instanceof Uint16Array ? rawData : new Uint16Array(rawData);
        const byteStride = rowBytes && rowBytes >= packedElements * 2 ? Math.floor(rowBytes / 2) : packedElements;
        const srcStride = byteStride * height <= u16.length ? byteStride : packedElements;
        const pixels = new Uint8Array(height * packedElements);

        // Photoshop represents 16-bit channels in the fixed-point [0..32768] range.
        for (let y = 0; y < height; y++) {
            const srcRow = y * srcStride;
            const dstRow = y * packedElements;
            for (let x = 0; x < packedElements; x++) {
                const value = u16[srcRow + x];
                pixels[dstRow + x] = value >= 32768 ? 255 : Math.round((value * 255) / 32768);
            }
        }

        return { pixels, rowBytes: packedElements };
    }

    if (is32Bit) {
        const f32 = rawData instanceof Float32Array ? rawData : new Float32Array(rawData);
        const byteStride = rowBytes && rowBytes >= packedElements * 4 ? Math.floor(rowBytes / 4) : packedElements;
        const srcStride = byteStride * height <= f32.length ? byteStride : packedElements;
        const pixels = new Uint8Array(height * packedElements);

        for (let y = 0; y < height; y++) {
            const srcRow = y * srcStride;
            const dstRow = y * packedElements;
            for (let x = 0; x < packedElements; x++) {
                const value = f32[srcRow + x];
                if (value <= 0 || Number.isNaN(value)) {
                    pixels[dstRow + x] = 0;
                } else if (value >= 1) {
                    pixels[dstRow + x] = 255;
                } else {
                    pixels[dstRow + x] = Math.round(value * 255);
                }
            }
        }

        return { pixels, rowBytes: packedElements };
    }

    const pixels = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
    const effectiveRowBytes = rowBytes && rowBytes >= packedElements ? rowBytes : packedElements;
    return { pixels, rowBytes: effectiveRowBytes };
}

module.exports = {
    isHighBitDepth,
    normalizeToUint8Pixels
};
