'use strict';

/**
 * Test doubles for the skin texture tests: a fake Photoshop plugin that runs the real scripts
 * Helper builds, the way the plugin's agentExecuteScript runs them, and a harness that wires
 * the real task registry, tool layer and job manager to it.
 *
 * The fake models only what the scripts touch: one task document with layers, the Imaging
 * API calls (createImageDataFromBuffer, putPixels), createPixelLayer, layer.delete, and the
 * plugin's data folder (a real temporary folder on disk). It is not evidence about Photoshop
 * itself; the real reads are in the task03 practical check.
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
    const state = {
        connected: true,
        runtimeId: 'uxp-runtime-1',
        closed: false,
        busy: false,
        scripts: [],
        historySteps: [],
        imageDataCreated: 0,
        imageDataDisposed: 0,
        putPixelsCalls: 0,
        failPutPixelsOnCall: null,
        failCreateImageDataOnCall: null,
        failDeleteIds: new Set(),
        failAllDeletes: false,
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

    function makeLayer(doc, name, kind = 'pixel', props = {}) {
        const layer = {
            id: nextLayerId++,
            name,
            kind,
            blendMode: kind === 'group' ? CONSTANTS.BlendMode.PASSTHROUGH : CONSTANTS.BlendMode.NORMAL,
            opacity: 100,
            fillOpacity: 100,
            visible: true,
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
            hasSelection: spec.hasSelection !== undefined ? spec.hasSelection : Boolean(spec.selection),
            selection: spec.selection || null,
            layers: [],
            changedInScript: false,
            async createPixelLayer({ name }) {
                const layer = makeLayer(doc, name, 'pixel');
                doc.layers.unshift(layer);
                doc.changedInScript = true;
                return layer;
            },
            async createLayerGroup({ name, opacity = 100, blendMode = CONSTANTS.BlendMode.PASSTHROUGH, fromLayers } = {}) {
                const group = makeLayer(doc, name, 'group');
                group.blendMode = blendMode;
                group.opacity = opacity;
                if (state.unexpectedChildMaskOnGroupName === name || (state.unexpectedChildMask && name === 'Formula 1')) {
                    group.mask = { width: 10, height: 10, bounds: { left: 0, top: 0, right: 10, bottom: 10 } };
                }
                if (Array.isArray(fromLayers)) {
                    for (const l of fromLayers) {
                        if (l.parent && Array.isArray(l.parent.layers)) {
                            l.parent.layers = l.parent.layers.filter(other => other !== l);
                        } else {
                            doc.layers = doc.layers.filter(other => other !== l);
                        }
                        l.parent = group;
                        group.layers.push(l);
                    }
                }
                doc.layers.unshift(group);
                doc.changedInScript = true;
                return group;
            }
        };
        const background = makeLayer(doc, 'Background');
        doc.layers.push(background);
        return doc;
    }

    const doc = makeDocument(document);
    const other = makeDocument({ id: 99, name: 'another.psd', width: 300, height: 300 });
    const app = { documents: [doc, other], activeDocument: other };

    const imaging = {
        async getSelection(options) {
            state.getSelectionCalls = (state.getSelectionCalls || 0) + 1;
            if (!doc.hasSelection || !doc.selection) return null;
            const s = doc.selection;
            const w = s.width || doc.width;
            const h = s.height || doc.height;
            return {
                imageData: {
                    width: w,
                    height: h,
                    components: 1,
                    data: s.data || new Uint8Array(w * h).fill(255),
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
        async getLayerMask({ documentID, layerID, kind, sourceBounds }) {
            state.getLayerMaskCalls = (state.getLayerMaskCalls || 0) + 1;
            const layer = findLayerById(layerID);
            if (!layer || !layer.mask) return null;
            if (state.corruptVerifiedMaskOnLayerId === layerID) {
                return {
                    imageData: null,
                    sourceBounds: { left: 0, top: 0, right: 0, bottom: 0 }
                };
            }
            if (state.corruptVerifiedMaskBounds || state.corruptVerifiedMaskBoundsOnLayerId === layerID) {
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
                maskData = new Uint8Array(width * height);
                const b = m.bounds;
                for (let i = 0; i < maskData.length; i++) {
                    const x = returnedBounds.left + (i % width);
                    const y = returnedBounds.top + Math.floor(i / width);
                    const inPatch = b && x >= b.left && x < b.right && y >= b.top && y < b.bottom;
                    maskData[i] = inPatch ? (m.data ? m.data[(y - b.top) * (b.right - b.left) + (x - b.left)] : 255) : (m.outside === undefined ? 255 : m.outside);
                }
            }

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
            const layer = findLayerById(layerID);
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
            state.imageDataCreated += 1;
            if (state.failCreateImageDataOnCall === state.imageDataCreated) throw new Error('createImageDataFromBuffer failed');
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
                    return {};
                }
                if (cmd && cmd._obj === 'make' && cmd.using && cmd.using._enum === 'userMaskEnabled') {
                    // Real batchPlay reports a failed command as an error entry, without throwing.
                    if (state.failMaskInit) return { _obj: 'error', message: 'make mask failed', result: -25922 };
                    const target = findLayerById(state.selectedLayerId);
                    if (target && !state.skipMaskInit) target.mask = { bounds: null, data: null, outside: cmd.using._value === 'hideAll' ? 0 : 255 };
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
                                userMaskFeather: l.layerMaskFeather !== undefined ? l.layerMaskFeather : 0
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
        } catch (error) {
            if (doc.changedInScript) state.historySteps.push(`Agent: ${payload.historyName}`);
            throw new Error(`The script failed: ${error.message}`);
        }
        if (doc.changedInScript) state.historySteps.push(`Agent: ${payload.historyName}`);
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
    return { state, doc, other, app, bridge, grayOf, findLayerById, constants: CONSTANTS };
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
