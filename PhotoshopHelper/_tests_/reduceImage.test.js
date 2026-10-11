'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createImageReducer } = require('../agent/reduce-image');

/**
 * A stand-in for Electron's nativeImage that records how it was asked to resize.
 *
 * @param {number} width - Width of every image it "decodes".
 * @param {number} height - Height of every image it "decodes".
 * @returns {object} { nativeImage, resizes }
 */
function fakeNativeImage(width, height) {
    const resizes = [];

    /**
     * @param {number} w - Width.
     * @param {number} h - Height.
     * @returns {object} A fake NativeImage.
     */
    function image(w, h) {
        return {
            isEmpty: () => false,
            getSize: () => ({ width: w, height: h }),
            resize(options) {
                resizes.push(options);
                const scale = options.width ? options.width / w : options.height / h;
                return image(Math.round(w * scale), Math.round(h * scale));
            },
            toPNG: () => Buffer.from(`png ${w}x${h}`)
        };
    }

    return {
        nativeImage: { createFromBuffer: () => image(width, height) },
        resizes
    };
}

test('a large image is reduced along its long side, keeping its proportions', () => {
    const { nativeImage, resizes } = fakeNativeImage(800, 1600);
    const reduce = createImageReducer(nativeImage);

    const shown = reduce(Buffer.from('original').toString('base64'), 512);

    assert.deepEqual(resizes, [{ height: 512, quality: 'good' }]);
    assert.equal(shown.reduced, true);
    assert.equal(shown.width, 256);
    assert.equal(shown.height, 512);
    assert.equal(shown.originalWidth, 800);
    assert.equal(shown.originalHeight, 1600);
    assert.equal(Buffer.from(shown.base64, 'base64').toString(), 'png 256x512');
});

test('an image that already fits is handed back unchanged', () => {
    const { nativeImage, resizes } = fakeNativeImage(300, 200);
    const reduce = createImageReducer(nativeImage);
    const original = Buffer.from('original').toString('base64');

    const shown = reduce(original, 512);

    assert.equal(resizes.length, 0);
    assert.equal(shown.reduced, false);
    assert.equal(shown.base64, original);
    assert.equal(shown.width, 300);
});

test('without Electron the image goes as it is', () => {
    const reduce = createImageReducer(null);

    const shown = reduce('abc', 512);

    assert.equal(shown.reduced, false);
    assert.equal(shown.base64, 'abc');
});
