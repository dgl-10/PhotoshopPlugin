/**
 * Image Processing Utilities Module
 * Handles in-memory image manipulation and conversion
 */

/**
 * Prepare mask data for encoding (fixes types, structure, components)
 * @param {object} maskData - Raw mask data from Photoshop
 * @returns {Promise<object>} Valid PhotoshopImageData object
 */
async function prepareMaskForEncoding(maskData) {
    const { imaging } = require('photoshop');

    // Debug: inspect full maskData structure
    console.log('prepareMaskForEncoding calling with maskData:', maskData ? 'present' : 'missing');

    // Try to find the actual image data and metadata
    let imgData, width, height, components, rowBytes;

    // 1. Try to handle PhotoshopImageData (has .getData() method)
    // Access nested imageData if present (standard structure from getSelection)
    const psImgData = (maskData.imageData && maskData.imageData.getData) ? maskData.imageData :
        (maskData.getData ? maskData : null);

    if (psImgData) {
        try {
            const rawData = await psImgData.getData();
            if (rawData) {
                // Ensure Uint8Array
                imgData = new Uint8Array(rawData);
            }

            width = psImgData.width || maskData.width;
            height = psImgData.height || maskData.height;
            components = psImgData.components || maskData.components || 1;
            rowBytes = psImgData.rowBytes || maskData.rowBytes;
        } catch (e) {
            console.error("Failed to getData from PhotoshopImageData:", e);
        }
    }

    // 2. Fallback to direct property access (if not a class instance or getData failed)
    if (!imgData) {
        if (maskData.imageData && (maskData.imageData instanceof Uint8Array || maskData.imageData.imageData)) {
            const src = maskData.imageData.imageData || maskData.imageData;
            if (src) imgData = new Uint8Array(src); // Ensure Uint8Array

            width = maskData.imageData.width || maskData.width;
            height = maskData.imageData.height || maskData.height;
            components = maskData.imageData.components || maskData.components || 1;
            rowBytes = maskData.imageData.rowBytes || maskData.rowBytes;
        } else {
            const src = maskData.imageData || maskData;
            if (src.byteLength || src.buffer) {
                imgData = new Uint8Array(src);
            } else {
                imgData = src;
            }

            width = maskData.width;
            height = maskData.height;
            components = maskData.components || 1;
            rowBytes = maskData.rowBytes;
        }
    }

    if (!imgData) {
        throw new Error("Could not extract image data from mask payload");
    }

    // Robust Heuristic V2 for RGB Mask Detection
    let inferred = components;

    // Check RowBytes (Stride)
    if (width && rowBytes) {
        const bpp = rowBytes / width;
        if (bpp >= 2.5 && bpp <= 4.5) {
            const rounded = Math.round(bpp);
            if (rounded === 3 || rounded === 4) {
                inferred = rounded;
            }
        }
    }

    // Check Data Size
    if (inferred === 1 && width && height && imgData.byteLength) {
        const ratio = imgData.byteLength / (width * height);
        if (ratio >= 2.5) {
            if (Math.abs(ratio - 3) < 0.6) inferred = 3;
            else if (Math.abs(ratio - 4) < 0.6) inferred = 4;
        }
    }

    if (inferred !== components) {
        components = inferred;
    }

    // Handle RowBytes/Stride padding if present
    const logicalRowBytes = width * components;

    if (rowBytes && rowBytes > logicalRowBytes) {
        const newBuffer = new Uint8Array(width * height * components);

        for (let y = 0; y < height; y++) {
            const srcStart = y * rowBytes;
            const srcEnd = srcStart + logicalRowBytes;
            const dstStart = y * logicalRowBytes;

            if (imgData.subarray) {
                newBuffer.set(imgData.subarray(srcStart, srcEnd), dstStart);
            } else {
                for (let x = 0; x < logicalRowBytes; x++) {
                    newBuffer[dstStart + x] = imgData[srcStart + x];
                }
            }
        }
        imgData = newBuffer;
    }

    // Check for Grayscale (1 component) and expand to RGB (3 components)
    if (components === 1) {
        const pixelCount = width * height;
        const rgbBuffer = new Uint8Array(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const val = (i < imgData.byteLength) ? imgData[i] : 0;
            rgbBuffer[i * 3] = val;     // R
            rgbBuffer[i * 3 + 1] = val; // G
            rgbBuffer[i * 3 + 2] = val; // B
        }

        imgData = rgbBuffer;
        components = 3;
    }

    // Create a valid object
    try {
        return await imaging.createImageDataFromBuffer(imgData, {
            width: width,
            height: height,
            components: components,
            chunky: true,
            colorSpace: 'RGB'
        });
    } catch (objErr) {
        console.error("Error creating PhotoshopImageData:", objErr);
        throw objErr;
    }
}

