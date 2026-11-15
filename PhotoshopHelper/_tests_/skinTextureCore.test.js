'use strict';

/** Validate request contracts independently of private formulas, plus the SKTX exchange format. */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const SkinExchange = require('../skin-texture/exchange');
const adapter = require('../skin-texture/core-adapter');
const catalog = require('../skin-texture/recipe-catalog');
const { Worker } = require('node:worker_threads');
const { missingBinaryReason, runWorker } = require('./skinTextureTestSupport');
const good = { rect: { x: 20, y: 30, width: 24, height: 20 }, px_per_mm: 4 };
const face = { eyes: [[-10, 20], [80, 20]], noseTip: [35, 65], mouth: [[10, 90], [60, 90]], chin: [35, 125], yawDeg: 12, pitchDeg: -5 };

// Face coordinates remain document-relative even when the patch misses several landmarks.
test('three-formula defaults, lighting, fields and canonical identity', () => {
    const implicit = adapter.checkRequestShape(good);
    const explicit = adapter.checkRequestShape({ ...good, recipe: 'skin_three_v2' });
    assert.equal(implicit.recipe, 'skin_three_v2');
    assert.equal(implicit.key, explicit.key);
    assert.deepEqual(implicit.outputs, ['formula_1_pores', 'formula_1_unevenness', 'formula_2_dermis', 'formula_3_pores', 'formula_3_furrows']);
    const withFace = adapter.checkRequestShape({ ...good, fields: { face } });
    assert.notEqual(withFace.key, implicit.key);
    const reordered = { chin: face.chin, mouth: face.mouth, noseTip: face.noseTip, eyes: face.eyes, pitchDeg: -5, yawDeg: 12 };
    assert.equal(adapter.checkRequestShape({ ...good, fields: { face: reordered } }).key, withFace.key);
    const changed = adapter.checkRequestShape({ ...good, fields: { face: { ...face, yawDeg: 13 } } });
    assert.notEqual(changed.key, withFace.key);
    const normalized = adapter.normalizeForDocument(withFace, { width: 120, height: 100 });
    for (const id of ['formula_1', 'formula_2', 'formula_3']) {
        const request = normalized.coreParams[id];
        assert.equal(request.width, good.rect.width);
        assert.equal(request.height, good.rect.height);
        assert.deepEqual(request.document, { width: 120, height: 100 });
        assert.deepEqual(request.rect, good.rect);
        assert.equal(request.seed, 1);
        assert.deepEqual(request.lighting, { azimuthDeg: 315, elevationDeg: 45 });
        if (id === 'formula_1') assert.deepEqual(request.fields, { face });
        else assert.equal(request.fields, undefined);
    }
    assert.equal(normalized.work.rectPixels, 480);
    assert.ok(Number.isFinite(normalized.work.retainedOutputBytes));
    assert.equal(normalized.work.radius, undefined);
    // Normalization must copy fields so a caller cannot mutate a worker request afterwards.
    normalized.coreParams.formula_1.fields.face.chin[0] = 999;
    assert.equal(face.chin[0], 35);
});

