'use strict';

/**
 * UXP script generator for skin texture recipes.
 *
 * Implements the UXP batchPlay/DOM scripting for recipe 'skin_pair_v1':
 * - Runs inside the plugin's agentExecuteScript within a single executeAsModal scope.
 * - Reads the mask source (active selection or existing layer mask) BEFORE creating any layers.
 * - Enforces zero partial state: if mask source is missing/empty, refuses before creating Skin.
 * - Verifies all 4 exchange files (Formula 1 Pores/Microrelief, Formula 2 Pores/Microrelief).
 * - Creates the structured hierarchy:
 *     Skin [marker] (Pass Through, Opacity 100%, user mask)
 *       Formula 2 (Pass Through, Opacity 100%, visible)
 *         Pores (Linear Light, Opacity 50%, Fill 100%)
 *         Microrelief (Linear Light, Opacity 50%, Fill 100%)
 *       Formula 1 (Pass Through, Opacity 100%, hidden)
 *         Pores (Linear Light, Opacity 50%, Fill 100%)
 *         Microrelief (Linear Light, Opacity 50%, Fill 100%)
 * - Preserves target bounds for texture layers, applies single mask to Skin group.
 * - In case of any failure during creation, rolls back only the newly created layers/groups.
 */

const fs = require('node:fs');
const path = require('node:path');

const EXCHANGE_SOURCE_FILE = path.join(__dirname, 'exchange.js');
let exchangeSource = null;

function getExchangeSource() {
    if (exchangeSource === null) exchangeSource = fs.readFileSync(EXCHANGE_SOURCE_FILE, 'utf8');
    return exchangeSource;
}

// Shared document facts functions matching uxp-scripts.js
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
 * Build the UXP script for writing recipe skin_pair_v1 into Photoshop.
 *
 * @param {object} expect
 * @param {string} expect.jobId - Job identifier
 * @param {string} expect.taskId - Task identifier
 * @param {string} expect.recipe - Recipe identifier ('skin_pair_v1')
 * @param {string} expect.marker - Marker for unique job tracking
 * @param {object} expect.document - Expected document state at start
 * @param {object} expect.rect - Texture target rectangle { x, y, width, height }
 * @param {object} expect.maskSource - { kind: 'selection' } | { kind: 'layer_mask', layer_id: number }
 * @param {object[]} expect.components - Component definitions with file names
 * @param {string} expect.dataFolder - Plugin data folder
 * @param {number} expect.deadlineEpochMs - Script start deadline
 * @returns {string} Executable UXP JavaScript code
 */
