'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { readImagePixelSize } = require('../../modules/image-size.js');

/**
 * The start of a PNG: signature and an IHDR chunk with the given size.
 *
 * @param {number} width - Width in pixels.
 * @param {number} height - Height in pixels.
 * @returns {Buffer}
 */
function pngHeader(width, height) {
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4, 'ascii');
    ihdr.writeUInt32BE(width, 8);
    ihdr.writeUInt32BE(height, 12);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

/**
 * The start of a JPEG: SOI, a JFIF segment that claims 300 ppi, an EXIF segment, then a
 * baseline frame header with the given size.
 *
 * @param {number} width - Width in pixels.
 * @param {number} height - Height in pixels.
 * @returns {Buffer}
 */
function jpegHeader(width, height) {
    const jfif = Buffer.from([
        0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
        0x01, 0x01, 0x2c, 0x01, 0x2c, 0x00, 0x00
    ]);
    const exif = Buffer.from([0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
    const frame = Buffer.alloc(19);
    frame.writeUInt16BE(0xffc0, 0);
    frame.writeUInt16BE(17, 2);
    frame[4] = 8;
    frame.writeUInt16BE(height, 5);
    frame.writeUInt16BE(width, 7);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, exif, frame]);
}

test('a PNG gives the size in its IHDR chunk', () => {
    assert.deepEqual(readImagePixelSize(pngHeader(1024, 768)), { width: 1024, height: 768 });
});

test('a JPEG gives the size in its frame header, past the segments before it, whatever ppi it claims', () => {
    assert.deepEqual(readImagePixelSize(jpegHeader(1536, 1024)), { width: 1536, height: 1024 });
});

test('an ArrayBuffer works as well as a Uint8Array', () => {
    const bytes = new Uint8Array(pngHeader(300, 200));
    assert.deepEqual(readImagePixelSize(bytes.buffer), { width: 300, height: 200 });
});

test('the format is told by the bytes, so anything else or a cut header gives null', () => {
    assert.equal(readImagePixelSize(Buffer.from('GIF89a........')), null);
    assert.equal(readImagePixelSize(pngHeader(10, 10).subarray(0, 20)), null);
    assert.equal(readImagePixelSize(jpegHeader(10, 10).subarray(0, 25)), null);
    assert.equal(readImagePixelSize(null), null);
});
