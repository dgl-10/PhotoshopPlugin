'use strict';

// error-text.js lives in the UXP plugin (modules/ at the repository root). It is pure, so it
// is tested from here, next to the project's test runner.

const assert = require('node:assert/strict');
const test = require('node:test');

const { describeError } = require('../../modules/error-text.js');

test('an ordinary Error gives its message', () => {
    assert.equal(describeError(new Error('The layer is locked.')), 'The layer is locked.');
});

test('extra properties Photoshop puts on an error are kept next to the message', () => {
    const error = new Error('Could not complete the command.');
    error.number = 8007;
    assert.equal(describeError(error), 'Could not complete the command. (number: 8007)');
});

test('an Error with an empty message and only a number never says "undefined"', () => {
    const error = new Error('');
    error.number = -25920;
    const text = describeError(error);
    assert.equal(text, 'Error without a message (number: -25920)');
    assert.doesNotMatch(text, /undefined/);
});

test('a plain object without a message is shown by its own properties', () => {
    const text = describeError({ number: 9, result: -128 });
    assert.equal(text, 'An error without a message (number: 9, result: -128)');
});

test('an object with its own toString is described by it', () => {
    const thrown = { toString: () => 'Photoshop is busy' };
    assert.equal(describeError(thrown), 'Photoshop is busy');
});

test('a thrown string or number is shown as it is', () => {
    assert.equal(describeError('the layer is gone'), 'the layer is gone');
    assert.equal(describeError(42), '42');
});

test('undefined, null, an empty object and an empty Error still give a real sentence', () => {
    for (const thrown of [undefined, null, {}, new Error(''), '', 'undefined']) {
        const text = describeError(thrown);
        assert.ok(text.length > 0);
        assert.notEqual(text, 'undefined');
        assert.notEqual(text, '[object Object]');
    }
    assert.match(describeError(undefined), /without any description/);
    assert.equal(describeError({}), 'An error without a message or any other details.');
});

test('a nested cause is shown by its message, not as "{}"', () => {
    const error = new Error('Outer failure', { cause: new Error('inner reason') });
    assert.equal(describeError(error), 'Outer failure (cause: inner reason)');
});

test('an object that cannot be serialized and has no message does not throw', () => {
    const thrown = {};
    thrown.self = thrown;
    const text = describeError(thrown);
    assert.equal(text, 'An error without a message or any other details.');
});

test('a very long message is cut', () => {
    const text = describeError(new Error('x'.repeat(5000)));
    assert.ok(text.length <= 1001);
});
