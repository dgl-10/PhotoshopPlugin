'use strict';

/**
 * The agent's knowledge base.
 *
 * It lives in Helper's data folder, next to the provider list. Agents reach it through
 * MCP rather than through filesystem paths, so the same article API works regardless of
 * where the MCP client was started or which local folders it may read.
 *
 * Two layers, following the providers pattern:
 *   author  ships with Helper and is never written to from here;
 *   user    written by the agent, and never overwritten by Helper.
 * Articles from the two layers do not replace each other. When the same id exists in
 * both, the agent is shown both, marked, and picks for itself.
 *
 * The index is not a separate file. Each article carries a one-line `problem:` in its
 * front matter, and the index is assembled from those lines on every read. A hand-kept
 * index file would be a second place to forget to update, and an article written by the
 * agent has to appear in the index without a second write.
 *
 * Content-hash tracking for author articles:
 *   Usage counters (helped/failed) and failure notes on author-layer articles are tied to
 *   the exact version of the article they were collected on. When the author updates an
 *   article (any text change), the SHA-256 hash of its file changes, and the old counters
 *   and failure notes are treated as stale: they are not displayed, and the next mark
 *   starts from zero. User-layer articles are not affected by this mechanism.
 *
 * Minimum Helper version:
 *   An optional `helper:` field in an article's front matter sets the minimum Helper
 *   version required to read it. Articles that require a newer version are silently
 *   excluded from listings and return a short "requires newer Helper" message on direct
 *   read. The field uses semver ordering.
 *
 * Planned article classes (design note, not an implemented taxonomy):
 *
 * The current base contains technical recipes: exact DOM, Imaging API, or action
 * descriptor operations whose result can be checked directly in Photoshop. For example,
 * a filter either ran with the documented descriptor, a mask was created, or a selection
 * was restored. An agent can normally verify this kind of knowledge itself by inspecting
 * the resulting document state.
 *
 * A later class may contain visual/CV workflows rather than exact API recipes. Examples
 * include how to approach colour correction, which Photoshop tools to choose and in what
 * order, and how to align or blend generated content with the original image at pixel
 * level. A command succeeding does not prove that this kind of result is good, so these
 * articles will need a more meaningful qualitative review model.
 *
 * Real usage may reveal a third class as well. This classification currently exists only
 * in the product author's plans: there is no class field, CV article format, or evaluation
 * workflow in the code yet. Do not build generic scoring around the idea until real
 * non-technical articles exist and it is clear who reviews them, what evidence is useful,
 * and how feedback leads to a concrete correction of an article.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { writeFileAtomic } = require('../atomic-write');

// Confidence is descriptive article metadata, not a score calculated by Helper. The
// value changes only when a person deliberately edits/reviews the article; no task result,
// usage counter, or MCP call promotes it automatically.
const CONFIDENCE_LEVELS = ['agent-written', 'user-confirmed', 'author-verified'];

const ARTICLE_EXTENSION = '.md';
const STATS_FILENAME = 'usage-stats.json';
const RULES_FILENAME = 'rules.md';

/**
 * Compute a short SHA-256 hex digest of a string, used to detect author article changes.
 *
 * @param {string} text - File content.
 * @returns {string} 16-character hex prefix of the SHA-256 digest.
 */
