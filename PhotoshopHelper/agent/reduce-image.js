'use strict';

/**
 * Reduce an image for the agent to look at.
 *
 * Images cost the agent context, so what it looks at is a reduced copy, as with
 * ps_get_image. Only that copy is reduced: the capture in the panel's FromPS card, which is
 * what goes to a generator, is never touched.
 */

/**
 * @returns {object|null} Electron's nativeImage, or null outside Electron (the tests).
 */
function loadNativeImage() {
    try {
        const electron = require('electron');
        // Outside Electron the package resolves to the path of its binary, a plain string.
        return electron && typeof electron === 'object' && electron.nativeImage ? electron.nativeImage : null;
    } catch {
        return null;
    }
}

/**
 * Build the reducer.
 *
 * @param {object|null} [nativeImage] - Electron's nativeImage; found by itself when omitted.
 * @returns {(base64: string, maxSide: number) => {base64: string, width: number|null,
 *   height: number|null, originalWidth: number|null, originalHeight: number|null,
 *   reduced: boolean}} Takes a PNG or JPEG as base64 and returns a PNG no larger than
 *   maxSide on its long side, or the image unchanged when it already fits or cannot be read.
 */
function createImageReducer(nativeImage = loadNativeImage()) {
    return function reduceImage(base64, maxSide) {
        const unchanged = { base64, width: null, height: null, originalWidth: null, originalHeight: null, reduced: false };
        if (!nativeImage || !base64) return unchanged;

        const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
        if (image.isEmpty()) return unchanged;

        const { width, height } = image.getSize();
        if (Math.max(width, height) <= maxSide) {
            return { ...unchanged, width, height, originalWidth: width, originalHeight: height };
        }

        // Only the longer side is given, so the proportions stay.
        const resized = width >= height
            ? image.resize({ width: maxSide, quality: 'good' })
            : image.resize({ height: maxSide, quality: 'good' });
        const size = resized.getSize();
        return {
            base64: resized.toPNG().toString('base64'),
            width: size.width,
            height: size.height,
            originalWidth: width,
            originalHeight: height,
            reduced: true
        };
    };
}

module.exports = { createImageReducer };
