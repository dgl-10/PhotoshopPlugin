/*
 * Skin texture exchange file: the format in which Helper hands a computed gray layer to the
 * Photoshop plugin, plus the gray-to-RGBA conversion used when the plugin writes the layer.
 *
 * Like the relief core (skin-core.js) this file has NO host dependencies: no require, no
 * Buffer, no TextEncoder/TextDecoder (UXP has neither), no DOM, no photoshop/uxp modules.
 * Only numbers, strings and typed arrays, and only ASCII characters in the source. Helper
 * loads it with require(); the apply script built by uxp-scripts.js carries the unchanged
 * text of this file and runs it inside Photoshop with
 *     new Function('module', text + '\nreturn SkinExchange;')(undefined)
 * so both sides run identical code for the format and the checksums. The approach and the
 * layout are adapted from the task02 delivery experiments (sandbox/task02/delivery-common.js,
 * format SKTX0001), which were checked against real Photoshop reads.
 *
 * File layout (all integers little-endian):
 *   0       8 bytes  magic "SKTX0002"
 *   8       uint32   H = header length in bytes
 *   12      H bytes  header: JSON text restricted to ASCII
 *   12+H             payload: rect.width * rect.height gray samples, 8 bit, row-major,
 *                    top row first; 128 is neutral
 *   end-16  16 bytes trailer: "SKTXEND!" + uint32 CRC-32(payload) + uint32 CRC-32(header)
 * The exact total length follows from the header, so a truncated or padded file is refused;
 * a missing trailer (the writer died) is refused; a payload or header changed after writing is
 * refused by the checksums. Helper writes "<name>.partial" first and renames it only when it
 * is complete, and the plugin opens final names only, so a half-written file is never read.
 *
 * Pixel conventions: a gray layer is a Uint8Array of width * height samples. RGBA buffers are
 * chunky (R, G, B, A per pixel) with R = G = B = gray and A opaque. 16-bit buffers use
 * Photoshop's reduced 16-bit range 0..32768 (createImageDataFromBuffer with fullRange false,
 * its default); an 8-bit value v maps to round(v * 32768 / 255). Because 255 is odd an exact
 * .5 tie never occurs, so the mapping is unambiguous and round(w * 255 / 32768) inverts it.
 * task02 verified exactly this mapping on 16-bit sRGB and ProPhoto documents.
 */
