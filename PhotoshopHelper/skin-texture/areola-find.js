'use strict';

/**
 * ps_skin_texture_find_areolas (task20): find and measure areolas, nipples and the light locally in
 * Helper, and tell the agent what to do next.
 *
 * Division of labour, agreed with the author: the agent can look at the document and understand
 * the scene (where roughly, is the edge covered, is it a tattoo), but models name exact pixel
 * coordinates poorly; Helper measures precisely but does not understand the picture. So the agent
 * passes rough positions as hints, Helper measures, and the answer carries numbers only: pixels
 * stay on this computer, which also covers a photo the person does not want any model to see.
 *
 * When to ask the person is decided from measured confidence, not from the agent's mood:
 *   apply             confident: compute and apply, report in one line what was estimated;
 *   apply_then_check  probably right: apply, then ask the person to look (one Undo removes it);
 *   ask_first         one question before computing (covered edge, unequal pair, ...);
 *   ask_for_selection nothing reliable: ask the person to select the areola, then measure that.
 * A search without hints never says "apply": a first result found without the agent's own look
 * is always checked.
 */

const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { SkinRequestError } = require('./core-adapter');
const exchangeFiles = require('./exchange-files');
const scripts = require('./uxp-scripts');
const readScript = require('./areola-read-script');
const { fitSelection } = require('./areola-detect');
const { MAX_AREOLAS } = require('./areola-geometry');

const MAX_SIDE = { image: 1600, selection: 2048 };
const TYPICAL_AREOLA_MM = 40;
const round2 = value => Math.round(value * 100) / 100;

/** Validate the tool arguments; refusals use the skin texture refusal type. */
function checkArgs(args) {
    const fail = message => { throw new SkinRequestError('INVALID_FIND_REQUEST', message); };
    const source = args.source === undefined ? 'image' : args.source;
    if (source !== 'image' && source !== 'selection') fail('source must be "image" or "selection".');
    const finite = v => typeof v === 'number' && Number.isFinite(v);
    let hints = [];
    if (args.hints !== undefined) {
        if (source !== 'image') fail('hints are used with source "image" only.');
        if (!Array.isArray(args.hints) || args.hints.length < 1 || args.hints.length > MAX_AREOLAS) fail(`hints must be 1 to ${MAX_AREOLAS} rough areola positions.`);
        hints = args.hints.map((hint, i) => {
            if (!hint || typeof hint !== 'object' || Array.isArray(hint)) fail(`hints[${i}] must be { center: [x, y], radius }.`);
            const unknown = Object.keys(hint).filter(k => !['center', 'radius'].includes(k));
            if (unknown.length) fail(`hints[${i}] has unknown fields: ${unknown.join(', ')}.`);
            if (!Array.isArray(hint.center) || hint.center.length !== 2 || !hint.center.every(finite)) fail(`hints[${i}].center must be [x, y] in document pixels.`);
            if (hint.radius !== undefined && (!finite(hint.radius) || hint.radius < 3)) fail(`hints[${i}].radius must be a rough radius in document pixels (at least 3).`);
            return hint.radius === undefined ? { center: hint.center.slice() } : { center: hint.center.slice(), radius: hint.radius };
        });
    }
    let area = null;
    if (args.area !== undefined) {
        const a = args.area;
        if (!a || typeof a !== 'object' || !['x', 'y', 'width', 'height'].every(k => Number.isInteger(a[k])) || a.width < 8 || a.height < 8) {
            fail('area must be { x, y, width, height } in integer document pixels, at least 8 x 8.');
        }
        area = { x: a.x, y: a.y, width: a.width, height: a.height };
    }
    return { source, hints, area };
}