/**
 * Convert Mask Data to base64 string
 * @param {object} maskData - Raw mask data
 * @returns {Promise<string>} Base64 encoded PNG
 */
async function maskDataToBase64(maskData) {
    try {
        const { imaging } = require('photoshop');

        // Use shared logic to prepare mask data
        const validImageObj = await prepareMaskForEncoding(maskData);

        // Encode to PNG base64
        const pngData = await imaging.encodeImageData({
            imageData: validImageObj,
            base64: true
        });

        return pngData;
    } catch (error) {
        console.error('Error converting mask to base64:', error);
        return null;
    }
}

/**
 * Convert ImageData to base64 string for preview
 * Uses Photoshop's imaging API to encode
 * @param {object} imageObj - Image object from imaging API
 * @returns {Promise<string>}
 */
async function imageDataToBase64(imageObj) {
    try {
        // BYPASS: If the object is already a Base64 data URL string, return ONLY the base64 part.
        // This ensures callers like getPreviewDataUrl don't create double-prefixed strings.
        if (typeof imageObj === 'string' && imageObj.includes(';base64,')) {
            return imageObj.split(';base64,')[1];
        }
        if (imageObj && typeof imageObj.imageData === 'string' && imageObj.imageData.includes(';base64,')) {
            return imageObj.imageData.split(';base64,')[1];
        }

        const { imaging } = require('photoshop');

        // Encode to PNG — must specify format explicitly, otherwise API may default to JPEG
        // which cannot encode alpha channel (RGBA) data
        const pngData = await imaging.encodeImageData({
            imageData: imageObj.imageData || imageObj,
            format: 'image/png',
            base64: true
        });

        return pngData;
    } catch (error) {
        console.error('Error converting to base64:', error);
        // Return empty placeholder
        return '';
    }
}

/**
 * Generate Overlay Mask for Preview (Dim unselected areas)
 * @param {object} maskData - Raw mask data from Photoshop
 * @returns {Promise<string>} Base64 encoded PNG for overlay
 */
async function generateOverlayMask(maskData) {
    try {
        const { imaging } = require('photoshop');

        // 1. Prepare Mask Data using shared logic
        const prepared = await prepareMaskForEncoding(maskData);
        // We need raw pixel data for ImageBlob
        // prepareMaskForEncoding returns a PhotoshopImageData object.
        const rgbData = await prepared.getData();
        const width = prepared.width;
        const height = prepared.height;

        // 2. Create RGBA buffer
        const pixelCount = width * height;
        const rgbaBuffer = new Uint8Array(pixelCount * 4);

        const OPACITY = 0.3; // 30% dimming (more transparent)

        for (let i = 0; i < pixelCount; i++) {
            // Mask is RGB (grayscale in 3 channels)
            const maskValue = rgbData[i * 3];

            // Set Color to Black (R=0, G=0, B=0)
            rgbaBuffer[i * 4] = 0;     // R
            rgbaBuffer[i * 4 + 1] = 0; // G
            rgbaBuffer[i * 4 + 2] = 0; // B

            // Transparency Logic:
            // Mask 255 (Selected) -> Alpha 0 (Fully Transparent Overlay)
            // Mask 0 (Unselected) -> Alpha ~153 (Semi-transparent Overlay)
            const alpha = (255 - maskValue) * OPACITY;
            rgbaBuffer[i * 4 + 3] = Math.round(alpha);
        }

        // 3. Create ImageBlob (Special UXP Class for efficient image handling)
        if (typeof ImageBlob === 'undefined') {
            console.warn('ImageBlob API is not available in this UXP version.');
            return null;
        }

        const imageMetaData = {
            width: width,
            height: height,
            colorSpace: "RGB",
            pixelFormat: "RGBA",
            components: 4,      // RGBA
            componentSize: 8,   // 8 bits per channel
            hasAlpha: true,     // Vital for transparency
            type: "image/uncompressed"
        };

        const blob = new ImageBlob(rgbaBuffer, imageMetaData);

        // 4. Create Object URL
        const dataUrl = URL.createObjectURL(blob);

        return dataUrl;

    } catch (error) {
        console.error('Error generating overlay mask (ImageBlob):', error);
        // Return null so we don't break the main flow
        return null;
    }
}

module.exports = {
    prepareMaskForEncoding,
    maskDataToBase64,
    imageDataToBase64,
    generateOverlayMask
};