'use strict';
var SkinExchange = (function () {
    const FORMAT = 'skin-texture-gray8';
    const VERSION = 2;
    const MAGIC = 'SKTX0002';
    const TRAILER = 'SKTXEND!';
    const MAX_HEADER = 65536;

    // ---- Checksums ---------------------------------------------------------
    // CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320), the PNG/zlib variant.
    const CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
        CRC_TABLE[i] = c >>> 0;
    }
    function crc32(bytes, start, end) {
        const from = start === undefined ? 0 : start, to = end === undefined ? bytes.length : end;
        let c = 0xffffffff;
        for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }
    // FNV-1a 32-bit: an independent second checksum, so an accidental double collision on a
    // large layer is practically impossible.
    function fnv1a(bytes, start, end) {
        const from = start === undefined ? 0 : start, to = end === undefined ? bytes.length : end;
        let h = 0x811c9dc5;
        for (let i = from; i < to; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
        return h >>> 0;
    }
    const hex = n => ('00000000' + (n >>> 0).toString(16)).slice(-8);
    function checksums(bytes) {
        return { length: bytes.length, crc32: hex(crc32(bytes)), fnv1a: hex(fnv1a(bytes)) };
    }

    // ---- Rectangles --------------------------------------------------------
    const RECT_KEYS = ['x', 'y', 'width', 'height'];
    function checkRect(rect, documentSize) {
        const ok = !!rect && typeof rect === 'object' && RECT_KEYS.every(k => Number.isInteger(rect[k])) &&
            rect.x >= 0 && rect.y >= 0 && rect.width >= 1 && rect.height >= 1;
        if (!ok) throw new Error('RECT_INVALID: rect needs integer x, y >= 0 and width, height >= 1');
        if (documentSize && (rect.x + rect.width > documentSize.width || rect.y + rect.height > documentSize.height))
            throw new Error('RECT_OUTSIDE_DOCUMENT: rect ' + JSON.stringify(rect) + ' exceeds the document ' +
                documentSize.width + 'x' + documentSize.height);
        return rect;
    }
    const sameRect = (a, b) => !!a && !!b && RECT_KEYS.every(k => a[k] === b[k]);

    // ---- Gray to RGBA ------------------------------------------------------
    function grayToRgba8(gray) {
        if (!(gray instanceof Uint8Array)) throw new Error('GRAY_TYPE: expected Uint8Array');
        const out = new Uint8Array(gray.length * 4);
        for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
            const v = gray[i];
            out[j] = v; out[j + 1] = v; out[j + 2] = v; out[j + 3] = 255;
        }
        return out;
    }
    const to16 = v => Math.round(v * 32768 / 255);
    const from16 = w => Math.round(w * 255 / 32768);
    function grayToRgba16(gray) {
        if (!(gray instanceof Uint8Array)) throw new Error('GRAY_TYPE: expected Uint8Array');
        const lut = new Uint16Array(256);
        for (let v = 0; v < 256; v++) lut[v] = to16(v);
        const out = new Uint16Array(gray.length * 4);
        for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
            const w = lut[gray[i]];
            out[j] = w; out[j + 1] = w; out[j + 2] = w; out[j + 3] = 32768;
        }
        return out;
    }

    // ---- Exchange file -----------------------------------------------------
    function asciiBytes(text) {
        const out = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c > 127) throw new Error('EXCHANGE_HEADER_NOT_ASCII: header must be ASCII');
            out[i] = c;
        }
        return out;
    }
    function asciiText(bytes, start, end) {
        let s = '';
        for (let i = start; i < end; i++) {
            if (bytes[i] > 127) throw new Error('EXCHANGE_HEADER_NOT_ASCII: header must be ASCII');
            s += String.fromCharCode(bytes[i]);
        }
        return s;
    }
    const putU32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
    const getU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    const REQUIRED = ['format', 'version', 'jobId', 'taskId', 'output', 'document', 'rect',
        'components', 'sampleBits', 'payloadLength', 'payloadCrc32', 'payloadFnv1a'];

    // meta: { jobId, taskId, output, document: { id, width, height }, rect, ...extra }.
    // Extra fields (core identity, timings) travel in the header but are not interpreted.
    function encode(meta, gray) {
        if (!(gray instanceof Uint8Array)) throw new Error('GRAY_TYPE: expected Uint8Array');
        if (!meta || !meta.document) throw new Error('EXCHANGE_META: document is required');
        checkRect(meta.rect, meta.document);
        if (gray.length !== meta.rect.width * meta.rect.height)
            throw new Error('EXCHANGE_LENGTH: payload length does not match rect');
        const header = Object.assign({}, meta, {
            format: FORMAT, version: VERSION, components: 1, sampleBits: 8,
            payloadLength: gray.length, payloadCrc32: hex(crc32(gray)), payloadFnv1a: hex(fnv1a(gray)) });
        const headerBytes = asciiBytes(JSON.stringify(header));
        if (headerBytes.length > MAX_HEADER) throw new Error('EXCHANGE_HEADER_TOO_LARGE');
        const total = 12 + headerBytes.length + gray.length + 16;
        const out = new Uint8Array(total);
        out.set(asciiBytes(MAGIC), 0);
        putU32(out, 8, headerBytes.length);
        out.set(headerBytes, 12);
        out.set(gray, 12 + headerBytes.length);
        const t = total - 16;
        out.set(asciiBytes(TRAILER), t);
        putU32(out, t + 8, crc32(gray));
        putU32(out, t + 12, crc32(headerBytes));
        return out;
    }

    // Returns { header, payload }; payload is a view into `bytes`. Throws an Error whose
    // message starts with a stable code on any defect. `expect` cross-checks the identity of
    // the job: jobId, taskId, output, documentId, document { width, height } and rect. Every
    // field given in `expect` must match, so a stale or foreign file is never written.
    function decode(bytes, expect) {
        if (!(bytes instanceof Uint8Array)) throw new Error('EXCHANGE_TYPE: expected Uint8Array');
        if (bytes.length < 28) throw new Error('EXCHANGE_TRUNCATED: file shorter than its fixed parts');
        if (asciiText(bytes, 0, 8) !== MAGIC) throw new Error('EXCHANGE_BAD_MAGIC: not a skin texture exchange file');
        const h = getU32(bytes, 8);
        if (h < 2 || h > MAX_HEADER || 12 + h > bytes.length) throw new Error('EXCHANGE_BAD_HEADER_LENGTH: ' + h);
        let header;
        try { header = JSON.parse(asciiText(bytes, 12, 12 + h)); }
        catch (error) { throw new Error('EXCHANGE_BAD_HEADER: ' + error.message); }
        if (!header || typeof header !== 'object') throw new Error('EXCHANGE_BAD_HEADER: not an object');
        for (const key of REQUIRED) if (!(key in header)) throw new Error('EXCHANGE_HEADER_FIELD: missing ' + key);
        if (header.format !== FORMAT || header.version !== VERSION || header.components !== 1 || header.sampleBits !== 8)
            throw new Error('EXCHANGE_UNSUPPORTED: ' + header.format + ' v' + header.version);
        checkRect(header.rect, header.document);
        if (header.payloadLength !== header.rect.width * header.rect.height)
            throw new Error('EXCHANGE_LENGTH: header payloadLength ' + header.payloadLength + ' != rect area ' +
                header.rect.width * header.rect.height);
        const expectedTotal = 12 + h + header.payloadLength + 16;
        if (bytes.length < expectedTotal) throw new Error('EXCHANGE_TRUNCATED: ' + bytes.length + ' of ' + expectedTotal + ' bytes');
        if (bytes.length > expectedTotal) throw new Error('EXCHANGE_EXTRA_BYTES: ' + bytes.length + ' > ' + expectedTotal);
        const t = expectedTotal - 16;
        if (asciiText(bytes, t, t + 8) !== TRAILER) throw new Error('EXCHANGE_NO_TRAILER: incomplete file');
        if (getU32(bytes, t + 12) !== crc32(bytes, 12, 12 + h)) throw new Error('EXCHANGE_HEADER_CRC: header changed');
        const payload = bytes.subarray(12 + h, t);
        const crc = crc32(payload);
        if (getU32(bytes, t + 8) !== crc || header.payloadCrc32 !== hex(crc))
            throw new Error('EXCHANGE_PAYLOAD_CRC: payload changed or incomplete');
        if (header.payloadFnv1a !== hex(fnv1a(payload)))
            throw new Error('EXCHANGE_PAYLOAD_FNV: payload changed');
        if (expect) {
            for (const key of ['jobId', 'taskId', 'output'])
                if (expect[key] !== undefined && expect[key] !== header[key])
                    throw new Error('EXCHANGE_WRONG_JOB: ' + key + ' is ' + header[key] + ', expected ' + expect[key]);
            if (expect.documentId !== undefined && expect.documentId !== header.document.id)
                throw new Error('EXCHANGE_WRONG_DOCUMENT: document id ' + header.document.id + ', expected ' + expect.documentId);
            if (expect.document && (expect.document.width !== header.document.width || expect.document.height !== header.document.height))
                throw new Error('EXCHANGE_WRONG_DOCUMENT: ' + header.document.width + 'x' + header.document.height);
            if (expect.rect && !sameRect(expect.rect, header.rect))
                throw new Error('EXCHANGE_WRONG_RECT: ' + JSON.stringify(header.rect));
        }
        return { header, payload };
    }

    return { format: FORMAT, version: VERSION, magic: MAGIC, crc32, fnv1a, hex, checksums, checkRect, sameRect,
        grayToRgba8, grayToRgba16, to16, from16, encode, decode };
})();
if (typeof module !== 'undefined') module.exports = SkinExchange;
