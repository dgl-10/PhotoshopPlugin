/**
 * Entering Photoshop's modal scope for the agent, and waiting while Photoshop is busy.
 *
 * Photoshop gives the modal scope to one plugin at a time and refuses it with error number 9
 * ("host is in a modal state") while another plugin holds it or the person is in the middle
 * of something. From Photoshop 25.10 executeAsModal queues for `timeOut` ms by itself;
 * before that it refuses at once, so the waiting is done here. A refused call never runs its
 * target function, so asking again cannot do anything twice. Once the body has started it is
 * never run a second time, whatever it throws.
 *
 * This file does not require('photoshop'): executeAsModal is handed in, so the waiting can
 * be exercised from Node with fakes.
 */

// How long the agent's call waits for Photoshop to become free before giving up. The person
// works in Photoshop while the agent does, so a few seconds of waiting are normal.
const MODAL_WAIT_MS = 10_000;

// Pause between attempts on a Photoshop that refuses at once instead of queuing.
const RETRY_DELAY_MS = 500;

// Lets Helper recognise this refusal in an error that crossed the channel as plain text:
// it is Photoshop being busy, not a struggle of the agent's, so it is not counted as one.
const PHOTOSHOP_BUSY_MARKER = '[photoshop-busy]';

/**
 * @param {*} error - Whatever executeAsModal threw.
 * @returns {boolean} True when Photoshop refused the modal scope.
 */
function isModalRefusal(error) {
    // Adobe's own sample compares with ==, so the number is not trusted to be a number.
    return Boolean(error) && Number(error.number) === 9;
}

/**
 * @param {number} waitMs - How long the call waited.
 * @returns {Error} What the agent is told after waiting in vain.
 */
function busyError(waitMs) {
    const seconds = Math.round(waitMs / 1000);
    return new Error(
        `${PHOTOSHOP_BUSY_MARKER} Photoshop stayed busy for ${seconds} seconds and would not `
        + 'let the plugin work: a dialog is open, the person is in the middle of something '
        + '(typing text, a transform), or another plugin is running a command. Nothing was '
        + 'changed in the document by this call. Tell the person in one short line, and call '
        + 'again when they say Photoshop is free.'
    );
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run a body in a modal scope, waiting while Photoshop refuses one.
 *
 * @param {Function} executeAsModal - core.executeAsModal of the photoshop module.
 * @param {Function} body - Target function; receives what executeAsModal passes it.
 * @param {object} options - executeAsModal options (commandName, interactive); `timeOut` is
 *   set here.
 * @param {object} [timing] - For tests.
 * @param {number} [timing.waitMs]
 * @param {number} [timing.retryDelayMs]
 * @param {Function} [timing.wait] - (ms) => Promise, the pause between attempts.
 * @param {Function} [timing.now] - () => ms, the clock.
 * @returns {Promise<*>} Whatever body returned.
 * @throws {Error} The busy message after waiting in vain; anything else as it was thrown.
 */
async function runInModalScope(executeAsModal, body, options, timing = {}) {
    const {
        waitMs = MODAL_WAIT_MS,
        retryDelayMs = RETRY_DELAY_MS,
        wait = sleep,
        now = Date.now
    } = timing;

    const startedAt = now();
    let started = false;
    const guardedBody = (...args) => {
        started = true;
        return body(...args);
    };

    for (;;) {
        try {
            return await executeAsModal(guardedBody, { ...options, timeOut: waitMs });
        } catch (error) {
            if (started || !isModalRefusal(error)) throw error;
            if (now() - startedAt + retryDelayMs > waitMs) throw busyError(waitMs);
            await wait(retryDelayMs);
        }
    }
}

module.exports = {
    runInModalScope,
    // Exported for testing only; Helper keeps its own copy of this string in mcp-tools.js.
    PHOTOSHOP_BUSY_MARKER,
    // Exported for testing only; it is how long a call waits for a busy Photoshop.
    MODAL_WAIT_MS
};
