const { nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');


/**
 * Detects image MIME type from a raw base64 string by inspecting magic bytes.
 * More reliable than prefix-matching on the base64 string itself.
 *
 * Supports: JPEG, PNG, WebP, GIF.
 * Falls back to 'image/png' for unknown types.
 *
 * @param {string} rawBase64 - Raw base64-encoded image data (no data URI prefix)
 * @returns {string} MIME type, e.g. 'image/jpeg'
 */
function detectMimeTypeFromBase64(rawBase64) {
    // Decode just the first 12 bytes — enough to check all common magic numbers
    const bytes = Buffer.from(rawBase64.substring(0, 16), 'base64');

    // JPEG: FF D8 FF
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }

    // WebP: RIFF????WEBP
    if (
        bytes.slice(0, 4).toString('ascii') === 'RIFF' &&
        bytes.slice(8, 12).toString('ascii') === 'WEBP'
    ) {
        return 'image/webp';
    }

    // GIF: GIF87a or GIF89a
    const gifSig = bytes.slice(0, 6).toString('ascii');
    if (gifSig === 'GIF87a' || gifSig === 'GIF89a') {
        return 'image/gif';
    }

    // Unknown — safe fallback
    return 'image/png';
}

/**
 * Maps a MIME type to a common file extension.
 *
 * @param {string} mimeType - e.g. 'image/jpeg'
 * @returns {string} File extension without dot, e.g. 'jpg'
 */
function mimeTypeToExt(mimeType) {
    switch (mimeType) {
        case 'image/jpeg':
        case 'image/jpg':
            return 'jpg';
        case 'image/webp':
            return 'webp';
        case 'image/gif':
            return 'gif';
        default:
            return 'png';
    }
}

/**
 * Parses an image input string, extracts metadata,
 * and prepares a nativeImage instance for further manipulation.
 *
 * Accepts a data URI (data:image/...;base64,...), a raw base64 string, or a full file path.
 *
 * @param {string} imgStr - Data URI, raw base64 string, or absolute file path
 * @returns {Object|null} Image controller object, or null if parsing failed
 */
