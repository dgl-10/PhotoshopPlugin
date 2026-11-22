'use strict';

/**
 * Test doubles for the skin texture tests: a fake Photoshop plugin that runs the real scripts
 * Helper builds, the way the plugin's agentExecuteScript runs them, and a harness that wires
 * the real task registry, tool layer and job manager to it.
 *
 * The fake models the layer-tree behavior that the scripts depend on: context-sensitive
 * native creation, active-layer selection, explicit Layer.move placement, Photoshop history
 * restoration, the Imaging API calls, and the plugin's data folder. It is a regression model
 * for script logic, not evidence about Photoshop itself; the real reads are in the task03
 * practical check.
 *
 * Not a test file itself (no .test.js suffix), so `npm test` does not run it on its own.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentTools } = require('../agent/mcp-tools');
const { createTaskSession } = require('../agent/task-session');
const { createKnowledgeBase } = require('../agent/knowledge-base');
const { createSkinTextureJobs } = require('../skin-texture/job-manager');

const CONSTANTS = Object.freeze({
    BitsPerChannelType: { EIGHT: 'bitDepth8', SIXTEEN: 'bitDepth16', THIRTYTWO: 'bitDepth32' },
    ColorProfileType: { NONE: 'none', WORKING: 'working', CUSTOM: 'custom' },
    DocumentMode: { RGB: 'RGBColorMode', CMYK: 'CMYKColorMode', GRAYSCALE: 'grayscaleMode' },
    BlendMode: { NORMAL: 'normal', LINEARLIGHT: 'linearLight', PASSTHROUGH: 'passThrough' },
    LayerKind: { NORMAL: 'pixel', GROUP: 'group' },
    ElementPlacement: { PLACEINSIDE: 'placeInside', PLACEBEFORE: 'placeBefore', PLACEAFTER: 'placeAfter' }
});

const BITS = { 8: CONSTANTS.BitsPerChannelType.EIGHT, 16: CONSTANTS.BitsPerChannelType.SIXTEEN, 32: CONSTANTS.BitsPerChannelType.THIRTYTWO };

/**
 * @param {object} options
 * @param {string} options.dataFolder - Real folder standing in for the plugin's data folder.
 * @param {object} [options.document] - { id, name, width, height, bits, profileType, profileName, mode }.
 * @returns {object} The fake.
 */
