'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    checkForKbUpdate,
    createKbUpdater,
    extractKbFilesFromTree,
    isContentIdentical
} = require('../kb-updater');

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory laid out like a packaged app's userData folder.
 * Returns paths compatible with getConfigPaths() output.
 */
function makePaths(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-kb-updater-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return {
        downloadedKnowledgeBasePath: path.join(dir, 'knowledge-base'),
        userDataPath: dir,
        resourcesPath: dir,
        downloadedProvidersPath: null
    };
}

/**
 * Build a mock GitHub tree API JSON response for the given relative paths.
 *
 * @param {string[]} files
 * @returns {string}
 */
function makeTreeResponse(files) {
    return JSON.stringify({
        sha: 'mock-tree-sha',
        tree: files.map(file => ({
            path: `PhotoshopHelper/knowledge-base/${file}`,
            type: 'blob',
            sha: `sha-for-${file}`
        }))
    });
}

/**
 * Build a fake article text for use in download responses.
 *
 * @param {string} id
 * @param {string} [extra]
 * @returns {string}
 */
function makeArticleText(id, extra = '') {
    return `---\nid: ${id}\ntitle: Test article ${id}\nproblem: test\nconfidence: author-verified\ndate: 2026-01-01\nhelped: 0\nfailed: 0\n---\n\nBody of ${id}.${extra ? ' ' + extra : ''}\n`;
}

/**
 * A fetch implementation that routes requests to tree response or raw file responses.
 *
 * @param {string} treeJson - Response for the tree URL.
 * @param {object} fileResponses - Map of relative path to content text.
 * @param {object} [opts]
 * @param {number} [opts.status] - HTTP status for all responses (default 200).
 * @param {string[]} [opts.calls] - Array to push called URLs into.
 */
function makeFetch(treeJson, fileResponses, { status = 200, calls = [] } = {}) {
    return async (url) => {
        calls.push(url);

        if (url.includes('trees')) {
            return {
                ok: status >= 200 && status < 300,
                status,
                headers: new Map(),
                text: async () => treeJson
            };
        }

        const match = Object.keys(fileResponses).find(k => url.endsWith(`/${k}`));
        const body = match !== undefined ? fileResponses[match] : '';
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: new Map(),
            text: async () => body
        };
    };
}

/**
 * Convenience: run one check with custom tree and file responses.
 */
async function checkOnce(paths, files, fileResponses, extra = {}) {
    const treeJson = makeTreeResponse(files);
    return checkForKbUpdate({
        treeUrl: 'https://api.github.test/git/trees/main',
        rawBaseUrl: 'https://raw.github.test/kb',
        fetchImpl: makeFetch(treeJson, fileResponses),
        paths,
        logger: silentLogger,
        ...extra
    });
}

// ---------------------------------------------------------------------------
// extractKbFilesFromTree unit tests
// ---------------------------------------------------------------------------

test('extractKbFilesFromTree extracts and normalizes knowledge-base .md files', () => {
    const tree = [
        { path: 'PhotoshopHelper/knowledge-base/rules.md', type: 'blob' },
        { path: 'PhotoshopHelper/knowledge-base/articles/foo.md', type: 'blob' },
        { path: 'PhotoshopHelper/knowledge-base/articles', type: 'tree' }, // directory skipped
        { path: 'PhotoshopHelper/other/file.md', type: 'blob' }, // outside kb skipped
        { path: 'PhotoshopHelper/knowledge-base/notes.txt', type: 'blob' } // non-md skipped
    ];
    const files = extractKbFilesFromTree(tree);
    assert.deepEqual(files, ['articles/foo.md', 'rules.md']);
});

test('extractKbFilesFromTree rejects non-array tree input', () => {
    assert.throws(() => extractKbFilesFromTree(null), /Invalid GitHub tree response/);
});

test('extractKbFilesFromTree rejects when no KB files are found', () => {
    assert.throws(() => extractKbFilesFromTree([]), /No knowledge base articles found/);
});

test('extractKbFilesFromTree rejects path traversal entries', () => {
    assert.throws(
        () => extractKbFilesFromTree([
            { path: 'PhotoshopHelper/knowledge-base/../escape.md', type: 'blob' }
        ]),
        /unsafe path/
    );
});

// ---------------------------------------------------------------------------
// isContentIdentical unit tests
// ---------------------------------------------------------------------------

