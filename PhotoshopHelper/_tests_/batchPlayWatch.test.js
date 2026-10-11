'use strict';

// The watch lives in the UXP plugin (modules/ at the repository root), not in Helper. It is
// tested from here because it takes the real Photoshop modules as arguments and runs in
// Node with fakes, and this is where the project's test runner is.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createBatchPlayWatch,
    formatForErrorText,
    REJECTED_COMMANDS_MARKER,
    MAX_RECORDED,
    silenceErrorDialogs
} = require('../../modules/batchplay-watch.js');

const REJECTED_SET = {
    _obj: 'error',
    message: 'FromPS-ToPS Dev: The command “Set” is not currently available.',
    result: -25920
};

/**
 * A stand-in for require('photoshop') whose batchPlay answers from a function.
 *
 * @param {Function} answer - (descriptors, options) => what batchPlay returns.
 * @returns {object} { photoshop, calls }
 */
function fakePhotoshop(answer) {
    const calls = [];
    const action = {
        batchPlay(...args) {
            calls.push({ args, self: this });
            return answer(...args);
        },
        addNotificationListener(events, listener) {
            // Checks its receiver, the way a host method might.
            if (this !== action) throw new Error('Illegal invocation');
            return { events, listener };
        }
    };
    const photoshop = {
        action,
        app: { name: 'app' },
        core: { name: 'core' },
        constants: { SelectionType: { REPLACE: 'replace' } }
    };
    return { photoshop, calls };
}

/**
 * @param {object} photoshop - Fake module.
 * @returns {object} The watch, with a require that knows one other module.
 */
function watchOver(photoshop) {
    const uxp = { name: 'uxp' };
    return createBatchPlayWatch({
        photoshop,
        realRequire: id => {
            if (id === 'uxp') return uxp;
            throw new Error(`Cannot find module '${id}'`);
        }
    });
}

test('batchPlay hands back the very same result and notes each rejected command', async () => {
    const results = [{ layerID: 3 }, REJECTED_SET, { _obj: 'error', message: 'fine', result: 0 }];
    const { photoshop, calls } = fakePhotoshop(async () => results);
    const watch = watchOver(photoshop);

    const descriptors = [
        { _obj: 'select', _target: [{ _ref: 'layer', _id: 3 }] },
        { _obj: 'set', _target: [{ _ref: 'levels' }] },
        { _obj: 'hide' }
    ];
    const options = { synchronousExecution: false };
    const returned = await watch.action.batchPlay(descriptors, options);

    assert.equal(returned, results, 'the script gets the same list, not a copy');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], descriptors);
    assert.equal(calls[0].args[1], options);
    assert.equal(calls[0].self, photoshop.action, 'the real batchPlay runs on the real module');

    // The third element carries result 0, which the documentation gives as "no error".
    assert.deepEqual(watch.report(), {
        total: 1,
        commands: [{
            command: 'set',
            message: 'FromPS-ToPS Dev: The command “Set” is not currently available.',
            code: -25920
        }]
    });
});

test('nothing rejected, nothing reported', async () => {
    const { photoshop } = fakePhotoshop(async () => [{ layerID: 3 }]);
    const watch = watchOver(photoshop);

    await watch.action.batchPlay([{ _obj: 'get' }], {});

    assert.equal(watch.report(), null);
});

test('with synchronousExecution the list comes back directly, not as a promise', () => {
    const results = [REJECTED_SET];
    const { photoshop } = fakePhotoshop(() => results);
    const watch = watchOver(photoshop);

    const returned = watch.action.batchPlay([{ _obj: 'set' }], { synchronousExecution: true });

    assert.equal(returned, results);
    assert.equal(watch.report().total, 1);
});

test('the arguments reach batchPlay exactly as written, including a missing options', async () => {
    const { photoshop, calls } = fakePhotoshop(async () => []);
    const watch = watchOver(photoshop);

    await watch.action.batchPlay([{ _obj: 'get' }]);

    assert.equal(calls[0].args.length, 1);
});

test('a rejected promise stays rejected, and is not counted as a rejected command', async () => {
    const { photoshop } = fakePhotoshop(async () => {
        throw new Error('Argument 1 has an invalid type. Expected type: array actual type: boolean');
    });
    const watch = watchOver(photoshop);

    await assert.rejects(watch.action.batchPlay(true, {}), /Argument 1 has an invalid type/);
    assert.equal(watch.report(), null);
});

test('require("photoshop") inside the script leads to the same watch', async () => {
    const { photoshop } = fakePhotoshop(async () => [REJECTED_SET]);
    const watch = watchOver(photoshop);

    // The way agents actually write it.
    const { app, core, constants, action } = watch.require('photoshop');
    assert.equal(app, photoshop.app);
    assert.equal(core, photoshop.core);
    assert.equal(constants.SelectionType.REPLACE, 'replace');

    await action.batchPlay([{ _obj: 'set' }], {});
    await watch.require('photoshop').action.batchPlay([{ _obj: 'make' }], {});

    assert.equal(watch.report().total, 2);
    assert.deepEqual(watch.report().commands.map(item => item.command), ['set', 'make']);
});

