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
    // Author-layer stats now include a contentHash field for change detection.
    assert.equal(typeof stats['author:shared'].contentHash, 'string');
    assert.equal(stats['author:shared'].helped, 1);
    assert.equal(stats['author:shared'].failed, 1);

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

test('the rules come from the author layer even when the user layer has a copy', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    fs.writeFileSync(path.join(authorDir, 'rules.md'), 'the shipped rules', 'utf8');

    assert.equal(kb.readRules(), 'the shipped rules');

    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'rules.md'), 'my own rules', 'utf8');
    assert.equal(kb.readRules(), 'the shipped rules');
});

test('asking for an article that does not exist says what to do instead', context => {
    const { kb } = makeKnowledgeBase(context);
    const article = kb.readArticle('nothing-here');

    assert.equal(article.found, false);
    assert.match(article.text, /ps_kb_contribute/);
});

// ---------------------------------------------------------------------------
// Content-hash mark reset for author-layer articles
// ---------------------------------------------------------------------------

test('author article counters reset to zero when the article text changes', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'recipe', {
        id: 'recipe', title: 'A recipe', problem: 'p', confidence: 'author-verified'
    }, 'original text');

    // Record a use
    kb.markHelped({ id: 'recipe' });
    assert.match(kb.readArticle('recipe').text, /helped 1 times/);

    // Author updates the article text
    writeArticleFile(authorDir, 'recipe', {
        id: 'recipe', title: 'A recipe', problem: 'p', confidence: 'author-verified'
    }, 'updated text — totally different');

    // Counters should now appear as zero because the hash changed
    assert.match(kb.readArticle('recipe').text, /helped 0 times/);
    assert.match(kb.readArticle('recipe').text, /did not work 0 times/);
    assert.doesNotMatch(kb.readArticle('recipe').text, /helped 1 times/);
});

test('user-layer article counters are NOT reset when their text changes', context => {
    const { kb, userDir } = makeKnowledgeBase(context);
    kb.writeArticle({ id: 'mine', title: 'T', problem: 'p', body: 'v1' });

    kb.markHelped({ id: 'mine' });
    assert.match(kb.readArticle('mine').text, /helped 1 times/);

    // Overwrite the user article file directly to simulate an edit
    writeArticleFile(userDir, 'mine', {
        id: 'mine', title: 'T', problem: 'p', confidence: 'agent-written',
        helped: 0, failed: 0
    }, 'v2 — different body');

    // User-layer article uses sidecar counters without hash checks
    assert.match(kb.readArticle('mine').text, /helped 1 times/);
});

test('after a hash reset the next mark starts from one with the new hash', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'recipe2', {
        id: 'recipe2', title: 'R', problem: 'p', confidence: 'author-verified'
    }, 'v1');

    kb.markHelped({ id: 'recipe2' });

    // Update article content (hash changes)
    writeArticleFile(authorDir, 'recipe2', {
        id: 'recipe2', title: 'R', problem: 'p', confidence: 'author-verified'
    }, 'v2 completely different');

    // Mark helped again — should start from 1, not 2
    kb.markHelped({ id: 'recipe2' });
    assert.match(kb.readArticle('recipe2').text, /helped 1 times/);

    // The stored hash must match the v2 content
    const stats = JSON.parse(fs.readFileSync(path.join(userDir, 'usage-stats.json'), 'utf8'));
    assert.equal(stats['author:recipe2'].helped, 1);
});

test('markFailed on an author article stores a content hash in the user note front matter', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'fragile', {
        id: 'fragile', title: 'Fragile', problem: 'p', confidence: 'author-verified'
    }, 'author recipe v1');

    kb.markFailed({ id: 'fragile', note: 'it crashed', taskId: 't-1' });

    const notePath = path.join(userDir, 'articles', 'fragile.md');
    const noteContent = fs.readFileSync(notePath, 'utf8');
    assert.match(noteContent, /author_content_hash:/);
});

// ---------------------------------------------------------------------------
// formatIndex "not yet downloaded" state
// ---------------------------------------------------------------------------

test('formatIndex reports "not yet downloaded" when authorDir is missing', context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-kb-'));
    const authorDir = path.join(root, 'not-there');
    const userDir = path.join(root, 'knowledge-base.user');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const kb = createKnowledgeBase({
        authorDir,
        userDir,
        logger: { info() {}, warn() {}, error() {} }
    });

    const index = kb.formatIndex();
    assert.match(index, /not been downloaded yet/);
    assert.doesNotMatch(index, /knowledge base is empty/);
});

test('formatIndex reports "empty" when authorDir exists but has no articles', context => {
    const { kb } = makeKnowledgeBase(context);
    // makeKnowledgeBase creates the authorDir and its articles/ folder
    const index = kb.formatIndex();
    assert.match(index, /knowledge base is empty/);
    assert.doesNotMatch(index, /not been downloaded yet/);
});

// ---------------------------------------------------------------------------
// helper: version field filtering
// ---------------------------------------------------------------------------

/**
 * Build a knowledge base with a specific Helper version.
 */
function makeKnowledgeBaseVersioned(context, helperVersion) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-kb-'));
    const authorDir = path.join(root, 'knowledge-base');
    const userDir = path.join(root, 'knowledge-base.user');
    fs.mkdirSync(path.join(authorDir, 'articles'), { recursive: true });
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const kb = createKnowledgeBase({
        authorDir,
        userDir,
        helperVersion,
        logger: { info() {}, warn() {}, error() {} }
    });
    return { kb, authorDir, userDir };
}

