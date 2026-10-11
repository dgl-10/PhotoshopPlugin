/**
 * Noticing the batchPlay commands Photoshop rejected while the agent's script ran.
 *
 * batchPlay does not throw when Photoshop refuses a descriptor. Its promise resolves, and
 * the refused command's place in the returned list holds { _obj: "error", message, result }.
 * A script that does not look at that element carries on as if the command had worked, and
 * so does everything after it: Helper gets an ordinary answer and the task looks smooth.
 *
 * While the agent's code runs, it gets its own view of batchPlay. That view returns exactly
 * what the real one returns — the same value, synchronous or a promise, the same rejection —
 * and writes every error element down on the side. The one thing it changes on the way in
 * is `dialogOptions: "dontDisplay"`, which becomes "silent" so that an error comes back to
 * the agent as text instead of as an alert in front of the person. The real `photoshop` module is never
 * changed, so the plugin's own batchPlay calls and whatever the panel does at the same time
 * stay out of the record.
 *
 * The agent reaches batchPlay two ways: the `action` handed to its script, and
 * require("photoshop").action. Both lead here. app.batchPlay is not covered: wrapping the
 * whole `app` object to reach one rarely used method would put every DOM call of the script
 * behind the wrapper.
 *
 * This file does not require('photoshop') itself: the real modules are handed in, so the
 * wrapping can be exercised from Node with fakes.
 */

// A script looping over a rejected command could produce hundreds of these. The first few
// say what went wrong; the rest are only counted.
const MAX_RECORDED = 10;
const MAX_MESSAGE_LENGTH = 300;

// Only text crosses the channel when a command fails, so a script that throws carries its
// rejected commands at the end of the error text, behind this marker, as JSON. Helper cuts
// them off and describes them. The same string is defined in Helper's mcp-tools.js.
const REJECTED_COMMANDS_MARKER = '[rejected-commands]';

/**
 * Whether one element of a batchPlay result is Photoshop refusing that command.
 *
 * @param {*} element - One element of the returned list.
 * @returns {boolean}
 */
function isRejection(element) {
    if (!element || typeof element !== 'object') return false;
    if (typeof element._obj !== 'string' || element._obj.toLowerCase() !== 'error') return false;
    // The documentation gives 0 as "no error".
    return element.result !== 0;
}

/**
 * Turn `_options.dialogOptions: "dontDisplay"` into `"silent"` in the descriptors the agent
 * passes to batchPlay.
 *
 * Per Adobe's batchPlay documentation, "dontDisplay" runs a command without UI unless an
 * error occurs — and then UI may be shown. For the agent's commands that UI is a modal alert
 * in front of the person, who can only click OK; batchPlay then answers result -128 (user
 * cancelled) with an empty message, and the real reason never reaches the agent. "silent",
 * the documented default, returns the error as a scripting error instead. Agents copy
 * "dontDisplay" from "Copy As JavaScript" output without meaning any of this.
 *
 * "display" is left alone: that is how a script deliberately opens a command's dialog (a
 * filter's, say) for the person.
 *
 * The agent's own objects are never changed: a descriptor that needs the change is copied
 * along with its `_options`, and the list is copied only when something in it changed.
 *
 * @param {*} descriptors - The first argument the script passed to batchPlay.
 * @returns {*} The same value when nothing needed changing, otherwise a new list.
 */
function silenceErrorDialogs(descriptors) {
    if (!Array.isArray(descriptors)) return descriptors;

    let changed = false;
    const rewritten = descriptors.map(descriptor => {
        const options = descriptor && typeof descriptor === 'object' ? descriptor._options : null;
        if (!options || typeof options !== 'object' || options.dialogOptions !== 'dontDisplay') {
            return descriptor;
        }
        changed = true;
        return { ...descriptor, _options: { ...options, dialogOptions: 'silent' } };
    });

    return changed ? rewritten : descriptors;
}

/**
 * A stand-in for an object that serves a few properties of its own and hands everything
 * else over from the original.
 *
 * The proxy's own target is an empty object rather than the original, because a proxy may
 * not report a different value for a property its target holds as non-configurable and
 * read-only — and nothing guarantees how the host defines its modules.
 *
 * @param {object} original - The real object.
 * @param {object} overrides - Properties served instead of the original's.
 * @param {object} [options]
 * @param {boolean} [options.bindMethods] - Bind the original's functions to it, so they
 *   run with the same `this` as when called on the original. Right for a module of plain
 *   methods; wrong for one that carries classes, whose static members a bound copy lacks.
 * @returns {object}
 */