/** Document area to read for the image search: around the hints, the given area, or everything. */
function imageBounds(document, hints, area) {
    const clip = b => ({ left: Math.max(0, Math.floor(b.left)), top: Math.max(0, Math.floor(b.top)),
        right: Math.min(document.width, Math.ceil(b.right)), bottom: Math.min(document.height, Math.ceil(b.bottom)) });
    if (area) return clip({ left: area.x, top: area.y, right: area.x + area.width, bottom: area.y + area.height });
    if (!hints.length) return { left: 0, top: 0, right: document.width, bottom: document.height };
    const boxes = hints.map(h => {
        const half = h.radius ? 2.4 * h.radius : 0.35 * Math.min(document.width, document.height);
        return { left: h.center[0] - half, top: h.center[1] - half, right: h.center[0] + half, bottom: h.center[1] + half };
    });
    return clip(boxes.reduce((u, b) => ({ left: Math.min(u.left, b.left), top: Math.min(u.top, b.top),
        right: Math.max(u.right, b.right), bottom: Math.max(u.bottom, b.bottom) })));
}

/** Run the image search (or, with `given`, the nipple and light inside known outlines) in a disposable worker. */
function analyseInWorker(samples, header, map, hints, given = null) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'areola-detect-worker.js'), {
            workerData: { samples: samples.buffer, width: header.width, height: header.height, channels: header.components, map, hints, given },
            transferList: [samples.buffer]
        });
        let answered = false;
        worker.on('message', message => {
            if (answered || !message) return;
            answered = true;
            if (message.type === 'result') resolve(message.result); else reject(new Error(message.message));
        });
        worker.once('error', reject);
        worker.once('exit', code => { if (!answered) reject(new Error(`The areola search stopped (exit code ${code}) without a result.`)); });
    });
}

/**
 * The decision and the words for the agent, from measured facts only.
 *
 * @returns {{ recommendation: string, next_step: string }}
 */
function decide(found, source, hinted) {
    const areolas = found.areolas;
    const why = [];
    let recommendation = 'apply';
    const lower = to => {
        const order = ['apply', 'apply_then_check', 'ask_first', 'ask_for_selection'];
        if (order.indexOf(to) > order.indexOf(recommendation)) recommendation = to;
    };
    if (!areolas.length) {
        lower('ask_for_selection');
        why.push(source === 'selection' ? 'the selection holds no usable part' : 'no areola edge was found');
    }
    for (const [i, a] of areolas.entries()) {
        const name = areolas.length > 1 ? `areola ${i + 1}` : 'the areola';
        if (a.confidence.level === 'low') {
            lower(source === 'selection' ? 'ask_first' : 'ask_for_selection');
            why.push(`${name}: ${a.confidence.reasons.filter(r => r.endsWith('(low)')).join('; ') || 'low confidence'}`);
        } else if (a.confidence.level === 'medium') {
            lower('apply_then_check');
            why.push(`${name}: ${a.confidence.reasons.join('; ')}`);
        }
        if (a.edge && a.edge.visible_share < 0.5) {
            lower('ask_first');
            why.push(`${name}: only ${Math.round(a.edge.visible_share * 100)}% of its edge is visible (covered or cut by the picture)`);
        }
    }
    if (areolas.length === 2) {
        const [p, q] = areolas.map(a => a.record.areola.radii[0]);
        if (Math.max(p, q) / Math.min(p, q) > 1.5) { lower('ask_first'); why.push('the two areolas differ in size more than 1.5 times'); }
    }
    // A nipple that was not found clearly gets the areola centre; the result must be looked at.
    if (areolas.some(a => !a.nipple.found)) {
        lower('apply_then_check');
        why.push(source === 'selection' ? 'the nipple was not marked (cut it out of the selection with Alt to mark it)' : 'a nipple was not found clearly');
    }
    if (source === 'image' && !hinted && areolas.length) {
        lower('apply_then_check');
        why.push('found without hints: a first result found without your own look is always checked');
    }
    const missingNipple = areolas.some(a => !a.nipple.found);
    const tail = [];
    if (missingNipple) {
        tail.push('Where the nipple was not found, its record uses the centre of the areola: after applying, hide the nipple layers of the areola groups (output "nipple" in the apply result) and say so, rather than show a nipple in the wrong place.');
    }
    tail.push(found.light.kind === 'estimated'
        ? `Light azimuth ${found.light.azimuthDeg} deg is estimated from the picture; elevation is the default.`
        : 'The light is the default 315/45 (the picture gave no reliable direction); mention it only if the person asks about the light.');
    tail.push('px_per_mm is an estimate from a typical areola: if the person knows a measure, use it instead and mark scale as measured or given. If the result\'s details look too large or too small, the person can say "larger" or "smaller" and you recompute with px_per_mm divided or multiplied by about 1.3.');
    tail.push('If the person has already corrected the areolas twice, work from their selection instead of searching again.');
    const lead = {
        apply: 'Confident. Pass fields and sources to ps_skin_texture_start and apply; afterwards tell the person in one line what was found and what was estimated.',
        apply_then_check: `Probably right (${why.join('; ')}). Compute and apply, then ask the person to look at the areolas before going on; one Undo removes the write. If the same job also computes the general skin over a large area (minutes), ask first instead.`,
        ask_first: `Not certain (${why.join('; ')}). Before computing, tell the person in one sentence what was found and ask one question: compute like this, or select the areola (Elliptical Marquee or Lasso) for an exact outline.`,
        ask_for_selection: `No reliable areola (${why.join('; ')}). Ask the person to select each areola with the Elliptical Marquee or Lasso as separate parts (cutting the nipple out of the selection with Alt marks it), then call this tool again with source "selection".`
    }[recommendation];
    return { recommendation, next_step: [lead, ...tail].join(' ') };
}

