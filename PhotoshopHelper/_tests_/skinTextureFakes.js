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
    BlendMode: { NORMAL: 'normal', LINEARLIGHT: 'linearLight' }
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

    function makeLayer(doc, name) {
        const layer = {
            id: nextLayerId++,
            name,
            blendMode: CONSTANTS.BlendMode.NORMAL,
            opacity: 100,
            fillOpacity: 100,
            visible: true,
            parent: null,
            pixels: null,
            get bounds() {
                if (!this.pixels) return { left: 0, top: 0, right: 0, bottom: 0 };
                const p = this.pixels;
                return { left: p.left, top: p.top, right: p.left + p.width, bottom: p.top + p.height };
            },
            async delete() {
                if (state.failAllDeletes || state.failDeleteIds.has(layer.id)) throw new Error('The layer could not be deleted');
                doc.layers = doc.layers.filter(other => other !== layer);
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
            layers: [],
            changedInScript: false,
            async createPixelLayer({ name }) {
                const layer = makeLayer(doc, name);
                doc.layers.unshift(layer);
                doc.changedInScript = true;
                return layer;
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
            const layer = target && target.layers.find(l => l.id === layerID);
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
    const action = { batchPlay: async () => [] };
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
            const record = { payload, timeoutMs, kind: payload.code.includes('Skin texture: write job') ? 'apply' : 'probe' };
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

    return { state, doc, other, app, bridge, grayOf, constants: CONSTANTS };
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
