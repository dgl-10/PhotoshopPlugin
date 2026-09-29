'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const {
    cleanupOldWebhelperFiles,
    resolveWebhelperFile,
    webhelperFileUrl
} = require('../webhelper-storage');

/**
 * @param {import('node:test').TestContext} context - Active test context.
 * @returns {string} Absolute fixture directory.
 */
function createFixtureDirectory(context) {
    const directory = path.join(
        __dirname,
        '.tmp-webhelper-storage',
        `${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(directory, { recursive: true });
    context.after(() => {
        fs.rmSync(directory, { recursive: true, force: true });
        try {
            fs.rmdirSync(path.dirname(directory));
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
        }
    });
    return directory;
}

/**
 * @param {string} filePath - File whose modified time is set.
 * @param {number} daysAgo - How many days before now the file should appear.
 */
function ageFile(filePath, daysAgo) {
    const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, when, when);
}

test('public file URLs map onto the task and generated folders and reject escapes', (t) => {
    const tempDir = createFixtureDirectory(t);
    const tasksDir = path.join(tempDir, '_WH_Tasks');
    const generatedDir = path.join(tempDir, '_WH_Generated');
    fs.mkdirSync(tasksDir);
    fs.mkdirSync(generatedDir);
    fs.writeFileSync(path.join(tasksDir, 'task.png'), 'task');
    fs.writeFileSync(path.join(generatedDir, 'result.png'), 'result');
    fs.writeFileSync(path.join(tempDir, 'legacy.png'), 'legacy');

    assert.equal(webhelperFileUrl('tasks', 'task.png'), '/api/webhelper/file/tasks/task.png');
    assert.equal(webhelperFileUrl('generated', 'result.png'), '/api/webhelper/file/generated/result.png');
    assert.equal(
        resolveWebhelperFile(tempDir, '/api/webhelper/file/tasks/task.png'),
        path.resolve(tasksDir, 'task.png')
    );
    assert.equal(
        resolveWebhelperFile(tempDir, 'generated/result.png'),
        path.resolve(generatedDir, 'result.png')
    );
    assert.equal(
        resolveWebhelperFile(tempDir, '/api/webhelper/file/legacy.png'),
        path.resolve(tempDir, 'legacy.png')
    );

    assert.equal(resolveWebhelperFile(tempDir, 'tasks/../../secret.png'), null);
    assert.equal(resolveWebhelperFile(tempDir, '/api/webhelper/file/generated/nested/secret.png'), null);
    assert.equal(resolveWebhelperFile(tempDir, '_WH_CliScratch/notes.txt'), null);
    assert.equal(resolveWebhelperFile(tempDir, 'tasks/../_WH_Generated/result.png'), null);
});

test('cleanup removes files older than 30 days in every subdirectory and drops empty directories', (t) => {
    const tempDir = createFixtureDirectory(t);
    const generatedDir = path.join(tempDir, '_WH_Generated');
    const tasksDir = path.join(tempDir, '_WH_Tasks');
    const scratchReferences = path.join(tempDir, '_WH_CliScratch', 'references');
    const oldRun = path.join(tempDir, '_WH_CliScratch', 'runs', 'old-run');
    const freshRun = path.join(tempDir, '_WH_CliScratch', 'runs', 'fresh-run');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(scratchReferences, { recursive: true });
    fs.mkdirSync(oldRun, { recursive: true });
    fs.mkdirSync(freshRun, { recursive: true });

    const oldGenerated = path.join(generatedDir, 'old.png');
    const freshGenerated = path.join(generatedDir, 'fresh.png');
    const oldTask = path.join(tasksDir, 'old-task.png');
    const oldReference = path.join(scratchReferences, 'old-ref.png');
    const oldRunFile = path.join(oldRun, 'old-out.png');
    const freshRunFile = path.join(freshRun, 'fresh-out.png');
    const oldRoot = path.join(tempDir, 'old-root.png');
    const freshRoot = path.join(tempDir, 'fresh-root.png');
    for (const filePath of [
        oldGenerated, freshGenerated, oldTask, oldReference, oldRunFile, freshRunFile, oldRoot, freshRoot
    ]) {
        fs.writeFileSync(filePath, 'x');
    }

    ageFile(oldGenerated, 31);
    ageFile(oldTask, 40);
    ageFile(oldReference, 31);
    ageFile(oldRunFile, 31);
    ageFile(oldRoot, 31);
    ageFile(freshGenerated, 1);
    ageFile(freshRunFile, 1);
    ageFile(freshRoot, 1);

    cleanupOldWebhelperFiles(tempDir, 30 * 24 * 60 * 60 * 1000);

    assert.equal(fs.existsSync(oldGenerated), false);
    assert.equal(fs.existsSync(freshGenerated), true);
    assert.equal(fs.existsSync(generatedDir), true);
    assert.equal(fs.existsSync(tasksDir), false);
    assert.equal(fs.existsSync(scratchReferences), false);
    assert.equal(fs.existsSync(oldRun), false);
    assert.equal(fs.existsSync(freshRunFile), true);
    assert.equal(fs.existsSync(path.join(tempDir, '_WH_CliScratch')), true);
    assert.equal(fs.existsSync(oldRoot), false);
    assert.equal(fs.existsSync(freshRoot), true);
    assert.equal(fs.existsSync(tempDir), true);
});

test('the file routes serve generated and task images from their folders', async (t) => {
    const tempDir = createFixtureDirectory(t);
    const application = express();
    const serve = (relative, res) => {
        const filePath = resolveWebhelperFile(tempDir, relative);
        if (!filePath) return res.status(403).end('forbidden');
        if (!fs.existsSync(filePath)) return res.status(404).end('missing');
        return res.end(fs.readFileSync(filePath, 'utf8'));
    };
    application.get('/api/webhelper/file/:area(tasks|generated)/:filename', (req, res) => {
        serve(`${req.params.area}/${req.params.filename}`, res);
    });
    application.get('/api/webhelper/file/:filename', (req, res) => {
        serve(req.params.filename, res);
    });

    fs.mkdirSync(path.join(tempDir, '_WH_Generated'));
    fs.mkdirSync(path.join(tempDir, '_WH_Tasks'));
    fs.writeFileSync(path.join(tempDir, '_WH_Generated', 'result.png'), 'generated-bytes');
    fs.writeFileSync(path.join(tempDir, '_WH_Tasks', 'source.png'), 'task-bytes');
    fs.writeFileSync(path.join(tempDir, 'legacy.png'), 'legacy-bytes');

    const server = await new Promise(resolve => {
        const listeningServer = application.listen(0, '127.0.0.1', () => resolve(listeningServer));
    });
    t.after(async () => {
        await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    fs.mkdirSync(path.join(tempDir, '_WH_CliScratch'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '_WH_CliScratch', 'notes.txt'), 'scratch-bytes');

    const generated = await fetch(`${base}/api/webhelper/file/generated/result.png`);
    const task = await fetch(`${base}/api/webhelper/file/tasks/source.png`);
    const legacy = await fetch(`${base}/api/webhelper/file/legacy.png`);
    const scratch = await fetch(`${base}/api/webhelper/file/_WH_CliScratch/notes.txt`);

    assert.equal(await generated.text(), 'generated-bytes');
    assert.equal(await task.text(), 'task-bytes');
    assert.equal(await legacy.text(), 'legacy-bytes');
    assert.equal(scratch.status, 404);
});