/**
 * Read the document pixels around fitted outlines and measure the nipple and light inside them.
 *
 * @returns {Promise<{areolas: object[], light: object}>}
 */
async function measureAroundSelection(transport, document, areolas, dataFolder) {
    const hints = areolas.map(a => ({ center: a.record.areola.center, radius: Math.max(...a.record.areola.radii) }));
    const fileName = readScript.newReadFileName();
    const expect = { mode: 'image', fileName, maxSide: MAX_SIDE.image, bounds: imageBounds(document, hints, null) };
    const answer = await transport.run(readScript.buildReadScript(expect), 'skin texture: read pixels around the selected areolas', 60_000);
    const read = answer && answer.result;
    if (!read || read.ok !== true) throw new Error((read && read.message) || 'Photoshop did not return the pixels');
    if (read.folder !== dataFolder) throw new Error('the plugin reported another data folder');
    const { header, samples } = readScript.takeReadFile(exchangeFiles.checkDataFolder(read.folder), read.file);
    const sb = header.sourceBounds;
    const map = { left: sb.left, top: sb.top, scaleX: (sb.right - sb.left) / header.width, scaleY: (sb.bottom - sb.top) / header.height };
    return analyseInWorker(samples, header, map, [], areolas);
}

/**
 * Run one find request for the task's document.
 *
 * @param {object} transport - { run(code, historyName, timeoutMs) } bound to the task.
 * @param {object} args - Tool arguments.
 * @returns {Promise<object>} The tool answer.
 */