test('article without helper: field is visible to any version', context => {
    const { kb, authorDir } = makeKnowledgeBaseVersioned(context, '1.0.0');
    writeArticleFile(authorDir, 'no-gate', {
        id: 'no-gate', title: 'No gate', problem: 'p', confidence: 'author-verified'
    }, 'body');

    const list = kb.listArticles();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'no-gate');
});

test('article with helper: matching the running version is visible', context => {
    const { kb, authorDir } = makeKnowledgeBaseVersioned(context, '1.3.0');
    writeArticleFile(authorDir, 'exact', {
        id: 'exact', title: 'Exact', problem: 'p', confidence: 'author-verified',
        helper: '1.3.0'
    }, 'body');

    assert.equal(kb.listArticles().length, 1);
});

test('article with helper: higher than running version is excluded from list', context => {
    const { kb, authorDir } = makeKnowledgeBaseVersioned(context, '1.2.0');
    writeArticleFile(authorDir, 'future', {
        id: 'future', title: 'Future', problem: 'p', confidence: 'author-verified',
        helper: '1.3.0'
    }, 'body');

    assert.equal(kb.listArticles().length, 0);
    assert.doesNotMatch(kb.formatIndex(), /future/);
});

test('reading a version-gated article by id returns a "requires newer Helper" notice', context => {
    const { kb, authorDir } = makeKnowledgeBaseVersioned(context, '1.2.0');
    writeArticleFile(authorDir, 'gated', {
        id: 'gated', title: 'Gated', problem: 'p', confidence: 'author-verified',
        helper: '2.0.0'
    }, 'body that should not appear');

    const result = kb.readArticle('gated');
    assert.equal(result.found, true); // article exists, just gated
    assert.match(result.text, /requires Helper 2\.0\.0 or newer/);
    assert.doesNotMatch(result.text, /body that should not appear/);
});

test('article with lower helper: than running version is visible', context => {
    const { kb, authorDir } = makeKnowledgeBaseVersioned(context, '2.0.0');
    writeArticleFile(authorDir, 'old-compat', {
        id: 'old-compat', title: 'Old compat', problem: 'p', confidence: 'author-verified',
        helper: '1.0.0'
    }, 'body');

    assert.equal(kb.listArticles().length, 1);
    const result = kb.readArticle('old-compat');
    assert.match(result.text, /body/);
    assert.doesNotMatch(result.text, /requires Helper/);
});

// ---------------------------------------------------------------------------
// Hiding and unmixing failure notes when author article changes
// ---------------------------------------------------------------------------

test('old failure notes on an author article are hidden from list and read when the article changes', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'tricky', {
        id: 'tricky', title: 'Tricky', problem: 'p', confidence: 'author-verified'
    }, 'original author text');

    // Add a failure note
    kb.markFailed({ id: 'tricky', note: 'failed because of parameter X', taskId: 't-1' });

    // Note is currently visible
    assert.match(kb.readArticle('tricky').text, /failed because of parameter X/);
    assert.equal(kb.listArticles().some(a => a.layer === 'user' && a.id === 'tricky'), true);

    // Author edits tricky.md
    writeArticleFile(authorDir, 'tricky', {
        id: 'tricky', title: 'Tricky', problem: 'p', confidence: 'author-verified'
    }, 'corrected author text that fixes parameter X');

    // The old note must now be hidden from both listArticles and readArticle!
    assert.doesNotMatch(kb.readArticle('tricky').text, /failed because of parameter X/);
    assert.equal(kb.listArticles().some(a => a.layer === 'user' && a.id === 'tricky'), false);
});

test('a new failure note after an author article change does not mix with old notes', context => {
    const { kb, authorDir, userDir } = makeKnowledgeBase(context);
    writeArticleFile(authorDir, 'tricky2', {
        id: 'tricky2', title: 'Tricky2', problem: 'p', confidence: 'author-verified'
    }, 'v1 text');

    // Add first failure note
    kb.markFailed({ id: 'tricky2', note: 'old failure in v1', taskId: 't-1' });
    assert.match(kb.readArticle('tricky2').text, /old failure in v1/);

    // Author updates tricky2.md
    writeArticleFile(authorDir, 'tricky2', {
        id: 'tricky2', title: 'Tricky2', problem: 'p', confidence: 'author-verified'
    }, 'v2 text');

    // Add new failure note for v2
    kb.markFailed({ id: 'tricky2', note: 'new failure in v2', taskId: 't-2' });

    // The read result should only contain the new failure, NOT the old failure!
    const article = kb.readArticle('tricky2');
    assert.match(article.text, /new failure in v2/);
    assert.doesNotMatch(article.text, /old failure in v1/);
});

test('hasAuthorBase reports accurately whether the author directory exists', context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-kb-'));
    const missingDir = path.join(root, 'non-existent');
    const userDir = path.join(root, 'user');
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const kbWithout = createKnowledgeBase({
        authorDir: missingDir,
        userDir,
        logger: { info() {}, warn() {}, error() {} }
    });
    assert.equal(kbWithout.hasAuthorBase(), false);

    fs.mkdirSync(missingDir, { recursive: true });
    assert.equal(kbWithout.hasAuthorBase(), true);
});