function parseImageInput(imgStr) {
    if (!imgStr) return null;

    let isDataUri = false;
    let mimeType = 'image/png'; // Default fallback for Electron
    let rawBase64 = imgStr;
    let dataUrl = imgStr;
    let img = null;

    // Check if the input is a full file path (for future optimization of file serving)
    const isPath = typeof imgStr === 'string' && imgStr.length < 2048 &&
        (imgStr.includes(':\\') || imgStr.startsWith('/') || imgStr.startsWith('\\\\'));

    if (isPath && fs.existsSync(imgStr)) {
        img = nativeImage.createFromPath(imgStr);
        if (!img.isEmpty()) {
            const ext = path.extname(imgStr).toLowerCase();
            if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
            else if (ext === '.webp') mimeType = 'image/webp';
            else if (ext === '.gif') mimeType = 'image/gif';

            isDataUri = false;
            // rawBase64 and dataUrl are not strictly needed here as pack() will regenerate them from nativeImage
        }
    }

    if (!img || img.isEmpty()) {
        // Check if the input is a data URI
        if (imgStr.startsWith('data:image/')) {
            isDataUri = true;
            const parts = imgStr.split(',');

            // Extract the actual MIME type so we can re-pack in the same format later
            const match = parts[0].match(/data:(image\/[^;]+)/);
            if (match) {
                mimeType = match[1];
            }
            rawBase64 = parts[1];
            dataUrl = imgStr; // nativeImage expects a data URI
        } else {
            // Detect MIME type from actual magic bytes (more reliable than prefix matching)
            mimeType = detectMimeTypeFromBase64(rawBase64);

            // Construct a data URI so nativeImage can consume it
            dataUrl = `data:${mimeType};base64,${rawBase64}`;
        }

        // Create a nativeImage instance for resize/crop operations
        img = nativeImage.createFromDataURL(dataUrl);

        if (img.isEmpty()) {
            // Try to create from buffer
            const imgBuffer = Buffer.from(rawBase64, 'base64');
            img = nativeImage.createFromBuffer(imgBuffer);
        }
    }

    if (!img || img.isEmpty()) {
        console.warn('[imageUtils] Failed to read image: nativeImage returned empty');
        return null;
    }


    // Return an image controller object
    return {
        image: img,     // nativeImage instance (supports img.resize, img.crop, etc.)
        size: img.getSize(), // { width, height }
        isDataUri,      // Whether the original input had a data URI prefix
        mimeType,       // Detected or extracted MIME type

        /**
         * Re-packs the current image state back into the string format.
         *
         * @param {nativeImage} [overrideImage] - Optional: pass a new nativeImage instance
         *   (e.g. the result of img.resize()) to pack that instead of the original.
         * @param {string} [forcedMimeType] - Optional: force a specific format, e.g. 'image/jpeg'
         * @returns {string}
         */
        pack: function (overrideImage, forcedMimeType) {
            const isSameMime = !forcedMimeType || forcedMimeType === this.mimeType ||
                (['image/jpeg', 'image/jpg'].includes(forcedMimeType) && ['image/jpeg', 'image/jpg'].includes(this.mimeType));

            // Protection against "broken" images: block format change if no processed image was provided.
            if (!overrideImage && !isSameMime) {
                throw new Error(`[imageUtils] Format change (${forcedMimeType}) is only allowed for processed images (overrideImage).`);
            }

            const targetMimeType = forcedMimeType || this.mimeType;

            // // Final check for supported formats to prevent MIME/data mismatch (broken images)
            // const isSupported = ['image/jpeg', 'image/jpg', 'image/png'].includes(targetMimeType);
            // if (!isSupported) {
            //     throw new Error(`[imageUtils] Unsupported output format: ${targetMimeType}. Only PNG and JPEG are supported.`);
            // }

            const finalImg = overrideImage || this.image;
            // nativeImage can export as PNG or JPEG
            const isJpeg = targetMimeType === 'image/jpeg' || targetMimeType === 'image/jpg';
            const newBuffer = isJpeg ? finalImg.toJPEG(95) : finalImg.toPNG();
            const newBase64 = newBuffer.toString('base64');

            // Return in the same format as received (or forced)
            if (this.isDataUri) {
                return `data:${targetMimeType};base64,${newBase64}`;
            }
            return newBase64; // raw base64
        },


        /**
         * Calculates optimized dimensions for the image while maintaining aspect ratio.
         *
         * @param {number} [maxSize=1440] - Maximum allowed dimension for the longest side.
         * @param {number} [minSize=256] - Minimum allowed dimension for any side.
         * @param {number} [step=1] - Ensures width and height are multiples of this value (rounding).
         * @param {boolean} [autoResize2Max=false] - If true, scales the image so its longest side matches maxSize.
         * @returns {[number, number]} A tuple containing the optimized [width, height].
         */
        getOptimizedSize: function (maxSize = 1440, minSize = 256, step = 1, autoResize2Max = false) {
            let width = this.size.width;
            let height = this.size.height;

            // 1. Limit by maximum or force scaling to maximum
            if (autoResize2Max || width > maxSize || height > maxSize) {
                const scaleFactor = Math.min(maxSize / width, maxSize / height);
                width = Math.floor(width * scaleFactor);
                height = Math.floor(height * scaleFactor);
            }

            // 2. Limit by minimum while preserving aspect ratio
            if (width < minSize || height < minSize) {
                const scaleFactor = Math.max(minSize / width, minSize / height);
                width = Math.floor(width * scaleFactor);
                height = Math.floor(height * scaleFactor);
            }

            // 3. Apply step (multiple) and final minSize check
            if (step > 1) {
                width = Math.max(minSize, Math.floor(width / step) * step);
                height = Math.max(minSize, Math.floor(height / step) * step);
            }

            return [width, height];
        },

        /**
         * Calculates dimensions for a target Megapixel area while maintaining aspect ratio.
         * Ensures the result never exceeds the target area and never upscales original dimensions unless allowUpscale is true.
         * 
         * @param {number} targetMP - Target megapixels
         * @param {number} minSize - Minimum side length
         * @param {number} step - Step/multiple for dimensions
         * @param {boolean} allowUpscale - If true, can return dimensions larger than original
         * @returns {[number, number]}
         */
        getOptimizedSizeByMegapixels: function (targetMP, minSize = 256, step = 1, allowUpscale = false) {
            const width = this.size.width;
            const height = this.size.height;

            if (!targetMP) return [width, height];

            const targetArea = targetMP * 1024 * 1024;
            const currentArea = width * height;

            if (currentArea <= targetArea && !allowUpscale) {
                // No upscaling to targetArea. But we MUST ensure minSize while preserving aspect ratio.
                let w = width;
                let h = height;

                if (w < minSize || h < minSize) {
                    const scaleFactor = Math.max(minSize / w, minSize / h);
                    w = Math.floor(w * scaleFactor);
                    h = Math.floor(h * scaleFactor);
                }

                // Apply step rounding down (but keep at least minSize)
                w = Math.max(minSize, Math.floor(w / step) * step);
                h = Math.max(minSize, Math.floor(h / step) * step);
                return [w, h];
            }

            const scale = Math.sqrt(targetArea / currentArea);
            let w = Math.floor(width * scale);
            let h = Math.floor(height * scale);

            // Apply step rounding down
            w = Math.floor(w / step) * step;
            h = Math.floor(h / step) * step;

            // Apply minSize proportionally if needed
            if (w < minSize || h < minSize) {
                const scaleFactor = Math.max(minSize / w, minSize / h);
                w = Math.floor(w * scaleFactor);
                h = Math.floor(h * scaleFactor);

                // Re-apply step rounding down (ensuring we stay at or above minSize)
                w = Math.max(minSize, Math.floor(w / step) * step);
                h = Math.max(minSize, Math.floor(h / step) * step);
            }

            // Final check for overshoot due to rounding edges or minSize
            // If w*h still exceeds targetArea, reduce the larger side to be safe
            if (w * h > targetArea && (w > minSize || h > minSize)) {
                if (w >= h) {
                    w = Math.max(minSize, w - step);
                } else {
                    h = Math.max(minSize, h - step);
                }
            }

            return [w, h];
        }
    };
}

module.exports = { detectMimeTypeFromBase64, mimeTypeToExt, parseImageInput };