function buildRecipeApplyScript(expect) {
    return `// Skin texture: write recipe ${expect.recipe} job ${expect.jobId} into the task document.
// Built by PhotoshopHelper/skin-texture/recipe-uxp-builder.js. Do not edit or resend by hand.
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

let maskImageDataToDispose = null;

try {
    // 1. Deadline check
    if (Date.now() > EXPECT.deadlineEpochMs) {
        return skinRefuse('APPLY_EXPIRED', 'The write arrived after its deadline and was not started. Nothing was changed.');
    }

    // 2. Document state verification
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

    // 3. Existing objects check by marker
    const existing = skinAllLayers(doc).filter(layer => typeof layer.name === 'string' && layer.name.indexOf(EXPECT.marker) !== -1);
    if (existing.length) {
        return skinRefuse('ALREADY_PRESENT', 'Objects of this job are already in the document. Nothing was changed.', { existingLayers: existing.map(layer => ({ id: layer.id, name: layer.name })) });
    }

    // 4. Data folder check
    const X = new Function('module', EXCHANGE_SOURCE + '\\nreturn SkinExchange;')(undefined);
    const uxp = require('uxp');
    const folder = await uxp.storage.localFileSystem.getDataFolder();
    if (folder.nativePath !== EXPECT.dataFolder) {
        return skinRefuse('DATA_FOLDER_CHANGED', 'The plugin data folder is not the one the files were written to. Nothing was changed.');
    }

    // 5. Read and decode all 4 exchange files
    let t = clock();
    const planes = {};
    for (const item of EXPECT.components) {
        let bytes;
        try {
            const entry = await folder.getEntry(item.file);
            bytes = new Uint8Array(await entry.read({ format: uxp.storage.formats.binary }));
        } catch (error) {
            return skinRefuse('EXCHANGE_READ_FAILED', 'Could not read ' + item.file + ': ' + String((error && error.message) || error) + '. Nothing was changed.');
        }
        try {
            const decoded = X.decode(bytes, {
                jobId: EXPECT.jobId,
                taskId: EXPECT.taskId,
                output: item.componentKey,
                documentId: was.id,
                document: { width: was.width, height: was.height },
                rect: EXPECT.rect
            });
            const h = decoded.header;
            if (h.recipe_id !== (item.recipeId || EXPECT.recipe)) {
                return skinRefuse('COMPONENT_HEADER_MISMATCH', 'Component ' + item.componentKey + ' has recipe_id "' + h.recipe_id + '" instead of "' + (item.recipeId || EXPECT.recipe) + '". Nothing was changed.');
            }
            if (h.formula_id !== item.formulaId) {
                return skinRefuse('COMPONENT_HEADER_MISMATCH', 'Component ' + item.componentKey + ' has formula_id "' + h.formula_id + '" instead of "' + item.formulaId + '". Nothing was changed.');
            }
            if (h.formula_version !== item.formulaVersion) {
                return skinRefuse('COMPONENT_HEADER_MISMATCH', 'Component ' + item.componentKey + ' has formula_version ' + h.formula_version + ' instead of ' + item.formulaVersion + '. Nothing was changed.');
            }
            if (!h.core || h.core.version !== item.coreVersion || h.core.sha256 !== item.coreSha256) {
                return skinRefuse('COMPONENT_HEADER_MISMATCH', 'Component ' + item.componentKey + ' core identity mismatch. Nothing was changed.');
            }
            planes[item.componentKey] = { item, gray: decoded.payload, bytes: bytes.length };
        } catch (error) {
            return skinRefuse(skinCodeOf(error), String(error.message) + '. Nothing was changed.');
        }
    }
    timings.readAndVerifyMs = Math.round(clock() - t);

    // 6. Read and verify Mask Source BEFORE creating ANY layers
    t = clock();
    let maskImageData = null;
    let maskBounds = null;
    const maskSrc = EXPECT.maskSource;

    if (!maskSrc || typeof maskSrc !== 'object') {
        return skinRefuse('INVALID_MASK_SOURCE', 'mask_source is required for recipe ' + EXPECT.recipe + '. Nothing was changed.');
    }

    if (maskSrc.kind === 'selection') {
        if (typeof doc.hasSelection === 'boolean' && !doc.hasSelection) {
            return skinRefuse('NO_SELECTION', 'The document has no active selection. Nothing was changed.');
        }
        let selObj = null;
        try {
            selObj = await imaging.getSelection({ documentID: doc.id });
        } catch (err) {
            return skinRefuse('SELECTION_READ_FAILED', 'Could not read active selection: ' + String((err && err.message) || err) + '. Nothing was changed.');
        }
        if (!selObj || !selObj.imageData) {
            return skinRefuse('NO_SELECTION', 'The document has no active selection or selection image data could not be retrieved. Nothing was changed.');
        }
        maskImageData = selObj.imageData;
        maskBounds = selObj.sourceBounds;
    } else if (maskSrc.kind === 'layer_mask') {
        if (!Number.isInteger(maskSrc.layer_id)) {
            return skinRefuse('INVALID_MASK_SOURCE', 'mask_source.layer_id must be an integer layer ID. Nothing was changed.');
        }
        const sourceLayer = skinAllLayers(doc).find(l => l.id === maskSrc.layer_id);
        if (!sourceLayer) {
            return skinRefuse('LAYER_NOT_FOUND', 'Source layer ' + maskSrc.layer_id + ' not found in document. Nothing was changed.');
        }

        // Read layer descriptor via batchPlay get to check real mask presence and enabled status
        let layerDesc = null;
        try {
            const [desc] = await action.batchPlay([{
                _obj: 'get',
                _target: [
                    { _ref: 'layer', _id: sourceLayer.id },
                    { _ref: 'document', _id: doc.id }
                ]
            }], { synchronousExecution: false });
            layerDesc = desc;
        } catch (err) {
            return skinRefuse('LAYER_READ_FAILED', 'Could not read layer descriptor for layer ' + maskSrc.layer_id + ': ' + String((err && err.message) || err) + '. Nothing was changed.');
        }

        if (!layerDesc || layerDesc.hasUserMask !== true) {
            return skinRefuse('NO_LAYER_MASK', 'Layer ' + maskSrc.layer_id + ' has no pixel layer mask. Nothing was changed.');
        }
        if (layerDesc.userMaskEnabled === false) {
            return skinRefuse('UNSUPPORTED_MASK_PROPERTIES', 'Layer mask on layer ' + maskSrc.layer_id + ' is disabled. Enable the mask before applying. Nothing was changed.');
        }
        if (sourceLayer.layerMaskDensity !== undefined && sourceLayer.layerMaskDensity !== 100) {
            return skinRefuse('UNSUPPORTED_MASK_PROPERTIES', 'Layer mask on layer ' + maskSrc.layer_id + ' has density ' + sourceLayer.layerMaskDensity + '% (expected 100%). Reset mask density before applying. Nothing was changed.');
        }
        if (sourceLayer.layerMaskFeather !== undefined && sourceLayer.layerMaskFeather !== 0) {
            return skinRefuse('UNSUPPORTED_MASK_PROPERTIES', 'Layer mask on layer ' + maskSrc.layer_id + ' has feather ' + sourceLayer.layerMaskFeather + 'px (expected 0px). Reset mask feather before applying. Nothing was changed.');
        }
        let maskObj = null;
        try {
            maskObj = await imaging.getLayerMask({ documentID: doc.id, layerID: sourceLayer.id, kind: 'user' });
        } catch (err) {
            return skinRefuse('LAYER_MASK_READ_FAILED', 'Could not read layer mask from layer ' + maskSrc.layer_id + ': ' + String((err && err.message) || err) + '. Nothing was changed.');
        }
        if (!maskObj || !maskObj.imageData) {
            return skinRefuse('NO_LAYER_MASK', 'Layer ' + maskSrc.layer_id + ' has no pixel layer mask. Nothing was changed.');
        }
        maskImageData = maskObj.imageData;
        maskBounds = maskObj.sourceBounds;
    } else {
        return skinRefuse('INVALID_MASK_SOURCE', 'Unsupported mask_source kind: ' + maskSrc.kind + '. Nothing was changed.');
    }

    maskImageDataToDispose = maskImageData;
    timings.readMaskMs = Math.round(clock() - t);

    // Snapshot expected mask pixel data for post-write bit-level verification
    let expectedMaskBytes = null;
    try {
        if (typeof maskImageData.getData === 'function') {
            expectedMaskBytes = await maskImageData.getData();
        } else if (maskImageData.data) {
            expectedMaskBytes = maskImageData.data;
        }
    } catch (e) {}
    if (!expectedMaskBytes) {
        return skinRefuse(maskSrc.kind === 'selection' ? 'SELECTION_READ_FAILED' : 'LAYER_MASK_READ_FAILED', 'Could not read the mask source pixels for verification. Nothing was changed.');
    }

    // 7. Write structure: Formula 2 (visible) & Formula 1 (hidden) inside Skin group
    const sixteen = was.bitsPerChannel === 16;
    const r = EXPECT.rect;

    async function createTexturePixelLayer(componentKey) {
        const plane = planes[componentKey];
        if (!plane) throw new Error('MISSING_COMPONENT: component ' + componentKey + ' not prepared');
        const layerTimings = {};
        let lt = clock();
        const rgba = sixteen ? X.grayToRgba16(plane.gray) : X.grayToRgba8(plane.gray);
        const options = { width: r.width, height: r.height, components: 4, chunky: true, colorSpace: 'RGB' };
        if (was.profileType !== 'none') options.colorProfile = was.profileName;
        if (sixteen) options.fullRange = false;
        const imgData = await imaging.createImageDataFromBuffer(rgba, options);
        layerTimings.imageDataMs = Math.round(clock() - lt);
        try {
            lt = clock();
            const layer = await doc.createPixelLayer({ name: plane.item.layerName });
            if (!layer || !Number.isInteger(layer.id)) throw new Error('LAYER_NOT_CREATED: createPixelLayer returned no layer');
            created.push(layer.id);
            layerTimings.createLayerMs = Math.round(clock() - lt);

            lt = clock();
            await imaging.putPixels({
                documentID: doc.id,
                layerID: layer.id,
                imageData: imgData,
                targetBounds: { left: r.x, top: r.y },
                replace: true
            });
            layerTimings.putPixelsMs = Math.round(clock() - lt);

            layer.blendMode = C.BlendMode.LINEARLIGHT;
            layer.opacity = 50;
            if (layer.fillOpacity !== undefined) layer.fillOpacity = 100;

            const b = layer.bounds;
            const bounds = b ? { left: +b.left, top: +b.top, right: +b.right, bottom: +b.bottom } : null;
            if (!bounds || bounds.left !== r.x || bounds.top !== r.y || bounds.right !== r.x + r.width || bounds.bottom !== r.y + r.height) {
                throw new Error('BOUNDS_MISMATCH: the written layer covers ' + JSON.stringify(bounds) + ' instead of the rect');
            }
            written.push({
                formulaId: plane.item.formulaId,
                output: plane.item.output,
                id: layer.id,
                name: layer.name,
                bounds,
                blendMode: String(layer.blendMode),
                opacity: layer.opacity,
                fillOpacity: layer.fillOpacity,
                timings: layerTimings
            });
            return layer;
        } finally {
            imgData.dispose();
        }
    }

    t = clock();

    // In Photoshop, each newly created layer/group is placed above the previous one.
    // Build bottom-to-top to ensure correct visual stacking order:
    // Formula 1 at bottom, Formula 2 on top; inside each formula: Microrelief below, Pores on top.

    // 1. Create Formula 1 layers (bottom-to-top: Microrelief then Pores)
    const f1MicroLayer = await createTexturePixelLayer('formula_1_furrows');
    const f1PoresLayer = await createTexturePixelLayer('formula_1_pores');
    const f1Group = await doc.createLayerGroup({
        name: 'Formula 1',
        fromLayers: [f1PoresLayer, f1MicroLayer]
    });
    created.push(f1Group.id);
    f1Group.blendMode = C.BlendMode.PASSTHROUGH;
    f1Group.opacity = 100;
    f1Group.visible = false;

    // 2. Create Formula 2 layers (bottom-to-top: Microrelief then Pores, above Formula 1)
    const f2MicroLayer = await createTexturePixelLayer('formula_2_furrows');
    const f2PoresLayer = await createTexturePixelLayer('formula_2_pores');
    const f2Group = await doc.createLayerGroup({
        name: 'Formula 2',
        fromLayers: [f2PoresLayer, f2MicroLayer]
    });
    created.push(f2Group.id);
    f2Group.blendMode = C.BlendMode.PASSTHROUGH;
    f2Group.opacity = 100;
    f2Group.visible = true;

    // 3. Create main Skin group containing Formula 2 (top) and Formula 1 (bottom)
    const skinGroup = await doc.createLayerGroup({
        name: 'Skin ' + EXPECT.marker,
        fromLayers: [f2Group, f1Group]
    });
    created.push(skinGroup.id);
    skinGroup.blendMode = C.BlendMode.PASSTHROUGH;
    skinGroup.opacity = 100;

    // 8. Put single common mask onto Skin group
    // Initialize with hideAll mask so all pixels outside maskBounds are guaranteed hidden (black).
    let maskInit = null;
    try {
        maskInit = await action.batchPlay([
            { _obj: 'select', _target: [{ _ref: 'layer', _id: skinGroup.id }], makeVisible: false },
            {
                _obj: 'make',
                at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
                new: { _class: 'channel' },
                using: { _enum: 'userMaskEnabled', _value: 'hideAll' }
            }
        ], { synchronousExecution: true });
    } catch (e) {
        throw new Error('MASK_INIT_FAILED: ' + String((e && e.message) || e));
    }
    // batchPlay may report a failed command as an { _obj: 'error' } entry instead of throwing.
    const maskInitError = (maskInit || []).find(item => item && item._obj === 'error');
    if (maskInitError) throw new Error('MASK_INIT_FAILED: ' + maskInitError.message);

    const maskTargetBounds = maskBounds ? { left: maskBounds.left, top: maskBounds.top } : { left: 0, top: 0 };
    await imaging.putLayerMask({
        documentID: doc.id,
        layerID: skinGroup.id,
        kind: 'user',
        imageData: maskImageData,
        replace: false,
        targetBounds: maskTargetBounds
    });

    // 9. Post-write mask verification on Skin group
    let verifiedMask = null;
    try {
        verifiedMask = await imaging.getLayerMask({
            documentID: doc.id,
            layerID: skinGroup.id,
            kind: 'user',
            sourceBounds: maskBounds
        });
    } catch (err) {
        throw new Error('MASK_VERIFICATION_FAILED: Could not read back created layer mask: ' + String((err && err.message) || err));
    }
    if (!verifiedMask || !verifiedMask.imageData) {
        throw new Error('MASK_WRITE_FAILED: putLayerMask did not attach user mask to Skin group');
    }

    // Verify bounds match requested source mask bounds exactly
    if (maskBounds && verifiedMask.sourceBounds) {
        const vb = verifiedMask.sourceBounds;
        if (vb.left !== maskBounds.left || vb.top !== maskBounds.top || vb.right !== maskBounds.right || vb.bottom !== maskBounds.bottom) {
            throw new Error('MASK_BOUNDS_MISMATCH: Verified mask bounds ' + JSON.stringify(vb) + ' do not match expected mask bounds ' + JSON.stringify(maskBounds));
        }
    }

    // Verify mask pixel buffer is non-empty and bit-for-bit matches expected source mask bytes
    let vData = null;
    if (typeof verifiedMask.imageData.getData === 'function') {
        vData = await verifiedMask.imageData.getData();
    } else if (verifiedMask.imageData.data) {
        vData = verifiedMask.imageData.data;
    }
    if (!vData || vData.length === 0) {
        throw new Error('MASK_EMPTY_DATA: Verified mask returned empty pixel buffer');
    }
    if (expectedMaskBytes) {
        if (vData.length !== expectedMaskBytes.length) {
            throw new Error('MASK_DATA_MISMATCH: Verified mask byte length ' + vData.length + ' does not match expected length ' + expectedMaskBytes.length);
        }
        let mismatches = 0;
        for (let i = 0; i < vData.length; i++) {
            if (vData[i] !== expectedMaskBytes[i]) {
                mismatches++;
                if (mismatches > 10) break;
            }
        }
        if (mismatches > 0) {
            throw new Error('MASK_DATA_MISMATCH: Verified mask pixel data does not match source mask data');
        }
    }

    const hasVerifiedMask = Boolean(verifiedMask && verifiedMask.imageData);
    if (typeof verifiedMask.imageData.dispose === 'function') {
        try { verifiedMask.imageData.dispose(); } catch (e) {}
    }

    // Where the texture rect lies outside the mask source, the texture shows unless the Skin mask is black there.
    const rectBounds = { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
    if (maskBounds && (rectBounds.left < maskBounds.left || rectBounds.top < maskBounds.top || rectBounds.right > maskBounds.right || rectBounds.bottom > maskBounds.bottom)) {
        const rectMask = await imaging.getLayerMask({ documentID: doc.id, layerID: skinGroup.id, kind: 'user', sourceBounds: rectBounds });
        const rectData = await rectMask.imageData.getData();
        const rb = rectMask.sourceBounds;
        rectMask.imageData.dispose();
        for (let i = 0; i < rectData.length; i++) {
            const x = rb.left + (i % (rb.right - rb.left));
            const y = rb.top + Math.floor(i / (rb.right - rb.left));
            const insideSource = x >= maskBounds.left && x < maskBounds.right && y >= maskBounds.top && y < maskBounds.bottom;
            if (!insideSource && rectData[i] !== 0) throw new Error('MASK_OUTSIDE_NOT_HIDDEN: the Skin mask is not black at ' + x + ',' + y + ', where the texture lies outside the mask source');
        }
    }

    // Verify that child groups have NO user mask attached
    for (const childGroup of [f1Group, f2Group]) {
        let childMask = null;
        try {
            childMask = await imaging.getLayerMask({ documentID: doc.id, layerID: childGroup.id, kind: 'user' });
        } catch (e) {}
        if (childMask && childMask.imageData) {
            if (typeof childMask.imageData.dispose === 'function') childMask.imageData.dispose();
            throw new Error('CHILD_MASK_UNEXPECTED: Subgroups must not have individual masks');
        }
    }

    // Verify that component layers have NO user mask attached
    for (const compLayer of written) {
        let compMask = null;
        try {
            compMask = await imaging.getLayerMask({ documentID: doc.id, layerID: compLayer.id, kind: 'user' });
        } catch (e) {}
        if (compMask && compMask.imageData) {
            if (typeof compMask.imageData.dispose === 'function') compMask.imageData.dispose();
            throw new Error('COMPONENT_MASK_UNEXPECTED: Component layers must not have individual masks');
        }
    }

    timings.createHierarchyMs = Math.round(clock() - t);
    timings.totalMs = Math.round(clock() - startedAt);

    const f2PoresInfo = written.find(w => w.output === 'formula_2_pores' || (w.formulaId === 'formula_2' && w.output === 'pores'));
    const f2MicroInfo = written.find(w => w.output === 'formula_2_furrows' || (w.formulaId === 'formula_2' && w.output === 'furrows'));
    const f1PoresInfo = written.find(w => w.output === 'formula_1_pores' || (w.formulaId === 'formula_1' && w.output === 'pores'));
    const f1MicroInfo = written.find(w => w.output === 'formula_1_furrows' || (w.formulaId === 'formula_1' && w.output === 'furrows'));

    return {
        ok: true,
        code: 'APPLIED',
        changed: true,
        jobId: EXPECT.jobId,
        recipe: EXPECT.recipe,
        documentId: doc.id,
        structure: {
            mainGroup: {
                id: skinGroup.id,
                name: skinGroup.name,
                blendMode: String(skinGroup.blendMode),
                opacity: skinGroup.opacity,
                hasUserMask: hasVerifiedMask,
                mask: {
                    source: EXPECT.maskSource,
                    bounds: maskBounds ? { left: +maskBounds.left, top: +maskBounds.top, right: +maskBounds.right, bottom: +maskBounds.bottom } : null
                }
            },
            subgroups: [
                {
                    id: f2Group.id,
                    name: f2Group.name,
                    blendMode: String(f2Group.blendMode),
                    opacity: f2Group.opacity,
                    visible: Boolean(f2Group.visible),
                    layers: [f2PoresInfo, f2MicroInfo].filter(Boolean)
                },
                {
                    id: f1Group.id,
                    name: f1Group.name,
                    blendMode: String(f1Group.blendMode),
                    opacity: f1Group.opacity,
                    visible: Boolean(f1Group.visible),
                    layers: [f1PoresInfo, f1MicroInfo].filter(Boolean)
                }
            ]
        },
        layers: written,
        timings
    };
} catch (error) {
    // Roll back only objects created in this attempt, reverse creation order
    const rolledBack = [];
    const leftover = [];
    for (const id of created.slice().reverse()) {
        try {
            const item = skinAllLayers(doc).find(other => other.id === id);
            if (item) await item.delete();
            if (skinAllLayers(doc).some(other => other.id === id)) leftover.push(id); else rolledBack.push(id);
        } catch (e) {
            leftover.push(id);
        }
    }
    const changed = created.length === 0 ? false : (leftover.length ? 'partial' : 'rolled_back');
    return {
        ok: false,
        code: skinCodeOf(error),
        message: String((error && error.message) || error),
        changed,
        jobId: EXPECT.jobId,
        createdLayerIds: created,
        rolledBack,
        leftover,
        timings
    };
} finally {
    if (maskImageDataToDispose && typeof maskImageDataToDispose.dispose === 'function') {
        try { maskImageDataToDispose.dispose(); } catch (e) {}
    }
}
`;
}

module.exports = {
    buildRecipeApplyScript
};
