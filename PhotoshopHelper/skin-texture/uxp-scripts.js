'use strict';

/**
 * The two short scripts Helper sends to Photoshop for a skin texture job, as `code` of the
 * plugin's existing agent_execute_script command.
 *
 * Both run inside the plugin's agentExecuteScript (modules/command-handlers.js), which already
 * provides what they rely on: `doc` is the task's own document even when the person looks at
 * another one; the call runs in ONE executeAsModal scope with history suspended, so all
 * changes of one call are one named History step; `require('uxp')` is the real UXP module.
 * The scripts therefore never open a modal scope of their own (a nested executeAsModal is not
 * needed), and the plugin and its WebSocket protocol stay unchanged.
 *
 * - The probe is read-only. It reports the document's identity, size, mode, depth and colour
 *   profile, and the native path of the data folder of the plugin instance that runs it.
 *   Read-only scripts add no History step (observed in task02).
 * - The apply script reads the job's exchange files from that folder, verifies them all,
 *   and writes one pixel layer per output. Everything that can be checked is checked before
 *   a layer exists; anything that fails after that deletes this script's own new layers by
 *   id (never a general Undo, which could take back the person's own work).
 */

const fs = require('node:fs');
const path = require('node:path');

const EXCHANGE_SOURCE_FILE = path.join(__dirname, 'exchange.js');

let exchangeSource = null;

/**
 * @returns {string} The text of exchange.js, which the apply script runs unchanged.
 */
function getExchangeSource() {
    if (exchangeSource === null) exchangeSource = fs.readFileSync(EXCHANGE_SOURCE_FILE, 'utf8');
    return exchangeSource;
}

// Shared helpers of both scripts, as script text. Mode, depth and profile type are compared
// with the DOM's own constants and reported as plain words, so Helper never depends on how
// an enum value happens to print.
const DOCUMENT_FACTS = `
const C = constants;
function skinDepthOf(d) {
    if (d.bitsPerChannel === C.BitsPerChannelType.EIGHT) return 8;
    if (d.bitsPerChannel === C.BitsPerChannelType.SIXTEEN) return 16;
    if (C.BitsPerChannelType.THIRTYTWO !== undefined && d.bitsPerChannel === C.BitsPerChannelType.THIRTYTWO) return 32;
    return null;
}
function skinProfileTypeOf(d) {
    if (d.colorProfileType === C.ColorProfileType.NONE) return 'none';
    if (d.colorProfileType === C.ColorProfileType.WORKING) return 'working';
    if (d.colorProfileType === C.ColorProfileType.CUSTOM) return 'custom';
    return 'unknown';
}
function skinDocumentFacts(d) {
    const profileType = skinProfileTypeOf(d);
    return {
        id: d.id,
        name: d.name,
        width: d.width,
        height: d.height,
        rgb: d.mode === C.DocumentMode.RGB,
        mode: String(d.mode),
        bitsPerChannel: skinDepthOf(d),
        bitsText: String(d.bitsPerChannel),
        profileType,
        profileName: profileType === 'none' ? null : String(d.colorProfileName)
    };
}
`;

/**
 * @returns {string} The read-only probe.
 */
function buildProbeScript() {
    return `// Skin texture: read the task document's facts and this plugin's data folder.
// Read-only; built by PhotoshopHelper/skin-texture/uxp-scripts.js.
${DOCUMENT_FACTS}
const uxp = require('uxp');
const folder = await uxp.storage.localFileSystem.getDataFolder();
const versions = {};
try { versions.photoshop = uxp.host.version; } catch (e) { versions.photoshop = null; }
try { versions.uxp = uxp.versions.uxp; } catch (e) { versions.uxp = null; }
try { versions.plugin = uxp.versions.plugin; } catch (e) { versions.plugin = null; }
return { probe: 'skin-texture-probe-1', document: skinDocumentFacts(doc), dataFolder: folder.nativePath, versions, epochMs: Date.now() };
`;
}

/**
 * Build the apply script for one attempt.
 *
 * @param {object} expect
 * @param {string} expect.jobId - Job id.
 * @param {string} expect.taskId - Task id.
 * @param {string} expect.marker - Text every layer name of this job contains.
 * @param {object} expect.document - Facts recorded at start (see the probe).
 * @param {object} expect.rect - Target rect in document pixels.
 * @param {object[]} expect.outputs - [{ output, file, layerName }] in writing order.
 * @param {string} expect.dataFolder - The data folder the files were written to.
 * @param {number} expect.deadlineEpochMs - After this moment the script refuses to start.
 * @returns {string} Script text.
 */
