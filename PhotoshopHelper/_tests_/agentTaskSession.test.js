'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTaskSession, TaskError } = require('../agent/task-session');

/**
 * A task registry with a clock the test controls.
 *
 * @param {object} [options] - Extra options for the registry.
 * @returns {object} { tasks, advance }
 */
function withClock(options = {}) {
    let now = 1_000_000;
    let counter = 0;

    const tasks = createTaskSession({
        now: () => now,
        generateId: () => `task-${++counter}`,
        ...options
    });

    return { tasks, advance: (ms) => { now += ms; } };
}

test('a tool called before ps_start_task is told what to do', () => {
    const { tasks } = withClock();

    assert.throws(
        () => tasks.require('task-1'),
        (error) => error instanceof TaskError
            && error.code === 'NO_TASK'
            && /ps_start_task/.test(error.message)
    );
});

test('a wrong task id names the task that is actually running', () => {
    const { tasks } = withClock();
    tasks.start({ intent: 'hide the text layers' });

    assert.throws(
        () => tasks.require('task-99'),
        (error) => error.code === 'TASK_ID_UNKNOWN' && /task-1/.test(error.message)
    );
});

test('a missing task id is refused even while a task runs', () => {
    const { tasks } = withClock();
    tasks.start({ intent: 'anything' });

    assert.throws(() => tasks.require(undefined), (error) => error.code === 'TASK_ID_MISSING');
});

test('only one task runs at a time', () => {
    const { tasks } = withClock();
    tasks.start({ intent: 'first' });

    assert.throws(
        () => tasks.start({ intent: 'second' }),
        (error) => error.code === 'TASK_ALREADY_RUNNING' && /first/.test(error.message)
    );
});

test('a task that goes silent closes itself and lets the next one start', () => {
    const { tasks, advance } = withClock({ idleTimeoutMs: 30 * 60 * 1000 });
    tasks.start({ intent: 'abandoned' });

    advance(29 * 60 * 1000);
    assert.ok(tasks.getCurrent(), 'still running just before the timeout');

    advance(2 * 60 * 1000);
    assert.equal(tasks.getCurrent(), null);

    const next = tasks.start({ intent: 'a new one' });
    assert.equal(next.intent, 'a new one');
});

test('every accepted call keeps the task alive', () => {
    const { tasks, advance } = withClock({ idleTimeoutMs: 10 * 60 * 1000 });
    const task = tasks.start({ intent: 'long work' });

    for (let step = 0; step < 5; step++) {
        advance(9 * 60 * 1000);
        tasks.require(task.id);
    }

    assert.equal(tasks.getCurrent().id, task.id);
});

test('finishing stores the report and frees the slot', () => {
    const { tasks } = withClock();
    const task = tasks.start({ intent: 'curves' });
    tasks.noteArticle(task.id, 'curves-clipped');

    const finished = tasks.finish(task.id, { summary: 'added a curves layer', issues: 'none' });

    assert.equal(finished.state, 'finished');
    assert.equal(finished.report.summary, 'added a curves layer');
    assert.deepEqual(finished.touchedArticles, ['curves-clipped']);
    assert.equal(tasks.getCurrent(), null);
});

test('the document the task started on is remembered on the task', () => {
    const { tasks } = withClock();
    const task = tasks.start({ intent: 'x', document: { id: 42, name: 'poster.psd' } });

    assert.equal(task.documentId, 42);
    assert.equal(task.documentName, 'poster.psd');
});

test('a disconnected task is paused and resumes with the same id', () => {
    const { tasks } = withClock();
    const task = tasks.start({ intent: 'keep working' });

    tasks.suspend({
        reason: 'the AI Assist window was closed',
        reasonCode: 'assistant-dialog-closed',
        runtimeId: 'runtime-1'
    });

    assert.equal(tasks.getCurrent().state, 'suspended');
    assert.throws(
        () => tasks.require(task.id),
        (error) => error.code === 'TASK_SUSPENDED'
            && /AI Assist/.test(error.message)
            && /Do not call ps_start_task/.test(error.message)
    );

    const resumed = tasks.resume({ reason: 'the same plugin runtime reconnected' });
    assert.equal(resumed.id, task.id);
    assert.equal(resumed.state, 'running');
    assert.equal(tasks.require(task.id).id, task.id);
});

test('a suspended task expires only after its recovery timeout', () => {
    const { tasks, advance } = withClock({ suspendTimeoutMs: 10 * 60 * 1000 });
    const task = tasks.start({ intent: 'recover later' });
    tasks.suspend({ reason: 'connection lost' });

    advance(9 * 60 * 1000);
    assert.equal(tasks.getCurrent().id, task.id);

    advance(2 * 60 * 1000);
    assert.equal(tasks.getCurrent(), null);
    assert.throws(
        () => tasks.require(task.id),
        (error) => error.code === 'TASK_ENDED' && /did not return/.test(error.message)
    );
});