function contentHash(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Parse a semver string into a comparable tuple. Returns [0,0,0] for anything
 * that does not look like major.minor.patch.
 *
 * @param {string} version - e.g. "1.3.0".
 * @returns {number[]} [major, minor, patch]
 */
function parseSemver(version) {
    const parts = String(version || '').trim().split('.');
    return [
        Math.max(0, parseInt(parts[0], 10) || 0),
        Math.max(0, parseInt(parts[1], 10) || 0),
        Math.max(0, parseInt(parts[2], 10) || 0)
    ];
}

/**
 * Compare two semver tuples.
 *
 * @param {number[]} a - [major, minor, patch].
 * @param {number[]} b - [major, minor, patch].
 * @returns {number} Negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(a, b) {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

/**
 * Split a Markdown file into its front matter and its body.
 *
 * The front matter is a block of `key: value` lines between two `---` lines. It is
 * deliberately not YAML: the files are written and re-read by an agent, and a format
 * that cannot fail in interesting ways is worth more here than expressiveness.
 *
 * @param {string} text - File contents.
 * @returns {{meta: object, body: string}}
 */
function parseArticle(text) {
    const meta = {};
    const normalized = String(text || '').replace(/\r\n/g, '\n');

    if (!normalized.startsWith('---\n')) {
        return { meta, body: normalized.trim() };
    }

    const end = normalized.indexOf('\n---', 4);
    if (end === -1) {
        return { meta, body: normalized.trim() };
    }

    const head = normalized.slice(4, end);
    for (const line of head.split('\n')) {
        const separator = line.indexOf(':');
        if (separator === -1) continue;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key) meta[key] = value;
    }

    const bodyStart = normalized.indexOf('\n', end + 1);
    return { meta, body: bodyStart === -1 ? '' : normalized.slice(bodyStart + 1).trim() };
}

/**
 * Render front matter and body back into a Markdown file.
 *
 * @param {object} meta - Front matter keys.
 * @param {string} body - Article text.
 * @returns {string}
 */
function formatArticle(meta, body) {
    const lines = ['---'];
    for (const [key, value] of Object.entries(meta)) {
        if (value === undefined || value === null || value === '') continue;
        lines.push(`${key}: ${String(value).replace(/\n/g, ' ')}`);
    }
    lines.push('---', '', String(body || '').trim(), '');
    return lines.join('\n');
}

/**
 * Turn a free-form id into something safe to use as a file name.
 *
 * @param {string} value - Proposed article id.
 * @returns {string} Lowercase, dash-separated, no path separators.
 */