function overlay(original, overrides, { bindMethods = false } = {}) {
    const own = key => Object.prototype.hasOwnProperty.call(overrides, key);

    return new Proxy({}, {
        get(_, key) {
            if (own(key)) return overrides[key];
            const value = Reflect.get(original, key, original);
            return bindMethods && typeof value === 'function' ? value.bind(original) : value;
        },
        has(_, key) {
            return own(key) || key in original;
        },
        ownKeys() {
            return [...new Set([...Reflect.ownKeys(original), ...Reflect.ownKeys(overrides)])];
        },
        getOwnPropertyDescriptor(_, key) {
            if (own(key)) {
                return { value: overrides[key], writable: false, enumerable: true, configurable: true };
            }
            const descriptor = Reflect.getOwnPropertyDescriptor(original, key);
            // Reported as configurable: the empty target does not hold the property, and a
            // proxy may not claim a non-configurable property its target does not have.
            return descriptor ? { ...descriptor, configurable: true } : undefined;
        }
    });
}

/**
 * Build the watched view of batchPlay for one run of the agent's script.
 *
 * @param {object} options
 * @param {object} options.photoshop - The real require('photoshop') module.
 * @param {Function} options.realRequire - The real require, for every other module.
 * @returns {object} { action, require, report } — `action` and `require` go into the
 *   script's scope; report() gives what was rejected, or null when nothing was.
 */
function createBatchPlayWatch({ photoshop, realRequire }) {
    const realAction = photoshop.action;
    const recorded = [];
    let total = 0;

    /**
     * @param {*} descriptors - What the script passed to batchPlay.
     * @param {*} results - What batchPlay gave back.
     */
    function inspect(descriptors, results) {
        if (!Array.isArray(results)) return;
        results.forEach((element, index) => {
            if (!isRejection(element)) return;
            total += 1;
            if (recorded.length >= MAX_RECORDED) return;

            // The returned list lines up with the descriptors: element i answers command i.
            const descriptor = Array.isArray(descriptors) ? descriptors[index] : null;
            recorded.push({
                command: descriptor && typeof descriptor._obj === 'string' ? descriptor._obj : 'unknown',
                message: String(element.message || '').slice(0, MAX_MESSAGE_LENGTH),
                code: typeof element.result === 'number' ? element.result : null
            });
        });
    }

    /**
     * @param {*} descriptors - What the script passed to batchPlay.
     * @param {*} results - What batchPlay gave back.
     */
    function inspectSafely(descriptors, results) {
        try {
            inspect(descriptors, results);
        } catch {
            // Watching must never break the script's own call.
        }
    }

    /**
     * Same call, same return value, and the same arguments except that error alerts are
     * turned off (see silenceErrorDialogs). With synchronousExecution batchPlay returns the
     * list itself rather than a promise, and a script may rely on that.
     *
     * @param {...*} args - Whatever the script passed.
     * @returns {*} Whatever the real batchPlay returned.
     */
    function batchPlay(...args) {
        let callArgs = args;
        if (args.length > 0) {
            let descriptors = args[0];
            try {
                descriptors = silenceErrorDialogs(args[0]);
            } catch {
                // A descriptor with a throwing getter goes through as the script wrote it.
            }
            if (descriptors !== args[0]) callArgs = [descriptors, ...args.slice(1)];
        }

        const outcome = realAction.batchPlay(...callArgs);
        if (outcome && typeof outcome.then === 'function') {
            return outcome.then(results => {
                inspectSafely(args[0], results);
                return results;
            });
        }
        inspectSafely(args[0], outcome);
        return outcome;
    }

    const action = overlay(realAction, { batchPlay }, { bindMethods: true });
    const watchedPhotoshop = overlay(photoshop, { action });

    /**
     * Shadows the global require inside the script.
     *
     * @param {string} id - Module name.
     * @returns {*}
     */
    function watchedRequire(id) {
        return id === 'photoshop' ? watchedPhotoshop : realRequire(id);
    }

    /**
     * @returns {object|null} { total, commands: [{ command, message, code }] }, or null.
     */
    function report() {
        return total === 0 ? null : { total, commands: recorded.slice() };
    }

    return { action, require: watchedRequire, report };
}

/**
 * The tail to put at the end of a failed script's error text.
 *
 * @param {object|null} report - From report().
 * @returns {string} An empty string when nothing was rejected.
 */
function formatForErrorText(report) {
    return report ? `\n${REJECTED_COMMANDS_MARKER}${JSON.stringify(report)}` : '';
}

module.exports = {
    createBatchPlayWatch,
    formatForErrorText,
    // Exported for testing only; Helper keeps its own copy of this string in mcp-tools.js.
    REJECTED_COMMANDS_MARKER,
    // Exported for testing only; the watch applies it to every call itself.
    silenceErrorDialogs,
    // Exported for testing only; it caps how many rejected commands are listed.
    MAX_RECORDED
};
