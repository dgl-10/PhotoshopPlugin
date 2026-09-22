'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createKnowledgeBase, parseArticle, formatArticle } = require('../agent/knowledge-base');

/**
 * A knowledge base over two throwaway folders.
 *
 * @param {import('node:test').TestContext} context - Active test context.
 * @returns {object} { kb, authorDir, userDir }
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
 * @param {string} dir - Layer folder.
 * @param {string} id - Article id.
 * @param {object} meta - Front matter.
 * @param {string} body - Article text.
 */
function writeArticleFile(dir, id, meta, body) {
    fs.mkdirSync(path.join(dir, 'articles'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'articles', `${id}.md`), formatArticle(meta, body), 'utf8');
}

test('front matter survives a round trip', () => {
    const text = formatArticle({ id: 'x', title: 'A title', helped: 3 }, 'The body.\n\nMore.');
    const parsed = parseArticle(text);

    assert.equal(parsed.meta.id, 'x');
    assert.equal(parsed.meta.title, 'A title');
    assert.equal(parsed.meta.helped, '3');
    assert.match(parsed.body, /^The body\./);
});

test('the index shows one line per article with its marks', context => {
    const { kb, authorDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'snapshot', {
        id: 'snapshot',
        title: 'Snapshots',
        problem: 'putting a snapshot in the History panel',
        confidence: 'author-verified',
        photoshop: '26.0'
    }, 'text');

    const index = kb.formatIndex();

    assert.match(index, /snapshot/);
    assert.match(index, /author, author-verified/);
    assert.match(index, /putting a snapshot in the History panel/);
});

test('a new article lands in the user layer at the lowest rung', context => {
    const { kb, userDir } = makeKnowledgeBase(context);

    const written = kb.writeArticle({
        id: 'Curves Clipped To Layer',
        title: 'Clipped curves',
        problem: 'a curves layer clipped to the layer below',
        body: 'Do this and that.',
        taskId: 'task-1',
        photoshopVersion: '26.0'
    });

    assert.equal(written.ok, true);
    assert.equal(written.id, 'curves-clipped-to-layer');
    assert.ok(fs.existsSync(path.join(userDir, 'articles', 'curves-clipped-to-layer.md')));

    const article = kb.readArticle('curves-clipped-to-layer');
    assert.equal(article.found, true);
    assert.match(article.text, /agent-written/);
});

test('writing over an existing user article is refused and points at the failed mark', context => {
    const { kb } = makeKnowledgeBase(context);
    kb.writeArticle({ id: 'thing', title: 'T', problem: 'p', body: 'first' });

    const again = kb.writeArticle({ id: 'thing', title: 'T', problem: 'p', body: 'second' });

    assert.equal(again.ok, false);
    assert.match(again.message, /ps_kb_mark_failed/);
    assert.match(again.message, /another id/);
});

test('an article that did not work keeps its history and counts the failure', context => {
    const { kb } = makeKnowledgeBase(context);
    kb.writeArticle({ id: 'thing', title: 'T', problem: 'p', body: 'the original advice' });

    const marked = kb.markFailed({
        id: 'thing',
        note: 'the descriptor was rejected; using the DOM worked',
        taskId: 'task-2'
    });

    assert.equal(marked.ok, true);

    const article = kb.readArticle('thing');
    assert.match(article.text, /the original advice/, 'the original text is not removed');
    assert.match(article.text, /Did not work/);
    assert.match(article.text, /did not work 1 times/);
});

test('a note on an author article becomes a user article shown next to it', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'shared', {
        id: 'shared', title: 'Shared', problem: 'p', confidence: 'author-verified'
    }, 'the author says this');

    const marked = kb.markFailed({ id: 'shared', note: 'did not work in 26.1', taskId: 'task-3' });

    assert.equal(marked.ok, true);
    assert.ok(fs.existsSync(path.join(userDir, 'articles', 'shared.md')));

    const article = kb.readArticle('shared');
    assert.match(article.text, /the author says this/, 'the author layer is untouched');
    assert.match(article.text, /did not work in 26\.1/);
    assert.match(article.text, /exists in both layers/);

    // The author's own file must be exactly as it was.
    const onDisk = fs.readFileSync(path.join(authorDir, 'articles', 'shared.md'), 'utf8');
    assert.match(onDisk, /the author says this/);
    assert.doesNotMatch(onDisk, /26\.1/);
});

test('a helped mark moves only the counter and takes no text', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'shared', {
        id: 'shared', title: 'Shared', problem: 'p', confidence: 'author-verified'
    }, 'the author says this');

    // A note passed anyway, the way an agent ignoring the schema would, goes nowhere.
    const marked = kb.markHelped({ id: 'shared', note: 'Worked reliably, applied successfully' });

    assert.equal(marked.ok, true);
    // Marking has to stay cheap for the base too: no user-layer twin, no second index line.
    assert.ok(!fs.existsSync(path.join(userDir, 'articles', 'shared.md')));
    assert.equal(kb.listArticles().length, 1);
    assert.match(kb.readArticle('shared').text, /helped 1 times/);
    assert.doesNotMatch(kb.readArticle('shared').text, /Worked reliably/);
});

test('a helped mark on an article that does not exist is refused', context => {
    const { kb } = makeKnowledgeBase(context);

    const refused = kb.markHelped({ id: 'nothing-here' });

    assert.equal(refused.ok, false);
    assert.match(refused.message, /There is no article "nothing-here"/);
});

test('a failed mark without a note is refused', context => {
    const { kb } = makeKnowledgeBase(context);
    kb.writeArticle({ id: 'thing', title: 'T', problem: 'p', body: 'text' });

    for (const note of [undefined, '', '   ']) {
        const refused = kb.markFailed({ id: 'thing', note, taskId: 'task-5' });
        assert.equal(refused.ok, false);
        assert.match(refused.message, /what helped instead/);
    }
    assert.match(kb.readArticle('thing').text, /did not work 0 times/);
});

test('one mark moves one counter, even when the article has a twin', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'shared', {
        id: 'shared', title: 'Shared', problem: 'p', confidence: 'author-verified'
    }, 'the author says this');

    // The failed note creates the user-layer twin before the counter is moved.
    kb.markFailed({ id: 'shared', note: 'needed another key', taskId: 'task-6' });
    // Now both layers have the id; a later helped mark must still count once.
    kb.markHelped({ id: 'shared' });

    const stats = JSON.parse(fs.readFileSync(path.join(userDir, 'usage-stats.json'), 'utf8'));
    assert.deepEqual(stats, { 'author:shared': { helped: 1, failed: 1 } });

    const lines = kb.formatIndex().split('\n');
    assert.equal(lines.length, 2, 'the author article and its twin');
    assert.match(lines[0], /\[author, .*helped 1, failed 1/);
    assert.match(lines[1], /\[user, .*helped 0, failed 0/, 'the twin does not repeat the counts');
});

test('a confirmed result lifts the articles the task wrote, once', context => {
    const { kb } = makeKnowledgeBase(context);
    kb.writeArticle({ id: 'thing', title: 'T', problem: 'p', body: 'text' });

    assert.deepEqual(kb.promoteArticles(['thing']), ['thing']);
    assert.match(kb.readArticle('thing').text, /user-confirmed/);

    // The top rung belongs to the author and is never reached this way.
    assert.deepEqual(kb.promoteArticles(['thing']), []);
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
