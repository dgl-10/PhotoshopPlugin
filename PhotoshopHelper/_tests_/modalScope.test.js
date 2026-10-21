'use strict';

// The waiting lives in the UXP plugin (modules/ at the repository root), not in Helper. It is
// tested from here because executeAsModal is handed to it, so it runs in Node with fakes, and
// this is where the project's test runner is.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    runInModalScope,
    PHOTOSHOP_BUSY_MARKER,
    MODAL_WAIT_MS
} = require('../../modules/modal-scope.js');

/**
 * The refusal Photoshop throws while it is busy.
 *
 * @param {*} [number=9] - The number as the host hands it over.
 * @returns {Error}
 */
function refusal(number = 9) {
    const error = new Error('host is in a modal state');
    error.number = number;
    error.code = number;
    return error;
}

/**
 * A clock that moves only when the code under test waits.
 *
 * @returns {{now: Function, wait: Function, waits: number[], advance: Function}}
 */
function fakeClock() {
    let time = 0;
    const waits = [];
    return {
        now: () => time,
        wait: async ms => { waits.push(ms); time += ms; },
        waits,
        advance: ms => { time += ms; }
    };
}

/**
 * An executeAsModal that refuses a given number of times, then runs the body.
 *
 * @param {number} refusals - How many calls are refused first.
 * @param {*} [number=9] - The number of the refusal.
 * @returns {{executeAsModal: Function, calls: object[]}}
 */
function busyThenFree(refusals, number = 9) {
    const calls = [];
    return {
        calls,
        executeAsModal: async (body, options) => {
            calls.push(options);
            if (calls.length <= refusals) throw refusal(number);
            return body({ isCancelled: false });
        }
    };
}

test('a free Photoshop runs the body once and hands back its value', async () => {
    const clock = fakeClock();
    const { executeAsModal, calls } = busyThenFree(0);
    let runs = 0;

    const value = await runInModalScope(executeAsModal, async context => {
        runs += 1;
        return { gotContext: Boolean(context) };
    }, { commandName: 'Agent: take a look' }, clock);

    assert.deepEqual(value, { gotContext: true });
    assert.equal(runs, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].commandName, 'Agent: take a look');
    assert.equal(calls[0].timeOut, MODAL_WAIT_MS, 'a Photoshop that queues by itself queues as long');
    assert.deepEqual(clock.waits, []);
});

test('the interactive option reaches executeAsModal unchanged', async () => {
    const { executeAsModal, calls } = busyThenFree(0);
    await runInModalScope(executeAsModal, async () => {}, { commandName: 'x', interactive: true }, fakeClock());
    assert.equal(calls[0].interactive, true);
});

test('a busy Photoshop that refuses at once is asked again until it is free', async () => {
    const clock = fakeClock();
    const { executeAsModal, calls } = busyThenFree(3);
    let runs = 0;

    const value = await runInModalScope(executeAsModal, async () => {
        runs += 1;
        return 'placed';
    }, { commandName: 'Agent: place back' }, clock);

    assert.equal(value, 'placed');
    assert.equal(calls.length, 4);
    assert.equal(runs, 1, 'the body ran only once, after the refusals');
    assert.equal(clock.waits.length, 3);
});

test('a refusal whose number comes as text is still recognised', async () => {
    const { executeAsModal, calls } = busyThenFree(1, '9');
    const value = await runInModalScope(executeAsModal, async () => 'ok', { commandName: 'x' }, fakeClock());
    assert.equal(value, 'ok');
    assert.equal(calls.length, 2);
});

test('a Photoshop that stays busy gives a marked message, and the body never runs', async () => {
    const clock = fakeClock();
    const { executeAsModal } = busyThenFree(Infinity);
    let runs = 0;

    await assert.rejects(
        runInModalScope(executeAsModal, async () => { runs += 1; }, { commandName: 'x' }, {
            ...clock, waitMs: 3000, retryDelayMs: 500
        }),
        error => {
            assert.ok(error.message.startsWith(PHOTOSHOP_BUSY_MARKER));
            assert.match(error.message, /stayed busy for 3 seconds/);
            assert.match(error.message, /Nothing was changed in the document/);
            return true;
        }
    );

    assert.equal(runs, 0);
    assert.ok(clock.now() <= 3000, 'it does not wait past the limit');
});

test('a Photoshop that queued for the whole wait itself is not asked again', async () => {
    const clock = fakeClock();
    let attempts = 0;
    // From Photoshop 25.10 executeAsModal queues for timeOut ms before refusing.
    const executeAsModal = async (body, options) => {
        attempts += 1;
        clock.advance(options.timeOut);
        throw refusal();
    };

    await assert.rejects(
        runInModalScope(executeAsModal, async () => {}, { commandName: 'x' }, clock),
        error => error.message.startsWith(PHOTOSHOP_BUSY_MARKER)
    );
    assert.equal(attempts, 1);
});

test('a body that has started is never run again, even when it throws a refusal', async () => {
    let runs = 0;
    const executeAsModal = async body => body({});
    const inner = refusal();

    await assert.rejects(
        runInModalScope(executeAsModal, async () => {
            runs += 1;
            throw inner;
        }, { commandName: 'x' }, fakeClock()),
        error => error === inner
    );
    assert.equal(runs, 1);
});

test('any other error is passed on as it was, without waiting', async () => {
    const clock = fakeClock();
    const failure = new Error('Unknown kind');
    const executeAsModal = async () => { throw failure; };

    await assert.rejects(
        runInModalScope(executeAsModal, async () => {}, { commandName: 'x' }, clock),
        error => error === failure
    );
    assert.deepEqual(clock.waits, []);
});
