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
 * @param {string} options.authorDir - Folder shipped with Helper. Read only.
 * @param {string} options.userDir - Folder the agent writes to.
 * @param {Console} [options.logger] - Destination for diagnostics.
 * @returns {object} Knowledge base.
 */
function createKnowledgeBase({ authorDir, userDir, logger = console }) {
    const layers = [
        { name: 'author', dir: authorDir, writable: false },
        { name: 'user', dir: userDir, writable: true }
    ];

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
     * Read one article file.
     *
     * @param {string} dir - Layer folder.
     * @param {string} id - Article id.
     * @returns {{meta: object, body: string}|null}
     */
    function readArticleFile(dir, id) {
        const file = path.join(articlesDir(dir), `${id}${ARTICLE_EXTENSION}`);
        try {
            if (!fs.existsSync(file)) return null;
            return parseArticle(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            logger.warn(`[knowledge-base] Could not read ${file}: ${error.message}`);
            return null;
        }
    }

    /**
     * Every article in both layers, with the descriptive metadata needed to find it.
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

                const counters = stats[`${layer.name}:${id}`] || {};
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
                    helped: Number(article.meta.helped || 0) + Number(counters.helped || 0),
                    failed: Number(article.meta.failed || 0) + Number(counters.failed || 0)
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
     * @returns {string} Plain text index.
     */
    function formatIndex() {
        const entries = listArticles();
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

            const counters = stats[`${layer.name}:${id}`] || {};
            const helped = Number(article.meta.helped || 0) + Number(counters.helped || 0);
            const failed = Number(article.meta.failed || 0) + Number(counters.failed || 0);

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

        if (inUser) {
            const meta = { ...inUser.meta, id: inUser.meta.id || id };
            writeFileAtomic(file, formatArticle(meta, `${inUser.body}\n\n${addition}`));
        } else {
            const meta = {
                id,
                title: inAuthor.meta.title || id,
                problem: inAuthor.meta.problem || inAuthor.meta.title || id,
                confidence: 'agent-written',
                task: taskId || '',
                photoshop: inAuthor.meta.photoshop || 'unknown',
                date: stamp,
                note_on: 'author-layer article of the same id',
                helped: 0,
                failed: 0
            };
            writeFileAtomic(file, formatArticle(meta, addition));
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
        const counters = stats[key] || { helped: 0, failed: 0 };
        if (outcome === 'failed') counters.failed = Number(counters.failed || 0) + 1;
        else counters.helped = Number(counters.helped || 0) + 1;
        stats[key] = counters;
        writeStats(stats);
    }

    /**
     * The general rules handed to the agent in ps_start_task. They are text, not code, so
     * they can be corrected without releasing Helper. A copy in the user layer wins.
     *
     * @returns {string} Rules text, or an empty string when there is no rules file.
     */
    function readRules() {
        for (const layer of [layers[1], layers[0]]) {
            const file = path.join(layer.dir, RULES_FILENAME);
            try {
                if (fs.existsSync(file)) {
                    return fs.readFileSync(file, 'utf8').trim();
                }
            } catch (error) {
                logger.warn(`[knowledge-base] Could not read ${file}: ${error.message}`);
            }
        }
        return '';
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
