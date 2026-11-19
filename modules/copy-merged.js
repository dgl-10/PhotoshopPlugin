/**
 * Copy Merged Transparent Capture Module
 * Captures the composite Photoshop document inside the requested document bounds via
 * imaging.getPixels (without layerID) with full alpha preservation and no temporary
 * document, clipboard mutation, selection changes, or disk I/O.
 *
 * Pure helpers have no top-level Photoshop dependency so they can be unit-tested in Node.
 * PNG encoding and frame alignment helpers are reused from copy-layer.js; bit-depth detection
 * and 16-bit/32-bit to 8-bit normalization live in pixel-depth.js (shared with copy-layer.js)
 * and are re-exported here for backward compatibility.
 */

const {
    normalizeTargetBounds,
    isNoPixelsError,
    compositeLayerPixels,
    encodePngDataUrl
} = require('./copy-layer.js');
const { isHighBitDepth, normalizeToUint8Pixels } = require('./pixel-depth.js');

const TARGET_COLOR_SPACE = 'RGB';
const TARGET_COLOR_PROFILE = 'sRGB IEC61966-2.1';

/**
 * Build imaging.getPixels options for reading the transparent composite in sRGB.
 *
 * Photoshop throws error -32005 ("Could not update smart object files") when
 * componentSize: 8 is combined with applyAlpha: false on 16-bit or 32-bit documents.
 * Omitting componentSize for high-bit-depth documents returns native pixels, which
 * normalizeToUint8Pixels converts to 8-bit in JavaScript.
 *
 * @param {object} params
 * @param {object} params.doc - Active Photoshop document
 * @param {{left: number, top: number, right: number, bottom: number}} params.targetBounds
 * @returns {object} Options object for imaging.getPixels
 */
function buildGetPixelsOptions({ doc, targetBounds }) {
    const options = {
        documentID: doc.id,
        sourceBounds: {
            left: targetBounds.left,
            top: targetBounds.top,
            right: targetBounds.right,
            bottom: targetBounds.bottom
        },
        colorSpace: TARGET_COLOR_SPACE,
        colorProfile: TARGET_COLOR_PROFILE,
        applyAlpha: false
    };

    if (!isHighBitDepth(doc)) {
        options.componentSize = 8;
    }

    return options;
}

/**
 * Align normalized pixels to the exact requested targetBounds and return an RGBA buffer
 * ready for PNG encoding without extra allocation when bounds and packing already match.
 *
 * @param {object} params
 * @param {object} params.targetBounds
 * @param {object|null} params.sourceBounds
 * @param {Uint8Array} params.pixels
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} params.components
 * @param {number} params.rowBytes
 * @returns {{pixels: Uint8Array, width: number, height: number, components: number}}
 */
function alignCompositeFrame({ targetBounds, sourceBounds, pixels, width, height, components, rowBytes }) {
    if (components !== 1 && components !== 3 && components !== 4) {
        throw new Error(`Unsupported component count from Copy merged getPixels: ${components}`);
    }

    const srcLeft = sourceBounds && sourceBounds.left !== undefined ? Math.round(sourceBounds.left) : targetBounds.left;
    const srcTop = sourceBounds && sourceBounds.top !== undefined ? Math.round(sourceBounds.top) : targetBounds.top;
    const expectedBytes = targetBounds.width * targetBounds.height * 4;

    if (
        srcLeft === targetBounds.left &&
        srcTop === targetBounds.top &&
        width === targetBounds.width &&
        height === targetBounds.height &&
        components === 4 &&
        rowBytes === targetBounds.width * 4 &&
        pixels.length >= expectedBytes
    ) {
        return {
            pixels: pixels.length === expectedBytes ? pixels : pixels.subarray(0, expectedBytes),
            width: targetBounds.width,
            height: targetBounds.height,
            components: 4
        };
    }

    return compositeLayerPixels({
        targetBounds,
        sourceBounds,
        sourcePixels: pixels,
        sourceWidth: width,
        sourceHeight: height,
        sourceComponents: components,
        sourceRowBytes: rowBytes,
        preserveTransparency: true
    });
}

/**
 * Capture the composite document inside `bounds` in document coordinates, preserving full
 * alpha transparency, and return a PNG data URL without creating any temporary document.
 *
 * @param {object} params
 * @param {object} params.doc - Active Photoshop document
 * @param {object} params.bounds - Target capture frame in document coordinates
 * @param {object} [params.imaging] - Optional imaging API override for tests
 * @returns {Promise<string>} PNG data URL matching `bounds` dimensions
 */
async function captureMergedSelection({ doc, bounds, imaging: imagingOverride = null }) {
    if (!doc || !doc.id) {
        throw new Error('No active document for Copy merged capture.');
    }

    const targetBounds = normalizeTargetBounds(bounds);
    const imaging = imagingOverride || require('photoshop').imaging;
    const pixelOptions = buildGetPixelsOptions({ doc, targetBounds });

    let pixelResult = null;
    try {
        pixelResult = await imaging.getPixels(pixelOptions);
    } catch (error) {
        if (!isNoPixelsError(error)) {
            throw error;
        }
    }

    let frame;
    if (!pixelResult || !pixelResult.imageData) {
        frame = compositeLayerPixels({ targetBounds, preserveTransparency: true });
    } else {
        const psImageData = pixelResult.imageData;
        try {
            const rawData = await psImageData.getData();
            const normalized = normalizeToUint8Pixels(rawData, {
                width: psImageData.width,
                height: psImageData.height,
                components: psImageData.components,
                componentSize: psImageData.componentSize,
                rowBytes: psImageData.rowBytes,
                label: 'Copy merged'
            });
            frame = alignCompositeFrame({
                targetBounds,
                sourceBounds: pixelResult.sourceBounds || targetBounds,
                pixels: normalized.pixels,
                width: psImageData.width,
                height: psImageData.height,
                components: psImageData.components,
                rowBytes: normalized.rowBytes
            });
        } finally {
            try {
                if (typeof psImageData.dispose === 'function') psImageData.dispose();
            } catch {
                // Ignore disposal errors so valid capture data is not lost.
            }
        }
    }

    return encodePngDataUrl(frame.pixels, frame.width, frame.height, frame.components);
}

module.exports = {
    isHighBitDepth,
    buildGetPixelsOptions,
    normalizeToUint8Pixels,
    alignCompositeFrame,
    captureMergedSelection
};