async function findAreolas(transport, args) {
    const { source, hints, area } = checkArgs(args);
    const probe = await transport.run(scripts.buildProbeScript(), 'skin texture: read document', 60_000);
    const facts = probe && probe.result && probe.result.document;
    if (!facts) throw new SkinRequestError('PROBE_INVALID', 'Photoshop answered the document check with something unexpected.');
    const document = { id: facts.id, width: facts.width, height: facts.height };

    const fileName = readScript.newReadFileName();
    const expect = { mode: source, fileName, maxSide: MAX_SIDE[source] };
    if (source === 'image') expect.bounds = imageBounds(document, hints, area);
    const answer = await transport.run(readScript.buildReadScript(expect), `skin texture: read ${source} for areolas`, 60_000);
    const read = answer && answer.result;
    if (!read || read.ok !== true) {
        throw new SkinRequestError((read && read.code) || 'READ_FAILED', `${(read && read.message) || 'Photoshop did not return the pixels.'} Nothing was changed.`);
    }
    if (read.folder !== probe.result.dataFolder) {
        throw new SkinRequestError('DATA_FOLDER_CHANGED', 'The plugin reported another data folder for the read than for the document check. Nothing was changed.');
    }
    let header, samples;
    try {
        const folder = exchangeFiles.checkDataFolder(read.folder);
        ({ header, samples } = readScript.takeReadFile(folder, read.file));
    } catch (error) {
        throw new SkinRequestError('READ_FAILED', `Helper could not read the pixels Photoshop handed over: ${error.message} Nothing was changed.`);
    }
    const sb = header.sourceBounds;
    const map = { left: sb.left, top: sb.top, scaleX: (sb.right - sb.left) / header.width, scaleY: (sb.bottom - sb.top) / header.height,
        full: header.componentSize === 16 ? 32768 : 255 };

    let found;
    if (source === 'selection') {
        const fit = fitSelection(samples, header.width, header.height, map);
        found = { areolas: fit.areolas.sort((p, q) => p.record.areola.center[0] - q.record.areola.center[0]), notes: fit.notes,
            light: { azimuthDeg: 315, elevationDeg: 45, kind: 'default', note: 'default 315/45: the picture around the selection gave no reliable light direction', reasons: [] } };
        // The outline is the person's; the nipple (unless they cut it out) and the light are
        // measured on the document pixels around the selected outlines. If that second read fails,
        // the selection result stands with the default light and the nipple as marked or missing.
        if (found.areolas.length) {
            try {
                const given = await measureAroundSelection(transport, document, found.areolas, probe.result.dataFolder);
                found.areolas = given.areolas;
                found.light = given.light;
            } catch (error) {
                found.notes = [...(found.notes || []), `The nipple and light could not be measured around the selection: ${error.message}`];
            }
        }
    } else {
        found = await analyseInWorker(samples, header, map, hints);
    }

    const records = found.areolas.map(a => a.record);
    const longest = records.map(r => Math.max(...r.areola.radii));
    const scale = longest.length ? {
        px_per_mm: round2(longest.reduce((s, v) => s + (2 * v) / TYPICAL_AREOLA_MM, 0) / longest.length),
        kind: 'estimated',
        note: `from a typical areola diameter of ${TYPICAL_AREOLA_MM} mm on the long axis; real areolas vary (about 30-50 mm), so the size of fine details is an estimate`,
        range: [round2((2 * Math.min(...longest)) / 50), round2((2 * Math.max(...longest)) / 30)]
    } : null;
    const nippleFound = found.areolas.length && found.areolas.every(a => a.nipple.found);
    const sources = records.length ? {
        geometry: source === 'selection'
            ? { kind: 'given', note: 'ellipse fitted by Helper to the person\'s selection' }
            : { kind: 'measured', note: `measured by Helper on the document pixels${hints.length ? ' around the agent\'s hints' : ' without hints'}` },
        // A nipple cut out of the selection is the person's; one measured inside the outline is Helper's.
        nipple: nippleFound
            ? { kind: found.areolas.every(a => a.nipple.source === 'hole in the selection') ? 'given' : 'measured',
                note: found.areolas.map(a => a.nipple.source).join('; ') }
            : { kind: 'default', note: 'not found everywhere: centre of the areola and 0.3 of the long half-axis where missing' },
        scale: { kind: 'estimated', note: scale.note },
        light: { kind: found.light.kind, note: found.light.note }
    } : null;
    const decision = decide(found, source, hints.length > 0);
    const out = {
        source, searched: source === 'selection' ? 'the active selection' : found.searched,
        document, read_area: sb, read_size: { width: header.width, height: header.height },
        areolas: found.areolas,
        light: found.light,
        scale,
        recommendation: decision.recommendation,
        next_step: decision.next_step
    };
    if (records.length) {
        out.fields = { areolas: records };
        out.sources = sources;
    }
    if (found.notes && found.notes.length) out.notes = found.notes;
    if (Number.isFinite(found.analysisMs)) out.analysis_ms = found.analysisMs;
    return out;
}

module.exports = { findAreolas, checkArgs, imageBounds, decide };
