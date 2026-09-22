/**
 * Turning whatever a script or Photoshop threw into text the agent can act on.
 *
 * Not everything thrown inside UXP is an Error with a message. Photoshop's DOM sometimes
 * throws an object whose useful part is a `number` or a `result`, or an Error whose message
 * is empty; formatting `${error.message}` then hands the agent the bare word "undefined",
 * and it is left guessing. This file picks the most informative text available instead.
 *
 * It is pure and does not require('photoshop'), so it is tested from Node.
 */

// Enough for any real message; a runaway dump of some large object is cut here.
const MAX_TEXT_LENGTH = 1000;
const MAX_VALUE_LENGTH = 200;

// Own properties that are already represented, or are noise for the agent.
const SKIPPED_PROPERTIES = new Set(['message', 'stack', 'name']);

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function cut(text, limit) {
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * @param {*} value - Anything.
 * @returns {string|null} JSON text, or null when it cannot be serialized.
 */
function safeJson(value) {
    try {
        const text = JSON.stringify(value);
        return typeof text === 'string' ? text : null;
    } catch {
        // Cyclic structures and host objects that refuse serialization.
        return null;
    }
}

/**
 * The thrown object's own extra properties, such as `number`, `code` or `result`, as
 * "key: value" pairs.
 *
 * @param {object} error
 * @returns {string[]}
 */
function extraProperties(error) {
    let keys;
    try {
        keys = Object.getOwnPropertyNames(error);
    } catch {
        return [];
    }

    const pairs = [];
    for (const key of keys) {
        if (SKIPPED_PROPERTIES.has(key)) continue;
        let value;
        try {
            value = error[key];
        } catch {
            continue;
        }
        if (value === undefined || typeof value === 'function') continue;
        // A nested Error (a `cause`, say) serializes to "{}", so its message is used instead.
        // Not described in full: that could loop on errors that point at each other.
        const text = typeof value === 'string'
            ? value
            : (value instanceof Error ? String(value.message || value.name || '') : safeJson(value));
        if (text === null || text === '' || text === '{}') continue;
        pairs.push(`${key}: ${cut(text, MAX_VALUE_LENGTH)}`);
    }
    return pairs;
}

/**
 * The most informative text for whatever was thrown. Never empty and never the bare word
 * "undefined".
 *
 * Order of preference: a non-empty `message`; otherwise the value's own string form when it
 * says something (not "[object Object]", not just the class name); then any other own
 * properties, which is where Photoshop puts its error `number`. When none of that exists,
 * a sentence says so plainly.
 *
 * @param {*} error - Whatever was thrown or rejected.
 * @returns {string}
 */
function describeError(error) {
    if (error === undefined || error === null) {
        return `An error without any description was thrown (the thrown value was ${error}).`;
    }

    if (typeof error !== 'object' && typeof error !== 'function') {
        const text = String(error).trim();
        if (!text) return 'An empty string was thrown, with no description.';
        if (text === 'undefined') return 'The string "undefined" was thrown, with no description.';
        return cut(text, MAX_TEXT_LENGTH);
    }

    let name = '';
    try {
        name = typeof error.name === 'string' ? error.name.trim() : '';
    } catch {
        // A host object may refuse even this.
    }

    let head = '';
    try {
        head = typeof error.message === 'string' ? error.message.trim() : '';
    } catch {
        // Same as above.
    }

    if (!head) {
        let own = '';
        try {
            own = String(error).trim();
        } catch {
            // An object whose toString throws says nothing useful anyway.
        }
        // String(new Error('')) is just "Error": the class name, already kept in `name`.
        const uninformative = !own
            || own === '[object Object]'
            || own === name
            || own === `${name}:`
            || own === 'undefined';
        if (!uninformative) head = own;
    }

    const extras = extraProperties(error);

    if (head) {
        const text = extras.length > 0 ? `${head} (${extras.join(', ')})` : head;
        return cut(text, MAX_TEXT_LENGTH);
    }

    const label = name && name !== 'Object' ? name : 'An error';
    if (extras.length > 0) {
        return cut(`${label} without a message (${extras.join(', ')})`, MAX_TEXT_LENGTH);
    }

    // Nothing on the object itself: the last resort is whatever JSON makes of it.
    const dump = safeJson(error);
    if (dump && dump !== '{}') {
        return cut(`${label} without a message: ${dump}`, MAX_TEXT_LENGTH);
    }
    return `${label} without a message or any other details.`;
}

module.exports = { describeError };