// Every rejected argument is caught before a Photoshop probe or a Wasm allocation is needed.
test('invalid geometry, obsolete recipe/mode, seed, lighting and fields are refused', () => {
    const invalid = [
        [{ rect: undefined }, 'INVALID_RECT'],
        [{ rect: { x: -1, y: 0, width: 4, height: 4 } }, 'INVALID_RECT'],
        [{ rect: { x: 0, y: 0, width: 4.5, height: 4 } }, 'INVALID_RECT'],
        [{ rect: { x: 0, y: 0, width: 5000, height: 4000 } }, 'RECT_TOO_LARGE'],
        [{ rect: { ...good.rect, extra: 1 } }, 'INVALID_RECT'],
        ...[undefined, 0, Infinity, NaN, 0.24, 401].map(value => [{ px_per_mm: value }, 'INVALID_SCALE']),
        [{ recipe: 'skin_pair_v1' }, 'INVALID_RECIPE'],
        ...[[], ['main']].map(value => [{ outputs: value }, 'INVALID_OUTPUTS']),
        ...[{ mode: 'lines' }, { relief: 2 }, { seed: -1 }, { seed: 4294967296 }, { seed: 1.5 }, { seed: '1' }, { azimuthDeg: Infinity }, { elevationDeg: 4 }, { elevationDeg: 91 }, { elevationDeg: '45' }, []].map(value => [{ params: value }, 'INVALID_PARAMS']),
        ...[[], { unknown: {} }, { face: {} }, { face: { ...face, extra: 1 } }, { face: { ...face, eyes: [[1, 1], [1, 1]] } }, { face: { ...face, eyes: [[1, 1], [3, 1]] } }, { face: { ...face, chin: [NaN, 20] } }, { face: { ...face, noseTip: [1, 2, 3] } }, { face: { ...face, yawDeg: Infinity } }].map(value => [{ fields: value }, 'INVALID_FIELDS'])
    ];
    for (const [overrides, code] of invalid) assert.throws(() => adapter.checkRequestShape({ ...good, ...overrides }), error => error.code === code, JSON.stringify(overrides));
    for (const seed of [0, 4294967295]) assert.equal(adapter.checkRequestShape({ ...good, params: { seed } }).params.seed, seed);
    const checked = adapter.checkRequestShape(good);
    assert.throws(() => adapter.normalizeForDocument(checked, { width: 30, height: 80 }), error => error.code === 'RECT_OUTSIDE_DOCUMENT');
});

test('main-thread parameter resolution does not compile, instantiate or execute Wasm', () => {
    const OriginalModule = WebAssembly.Module;
    const OriginalInstance = WebAssembly.Instance;
    try {
        // Fail at the allocation boundary rather than relying on source-text searches.
        WebAssembly.Module = function forbiddenModule() { throw new Error('main-thread compile'); };
        WebAssembly.Instance = function forbiddenInstance() { throw new Error('main-thread instance'); };
        const checked = adapter.checkRequestShape({ ...good, fields: { face } });
        const normalized = adapter.normalizeForDocument(checked, { width: 120, height: 100 });
        assert.equal(normalized.coreParams.formula_3.pxPerMm, 4);
    } finally {
        WebAssembly.Module = OriginalModule;
        WebAssembly.Instance = OriginalInstance;
    }
});

test('default and explicit recipes produce the same five outputs and versioned metadata', { skip: missingBinaryReason() }, async () => {
    const document = { width: 120, height: 100 };
    const normalized = adapter.normalizeForDocument(adapter.checkRequestShape(good), document);
    const [implicit, explicit] = await Promise.all([
        runWorker(normalized.coreParams, good.rect, document, undefined),
        runWorker(normalized.coreParams, good.rect, document, 'skin_three_v2')
    ]);
    assert.equal(implicit.recipe, 'skin_three_v2');
    assert.deepEqual(Object.keys(implicit.files), catalog.RECIPE_COMPONENTS.map(layer => layer.componentKey));
    for (const component of catalog.RECIPE_COMPONENTS) {
        const decoded = SkinExchange.decode(implicit.files[component.componentKey]);
        assert.equal(decoded.header.formula_id, component.formulaId);
        assert.equal(decoded.header.formula_version, 2);
        assert.equal(decoded.payload.length, 480);
        assert.deepEqual(Buffer.from(implicit.files[component.componentKey]), Buffer.from(explicit.files[component.componentKey]));
        const formula = catalog.FORMULA_DEFINITIONS[component.formulaId];
        assert.deepEqual(decoded.header.core, { name: formula.variant, version: formula.variantVersion, sha256: formula.sha256 });
    }
});