function createFakePhotoshop({ dataFolder, document = {} }) {
    let nextLayerId = 100;
    // Set after the primary fake document has been constructed; helper closures use it later.
    let doc = null;
    const state = {
        connected: true,
        runtimeId: 'uxp-runtime-1',
        closed: false,
        busy: false,
        scripts: [],
        historySteps: [],
        lastScriptValue: null,
        imageDataCreated: 0,
        imageDataDisposed: 0,
        putPixelsCalls: 0,
        failPutPixelsOnCall: null,
        failCreateImageDataOnCall: null,
        failDeleteIds: new Set(),
        // task20: fail the putLayerMask call with this 1-based number, or on a layer of this name.
        failPutLayerMaskOnCall: null,
        failPutLayerMaskOnLayerName: null,
        // task20: synthetic RGB picture the Imaging getPixels reads: { width, height, data } chunky
        // 8-bit RGB in document coordinates (origin 0,0), or null when a test supplies none.
        documentPixels: null,
        // task20: 8 or 16; 16 makes getSelection answer Photoshop's 0..32768 range as Uint16Array.
        selectionComponentSize: 8,
        getPixelsCalls: 0,
        failAllDeletes: false,
        // Optional one-shot host side effect used to test the original-scene mutation guard.
        mutateExistingLayerOnMaskRead: null,
        nestedModalCalls: 0,
        // (payload) => Promise|void, before the script runs: delay, tamper with files, throw.
        beforeScript: null,
        // (answer, payload) => answer, after it ran: replace or throw.
        afterScript: null
    };

    function findLayerById(id, list = doc.layers) {
        for (const l of list) {
            if (l.id === id) return l;
            if (l.layers) {
                const found = findLayerById(id, l.layers);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Find a layer by its display name in a nested Layers panel tree.
     *
     * @param {string} name - The exact layer name to find.
     * @param {object[]} [list] - The current sibling list to search.
     * @returns {object|null} The matching fake layer, if present.
     */
    function findLayerByName(name, list = doc.layers) {
        for (const layer of list) {
            if (layer.name === name) return layer;
            if (layer.layers) {
                const found = findLayerByName(name, layer.layers);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Return the live sibling array that owns a layer, preserving Photoshop's nested tree.
     *
     * @param {object} layer - The layer whose containing list is needed.
     * @returns {object[]} The parent group's children or the document's root layers.
     */
    function siblingListFor(layer) {
        return layer.parent && Array.isArray(layer.parent.layers) ? layer.parent.layers : doc.layers;
    }

    /**
     * Remove a layer from its current parent without changing any other layer properties.
     *
     * @param {object} layer - The layer to detach from its current list.
     */
    function detachLayer(layer) {
        const siblings = siblingListFor(layer);
        const index = siblings.indexOf(layer);
        if (index >= 0) siblings.splice(index, 1);
        layer.parent = null;
    }

    /**
     * Insert a newly created Photoshop layer at the current active layer context.
     *
     * A selected group receives new content inside itself. A selected pixel layer receives
     * new content as a sibling in the same parent, directly above that selected layer.
     * This context-sensitive default is the behavior the recipe script must not rely on.
     *
     * @param {object} layer - The new layer to insert.
     */
    function insertAtActiveContext(layer) {
        const active = doc.activeLayers && doc.activeLayers[0];
        let parent = null;
        let siblings = doc.layers;
        let index = 0;

        if (active && active.kind === 'group') {
            parent = active;
            siblings = active.layers;
            index = 0;
        } else if (active) {
            parent = active.parent || null;
            siblings = siblingListFor(active);
            const activeIndex = siblings.indexOf(active);
            index = activeIndex < 0 ? 0 : activeIndex;
        }

        siblings.splice(index, 0, layer);
        layer.parent = parent;
        doc.activeLayers = [layer];
        doc.changedInScript = true;
    }

    /**
     * Copy the state needed to emulate one native Photoshop history checkpoint.
     *
     * @returns {object} A plain snapshot that does not retain mutable layer properties.
     */
    function captureHistoryState(targetDoc = doc) {
        function captureLayer(layer) {
            return {
                id: layer.id,
                name: layer.name,
                kind: layer.kind,
                visible: layer.visible,
                opacity: layer.opacity,
                fillOpacity: layer.fillOpacity,
                blendMode: layer.blendMode,
                layerSectionExpanded: layer.layerSectionExpanded,
                mask: layer.mask ? {
                    width: layer.mask.width,
                    height: layer.mask.height,
                    data: layer.mask.data ? layer.mask.data.slice() : null,
                    outside: layer.mask.outside,
                    bounds: layer.mask.bounds ? { ...layer.mask.bounds } : null
                } : null,
                pixels: layer.pixels ? {
                    ...layer.pixels,
                    data: layer.pixels.data ? layer.pixels.data.slice() : null
                } : null,
                userMaskEnabled: layer._userMaskEnabled,
                layerMaskDensity: layer.layerMaskDensity,
                layerMaskFeather: layer.layerMaskFeather,
                children: layer.layers ? layer.layers.map(captureLayer) : null
            };
        }

        return {
            __fakePhotoshopHistoryState: true,
            layers: targetDoc.layers.map(captureLayer),
            activeLayerIds: (targetDoc.activeLayers || []).map(layer => layer.id)
        };
    }

    /**
     * Restore a history snapshot while preserving object identity for layers that existed
     * before the script. This makes tests able to detect if rollback deleted an old object.
     *
     * @param {object} snapshot - A value returned by captureHistoryState().
     */
    function restoreHistoryState(snapshot, targetDoc = doc) {
        const existing = new Map();
        function indexExisting(layers) {
            for (const layer of layers) {
                existing.set(layer.id, layer);
                if (layer.layers) indexExisting(layer.layers);
            }
        }
        indexExisting(skinAllLayers(targetDoc));

        function restoreLayer(saved, parent) {
            const layer = existing.get(saved.id) || makeLayer(targetDoc, saved.name, saved.kind);
            layer.name = saved.name;
            layer.kind = saved.kind;
            layer.visible = saved.visible;
            layer.opacity = saved.opacity;
            layer.fillOpacity = saved.fillOpacity;
            layer.blendMode = saved.blendMode;
            layer.layerSectionExpanded = saved.layerSectionExpanded;
            layer.parent = parent;
            layer.mask = saved.mask ? {
                width: saved.mask.width,
                height: saved.mask.height,
                data: saved.mask.data ? saved.mask.data.slice() : null,
                outside: saved.mask.outside,
                bounds: saved.mask.bounds ? { ...saved.mask.bounds } : null
            } : null;
            layer.pixels = saved.pixels ? {
                ...saved.pixels,
                data: saved.pixels.data ? saved.pixels.data.slice() : null
            } : null;
            layer._userMaskEnabled = saved.userMaskEnabled;
            layer.layerMaskDensity = saved.layerMaskDensity;
            layer.layerMaskFeather = saved.layerMaskFeather;
            if (saved.children) layer.layers = saved.children.map(child => restoreLayer(child, layer));
            return layer;
        }

        targetDoc.layers = snapshot.layers.map(layer => restoreLayer(layer, null));
        function findInRestoredTree(id, layers) {
            for (const layer of layers) {
                if (layer.id === id) return layer;
                if (layer.layers) {
                    const found = findInRestoredTree(id, layer.layers);
                    if (found) return found;
                }
            }
            return null;
        }
        targetDoc.activeLayers = snapshot.activeLayerIds
            .map(id => findInRestoredTree(id, targetDoc.layers))
            .filter(Boolean);
        targetDoc.changedInScript = false;
    }

    // A one-shot hook models host side effects that happen during mask readback, such as
    // an indirect native visibility change. The real apply script must catch this by comparing
    // the original scene and restore its starting Photoshop history state.
    function applyMaskReadSideEffect() {
        const effect = state.mutateExistingLayerOnMaskRead;
        if (!effect || effect.applied) return;
        const layer = findLayerById(effect.layerId);
        if (!layer) return;
        layer[effect.property] = effect.value;
        effect.applied = true;
    }

    function makeLayer(doc, name, kind = 'pixel', props = {}) {
        const layer = {
            id: nextLayerId++,
            name,
            kind,
            blendMode: kind === 'group' ? CONSTANTS.BlendMode.PASSTHROUGH : CONSTANTS.BlendMode.NORMAL,
            opacity: 100,
            fillOpacity: 100,
            visible: true,
            layerSectionExpanded: kind === 'group' ? (props.layerSectionExpanded !== undefined ? props.layerSectionExpanded : true) : undefined,
            parent: null,
            pixels: null,
            mask: props.mask ? {
                width: props.mask.width || 100,
                height: props.mask.height || 100,
                data: props.mask.data || null,
                bounds: props.mask.bounds || { left: 0, top: 0, right: 100, bottom: 100 }
            } : null,
            _userMaskEnabled: props.userMaskEnabled !== undefined ? props.userMaskEnabled : (props._userMaskEnabled !== undefined ? props._userMaskEnabled : true),
            layerMaskDensity: props.layerMaskDensity !== undefined ? props.layerMaskDensity : 100,
            layerMaskFeather: props.layerMaskFeather !== undefined ? props.layerMaskFeather : 0,
            layers: kind === 'group' ? [] : undefined,
            get bounds() {
                if (kind === 'group') {
                    if (!this.layers || !this.layers.length) return { left: 0, top: 0, right: 0, bottom: 0 };
                    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
                    for (const child of this.layers) {
                        const b = child.bounds;
                        if (b.left < left) left = b.left;
                        if (b.top < top) top = b.top;
                        if (b.right > right) right = b.right;
                        if (b.bottom > bottom) bottom = b.bottom;
                    }
                    return { left: isFinite(left) ? left : 0, top: isFinite(top) ? top : 0, right: isFinite(right) ? right : 0, bottom: isFinite(bottom) ? bottom : 0 };
                }
                if (!this.pixels) return { left: 0, top: 0, right: 0, bottom: 0 };
                const p = this.pixels;
                return { left: p.left, top: p.top, right: p.left + p.width, bottom: p.top + p.height };
            },
            async delete() {
                if (state.failAllDeletes || state.failDeleteIds.has(layer.id)) throw new Error('The layer could not be deleted');
                if (layer.parent && Array.isArray(layer.parent.layers)) {
                    layer.parent.layers = layer.parent.layers.filter(other => other !== layer);
                } else {
                    doc.layers = doc.layers.filter(other => other !== layer);
                }
                doc.changedInScript = true;
            },
            async move(relativeObject, placement) {
                if (!relativeObject || relativeObject.id === layer.id) {
                    throw new Error('Layer.move requires a different relative layer');
                }

                if (placement === CONSTANTS.ElementPlacement.PLACEINSIDE) {
                    if (relativeObject.kind !== 'group' || !Array.isArray(relativeObject.layers)) {
                        throw new Error('PLACEINSIDE requires a group layer');
                    }
                    for (let ancestor = relativeObject; ancestor; ancestor = ancestor.parent) {
                        if (ancestor === layer) throw new Error('A group cannot be moved inside itself');
                    }
                    detachLayer(layer);
                    // PLACEINSIDE inserts at the top of the target group's child stack.
                    relativeObject.layers.unshift(layer);
                    layer.parent = relativeObject;
                } else if (placement === CONSTANTS.ElementPlacement.PLACEBEFORE
                    || placement === CONSTANTS.ElementPlacement.PLACEAFTER) {
                    detachLayer(layer);
                    const siblings = siblingListFor(relativeObject);
                    const targetIndex = siblings.indexOf(relativeObject);
                    if (targetIndex < 0) throw new Error('Relative layer is not in its parent list');
                    const offset = placement === CONSTANTS.ElementPlacement.PLACEAFTER ? 1 : 0;
                    siblings.splice(targetIndex + offset, 0, layer);
                    layer.parent = relativeObject.parent || null;
                } else {
                    throw new Error('Unsupported ElementPlacement value: ' + placement);
                }

                doc.changedInScript = true;
            }
        };
        return layer;
    }

    function makeDocument(spec) {
        const bits = spec.bits || 8;
        const profileType = spec.profileType || 'working';
        const doc = {
            id: spec.id === undefined ? 7 : spec.id,
            name: spec.name || 'portrait-copy.psd',
            width: spec.width || 600,
            height: spec.height || 400,
            mode: spec.mode || CONSTANTS.DocumentMode.RGB,
            bitsPerChannel: BITS[bits],
            colorProfileType: CONSTANTS.ColorProfileType[profileType.toUpperCase()],
            colorProfileName: profileType === 'none' ? 'None' : (spec.profileName || 'sRGB IEC61966-2.1'),
            hasSelection: spec.hasSelection !== undefined ? spec.hasSelection : true,
            selection: spec.selection !== undefined ? spec.selection : { x: 0, y: 0, width: spec.width || 600, height: spec.height || 400 },
            layers: [],
            activeLayers: [],
            changedInScript: false,
            async createPixelLayer({ name }) {
                const layer = makeLayer(doc, name, 'pixel');
                insertAtActiveContext(layer);
                return layer;
            },
            async createLayerGroup({ name, opacity = 100, blendMode = CONSTANTS.BlendMode.PASSTHROUGH, fromLayers } = {}) {
                const group = makeLayer(doc, name, 'group');
                group.blendMode = blendMode;
                group.opacity = opacity;
                if (state.unexpectedChildMaskOnGroupName === name || (state.unexpectedChildMask && name === 'Formula 1')) {
                    group.mask = { width: 10, height: 10, bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
                }
                insertAtActiveContext(group);
                if (Array.isArray(fromLayers)) {
                    for (const l of fromLayers) {
                        await l.move(group, CONSTANTS.ElementPlacement.PLACEINSIDE);
                    }
                }
                return group;
            }
        };

        function buildLayer(entry, parent) {
            const layer = makeLayer(doc, entry.name || 'Layer', entry.kind || 'pixel', entry);
            if (entry.visible !== undefined) layer.visible = entry.visible;
            if (entry.opacity !== undefined) layer.opacity = entry.opacity;
            if (entry.fillOpacity !== undefined) layer.fillOpacity = entry.fillOpacity;
            if (entry.blendMode !== undefined) layer.blendMode = entry.blendMode;
            layer.parent = parent || null;
            if (layer.kind === 'group') {
                layer.layers = (entry.children || []).map(child => buildLayer(child, layer));
            }
            return layer;
        }

        if (Array.isArray(spec.layerTree)) {
            doc.layers = spec.layerTree.map(entry => buildLayer(entry, null));
        } else {
            const background = makeLayer(doc, 'Background');
            doc.layers.push(background);
        }
        const initialActive = spec.activeLayerName
            ? findLayerByName(spec.activeLayerName, doc.layers)
            : doc.layers[0];
        doc.activeLayers = initialActive ? [initialActive] : [];
        let activeHistoryState = spec.historyAvailable === true ? captureHistoryState(doc) : null;
        if (spec.historyAvailable === true) {
            Object.defineProperty(doc, 'activeHistoryState', {
                enumerable: true,
                get() { return activeHistoryState; },
                set(snapshot) {
                    if (!snapshot || snapshot.__fakePhotoshopHistoryState !== true) {
                        throw new Error('Unsupported fake Photoshop history state');
                    }
                    restoreHistoryState(snapshot, doc);
                    activeHistoryState = snapshot;
                }
            });
        }
        // History is optional in the fake. Most tests retain the older delete-created fallback;
        // focused rollback tests opt in to model Photoshop's native history-state restoration.
        doc._beginHistoryStep = () => {
            if (spec.historyAvailable === true) activeHistoryState = captureHistoryState(doc);
        };
        doc._commitHistoryStep = () => {
            if (spec.historyAvailable === true) activeHistoryState = captureHistoryState(doc);
        };
        return doc;
    }

    /**
     * Reusable recursive walk for the history snapshot helpers above.
     *
     * @param {object} container - The document or a group layer.
     * @returns {object[]} All layers in depth-first order.
     */
    function skinAllLayers(container) {
        const result = [];
        for (const layer of Array.from(container.layers || [])) {
            result.push(layer);
            if (layer.layers) result.push(...skinAllLayers(layer));
        }
        return result;
    }

    doc = makeDocument(document);

    // task20: UXP's Selection API, doc.selection.bounds = {left, top, right, bottom} or null. The
    // selection object stays the plain test spec ({x, y, width, height, data}); the getter hands
    // the script a view of it with the tight bounds of the selected cells (the rectangle when the
    // spec has no mask data). Tests still assign doc.selection = {...} as before.
    let rawSelection = doc.selection;
    const boundsCache = new WeakMap();
    // task20, measured in Photoshop on 21 November 2026 (task20-output/live/23-format.json): in a
    // 16-bit document getLayerMask answers Photoshop's 0..32768 range as Uint16Array, but
    // getSelection still answers 8-bit values (Uint8Array, 255 = selected). 8-bit documents use
    // Uint8Array for both. (state.selectionComponentSize = 16 makes getSelection answer 16-bit
    // values, to exercise code that must accept either.)
    const wideDocument = () => doc.bitsPerChannel === CONSTANTS.BitsPerChannelType.SIXTEEN;
    const to16 = v => Math.round(v * 32768 / 255);
    function selectionRect(s) {
        const left = s.left !== undefined ? s.left : (s.x || 0);
        const top = s.top !== undefined ? s.top : (s.y || 0);
        return { left, top, width: s.width || doc.width, height: s.height || doc.height };
    }
    function selectionBounds(s) {
        if (boundsCache.has(s)) return boundsCache.get(s);
        const r = selectionRect(s);
        let b = { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
        if (s.data) {
            let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
            for (let y = 0; y < r.height; y++) {
                for (let x = 0; x < r.width; x++) {
                    if (!s.data[y * r.width + x]) continue;
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
            }
            b = x1 < 0 ? null : { left: r.left + x0, top: r.top + y0, right: r.left + x1 + 1, bottom: r.top + y1 + 1 };
        }
        boundsCache.set(s, b);
        return b;
    }
    Object.defineProperty(doc, 'selection', {
        enumerable: true,
        configurable: true,
        get() {
            if (!rawSelection) return rawSelection;
            return Object.create(rawSelection, {
                bounds: { enumerable: true, get: () => (doc.hasSelection ? selectionBounds(rawSelection) : null) }
            });
        },
        set(value) { rawSelection = value; }
    });

    /**
     * Area-average resampling of a window of a source grid, the way Imaging's targetSize reads a
     * region at a reduced size. Cells outside the source take `outside`.
     *
     * @param {(x: number, y: number, c: number) => number} at - Source value at document pixel x, y.
     * @param {{left: number, top: number, right: number, bottom: number}} window - Source window.
     * @param {{width: number, height: number}} target - Result grid.
     * @param {number} components - Values per cell.
     * @returns {Float64Array} Chunky averaged values.
     */
    function resampleWindow(at, window, target, components) {
        const sw = window.right - window.left, sh = window.bottom - window.top;
        const out = new Float64Array(target.width * target.height * components);
        for (let ty = 0; ty < target.height; ty++) {
            const ya = window.top + ty * sh / target.height, yb = window.top + (ty + 1) * sh / target.height;
            const y0 = Math.floor(ya), y1 = Math.max(y0 + 1, Math.ceil(yb));
            for (let tx = 0; tx < target.width; tx++) {
                const xa = window.left + tx * sw / target.width, xb = window.left + (tx + 1) * sw / target.width;
                const x0 = Math.floor(xa), x1 = Math.max(x0 + 1, Math.ceil(xb));
                for (let c = 0; c < components; c++) {
                    let sum = 0;
                    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += at(x, y, c);
                    out[(ty * target.width + tx) * components + c] = sum / ((x1 - x0) * (y1 - y0));
                }
            }
        }
        return out;
    }
    const other = makeDocument({ id: 99, name: 'another.psd', width: 300, height: 300 });
    const app = { documents: [doc, other], activeDocument: other };

    const imaging = {
        async getSelection(options) {
            state.getSelectionCalls = (state.getSelectionCalls || 0) + 1;
            if (!doc.hasSelection || !doc.selection) return null;
            const s = doc.selection;
            const w = s.width || doc.width;
            const h = s.height || doc.height;
            if (options && options.sourceBounds) {
                // task20: a window of the selection, optionally reduced to targetSize (UXP Imaging
                // getSelection). Cells outside the supplied mask are not selected.
                const win = options.sourceBounds;
                const r = selectionRect(s);
                const target = options.targetSize || { width: win.right - win.left, height: win.bottom - win.top };
                const avg = resampleWindow((x, y) => {
                    const mx = x - r.left, my = y - r.top;
                    if (mx < 0 || my < 0 || mx >= r.width || my >= r.height) return 0;
                    return s.data ? s.data[my * r.width + mx] : 255;
                }, win, target, 1);
                const wide = state.selectionComponentSize === 16;
                const values = wide ? new Uint16Array(avg.length) : new Uint8Array(avg.length);
                for (let i = 0; i < avg.length; i++) values[i] = wide ? Math.round(avg[i] * 32768 / 255) : Math.round(avg[i]);
                state.imageDataCreated += 1;
                return {
                    imageData: {
                        width: target.width, height: target.height, components: 1, data: values,
                        getData: async () => values,
                        dispose() { state.imageDataDisposed += 1; }
                    },
                    sourceBounds: { left: win.left, top: win.top, right: win.right, bottom: win.bottom }
                };
            }
            state.imageDataCreated += 1;
            let wholeData = s.data || new Uint8Array(w * h).fill(255);
            if (state.selectionComponentSize === 16) wholeData = Uint16Array.from(wholeData, to16);
            return {
                imageData: {
                    width: w,
                    height: h,
                    components: 1,
                    data: wholeData,
                    getData: async () => wholeData,
                    dispose() { state.imageDataDisposed += 1; }
                },
                sourceBounds: {
                    left: s.left !== undefined ? s.left : (s.x || 0),
                    top: s.top !== undefined ? s.top : (s.y || 0),
                    right: (s.left !== undefined ? s.left : (s.x || 0)) + w,
                    bottom: (s.top !== undefined ? s.top : (s.y || 0)) + h
                }
            };
        },
        // task20: the composite of a window of the synthetic picture in state.documentPixels as 8-bit
        // RGB, optionally reduced to targetSize. Options it does not model (colour profile,
        // applyAlpha) are accepted and ignored; componentSize other than 8 is refused.
        async getPixels(options = {}) {
            state.getPixelsCalls += 1;
            const source = state.documentPixels;
            if (!source) throw new Error('The fake has no synthetic picture: set fake.state.documentPixels');
            if (options.componentSize !== undefined && options.componentSize !== 8) throw new Error('The fake reads 8-bit pixels only');
            const win = options.sourceBounds || { left: 0, top: 0, right: doc.width, bottom: doc.height };
            const target = options.targetSize || { width: win.right - win.left, height: win.bottom - win.top };
            const avg = resampleWindow((x, y, c) => {
                const cx = Math.min(source.width - 1, Math.max(0, x)), cy = Math.min(source.height - 1, Math.max(0, y));
                return source.data[(cy * source.width + cx) * 3 + c];
            }, win, target, 3);
            const values = new Uint8Array(avg.length);
            for (let i = 0; i < avg.length; i++) values[i] = Math.round(avg[i]);
            state.imageDataCreated += 1;
            return {
                imageData: {
                    width: target.width, height: target.height, components: 3, data: values,
                    getData: async () => values,
                    dispose() { state.imageDataDisposed += 1; }
                },
                sourceBounds: { left: win.left, top: win.top, right: win.right, bottom: win.bottom }
            };
        },
        async getLayerMask({ documentID, layerID, kind, sourceBounds }) {
            state.getLayerMaskCalls = (state.getLayerMaskCalls || 0) + 1;
            const layer = findLayerById(layerID);
            applyMaskReadSideEffect();
            if (!layer || !layer.mask) return null;
            if (state.corruptVerifiedMaskOnLayerId === layerID) {
                return {
                    imageData: null,
                    sourceBounds: { left: 0, top: 0, right: 0, bottom: 0 }
                };
            }
            if (state.corruptVerifiedMaskBounds || state.corruptVerifiedMaskBoundsOnLayerId === layerID) {
                state.imageDataCreated += 1;
                return {
                    imageData: {
                        width: 1,
                        height: 1,
                        components: 1,
                        data: new Uint8Array(1),
                        getData: async () => new Uint8Array(1),
                        dispose() { state.imageDataDisposed += 1; }
                    },
                    sourceBounds: { left: 9999, top: 9999, right: 10000, bottom: 10000 }
                };
            }
            const m = layer.mask;
            // In real Photoshop, getLayerMask with sourceBounds extracts that ROI. Without sourceBounds, it returns the whole document canvas.
            let returnedBounds;
            let width;
            let height;
            let maskData;

            if (sourceBounds) {
                returnedBounds = { left: sourceBounds.left, top: sourceBounds.top, right: sourceBounds.right, bottom: sourceBounds.bottom };
                width = sourceBounds.right - sourceBounds.left;
                height = sourceBounds.bottom - sourceBounds.top;
            } else {
                returnedBounds = { left: 0, top: 0, right: doc.width, bottom: doc.height };
                width = doc.width;
                height = doc.height;
            }

            if (state.corruptVerifiedMaskEmptyData) {
                maskData = new Uint8Array(0);
            } else if (state.corruptVerifiedMaskData || state.corruptVerifiedMaskDataOnLayerId === layerID) {
                maskData = new Uint8Array(width * height).fill(42);
            } else {
                // Sample the mask like a canvas: the written patch inside m.bounds, m.outside elsewhere
                // (255 by default: Photoshop leaves a new mask white outside a putLayerMask patch, live-11).
                const wideMask = wideDocument();
                maskData = wideMask ? new Uint16Array(width * height) : new Uint8Array(width * height);
                // Stored patch values are in the unit they were written in: 8-bit, or 0..32768 when
                // the patch is a Uint16Array. Everything else is 8-bit and converted when read wide.
                const patchIsWide = m.data instanceof Uint16Array;
                const unit = v => (wideMask && !patchIsWide ? to16(v) : v);
                const b = m.bounds;
                for (let i = 0; i < maskData.length; i++) {
                    const x = returnedBounds.left + (i % width);
                    const y = returnedBounds.top + Math.floor(i / width);
                    const inPatch = b && x >= b.left && x < b.right && y >= b.top && y < b.bottom;
                    maskData[i] = inPatch
                        ? unit(m.data ? m.data[(y - b.top) * (b.right - b.left) + (x - b.left)] : 255)
                        : (wideMask ? to16(m.outside === undefined ? 255 : m.outside) : (m.outside === undefined ? 255 : m.outside));
                }
            }

            state.imageDataCreated += 1;
            return {
                imageData: {
                    width,
                    height,
                    components: 1,
                    data: maskData,
                    getData: async () => maskData,
                    dispose() { state.imageDataDisposed += 1; }
                },
                sourceBounds: returnedBounds
            };
        },
        async putLayerMask({ documentID, layerID, kind = 'user', imageData, replace = true, targetBounds }) {
            state.putLayerMaskCalls = (state.putLayerMaskCalls || 0) + 1;
            if (state.silentFailPutLayerMask) return;
            if (state.failPutLayerMask) throw new Error('putLayerMask simulated failure');
            if (state.failPutLayerMaskOnCall === state.putLayerMaskCalls) throw new Error('putLayerMask simulated failure on call ' + state.putLayerMaskCalls);
            const layer = findLayerById(layerID);
            if (state.failPutLayerMaskOnLayerName && layer && layer.name === state.failPutLayerMaskOnLayerName) {
                throw new Error('putLayerMask simulated failure on ' + layer.name);
            }
            if (!layer) throw new Error('Layer not found: ' + layerID);
            layer.layerMaskDensity = 100;
            layer.layerMaskFeather = 0;
            layer._userMaskEnabled = true;
            let maskBytes = null;
            if (imageData.data) {
                maskBytes = imageData.data.slice();
            } else if (typeof imageData.getData === 'function') {
                maskBytes = await imageData.getData();
            }
            layer.mask = {
                width: imageData.width,
                height: imageData.height,
                // replace: false writes into the existing mask, so its colour outside the patch stays.
                outside: replace === false && layer.mask ? layer.mask.outside : 255,
                data: maskBytes ? maskBytes.slice() : null,
                bounds: targetBounds ? { ...targetBounds, right: targetBounds.left + imageData.width, bottom: targetBounds.top + imageData.height } : { left: 0, top: 0, right: imageData.width, bottom: imageData.height }
            };
            doc.changedInScript = true;
        },
        async createImageDataFromBuffer(data, options) {
            state.createImageDataCalls = (state.createImageDataCalls || 0) + 1;
            if (state.failCreateImageDataOnCall === state.createImageDataCalls) throw new Error('createImageDataFromBuffer failed');
            // Count only buffers that were actually returned to the caller; a rejected
            // creation has no ImageData handle for the script to dispose.
            state.imageDataCreated += 1;
            const components = options.components;
            if (data.length !== options.width * options.height * components) throw new Error('wrong buffer length');
            const sixteen = data instanceof Uint16Array;
            if (sixteen && !options.colorProfile) throw new Error('A color profile must be specified for the source data');
            return {
                width: options.width,
                height: options.height,
                components,
                componentSize: sixteen ? 16 : 8,
                colorProfile: options.colorProfile || '',
                fullRange: options.fullRange,
                data,
                dispose() { state.imageDataDisposed += 1; }
            };
        },
        async putPixels({ documentID, layerID, imageData, targetBounds, replace }) {
            state.putPixelsCalls += 1;
            if (state.failPutPixelsOnCall === state.putPixelsCalls) throw new Error('putPixels failed');
            const target = app.documents.find(d => d.id === documentID);
            const layer = findLayerById(layerID, target ? target.layers : doc.layers);
            if (!layer) throw new Error('no such layer');
            layer.pixels = {
                left: targetBounds.left,
                top: targetBounds.top,
                width: imageData.width,
                height: imageData.height,
                data: imageData.data.slice(),
                componentSize: imageData.componentSize,
                colorProfile: imageData.colorProfile,
                fullRange: imageData.fullRange,
                replace
            };
        }
    };

    const folderEntry = {
        get nativePath() { return dataFolder; },
        // task20: storage Folder.createFile + File.write, as the areola read script uses them.
        async createFile(name, { overwrite = false } = {}) {
            const full = path.join(dataFolder, name);
            if (!overwrite && fs.existsSync(full)) throw new Error(`File ${name} already exists`);
            fs.writeFileSync(full, Buffer.alloc(0));
            return {
                async write(data, { format } = {}) {
                    if (format !== 'binary') throw new Error('The fake writes binary data only');
                    if (!(data instanceof ArrayBuffer)) throw new Error('A binary write needs an ArrayBuffer');
                    fs.writeFileSync(full, Buffer.from(data));
                }
            };
        },
        async getEntry(name) {
            const full = path.join(dataFolder, name);
            if (!fs.existsSync(full)) throw new Error(`Could not find an entry of ${name}`);
            return {
                async read() {
                    const bytes = fs.readFileSync(full);
                    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
                }
            };
        }
    };
    const uxp = {
        storage: { localFileSystem: { getDataFolder: async () => folderEntry }, formats: { binary: 'binary', utf8: 'utf8' } },
        host: { name: 'Photoshop', version: '25.3.1' },
        versions: { uxp: 'uxp-7.3.0-6', plugin: '2.0.2' }
    };
    const core = {
        executeAsModal() {
            state.nestedModalCalls += 1;
            throw new Error('A nested executeAsModal is not expected inside agent_execute_script');
        }
    };
    const action = {
        batchPlay: async (commands) => {
            if (!Array.isArray(commands)) return [];
            return commands.map(cmd => {
                if (cmd && cmd._obj === 'select' && Array.isArray(cmd._target) && cmd._target[0] && cmd._target[0]._ref === 'layer') {
                    state.selectedLayerId = cmd._target[0]._id;
                    const selected = findLayerById(state.selectedLayerId);
                    if (selected) doc.activeLayers = [selected];
                    return {};
                }
                if (cmd && cmd._obj === 'make' && cmd.using && cmd.using._enum === 'userMaskEnabled') {
                    // Real batchPlay reports a failed command as an error entry, without throwing.
                    if (state.failMaskInit) return { _obj: 'error', message: 'make mask failed', result: -25922 };
                    const target = findLayerById(state.selectedLayerId);
                    if (target && !state.skipMaskInit) target.mask = { bounds: null, data: null, outside: cmd.using._value === 'hideAll' ? 0 : 255 };
                    return {};
                }
                if (cmd && cmd._obj === 'set' && Array.isArray(cmd._target)
                    && cmd._target[0] && cmd._target[0]._ref === 'property'
                    && cmd._target[0]._property === 'layerSectionExpanded'
                    && cmd._target[1] && cmd._target[1]._ref === 'layer') {
                    if (state.failGroupCollapse) return { _obj: 'error', message: 'collapse group failed', result: -1 };
                    const target = findLayerById(cmd._target[1]._id, doc.layers);
                    if (target && target.kind === 'group') {
                        target.layerSectionExpanded = Boolean(cmd.to);
                        doc.changedInScript = true;
                    }
                    return {};
                }
                if (cmd && cmd._obj === 'get' && Array.isArray(cmd._target)) {
                    const layerRef = cmd._target.find(t => t._ref === 'layer');
                    if (layerRef && layerRef._id !== undefined) {
                        const l = findLayerById(layerRef._id, doc.layers);
                        if (l) {
                            return {
                                hasUserMask: Boolean(l.mask),
                                userMaskEnabled: l._userMaskEnabled !== false,
                                userMaskDensity: l.layerMaskDensity !== undefined ? l.layerMaskDensity : 100,
                                userMaskFeather: l.layerMaskFeather !== undefined ? l.layerMaskFeather : 0,
                                layerSectionExpanded: l.kind === 'group' ? l.layerSectionExpanded !== false : undefined
                            };
                        }
                    }
                }
                return {};
            });
        }
    };
    const requireInScript = id => {
        if (id === 'uxp') return uxp;
        if (id === 'photoshop') return { app, action, core, imaging, constants: CONSTANTS };
        throw new Error(`Cannot find module ${id}`);
    };

    // What the plugin's agentExecuteScript does with the code (modules/command-handlers.js).
    async function agentExecuteScript(payload) {
        if (state.closed) {
            throw new Error(`[document-closed] The document "${doc.name}" is closed, so the task cannot continue.`);
        }
        if (state.busy) {
            throw new Error('[photoshop-busy] Photoshop stayed busy for 10 seconds and would not let the plugin work. Nothing was changed in the document by this call.');
        }
        doc.changedInScript = false;
        doc._beginHistoryStep();

        const fn = new Function(
            'app', 'action', 'core', 'imaging', 'constants', 'doc', 'require',
            `return (async () => {
                let result;
                let returnedValue = await (async () => {
                    ${payload.code}
                })();
                return returnedValue !== undefined ? returnedValue : result;
            })()`
        );
        let value;
        try {
            value = await fn(app, action, core, imaging, CONSTANTS, doc, requireInScript);
            state.lastScriptValue = value;
        } catch (error) {
            if (doc.changedInScript) {
                state.historySteps.push(`Agent: ${payload.historyName}`);
                doc._commitHistoryStep();
            }
            throw new Error(`The script failed: ${error.message}`);
        }
        if (doc.changedInScript) {
            state.historySteps.push(`Agent: ${payload.historyName}`);
            doc._commitHistoryStep();
        }
        return {
            result: value === undefined ? null : value,
            status: { documentId: doc.id, documentName: doc.name, historyStep: state.historySteps[state.historySteps.length - 1] || 'Open', sinceLastCall: [] }
        };
    }

    const bridge = {
        getConnectedClients: () => (state.connected ? 1 : 0),
        getActiveRuntimeId: () => (state.connected ? state.runtimeId : null),
        sendCommand: () => 'command-id',
        async sendCommandAndWait(action, payload, timeoutMs) {
            if (action === 'agent_start_task') {
                return {
                    document: { id: doc.id, name: doc.name, width: doc.width, height: doc.height, resolution: 72,
                        colorMode: 'RGB', bitsPerChannel: 8, layerCount: doc.layers.length },
                    photoshopVersion: '25.3.1',
                    status: { documentId: doc.id, documentName: doc.name, historyStep: 'Open', sinceLastCall: [] }
                };
            }
            if (action === 'agent_finish_task') return {};
            if (action !== 'agent_execute_script') throw new Error(`no fake answer for ${action}`);
            const isApply = payload.code.includes('Skin texture: write job') || payload.code.includes('Skin texture: write recipe');
            const record = { payload, timeoutMs, kind: isApply ? 'apply' : 'probe' };
            state.scripts.push(record);
            if (state.beforeScript) await state.beforeScript(payload, record);
            const answer = await agentExecuteScript(payload);
            return state.afterScript ? state.afterScript(answer, payload, record) : answer;
        }
    };

    /**
     * @param {object} layer - A layer of the fake document.
     * @returns {Uint8Array|null} Its gray values (R) as 8-bit, or null when it has no pixels.
     */
    function grayOf(layer) {
        if (!layer.pixels) return null;
        const p = layer.pixels;
        const out = new Uint8Array(p.width * p.height);
        for (let i = 0; i < out.length; i++) out[i] = p.data[i * 4];
        return out;
    }

    // findLayerById is exported on fake for test inspection of nested layer hierarchy
    return { state, doc, other, app, bridge, grayOf, findLayerById, findLayerByName, constants: CONSTANTS };
}

const silent = { info() {}, warn() {}, error() {} };

/**
 * Hold the job manager's file publication at a chosen point until the test releases it. This
 * gives a deterministic moment between "apply was called" and "the command was sent", the
 * window of finding R2 in the task03 lead review, without touching the job's own state.
 * exchange-files.js itself is untouched: only its exported publish is wrapped, and restore()
 * puts it back (and releases a held call).
 *
 * @param {object} [options]
 * @param {'after'|'before'} [options.when] - Hold after the file is on disk (default), or
 *   before it is written, so a late write of the file can be checked too.
 * @param {number} [options.holdCall] - Which publish call to hold, 1 = the first.
 * @returns {{reached: Promise<void>, release: Function, restore: Function, calls: number}}
 */
function holdPublish({ when = 'after', holdCall = 1 } = {}) {
    // Required here, not at the top: the fake Photoshop itself does not depend on it.
    const exchangeFiles = require('../skin-texture/exchange-files');
    const original = exchangeFiles.publish;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let entered;
    const reached = new Promise(resolve => { entered = resolve; });
    const hold = { reached, release: () => release(), restore: null, calls: 0 };
    exchangeFiles.publish = async (...args) => {
        hold.calls += 1;
        const held = hold.calls === holdCall;
        if (held && when === 'before') {
            entered();
            await gate;
        }
        const result = await original(...args);
        if (held && when === 'after') {
            entered();
            await gate;
        }
        return result;
    };
    hold.restore = () => {
        release();
        exchangeFiles.publish = original;
    };
    return hold;
}

/**
 * Wire the real task registry, tool layer and job manager to a fake Photoshop.
 *
 * @param {import('node:test').TestContext} context - Test context (clean-up).
 * @param {object} [options]
 * @param {object} [options.document] - Fake document spec.
 * @param {object} [options.limits] - Job manager limits.
 * @param {Function} [options.createWorker] - Worker factory.
 * @param {object} [options.taskOptions] - Task registry options (a clock).
 * @param {() => number} [options.now] - Job manager clock.
 * @param {number} [options.dialogWaitMs] - How long an interactive script call waits.
 * @param {string} [options.dataFolder] - Reuse this plugin data folder (a "next run" of
 *   Helper over the files an earlier harness left); it is not removed by this harness.
 * @returns {object} Harness.
 */
function makeHarness(context, { document, limits = {}, createWorker, taskOptions = {}, now, dialogWaitMs, dataFolder: reuseFolder } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skin-texture-'));
    const dataFolder = reuseFolder || path.join(root, 'PluginData');
    if (!reuseFolder) {
        fs.mkdirSync(dataFolder);
        fs.writeFileSync(path.join(dataFolder, 'photoshop-helper.json'), '{"not":"ours"}');
    }

    const fake = createFakePhotoshop({ dataFolder, document });
    const tasks = createTaskSession(taskOptions);
    const knowledgeBase = createKnowledgeBase({
        authorDir: path.join(root, 'knowledge-base'),
        userDir: path.join(root, 'knowledge-base.user'),
        logger: silent
    });
    const journalLines = [];
    const progressLines = [];
    const jobs = createSkinTextureJobs({
        tasks,
        getBridge: () => fake.bridge,
        logger: silent,
        createWorker,
        now,
        limits: { responseBudgetMs: 5000, ...limits }
    });
    const tools = createAgentTools({
        getBridge: () => fake.bridge,
        tasks,
        knowledgeBase,
        journal: { startTask() {}, logCall(entry) { journalLines.push(entry); }, endTask() {} },
        progress: { push(step) { progressLines.push(step); } },
        skinTextureJobs: jobs,
        dialogWaitMs
    });

    context.after(async () => {
        await jobs.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    async function call(name, args) {
        const result = await tools.call(name, args);
        const text = result.content[0].text;
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { result, text, json, isError: Boolean(result.isError) };
    }

    async function startTask() {
        const started = await tools.call('ps_start_task', { intent: 'add skin texture' });
        return started.content[0].text.match(/(task-[a-f0-9]+)/)[1];
    }

    async function waitForPhase(taskId, jobId, phases, timeoutMs = 30_000) {
        const wanted = Array.isArray(phases) ? phases : [phases];
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const answer = await call('ps_skin_texture_status', { task_id: taskId, job_id: jobId });
            if (answer.json && wanted.includes(answer.json.phase)) return answer.json;
            if (Date.now() > deadline) throw new Error(`job ${jobId} stayed ${answer.json && answer.json.phase}: ${answer.text}`);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }

    function ownFiles() {
        return fs.readdirSync(dataFolder).filter(name => name.startsWith('skin-texture-'));
    }

    return { root, dataFolder, fake, tasks, jobs, tools, call, startTask, waitForPhase, ownFiles, journalLines, progressLines };
}

module.exports = { createFakePhotoshop, makeHarness, holdPublish, CONSTANTS };