test('isContentIdentical returns true when file lists and contents match', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-kb-diff-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    fs.mkdirSync(path.join(dirA, 'articles'), { recursive: true });
    fs.mkdirSync(path.join(dirB, 'articles'), { recursive: true });

    fs.writeFileSync(path.join(dirA, 'rules.md'), 'rules\r\ntext');
    fs.writeFileSync(path.join(dirB, 'rules.md'), 'rules\ntext'); // line endings ignored
    fs.writeFileSync(path.join(dirA, 'articles', 'x.md'), 'same');
    fs.writeFileSync(path.join(dirB, 'articles', 'x.md'), 'same');

    assert.equal(isContentIdentical(dirA, dirB), true);
});

test('isContentIdentical returns false when content differs', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-kb-diff-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    fs.writeFileSync(path.join(dirA, 'rules.md'), 'old');
    fs.writeFileSync(path.join(dirB, 'rules.md'), 'new');

    assert.equal(isContentIdentical(dirA, dirB), false);
});

// ---------------------------------------------------------------------------
// checkForKbUpdate integration tests
// ---------------------------------------------------------------------------

test('the first download is saved and used', async (t) => {
    const paths = makePaths(t);
    const files = ['rules.md', 'articles/foo.md'];
    const result = await checkOnce(paths, files, {
        'rules.md': makeArticleText('rules'),
        'articles/foo.md': makeArticleText('foo')
    });

    assert.deepEqual(result, { status: 'updated' });
    assert.ok(fs.existsSync(path.join(paths.downloadedKnowledgeBasePath, 'rules.md')));
    assert.ok(fs.existsSync(path.join(paths.downloadedKnowledgeBasePath, 'articles', 'foo.md')));
});

test('an unchanged knowledge base reports unchanged without modifying target', async (t) => {
    const paths = makePaths(t);
    const files = ['rules.md'];

    // First download
    await checkOnce(paths, files, { 'rules.md': makeArticleText('rules') });

    // Second check with identical content
    const result = await checkOnce(paths, files, { 'rules.md': makeArticleText('rules') });
    assert.deepEqual(result, { status: 'unchanged' });
});

test('an edited article text triggers update even when file list is unchanged', async (t) => {
    const paths = makePaths(t);
    const files = ['rules.md', 'articles/foo.md'];

    // First download
    await checkOnce(paths, files, {
        'rules.md': makeArticleText('rules'),
        'articles/foo.md': makeArticleText('foo', 'v1')
    });

    // Author edits articles/foo.md (file names in tree are identical!)
    const result = await checkOnce(paths, files, {
        'rules.md': makeArticleText('rules'),
        'articles/foo.md': makeArticleText('foo', 'v2 updated content')
    });

    assert.deepEqual(result, { status: 'updated' });
    const localContent = fs.readFileSync(
        path.join(paths.downloadedKnowledgeBasePath, 'articles', 'foo.md'),
        'utf8'
    );
    assert.match(localContent, /v2 updated content/);
});

test('an article removed in the repository disappears locally after update', async (t) => {
    const paths = makePaths(t);

    // First download: two articles
    await checkOnce(paths, ['rules.md', 'articles/old.md'], {
        'rules.md': makeArticleText('rules'),
        'articles/old.md': makeArticleText('old')
    });
    assert.ok(fs.existsSync(path.join(paths.downloadedKnowledgeBasePath, 'articles', 'old.md')));

    // Second download: old.md removed from tree
    const result = await checkOnce(paths, ['rules.md'], {
        'rules.md': makeArticleText('rules')
    });

    assert.deepEqual(result, { status: 'updated' });
    assert.equal(
        fs.existsSync(path.join(paths.downloadedKnowledgeBasePath, 'articles', 'old.md')),
        false
    );
});

