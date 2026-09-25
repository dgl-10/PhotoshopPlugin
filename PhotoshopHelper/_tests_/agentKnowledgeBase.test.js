'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    createKnowledgeBase,
    CONFIDENCE_LEVELS,
    parseArticle,
    formatArticle
} = require('../agent/knowledge-base');

/**
 * Build a knowledge base over two throwaway folders.
 *
 * @param {import('node:test').TestContext} context - Active test context.
 * @returns {object} Knowledge base and its layer paths.
 */
function makeKnowledgeBase(context) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-kb-'));
    const authorDir = path.join(root, 'knowledge-base');
    const userDir = path.join(root, 'knowledge-base.user');
    fs.mkdirSync(path.join(authorDir, 'articles'), { recursive: true });

    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const kb = createKnowledgeBase({
        authorDir,
        userDir,
        logger: { info() {}, warn() {}, error() {} }
    });
    return { kb, authorDir, userDir };
}

/**
 * Write one article fixture directly into a chosen layer.
 *
 * @param {string} dir - Layer folder.
 * @param {string} id - Article id.
 * @param {object} meta - Front matter.
 * @param {string} body - Article body.
 */
function writeArticleFile(dir, id, meta, body) {
    fs.mkdirSync(path.join(dir, 'articles'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'articles', `${id}.md`), formatArticle(meta, body), 'utf8');
}

test('front matter survives a round trip', () => {
    const text = formatArticle({ id: 'x', title: 'A title', photoshop: '27.0' }, 'The body.\n\nMore.');
    const parsed = parseArticle(text);

    assert.equal(parsed.meta.id, 'x');
    assert.equal(parsed.meta.title, 'A title');
    assert.equal(parsed.meta.photoshop, '27.0');
    assert.match(parsed.body, /^The body\./);
});

test('the manual confidence vocabulary stays stable', () => {
    assert.deepEqual(CONFIDENCE_LEVELS, [
        'agent-written',
        'user-confirmed',
        'author-verified'
    ]);
});

test('the index shows manual confidence and agent usage outcomes', context => {
    const { kb, authorDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'snapshot', {
        id: 'snapshot',
        title: 'Snapshots',
        problem: 'putting a snapshot in the History panel',
        confidence: 'author-verified',
        photoshop: '26.0'
    }, 'text');

    const index = kb.formatIndex();
    assert.match(index, /snapshot \[author, author-verified, helped 0, failed 0, Photoshop 26\.0\]/);
    assert.match(index, /putting a snapshot in the History panel/);
});

test('a new article starts at the manual agent-written confidence level', context => {
    const { kb, userDir } = makeKnowledgeBase(context);

    const written = kb.writeArticle({
        id: 'Curves Clipped To Layer',
        title: 'Clipped curves',
        problem: 'a curves layer clipped to the layer below',
        body: 'Do this and that.',
        taskId: 'task-1',
        photoshopVersion: '26.0',
        agent: 'codex 1.0'
    });

    assert.equal(written.ok, true);
    assert.equal(written.id, 'curves-clipped-to-layer');

    const file = path.join(userDir, 'articles', 'curves-clipped-to-layer.md');
    const onDisk = parseArticle(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(onDisk.meta).sort(), [
        'agent', 'confidence', 'date', 'failed', 'helped', 'id', 'photoshop', 'problem', 'task', 'title'
    ]);
    assert.equal(onDisk.meta.confidence, 'agent-written');

    const article = kb.readArticle('curves-clipped-to-layer');
    assert.equal(article.found, true);
    assert.match(article.text, /confidence: agent-written/);
    assert.match(article.text, /written by: codex 1\.0/);
    assert.match(article.text, /Photoshop: 26\.0/);
});

test('writing over an existing user article is refused and points at the failed mark', context => {
    const { kb } = makeKnowledgeBase(context);
    kb.writeArticle({ id: 'thing', title: 'T', problem: 'p', body: 'first' });

    const again = kb.writeArticle({ id: 'thing', title: 'T', problem: 'p', body: 'second' });

    assert.equal(again.ok, false);
    assert.match(again.message, /ps_kb_mark_failed/);
    assert.match(again.message, /another id/);
    assert.match(kb.readArticle('thing').text, /first/);
    assert.doesNotMatch(kb.readArticle('thing').text, /second/);
});