function normalizeArticleId(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

/**
 * Create the knowledge base over a pair of folders.
 *
 * @param {object} options
 * @param {string} options.authorDir - Folder shipped with Helper or downloaded from the
 *   repository. Read only from the knowledge base's perspective.
 * @param {string} options.userDir - Folder the agent writes to.
 * @param {string} [options.helperVersion] - Current Helper version string (e.g. "1.3.0"),
 *   used to filter out articles that require a newer release.
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {object} Knowledge base.
 */
function createKnowledgeBase({ authorDir, userDir, helperVersion, logger = console }) {
    const layers = [
        { name: 'author', dir: authorDir, writable: false },
        { name: 'user', dir: userDir, writable: true }
    ];

    // Parsed [major, minor, patch] of the running Helper; articles with a higher
    // `helper:` requirement are invisible to this version.
    const runningVersion = parseSemver(helperVersion);

    /**
     * @param {string} dir - Layer folder.
     * @returns {string} Its articles folder.
     */
    function articlesDir(dir) {
        return path.join(dir, 'articles');
    }

    /**
     * Create the user layer on first use, so the user finds the folder next to .env even
     * before the agent has written anything into it.
     */
    function ensureUserLayer() {
        const dir = articlesDir(userDir);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            logger.info(`[knowledge-base] Created ${dir}`);
        }
    }

    /**
     * Read agent-reported outcomes for individual article uses.
     *
     * The sidecar lives in the user layer so Helper can count uses of shipped author
     * articles without ever modifying the read-only files that came with the application.
     * These counters are evidence from agents applying a specific article, not a person's
     * rating of the overall task.
     *
     * Stats object shape: keyed by "<layer>:<article-id>".
     * Each value may contain: { helped, failed, contentHash? }
     * contentHash is only stored for author-layer articles. When the file's current hash
     * differs from the stored one, the counters are treated as stale (reset to 0).
     *
     * @returns {object} Counters keyed by `<layer>:<article-id>`.
     */
    function readStats() {
        const file = path.join(userDir, STATS_FILENAME);
        try {
            if (!fs.existsSync(file)) return {};
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            logger.warn(`[knowledge-base] Could not read ${STATS_FILENAME}: ${error.message}`);
            return {};
        }
    }

    /**
     * Persist agent-reported article outcomes atomically.
     *
     * @param {object} stats - Counters keyed by layer and article id.
     */
    function writeStats(stats) {
        ensureUserLayer();
        writeFileAtomic(path.join(userDir, STATS_FILENAME), JSON.stringify(stats, null, 2));
    }

    /**
     * Read one article file. Returns the raw file text alongside the parsed article so
     * the caller can compute a content hash without re-reading the file.
     *
     * @param {string} dir - Layer folder.
     * @param {string} id - Article id.
     * @returns {{meta: object, body: string, rawText: string}|null}
     */
    function readArticleFile(dir, id) {
        const file = path.join(articlesDir(dir), `${id}${ARTICLE_EXTENSION}`);
        try {
            if (!fs.existsSync(file)) return null;
            const rawText = fs.readFileSync(file, 'utf8');
            const { meta, body } = parseArticle(rawText);
            return { meta, body, rawText };
        } catch (error) {
            logger.warn(`[knowledge-base] Could not read ${file}: ${error.message}`);
            return null;
        }
    }

    /**
     * Return the effective helped/failed counters for an author-layer article, resetting
     * them to zero when the article's content has changed since the counters were recorded.
     *
     * Old stats records that predate content-hash tracking have no `contentHash` field.
     * Per the TZ specification, such records are treated as stale and reset to 0.
     *
     * @param {string} id - Article id.
     * @param {string} rawText - Current file content of the author article.
     * @param {object} storedCounters - The raw stats entry for `author:<id>`.
     * @returns {{ helped: number, failed: number, currentHash: string }} Effective counters.
     */
    function effectiveAuthorCounters(id, rawText, storedCounters) {
        const currentHash = contentHash(rawText);
        const stored = storedCounters || {};
        const storedHash = stored.contentHash;

        // If no hash was stored, or the hash differs, the counters are stale.
        if (!storedHash || storedHash !== currentHash) {
            return { helped: 0, failed: 0, currentHash };
        }

        return {
            helped: Number(stored.helped || 0),
            failed: Number(stored.failed || 0),
            currentHash
        };
    }

    /**
     * Decide whether an article with the given `helper:` front-matter value should be
     * visible to the current Helper version.
     *
     * @param {string|undefined} requiredVersion - The `helper:` field value, or undefined.
     * @returns {boolean} True when the article may be shown.
     */
    function isVersionVisible(requiredVersion) {
        if (!requiredVersion) return true;
        const required = parseSemver(requiredVersion);
        // Article is visible when the running version is >= the required version.
        return compareSemver(runningVersion, required) >= 0;
    }

    /**
     * Every article in both layers, with the descriptive metadata needed to find it.
     * Articles requiring a newer Helper version are silently excluded.
     *
     * @returns {object[]} Entries sorted by id, author layer first for a shared id.
     */
    function listArticles() {
        const stats = readStats();
        const entries = [];

        for (const layer of layers) {
            const dir = articlesDir(layer.dir);
            let names = [];
            try {
                names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
            } catch (error) {
                logger.warn(`[knowledge-base] Could not list ${dir}: ${error.message}`);
            }

            for (const name of names) {
                if (!name.endsWith(ARTICLE_EXTENSION)) continue;
                const id = name.slice(0, -ARTICLE_EXTENSION.length);
                const article = readArticleFile(layer.dir, id);
                if (!article) continue;

                // Filter out articles that require a newer Helper version.
                if (!isVersionVisible(article.meta.helper)) continue;

                // If this is a user-layer failure note on an author article, hide it if the
                // author has updated the article since the note was recorded.
                if (layer.name === 'user' && article.meta.note_on) {
                    const authorArticle = readArticleFile(authorDir, id);
                    if (authorArticle) {
                        const currentHash = contentHash(authorArticle.rawText);
                        if (!article.meta.author_content_hash || article.meta.author_content_hash !== currentHash) {
                            continue;
                        }
                    }
                }

                let helped, failed;
                if (layer.name === 'author') {
                    const key = `author:${id}`;
                    const effective = effectiveAuthorCounters(id, article.rawText, stats[key]);
                    helped = Number(article.meta.helped || 0) + effective.helped;
                    failed = Number(article.meta.failed || 0) + effective.failed;
                } else {
                    const counters = stats[`user:${id}`] || {};
                    helped = Number(article.meta.helped || 0) + Number(counters.helped || 0);
                    failed = Number(article.meta.failed || 0) + Number(counters.failed || 0);
                }

                entries.push({
                    id,
                    layer: layer.name,
                    title: article.meta.title || id,
                    problem: article.meta.problem || article.meta.title || id,
                    confidence: CONFIDENCE_LEVELS.includes(article.meta.confidence)
                        ? article.meta.confidence
                        : 'agent-written',
                    photoshop: article.meta.photoshop || 'unknown',
                    date: article.meta.date || '',
                    task: article.meta.task || '',
                    agent: article.meta.agent || '',
                    helped,
                    failed
                });
            }
        }

        entries.sort((a, b) => (a.id === b.id
            ? (a.layer === 'author' ? -1 : 1)
            : a.id.localeCompare(b.id)));
        return entries;
    }

    /**
     * The index the agent is given in ps_start_task: one line per article, both layers
     * joined line by line, so the agent opens an article only when it looks relevant.
     *
     * When the author KB has never been downloaded yet (authorDir does not exist), a
     * distinct message tells the agent to wait rather than concluding the base is empty.
     *
     * @returns {string} Plain text index.
     */
    function formatIndex() {
        // Distinguish "base not yet downloaded" from "base is empty".
        const authorDirMissing = !fs.existsSync(authorDir);
        const entries = listArticles();

        if (authorDirMissing && entries.length === 0) {
            return 'The knowledge base has not been downloaded yet. It will be available after the '
                + 'first scheduled update or when you trigger one from the tray menu. '
                + 'Continue working without it for now.';
        }

        if (entries.length === 0) {
            return 'The knowledge base is empty. That does not make everything you do worth an '
                + 'article: write with ps_kb_contribute only what the next agent would get wrong '
                + 'or lose real time on without it. The rules from ps_start_task say how to tell.';
        }

        const lines = entries.map(entry => (
            `- ${entry.id} [${entry.layer}, ${entry.confidence}, helped ${entry.helped}, `
            + `failed ${entry.failed}, Photoshop ${entry.photoshop}] — ${entry.problem}`
        ));

        return lines.join('\n');
    }

    /**
     * Read an article by id, from both layers.
     * Articles requiring a newer Helper version return a short notice instead.
     *
     * @param {string} rawId - Article id.
     * @returns {{found: boolean, text: string}} Text ready to hand to the agent.
     */
    function readArticle(rawId) {
        const id = normalizeArticleId(rawId);
        const stats = readStats();
        const parts = [];

        for (const layer of layers) {
            const article = readArticleFile(layer.dir, id);
            if (!article) continue;

            // Return a version-gate notice instead of the article body.
            if (!isVersionVisible(article.meta.helper)) {
                parts.push(
                    `=== ${id} (${layer.name} layer) ===\n`
                    + `This article requires Helper ${article.meta.helper} or newer. `
                    + 'Update Helper to read it.'
                );
                continue;
            }

            // If this is a user-layer failure note on an author article, do not show it if the
            // author has updated the article since the note was recorded.
            if (layer.name === 'user' && article.meta.note_on) {
                const authorArticle = readArticleFile(authorDir, id);
                if (authorArticle) {
                    const currentHash = contentHash(authorArticle.rawText);
                    if (!article.meta.author_content_hash || article.meta.author_content_hash !== currentHash) {
                        continue;
                    }
                }
            }

            let helped, failed;
            if (layer.name === 'author') {
                const key = `author:${id}`;
                const effective = effectiveAuthorCounters(id, article.rawText, stats[key]);
                helped = Number(article.meta.helped || 0) + effective.helped;
                failed = Number(article.meta.failed || 0) + effective.failed;
            } else {
                const counters = stats[`user:${id}`] || {};
                helped = Number(article.meta.helped || 0) + Number(counters.helped || 0);
                failed = Number(article.meta.failed || 0) + Number(counters.failed || 0);
            }

            parts.push(
                `=== ${id} (${layer.name} layer) ===\n`
                + `confidence: ${CONFIDENCE_LEVELS.includes(article.meta.confidence)
                    ? article.meta.confidence
                    : 'agent-written'}\n`
                + `written by: ${article.meta.agent || 'unknown'}\n`
                + `written on task: ${article.meta.task || 'unknown'}\n`
                + `Photoshop: ${article.meta.photoshop || 'unknown'}, date: ${article.meta.date || 'unknown'}\n`
                + `helped ${helped} times, did not work ${failed} times\n`
                + '\n'
                + article.body
            );
        }

        if (parts.length === 0) {
            return {
                found: false,
                text: `There is no article "${id}". Check the id against the index from `
                    + 'ps_kb_list, or work the answer out yourself. If it turns out to be something '
                    + 'the next agent would get wrong or lose real time on, write it down with '
                    + 'ps_kb_contribute.'
            };
        }

        if (parts.length > 1) {
            parts.unshift(
                'This article exists in both layers. They do not replace each other — read '
                + 'both and decide which one fits the document in front of you.'
            );
        }

        return { found: true, text: parts.join('\n\n') };
    }

    /**
     * Write a new article into the user layer.
     *
     * @param {object} params
     * @param {string} params.id - Article id.
     * @param {string} params.title - Short title.
     * @param {string} params.problem - The one line that goes into the index.
     * @param {string} params.body - The article itself.
     * @param {string} [params.whatDidNotWork] - What was tried first and failed. It is
     *   kept as its own section because it is the half that stops the next agent from
     *   walking into the same thing.
     * @param {string} [params.taskId] - Task it came from.
     * @param {string} [params.photoshopVersion] - Photoshop version it was checked on.
     * @param {string} [params.agent] - Which agent wrote it, as its MCP client named itself.
     * @returns {{ok: boolean, id: string, message: string}}
     */
    function writeArticle({
        id: rawId, title, problem, body, whatDidNotWork, taskId, photoshopVersion, agent
    }) {
        const id = normalizeArticleId(rawId);
        if (!id) {
            return { ok: false, id: '', message: 'The article id must contain letters or digits.' };
        }
        if (!body || !String(body).trim()) {
            return { ok: false, id, message: 'The article body is empty.' };
        }

        ensureUserLayer();
        const file = path.join(articlesDir(userDir), `${id}${ARTICLE_EXTENSION}`);

        if (fs.existsSync(file)) {
            return {
                ok: false,
                id,
                message: `An article "${id}" already exists in the user layer. Do not overwrite it. `
                    + 'If you followed it and it needed a change to work, put that on it with '
                    + 'ps_kb_mark_failed, which keeps the history the next agent reads. If yours '
                    + 'is a different problem, give it another id.'
            };
        }

        const meta = {
            id,
            title: title || id,
            problem: problem || title || id,
            // A new contribution starts as agent-written. Deliberate human review can
            // change this field in the Markdown later; Helper never promotes it itself.
            confidence: 'agent-written',
            agent: agent || 'unknown',
            task: taskId || '',
            photoshop: photoshopVersion || 'unknown',
            date: new Date().toISOString().slice(0, 10),
            // Baseline counters make the article format self-describing. Later outcomes
            // are kept in the user-layer sidecar so shipped articles stay read-only.
            helped: 0,
            failed: 0
        };

        const text = whatDidNotWork && String(whatDidNotWork).trim()
            ? `${String(body).trim()}\n\n## What did not work first\n\n${String(whatDidNotWork).trim()}`
            : body;

        writeFileAtomic(file, formatArticle(meta, text));
        logger.info(`[knowledge-base] Wrote article ${id}`);
        return { ok: true, id, message: `Article "${id}" written to the user layer.` };
    }

    /**
     * Find an article an agent wants to mark in either knowledge-base layer.
     *
     * @param {string} rawId - Article id as supplied by the agent.
     * @returns {{ok: true, id: string, inAuthor: object|null, inUser: object|null}
     *   |{ok: false, id: string, message: string}}
     */
    function findArticleToMark(rawId) {
        const id = normalizeArticleId(rawId);
        if (!id) {
            return { ok: false, id: '', message: 'The article id must contain letters or digits.' };
        }

        const inAuthor = readArticleFile(authorDir, id);
        const inUser = readArticleFile(userDir, id);
        if (!inAuthor && !inUser) {
            return {
                ok: false,
                id,
                message: `There is no article "${id}". Check the id against the index from ps_kb_list.`
            };
        }

        return { ok: true, id, inAuthor, inUser };
    }

    /**
     * Record that one article worked exactly as written.
     *
     * A helped mark deliberately has no free-text note. Earlier experiments showed that
     * agents fill any available note field with repetitive text; a pure counter captures
     * the useful signal without growing a duplicate user-layer article.
     *
     * @param {object} params
     * @param {string} params.id - Article id.
     * @returns {{ok: boolean, id: string, message: string}}
     */
    function markHelped({ id: rawId }) {
        const found = findArticleToMark(rawId);
        if (!found.ok) return found;

        recordUsage(found.id, 'helped');
        return { ok: true, id: found.id, message: `Marked "${found.id}" as helped.` };
    }

    /**
     * Record that an article failed or required a change, preserving the explanation.
     *
     * The author layer remains immutable. If only an author article exists, its failure
     * note becomes a same-id article in the user layer, so future agents see the shipped
     * recipe and its local correction history side by side.
     *
     * When writing a failure note for an author article, the current content hash is stored
     * in the note's front matter. If the author later updates the article (hash changes),
     * the old notes describe text that no longer exists: listArticles and readArticle stop
     * showing them, and the next failure note replaces them instead of being appended.
     *
     * @param {object} params
     * @param {string} params.id - Article id.
     * @param {string} params.note - What failed and what worked instead.
     * @param {string} [params.taskId] - Task that produced the evidence.
     * @returns {{ok: boolean, id: string, message: string}}
     */
    function markFailed({ id: rawId, note, taskId }) {
        if (!note || !String(note).trim()) {
            return {
                ok: false,
                id: normalizeArticleId(rawId),
                message: 'A failed mark needs a note: in what task it failed, why, and what helped instead.'
            };
        }

        const found = findArticleToMark(rawId);
        if (!found.ok) return found;
        const { id, inAuthor, inUser } = found;

        ensureUserLayer();
        const file = path.join(articlesDir(userDir), `${id}${ARTICLE_EXTENSION}`);
        const stamp = new Date().toISOString().slice(0, 10);
        const addition = `### Did not work — ${stamp}, task ${taskId || 'unknown'}\n\n${String(note).trim()}`;

        if (inAuthor) {
            const hash = contentHash(inAuthor.rawText);
            const isStale = inUser && inUser.meta.note_on
                && (!inUser.meta.author_content_hash || inUser.meta.author_content_hash !== hash);

            if (inUser && !isStale) {
                // Same author article version: append note to existing history
                const meta = { ...inUser.meta, id: inUser.meta.id || id, author_content_hash: hash };
                writeFileAtomic(file, formatArticle(meta, `${inUser.body}\n\n${addition}`));
            } else {
                // First note or new author article version: do not mix with old notes, start fresh
                const meta = {
                    id,
                    title: inAuthor.meta.title || id,
                    problem: inAuthor.meta.problem || inAuthor.meta.title || id,
                    confidence: 'agent-written',
                    task: taskId || '',
                    photoshop: inAuthor.meta.photoshop || 'unknown',
                    date: stamp,
                    note_on: 'author-layer article of the same id',
                    author_content_hash: hash,
                    helped: 0,
                    failed: 0
                };
                writeFileAtomic(file, formatArticle(meta, addition));
            }
        } else if (inUser) {
            // Standalone user-layer article
            const meta = { ...inUser.meta, id: inUser.meta.id || id };
            writeFileAtomic(file, formatArticle(meta, `${inUser.body}\n\n${addition}`));
        }

        recordUsage(id, 'failed');
        return { ok: true, id, message: `Added to "${id}": what did not work and what did.` };
    }

    /**
     * Increment exactly one agent-reported outcome for one article use.
     *
     * When the id exists in both layers, the author layer wins because the user-layer twin
     * normally contains failure notes about that shipped article. Counting both would make
     * one use appear twice in the index.
     *
     * For author-layer articles the current content hash is also persisted, so that future
     * reads can detect whether the article was updated since the mark was recorded.
     *
     * @param {string} rawId - Article id.
     * @param {'helped'|'failed'} outcome - Result of applying the article.
     */
    function recordUsage(rawId, outcome) {
        const id = normalizeArticleId(rawId);
        if (!id) return;

        const layer = layers.find(candidate => readArticleFile(candidate.dir, id));
        if (!layer) return;

        const stats = readStats();
        const key = `${layer.name}:${id}`;
        const stored = stats[key] || { helped: 0, failed: 0 };

        if (layer.name === 'author') {
            // Refresh the content hash when recording a usage mark.
            const articleFile = readArticleFile(authorDir, id);
            if (articleFile) {
                const currentHash = contentHash(articleFile.rawText);
                // If the hash has changed since the last mark, the old counts are stale;
                // start fresh from this mark.
                if (!stored.contentHash || stored.contentHash !== currentHash) {
                    stats[key] = {
                        helped: outcome === 'helped' ? 1 : 0,
                        failed: outcome === 'failed' ? 1 : 0,
                        contentHash: currentHash
                    };
                    writeStats(stats);
                    return;
                }
                stored.contentHash = currentHash;
            }
        }

        if (outcome === 'failed') stored.failed = Number(stored.failed || 0) + 1;
        else stored.helped = Number(stored.helped || 0) + 1;
        stats[key] = stored;
        writeStats(stats);
    }

    /**
     * The general rules handed to the agent in ps_start_task.
     *
     * They are part of the program and are read from the author layer only. A rules.md in
     * the user layer is deliberately ignored: a local copy would otherwise override every
     * later release of the rules, and the person would never learn that their Helper had
     * stopped receiving them.
     *
     * When the author KB has not been downloaded yet, returns an empty string so the
     * agent gets the same "(No rules file was found…)" fallback message as before.
     *
     * @returns {string} Rules text, or an empty string when there is no rules file.
     */
    function readRules() {
        const file = path.join(authorDir, RULES_FILENAME);
        try {
            if (fs.existsSync(file)) {
                return fs.readFileSync(file, 'utf8').trim();
            }
        } catch (error) {
            logger.warn(`[knowledge-base] Could not read ${file}: ${error.message}`);
        }
        return '';
    }

    /**
     * Whether the author knowledge base exists on disk (has been downloaded or exists locally).
     *
     * @returns {boolean}
     */
    function hasAuthorBase() {
        return fs.existsSync(authorDir);
    }

    return {
        listArticles,
        formatIndex,
        readArticle,
        writeArticle,
        markHelped,
        markFailed,
        recordUsage,
        readRules,
        hasAuthorBase,
        ensureUserLayer,
        // For Helper itself and the person (the "Open the Knowledge Base Folder" menu item).
        // Never put these into anything an agent reads: the agent uses the ps_kb_ tools only.
        paths: { authorDir, userDir }
    };
}

module.exports = {
    createKnowledgeBase,
    CONFIDENCE_LEVELS,
    // Exported for testing only; these are the file format itself.
    parseArticle,
    formatArticle,
    normalizeArticleId
};
