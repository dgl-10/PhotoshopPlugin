/**
 * The real pixel size of a PNG or JPEG, read from the file's own header.
 *
 * Photoshop's Place scales an image by the resolution stored in it against the document's
 * own: a 1024 px file saved at 300 ppi lands in a 72 ppi document at 246 px. Code that has
 * to undo that needs the size in pixels, which the header states plainly, whatever
 * resolution the file claims. The format is told by the first bytes, not by the extension:
 * a pasted image is saved as .png whatever it really is.
 *
 * No Photoshop or UXP dependency, so it runs in the plugin and in Node tests alike.
 */

// PNG files start with these eight bytes; the IHDR chunk with the size follows at once.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * @param {Uint8Array} bytes - File bytes.
 * @param {number} at - Offset.
 * @returns {number} Big-endian 16-bit value.
 */
function readUint16(bytes, at) {
    return (bytes[at] << 8) | bytes[at + 1];
}

/**
 * @param {Uint8Array} bytes - File bytes.
 * @param {number} at - Offset.
 * @returns {number} Big-endian 32-bit value.
 */
function readUint32(bytes, at) {
    return ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
}

/**
 * @param {Uint8Array} bytes - File bytes.
 * @returns {{width: number, height: number}|null}
 */
function readPngSize(bytes) {
    if (bytes.length < 24) return null;
    // The first chunk must be IHDR: width and height are its first two fields.
    const isIhdr = bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
    if (!isIhdr) return null;
    return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
}

/**
 * @param {Uint8Array} bytes - File bytes.
 * @returns {{width: number, height: number}|null}
 */
function readJpegSize(bytes) {
    let at = 2;
    while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1];

        // Fill bytes before a marker, and the markers that carry no length.
        if (marker === 0xff) { at += 1; continue; }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue; }

        // A start-of-frame marker holds the size: SOF0–SOF15, except DHT, JPG and DAC.
        const isFrame = marker >= 0xc0 && marker <= 0xcf
            && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) {
            return { width: readUint16(bytes, at + 7), height: readUint16(bytes, at + 5) };
        }

        // Image data starts at start-of-scan; a frame header always comes before it.
        if (marker === 0xda) return null;
        at += 2 + readUint16(bytes, at + 2);
    }
    return null;
}

/**
 * Read the pixel size of a PNG or JPEG.
 *
 * @param {ArrayBuffer|Uint8Array} data - The whole file, or at least its beginning.
 * @returns {{width: number, height: number}|null} The size, or null for anything else or a
 *   header that cannot be read.
 */
function readImagePixelSize(data) {
    if (!data) return null;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

    let size = null;
    if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
        size = readPngSize(bytes);
    } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        size = readJpegSize(bytes);
    }

    return size && size.width > 0 && size.height > 0 ? size : null;
}

module.exports = { readImagePixelSize };