function buildApplyScript(expect) {
    return `// Skin texture: write job ${expect.jobId} into the task document.
// Built by PhotoshopHelper/skin-texture/uxp-scripts.js. Do not edit or resend by hand.
const EXPECT = ${JSON.stringify(expect)};
const EXCHANGE_SOURCE = ${JSON.stringify(getExchangeSource())};
${DOCUMENT_FACTS}
const clock = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? () => performance.now() : () => Date.now();
const startedAt = clock();
const timings = {};
const created = [];
const written = [];
function skinAllLayers(container, out) {
    const list = out || [];
    for (const layer of Array.from(container.layers || [])) {
        list.push(layer);
        if (layer.layers) skinAllLayers(layer, list);
    }
    return list;
}
function skinRefuse(code, message, extra) {
    return Object.assign({ ok: false, code, message, changed: false, jobId: EXPECT.jobId }, extra || {});
}
function skinCodeOf(error) {
    const text = String((error && error.message) || error);
    const match = /^([A-Z][A-Z0-9_]+):/.exec(text);
    return match ? match[1] : 'WRITE_FAILED';
}
try {
    // A command can be re-delivered after a reconnection. A write that did not start in time
    // is refused here, before anything is read or changed, so it never lands late on its own.
    if (Date.now() > EXPECT.deadlineEpochMs) {
        return skinRefuse('APPLY_EXPIRED', 'The write arrived after its deadline and was not started. Nothing was changed.');
    }
    const facts = skinDocumentFacts(doc);
    const was = EXPECT.document;
    const changes = [];
    if (facts.id !== was.id) changes.push('document id ' + facts.id + ' instead of ' + was.id);
    if (facts.width !== was.width || facts.height !== was.height) changes.push('size ' + facts.width + 'x' + facts.height + ' instead of ' + was.width + 'x' + was.height);
    if (!facts.rgb) changes.push('mode ' + facts.mode + ' instead of RGB');
    if (facts.bitsPerChannel !== was.bitsPerChannel) changes.push('depth ' + facts.bitsText + ' instead of ' + was.bitsPerChannel + ' bit');
    if (facts.profileType !== was.profileType || facts.profileName !== was.profileName) changes.push('colour profile ' + (facts.profileName || 'none') + ' instead of ' + (was.profileName || 'none'));
    if (changes.length) {
        return skinRefuse('STALE_DOCUMENT', 'The document changed since the texture was computed: ' + changes.join('; ') + '. Nothing was changed.', { document: facts });
    }
    const existing = skinAllLayers(doc).filter(layer => typeof layer.name === 'string' && layer.name.indexOf(EXPECT.marker) !== -1);
    if (existing.length) {
        return skinRefuse('ALREADY_PRESENT', 'Layers of this job are already in the document. Nothing was changed.', { existingLayers: existing.map(layer => ({ id: layer.id, name: layer.name })) });
    }

    const X = new Function('module', EXCHANGE_SOURCE + '\\nreturn SkinExchange;')(undefined);
    const uxp = require('uxp');
    const folder = await uxp.storage.localFileSystem.getDataFolder();
    if (folder.nativePath !== EXPECT.dataFolder) {
        return skinRefuse('DATA_FOLDER_CHANGED', 'The plugin data folder is not the one the files were written to. Nothing was changed.');
    }

    // Every file is read and verified before the first layer is created.
    let t = clock();
    const planes = [];
    for (const item of EXPECT.outputs) {
        let bytes;
        try {
            const entry = await folder.getEntry(item.file);
            bytes = new Uint8Array(await entry.read({ format: uxp.storage.formats.binary }));
        } catch (error) {
            return skinRefuse('EXCHANGE_READ_FAILED', 'Could not read ' + item.file + ': ' + String((error && error.message) || error) + '. Nothing was changed.');
        }
        try {
            const decoded = X.decode(bytes, { jobId: EXPECT.jobId, taskId: EXPECT.taskId, output: item.output,
                documentId: was.id, document: { width: was.width, height: was.height }, rect: EXPECT.rect });
            planes.push({ item, gray: decoded.payload, bytes: bytes.length });
        } catch (error) {
            return skinRefuse(skinCodeOf(error), String(error.message) + '. Nothing was changed.');
        }
    }
    timings.readAndVerifyMs = Math.round(clock() - t);

    const sixteen = was.bitsPerChannel === 16;
    const r = EXPECT.rect;
    for (const plane of planes) {
        const layerTimings = {};
        t = clock();
        // Data tagged with the document's own profile needs no conversion, so the numbers stay
        // exact (task02). An unmanaged 8-bit document gets untagged data. 16-bit uses the
        // reduced range 0..32768 with fullRange false, as verified in task02.
        const rgba = sixteen ? X.grayToRgba16(plane.gray) : X.grayToRgba8(plane.gray);
        const options = { width: r.width, height: r.height, components: 4, chunky: true, colorSpace: 'RGB' };
        if (was.profileType !== 'none') options.colorProfile = was.profileName;
        if (sixteen) options.fullRange = false;
        const imageData = await imaging.createImageDataFromBuffer(rgba, options);
        layerTimings.imageDataMs = Math.round(clock() - t);
        try {
            t = clock();
            const layer = await doc.createPixelLayer({ name: plane.item.layerName });
            if (!layer || !Number.isInteger(layer.id)) throw new Error('LAYER_NOT_CREATED: createPixelLayer returned no layer');
            created.push(layer.id);
            if (!skinAllLayers(doc).some(other => other.id === layer.id)) throw new Error('LAYER_NOT_IN_DOCUMENT: the new layer is not in the task document');
            layerTimings.createLayerMs = Math.round(clock() - t);
            t = clock();
            await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData,
                targetBounds: { left: r.x, top: r.y }, replace: true });
            layerTimings.putPixelsMs = Math.round(clock() - t);
            if (layer.blendMode !== C.BlendMode.NORMAL) layer.blendMode = C.BlendMode.NORMAL;
            if (layer.opacity !== 100) layer.opacity = 100;
            if (layer.fillOpacity !== undefined && layer.fillOpacity !== 100) layer.fillOpacity = 100;
            const b = layer.bounds;
            const bounds = b ? { left: +b.left, top: +b.top, right: +b.right, bottom: +b.bottom } : null;
            if (!bounds || bounds.left !== r.x || bounds.top !== r.y || bounds.right !== r.x + r.width || bounds.bottom !== r.y + r.height) {
                throw new Error('BOUNDS_MISMATCH: the written layer covers ' + JSON.stringify(bounds) + ' instead of the rect');
            }
            let parent = null;
            try { parent = layer.parent ? { id: layer.parent.id, name: layer.parent.name } : null; } catch (e) { parent = null; }
            written.push({ output: plane.item.output, id: layer.id, name: layer.name, bounds,
                blendMode: String(layer.blendMode), opacity: layer.opacity, fillOpacity: layer.fillOpacity,
                parent, timings: layerTimings });
        } finally {
            imageData.dispose();
        }
    }
    timings.totalMs = Math.round(clock() - startedAt);
    return { ok: true, code: 'APPLIED', changed: true, jobId: EXPECT.jobId, documentId: doc.id, layers: written, timings };
} catch (error) {
    // Roll back only what this script created, by id, newest first.
    const rolledBack = [];
    const leftover = [];
    for (const id of created.slice().reverse()) {
        try {
            const layer = skinAllLayers(doc).find(other => other.id === id);
            if (layer) await layer.delete();
            if (skinAllLayers(doc).some(other => other.id === id)) leftover.push(id); else rolledBack.push(id);
        } catch (e) {
            leftover.push(id);
        }
    }
    const changed = created.length === 0 ? false : (leftover.length ? 'partial' : 'rolled_back');
    return { ok: false, code: skinCodeOf(error), message: String((error && error.message) || error), changed,
        jobId: EXPECT.jobId, createdLayerIds: created, rolledBack, leftover, timings };
}
`;
}

const { buildRecipeApplyScript } = require('./recipe-uxp-builder');

module.exports = { buildProbeScript, buildApplyScript, buildRecipeApplyScript, getExchangeSource };