test('every other module comes from the real require', () => {
    const { photoshop } = fakePhotoshop(async () => []);
    const watch = watchOver(photoshop);

    assert.equal(watch.require('uxp').name, 'uxp');
    assert.throws(() => watch.require('left-pad'), /Cannot find module/);
});

test('the rest of the action module still works, with its own receiver', () => {
    const { photoshop } = fakePhotoshop(async () => []);
    const watch = watchOver(photoshop);

    const listener = () => {};
    const added = watch.action.addNotificationListener(['set'], listener);

    assert.equal(added.listener, listener);
    assert.equal('addNotificationListener' in watch.action, true);
    assert.ok(Object.keys(watch.action).includes('batchPlay'));
});

test('a frozen photoshop module does not trip the stand-in', async () => {
    const { photoshop } = fakePhotoshop(async () => [REJECTED_SET]);
    Object.freeze(photoshop.action);
    Object.freeze(photoshop);
    const watch = watchOver(photoshop);

    const spread = { ...watch.require('photoshop') };
    assert.equal(spread.app, photoshop.app);

    await watch.require('photoshop').action.batchPlay([{ _obj: 'set' }], {});
    assert.equal(watch.report().total, 1);
});

test('a script looping over a rejected command is listed briefly and counted in full', async () => {
    const { photoshop } = fakePhotoshop(async () => [REJECTED_SET]);
    const watch = watchOver(photoshop);

    for (let i = 0; i < MAX_RECORDED + 5; i++) {
        await watch.action.batchPlay([{ _obj: 'set' }], {});
    }

    const report = watch.report();
    assert.equal(report.total, MAX_RECORDED + 5);
    assert.equal(report.commands.length, MAX_RECORDED);
});

test('dialogOptions "dontDisplay" reaches batchPlay as "silent", the agent\'s objects untouched', async () => {
    const { photoshop, calls } = fakePhotoshop(async () => [{}, {}]);
    const watch = watchOver(photoshop);

    // The shape agents copy from "Copy As JavaScript", with the typo from the real run.
    const make = {
        _obj: 'make',
        _target: [{ _ref: 'adjustmentLayer' }],
        _using: { _obj: 'adjustmentLayer', type: { _obj: 'vibrance' } },
        _options: { dialogOptions: 'dontDisplay', suppressProgressBar: true }
    };
    const hide = { _obj: 'hide' };
    const descriptors = [make, hide];
    const options = { synchronousExecution: false };

    await watch.action.batchPlay(descriptors, options);

    const [sent, sentOptions] = calls[0].args;
    assert.deepEqual(sent[0]._options, { dialogOptions: 'silent', suppressProgressBar: true });
    assert.equal(sent[0]._using, make._using, 'everything else stays as written');
    assert.equal(sent[1], hide, 'a descriptor without the option is passed as it is');
    assert.equal(sentOptions, options);

    // Nothing the script holds has changed.
    assert.equal(make._options.dialogOptions, 'dontDisplay');
    assert.deepEqual(descriptors, [make, hide]);
    assert.notEqual(sent, descriptors);
});

test('dialogOptions "display" and "silent" are left exactly as written', async () => {
    const { photoshop, calls } = fakePhotoshop(async () => [{}, {}]);
    const watch = watchOver(photoshop);

    const descriptors = [
        { _obj: 'gaussianBlur', _options: { dialogOptions: 'display' } },
        { _obj: 'hide', _options: { dialogOptions: 'silent' } }
    ];
    await watch.action.batchPlay(descriptors, {});

    assert.equal(calls[0].args[0], descriptors, 'the same list, not a copy');
});

test('the rewrite also applies with synchronousExecution and through require("photoshop")', () => {
    const { photoshop, calls } = fakePhotoshop(() => [{}]);
    const watch = watchOver(photoshop);

    watch.require('photoshop').action.batchPlay(
        [{ _obj: 'make', _options: { dialogOptions: 'dontDisplay' } }],
        { synchronousExecution: true }
    );

    assert.equal(calls[0].args[0][0]._options.dialogOptions, 'silent');
});

test('silenceErrorDialogs leaves anything that is not a list of descriptors alone', () => {
    assert.equal(silenceErrorDialogs(true), true);
    assert.equal(silenceErrorDialogs(undefined), undefined);
    const odd = [null, 3, { _obj: 'get', _options: null }];
    assert.equal(silenceErrorDialogs(odd), odd);
});

test('the command name of a rejection still comes from the descriptor the script wrote', async () => {
    const cancelled = { _obj: 'error', message: '', result: -128 };
    const { photoshop } = fakePhotoshop(async () => [cancelled]);
    const watch = watchOver(photoshop);

    await watch.action.batchPlay([{ _obj: 'make', _options: { dialogOptions: 'dontDisplay' } }], {});

    assert.deepEqual(watch.report().commands, [{ command: 'make', message: '', code: -128 }]);
});

test('the error text carries the report behind the marker, and nothing when there is none', () => {
    assert.equal(formatForErrorText(null), '');

    const report = { total: 1, commands: [{ command: 'set', message: 'no', code: -25920 }] };
    const tail = formatForErrorText(report);

    assert.ok(tail.startsWith(`\n${REJECTED_COMMANDS_MARKER}`));
    assert.deepEqual(JSON.parse(tail.slice(REJECTED_COMMANDS_MARKER.length + 1)), report);
});