test('cancelling the real coordinator stops its active nested worker tree', { skip: missingBinaryReason(), timeout: 15000 }, async context => {
    const counterBuffer = new SharedArrayBuffer(4);
    const counter = new Int32Array(counterBuffer);
    const document = { width: 1024, height: 1024 };
    const rect = { x: 0, y: 0, ...document };
    const normalized = adapter.normalizeForDocument(adapter.checkRequestShape({ rect, px_per_mm: 1.6 }), document);
    const workerFile = require('../skin-texture/job-manager').WORKER_FILE;
    // Install an observable heartbeat beneath each real formula worker. A grandchild
    // remains responsive during synchronous Wasm computation, so an orphaned formula
    // worker cannot hide behind a blocked JavaScript interval in its own event loop.
    const bootstrap = `
        const threads = require('node:worker_threads');
        const NativeWorker = threads.Worker;
        const counterBuffer = threads.workerData.counterBuffer;
        threads.Worker = class ObservedFormulaWorker extends NativeWorker {
            constructor(filename, options) {
                const childCode = \`
                    const { Worker, workerData } = require('node:worker_threads');
                    new Worker(\\\`const {workerData}=require('node:worker_threads');
                        const count=new Int32Array(workerData);
                        setInterval(()=>Atomics.add(count,0,1),10);\\\`,
                        {eval:true,workerData:workerData.counterBuffer});
                    require(workerData.filename);
                \`;
                super(childCode, { ...options, eval: true,
                    workerData: { ...options.workerData, counterBuffer, filename } });
            }
        };
        require(threads.workerData.workerFile);
    `;
    const worker = new Worker(bootstrap, { eval: true, workerData: {
        counterBuffer, workerFile, recipe: 'skin_three_v2', formulaParams: normalized.coreParams,
        meta: { jobId: 'skt-0123456789ab', taskId: 'task-test', document: { id: 7, ...document }, rect }
    } });
    context.after(() => worker.terminate());
    let failure;
    worker.on('error', error => { failure = error; });
    const deadline = Date.now() + 10000;
    while (Atomics.load(counter, 0) < 3) {
        if (failure) throw failure;
        assert.ok(Date.now() < deadline, 'the active nested heartbeat starts');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    await worker.terminate();
    const stopped = Atomics.load(counter, 0);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(Atomics.load(counter, 0), stopped, 'no descendant remains alive after cancellation');
});

test('each real formula worker exits before the next formula starts', { skip: missingBinaryReason() }, async context => {
    const normalized = adapter.normalizeForDocument(adapter.checkRequestShape(good), { width: 120, height: 100 });
    const workerFile = require('../skin-texture/job-manager').WORKER_FILE;
    const audit = [];
    // Wrap Worker only inside the coordinator, retaining actual worker execution and exit
    // promises. The audit records observable lifetime overlap, rather than GC assumptions.
    const bootstrap = `
        const threads = require('node:worker_threads');
        const NativeWorker = threads.Worker;
        let active = 0;
        threads.Worker = class AuditedWorker extends NativeWorker {
            constructor(filename, options) {
                super(filename, options);
                threads.parentPort.postMessage({type:'audit',kind:'start',formula:options.workerData.formulaId,active:++active});
                this.once('exit',()=>threads.parentPort.postMessage({type:'audit',kind:'exit',formula:options.workerData.formulaId,active:--active}));
            }
        };
        require(threads.workerData.workerFile);
    `;
    const worker = new Worker(bootstrap, { eval: true, workerData: {
        workerFile, recipe: 'skin_three_v2', formulaParams: normalized.coreParams,
        meta: { jobId: 'skt-0123456789ab', taskId: 'task-test', document: { id: 7, width: 120, height: 100 }, rect: good.rect }
    } });
    context.after(() => worker.terminate());
    await new Promise((resolve, reject) => {
        worker.on('message', message => {
            if (message.type === 'audit') audit.push(message);
            if (message.type === 'error') reject(new Error(message.message));
        });
        worker.once('error', reject);
        worker.once('exit', code => code ? reject(new Error(`worker exited ${code}`)) : resolve());
    });
    assert.deepEqual(audit.map(event => [event.kind, event.formula, event.active]), [
        ['start', 'formula_1', 1], ['exit', 'formula_1', 0],
        ['start', 'formula_2', 1], ['exit', 'formula_2', 0],
        ['start', 'formula_3', 1], ['exit', 'formula_3', 0]
    ]);
});

test('the exchange file round-trips and refuses every kind of damage', () => {
    const rect = { x: 3, y: 4, width: 20, height: 10 };
    const gray = new Uint8Array(200).map((_, i) => (i * 37) & 255);
    const meta = { jobId: 'skt-0123456789ab', taskId: 'task-1', output: 'formula_2_dermis', document: { id: 5, width: 50, height: 40 }, rect };
    const bytes = SkinExchange.encode(meta, gray);
    const expect = { jobId: meta.jobId, taskId: 'task-1', output: 'formula_2_dermis', documentId: 5, document: { width: 50, height: 40 }, rect };
    assert.deepEqual(Buffer.from(SkinExchange.decode(bytes, expect).payload), Buffer.from(gray));

    const cases = {
        EXCHANGE_TRUNCATED: bytes.slice(0, bytes.length - 1),
        EXCHANGE_EXTRA_BYTES: (() => { const b = new Uint8Array(bytes.length + 1); b.set(bytes); return b; })(),
        EXCHANGE_BAD_MAGIC: (() => { const b = bytes.slice(); b[0] = 0x41; return b; })(),
        EXCHANGE_PAYLOAD_CRC: (() => { const b = bytes.slice(); b[b.length - 20] ^= 1; return b; })(),
        EXCHANGE_NO_TRAILER: (() => { const b = bytes.slice(); b[b.length - 16] = 0x41; return b; })()
    };
    for (const [code, damaged] of Object.entries(cases)) {
        assert.throws(() => SkinExchange.decode(damaged, expect), new RegExp(`^Error: ${code}`), code);
    }
    const headerChanged = bytes.slice();
    headerChanged[20] = headerChanged[20] === 0x31 ? 0x32 : 0x31;
    assert.throws(() => SkinExchange.decode(headerChanged, expect), /EXCHANGE_(HEADER_CRC|BAD_HEADER|LENGTH|HEADER_FIELD|WRONG|PAYLOAD)/);

    for (const [key, value, code] of [
        ['jobId', 'skt-ffffffffffff', 'EXCHANGE_WRONG_JOB'],
        ['taskId', 'task-2', 'EXCHANGE_WRONG_JOB'],
        ['output', 'formula_1_pores', 'EXCHANGE_WRONG_JOB'],
        ['documentId', 6, 'EXCHANGE_WRONG_DOCUMENT'],
        ['document', { width: 51, height: 40 }, 'EXCHANGE_WRONG_DOCUMENT'],
        ['rect', { ...rect, x: 4 }, 'EXCHANGE_WRONG_RECT']
    ]) {
        assert.throws(() => SkinExchange.decode(bytes, { ...expect, [key]: value }), new RegExp(code), key);
    }
    const source = fs.readFileSync(path.join(__dirname, '..', 'skin-texture', 'exchange.js'), 'utf8');
    assert.ok([...source].every(char => char.charCodeAt(0) < 128));
});

test('gray maps to RGBA 8 and to the verified 16-bit range for every value', () => {
    const gray = new Uint8Array(256).map((_, i) => i);
    const rgba8 = SkinExchange.grayToRgba8(gray);
    const rgba16 = SkinExchange.grayToRgba16(gray);
    for (let v = 0; v < 256; v++) {
        assert.deepEqual(Array.from(rgba8.subarray(v * 4, v * 4 + 4)), [v, v, v, 255]);
        const w = Math.round(v * 32768 / 255);
        assert.deepEqual(Array.from(rgba16.subarray(v * 4, v * 4 + 4)), [w, w, w, 32768]);
        assert.equal(SkinExchange.from16(w), v);
    }
    assert.equal(SkinExchange.to16(128), 16448, 'the value task02 read back from 16-bit documents');
});