test('a failed file download leaves the saved copy untouched', async (t) => {
    const paths = makePaths(t);

    // First download succeeds
    await checkOnce(paths, ['rules.md'], { 'rules.md': makeArticleText('rules') });
    const originalContent = fs.readFileSync(
        path.join(paths.downloadedKnowledgeBasePath, 'rules.md'),
        'utf8'
    );

    // Second check: tree has a new file that returns HTTP 404
    const updater = createKbUpdater({
        treeUrl: 'https://api.github.test/trees',
        rawBaseUrl: 'https://raw.github.test/kb',
        fetchImpl: async (url) => {
            if (url.includes('trees')) {
                return {
                    ok: true, status: 200, headers: new Map(),
                    text: async () => makeTreeResponse(['rules.md', 'articles/broken.md'])
                };
            }
            if (url.endsWith('/articles/broken.md')) {
                return { ok: false, status: 404, headers: new Map(), text: async () => 'Not Found' };
            }
            return { ok: true, status: 200, headers: new Map(), text: async () => makeArticleText('rules') };
        },
        paths,
        logger: silentLogger
    });

    const result = await updater.checkNow();
    assert.equal(result.status, 'error');
    assert.match(result.error, /HTTP 404/);

    // The previously downloaded rules.md must be intact
    const afterContent = fs.readFileSync(
        path.join(paths.downloadedKnowledgeBasePath, 'rules.md'),
        'utf8'
    );
    assert.equal(afterContent, originalContent);
});

test('a truncated repository tree is rejected and the saved copy is kept', async (t) => {
    const paths = makePaths(t);
    await checkOnce(paths, ['rules.md', 'articles/foo.md'], {
        'rules.md': makeArticleText('rules'),
        'articles/foo.md': makeArticleText('foo')
    });

    // GitHub cut the list short: foo.md is missing from it only because of the limit.
    const truncatedTree = JSON.stringify({
        ...JSON.parse(makeTreeResponse(['rules.md'])),
        truncated: true
    });
    const updater = createKbUpdater({
        treeUrl: 'https://api.github.test/trees',
        rawBaseUrl: 'https://raw.github.test/kb',
        fetchImpl: makeFetch(truncatedTree, { 'rules.md': makeArticleText('rules') }),
        paths,
        logger: silentLogger
    });
    const result = await updater.checkNow();

    assert.equal(result.status, 'error');
    assert.match(result.error, /truncated/);
    assert.ok(fs.existsSync(path.join(paths.downloadedKnowledgeBasePath, 'articles', 'foo.md')));
});

test('nothing is downloaded in development (downloadedKnowledgeBasePath is null)', async (t) => {
    const paths = { ...makePaths(t), downloadedKnowledgeBasePath: null };
    const calls = [];
    const fetchImpl = makeFetch(makeTreeResponse(['rules.md']), { 'rules.md': 'body' }, { calls });

    const updater = createKbUpdater({
        treeUrl: 'https://api.github.test/trees',
        rawBaseUrl: 'https://raw.github.test/kb',
        fetchImpl,
        paths,
        logger: silentLogger
    });
    const result = await updater.checkNow();

    assert.equal(result.status, 'error');
    assert.match(result.error, /disabled in development/);
    assert.equal(calls.length, 0);
});

test('only https URLs are accepted', async (t) => {
    const paths = makePaths(t);
    const fetchImpl = makeFetch(makeTreeResponse(['rules.md']), { 'rules.md': 'body' });

    const updater = createKbUpdater({
        treeUrl: 'http://api.github.test/trees',
        rawBaseUrl: 'https://raw.github.test/kb',
        fetchImpl,
        paths,
        logger: silentLogger
    });
    const result = await updater.checkNow();

    assert.equal(result.status, 'error');
    assert.match(result.error, /must use https/);
});

test('an HTTP error on the tree endpoint is reported', async (t) => {
    const paths = makePaths(t);
    const fetchImpl = makeFetch('', {}, { status: 503 });

    const updater = createKbUpdater({
        treeUrl: 'https://api.github.test/trees',
        rawBaseUrl: 'https://raw.github.test/kb',
        fetchImpl,
        paths,
        logger: silentLogger
    });
    const result = await updater.checkNow();

    assert.equal(result.status, 'error');
    assert.match(result.error, /HTTP 503/);
});

test('a check requested during another one shares its result', async (t) => {
    const paths = makePaths(t);
    const calls = [];

    const fetchImpl = makeFetch(
        makeTreeResponse(['rules.md']),
        { 'rules.md': makeArticleText('rules') },
        { calls }
    );

    const updater = createKbUpdater({
        treeUrl: 'https://api.github.test/trees',
        rawBaseUrl: 'https://raw.github.test/kb',
        fetchImpl,
        paths,
        logger: silentLogger
    });

    const [first, second] = await Promise.all([updater.checkNow(), updater.checkNow()]);

    assert.equal(first, second);
    assert.equal(first.status, 'updated');
    // Tree endpoint was fetched only once
    const treeCalls = calls.filter(url => url.includes('trees'));
    assert.equal(treeCalls.length, 1);
});
