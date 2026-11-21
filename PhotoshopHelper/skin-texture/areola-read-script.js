'use strict';

/**
 * Read-only Photoshop script for task20: hand Helper the pixels it measures areolas on, through a
 * file in the plugin's data folder (the same folder the texture exchange files use, in the other
 * direction). The agent receives Helper's numbers, never these pixels.
 *
 * Two modes:
 * - "selection": the active selection as a gray mask, reduced so its longer side is at most
 *   maxSide (Photoshop scales it; the map back to document pixels is in the header);
 * - "image": the composite of a document area as 8-bit sRGB, reduced the same way.
 *
 * File layout: "SKAR0001", uint32 little-endian header length H, H bytes of ASCII JSON header
 * { kind, width, height, components, componentSize, sourceBounds }, then the samples, row-major,
 * chunky, 8 or 16 bits per sample (16-bit little-endian, Photoshop's range 0..32768).
 *
 * The script changes nothing in the document. Helper deletes the file after reading it.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAGIC = 'SKAR0001';
const FILE_PREFIX = 'skin-areola-read-';

/** A fresh file name for one read; Helper owns and removes it. */
function newReadFileName() {
    return `${FILE_PREFIX}${crypto.randomBytes(6).toString('hex')}.bin`;
}

/**
 * @param {object} expect
 * @param {'selection'|'image'} expect.mode
 * @param {string} expect.fileName - From newReadFileName.
 * @param {number} expect.maxSide - Longest side of the returned grid.
 * @param {{left: number, top: number, right: number, bottom: number}} [expect.bounds] - Image area.
 * @returns {string} UXP script for agent_execute_script.
 */
function buildReadScript(expect) {
    return `// Skin texture: read ${expect.mode === 'selection' ? 'the selection' : 'document pixels'} for local areola measurement.
// Built by PhotoshopHelper/skin-texture/areola-read-script.js. Read-only. Do not edit or resend by hand.
const EXPECT = ${JSON.stringify(expect)};
const uxp = require('uxp');
const folder = await uxp.storage.localFileSystem.getDataFolder();
const facts = { id: doc.id, width: doc.width, height: doc.height };
function reduceTo(width, height) {
    const scale = Math.max(width, height) / EXPECT.maxSide;
    return scale > 1 ? { width: Math.max(1, Math.round(width / scale)), height: Math.max(1, Math.round(height / scale)) } : null;
}
let result = null, header = null;
if (EXPECT.mode === 'selection') {
    let bounds = null;
    try { bounds = doc.selection ? doc.selection.bounds : null; } catch (e) { bounds = null; }
    if (!bounds) return { ok: false, code: 'NO_SELECTION', message: 'The document has no active selection.', document: facts };
    // The selection may extend past the canvas; only the canvas part can hold an areola.
    const b = { left: Math.max(0, Math.floor(bounds.left)), top: Math.max(0, Math.floor(bounds.top)),
        right: Math.min(doc.width, Math.ceil(bounds.right)), bottom: Math.min(doc.height, Math.ceil(bounds.bottom)) };
    if (b.right <= b.left || b.bottom <= b.top) return { ok: false, code: 'NO_SELECTION', message: 'The selection lies outside the canvas.', document: facts };
    const options = { documentID: doc.id, sourceBounds: b };
    const target = reduceTo(b.right - b.left, b.bottom - b.top);
    if (target) options.targetSize = target;
    result = await imaging.getSelection(options);
    if (!result || !result.imageData) return { ok: false, code: 'NO_SELECTION', message: 'The selection could not be read.', document: facts };
} else {
    const b = EXPECT.bounds;
    const options = { documentID: doc.id, sourceBounds: b, componentSize: 8, colorSpace: 'RGB',
        colorProfile: 'sRGB IEC61966-2.1', applyAlpha: true };
    const target = reduceTo(b.right - b.left, b.bottom - b.top);
    if (target) options.targetSize = target;
    result = await imaging.getPixels(options);
    if (!result || !result.imageData) return { ok: false, code: 'PIXELS_UNREADABLE', message: 'The document pixels could not be read.', document: facts };
}
try {
    const data = await result.imageData.getData();
    header = { kind: EXPECT.mode, width: result.imageData.width, height: result.imageData.height,
        components: result.imageData.components, componentSize: data instanceof Uint16Array ? 16 : 8,
        sourceBounds: { left: +result.sourceBounds.left, top: +result.sourceBounds.top,
            right: +result.sourceBounds.right, bottom: +result.sourceBounds.bottom } };
    const text = JSON.stringify(header);
    const payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const bytes = new Uint8Array(12 + text.length + payload.length);
    for (let i = 0; i < 8; i++) bytes[i] = '${MAGIC}'.charCodeAt(i);
    bytes[8] = text.length & 255; bytes[9] = (text.length >>> 8) & 255; bytes[10] = (text.length >>> 16) & 255; bytes[11] = (text.length >>> 24) & 255;
    for (let i = 0; i < text.length; i++) bytes[12 + i] = text.charCodeAt(i);
    bytes.set(payload, 12 + text.length);
    const file = await folder.createFile(EXPECT.fileName, { overwrite: true });
    await file.write(bytes.buffer, { format: uxp.storage.formats.binary });
} finally {
    result.imageData.dispose();
}
return { ok: true, file: EXPECT.fileName, folder: folder.nativePath, header, document: facts };
`;
}

/**
 * Read and remove one file written by the script. The folder must be the plugin data folder the
 * script reported; the name must be the one Helper chose.
 *
 * @returns {{ header: object, samples: Uint8Array|Uint16Array }}
 */
function takeReadFile(folder, fileName) {
    if (!fileName.startsWith(FILE_PREFIX) || path.basename(fileName) !== fileName) throw new Error('Unexpected read file name.');
    const file = path.join(folder, fileName);
    let bytes;
    try {
        bytes = fs.readFileSync(file);
    } finally {
        fs.rmSync(file, { force: true });
    }
    if (bytes.length < 12 || bytes.toString('latin1', 0, 8) !== MAGIC) throw new Error('The read file is not an areola read file.');
    const length = bytes.readUInt32LE(8);
    const header = JSON.parse(bytes.toString('latin1', 12, 12 + length));
    const start = 12 + length;
    const count = header.width * header.height * header.components;
    const size = header.componentSize === 16 ? 2 : 1;
    if (bytes.length !== start + count * size) throw new Error(`The read file has ${bytes.length - start} sample bytes instead of ${count * size}.`);
    const body = bytes.subarray(start);
    const samples = size === 2
        ? new Uint16Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length))
        : new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length));
    return { header, samples };
}

module.exports = { MAGIC, FILE_PREFIX, newReadFileName, buildReadScript, takeReadFile };