test('a failed mark preserves the original article, its note and one failed use', context => {
    const { kb } = makeKnowledgeBase(context);
    kb.writeArticle({ id: 'thing', title: 'T', problem: 'p', body: 'the original advice' });

    const marked = kb.markFailed({
        id: 'thing',
        note: 'the descriptor was rejected; using the DOM worked',
        taskId: 'task-2'
    });

    assert.equal(marked.ok, true);
    const article = kb.readArticle('thing');
    assert.match(article.text, /the original advice/);
    assert.match(article.text, /Did not work/);
    assert.match(article.text, /did not work 1 times/);
    assert.match(article.text, /confidence: agent-written/);
});

test('a failed mark on an author article creates a user-layer note without editing the source', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'shared', {
        id: 'shared', title: 'Shared', problem: 'p', confidence: 'author-verified'
    }, 'the author says this');

    const marked = kb.markFailed({ id: 'shared', note: 'did not work in 26.1', taskId: 'task-3' });

    assert.equal(marked.ok, true);
    assert.ok(fs.existsSync(path.join(userDir, 'articles', 'shared.md')));
    const article = kb.readArticle('shared');
    assert.match(article.text, /the author says this/);
    assert.match(article.text, /did not work in 26\.1/);
    assert.match(article.text, /exists in both layers/);

    const shipped = fs.readFileSync(path.join(authorDir, 'articles', 'shared.md'), 'utf8');
    assert.doesNotMatch(shipped, /26\.1/);
    assert.match(shipped, /confidence: author-verified/);
});

test('a helped mark increments only the sidecar counter and writes no note', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'shared', {
        id: 'shared', title: 'Shared', problem: 'p', confidence: 'author-verified'
    }, 'the author says this');

    // Extra text from a client that ignores the schema is intentionally discarded.
    const marked = kb.markHelped({ id: 'shared', note: 'Worked reliably' });

    assert.equal(marked.ok, true);
    assert.ok(!fs.existsSync(path.join(userDir, 'articles', 'shared.md')));
    assert.equal(kb.listArticles().length, 1);
    assert.match(kb.readArticle('shared').text, /helped 1 times/);
    assert.doesNotMatch(kb.readArticle('shared').text, /Worked reliably/);
});

test('article marks validate the id and require a failure note', context => {
    const { kb } = makeKnowledgeBase(context);
    kb.writeArticle({ id: 'thing', title: 'T', problem: 'p', body: 'text' });

    const missing = kb.markHelped({ id: 'nothing-here' });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /There is no article/);

    for (const note of [undefined, '', '   ']) {
        const refused = kb.markFailed({ id: 'thing', note, taskId: 'task-5' });
        assert.equal(refused.ok, false);
        assert.match(refused.message, /what helped instead/);
    }
    assert.match(kb.readArticle('thing').text, /did not work 0 times/);
});

test('one use moves one counter when an author article has a user-layer note twin', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'shared', {
        id: 'shared', title: 'Shared', problem: 'p', confidence: 'author-verified'
    }, 'the author says this');

    kb.markFailed({ id: 'shared', note: 'needed another key', taskId: 'task-6' });
    kb.markHelped({ id: 'shared' });

    const stats = JSON.parse(fs.readFileSync(path.join(userDir, 'usage-stats.json'), 'utf8'));
    assert.deepEqual(stats, { 'author:shared': { helped: 1, failed: 1 } });

    const lines = kb.formatIndex().split('\n');
    assert.match(lines[0], /\[author, .*helped 1, failed 1/);
    assert.match(lines[1], /\[user, .*helped 0, failed 0/);
});

test('articles with the same id in both layers are both returned', context => {
    const { kb, authorDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'shared', {
        id: 'shared', title: 'Author recipe', problem: 'p', photoshop: '26.0'
    }, 'the author says this');
    kb.writeArticle({ id: 'shared', title: 'User recipe', problem: 'p', body: 'the user says this' });

    const article = kb.readArticle('shared');
    assert.equal(article.found, true);
    assert.match(article.text, /exists in both layers/);
    assert.match(article.text, /the author says this/);
    assert.match(article.text, /the user says this/);
});

test('the rules come from the user layer when there is a copy there', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    fs.writeFileSync(path.join(authorDir, 'rules.md'), 'the shipped rules', 'utf8');

    assert.equal(kb.readRules(), 'the shipped rules');

    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'rules.md'), 'my own rules', 'utf8');
    assert.equal(kb.readRules(), 'my own rules');
});

test('asking for an article that does not exist says what to do instead', context => {
    const { kb } = makeKnowledgeBase(context);
    const article = kb.readArticle('nothing-here');

    assert.equal(article.found, false);
    assert.match(article.text, /ps_kb_contribute/);
});
