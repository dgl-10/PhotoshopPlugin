'use strict';

/**
 * The pinned core, the worker that runs it, the exchange format and the request checks.
 * The worker must give exactly the bytes the core gives on its own: the integration moves the
 * computation, it does not change it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const SkinTexture = require('../skin-texture/skin-core.js');
const SkinExchange = require('../skin-texture/exchange.js');
const adapter = require('../skin-texture/core-adapter');
const { WORKER_FILE } = require('../skin-texture/job-manager');

const META = { jobId: 'skt-0123456789ab', taskId: 'task-abc123', core: { version: 'test' } };

/**
 * Run the real worker once.
 *
 * @param {object} params - Resolved core parameters.
 * @param {string[]} outputs - Outputs.
 * @returns {Promise<object>} The result message.
 */
function runWorker(params, outputs) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_FILE, {
            workerData: {
                params,
                outputs,
                meta: { ...META, document: { id: 1, width: params.width, height: params.height }, rect: params.rect }
            }
        });
        worker.on('message', message => {
            if (message.type === 'result') resolve(message);
            if (message.type === 'error') reject(new Error(message.message));
        });
        worker.on('error', reject);
    });
}

/**
 * @param {object} message - Worker result.
 * @param {string} output - Output name.
 * @param {object} rect - Expected rect.
 * @returns {Uint8Array} The decoded gray layer.
 */
function grayFrom(message, output, rect) {
    return SkinExchange.decode(message.files[output], { jobId: META.jobId, output, rect }).payload;
}

test('the product copy of the core is the accepted one, byte for byte', () => {
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'skin-texture', 'skin-core.js'));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256, '5d0c9d54678cd4d60205c1913aa031e68f193657e951b92fd3c401606f616f8d');
    assert.equal(adapter.PINNED_CORE_SHA256, sha256);
    assert.equal(adapter.getCoreIdentity().matchesPinned, true);
    // Line-ending conversion on checkout would change the bytes; git is told to leave them.
    const attributes = fs.readFileSync(path.join(__dirname, '..', 'skin-texture', '.gitattributes'), 'utf8');
    assert.match(attributes, /^skin-core\.js -text$/m);
});

for (const mode of ['lines', 'cells']) {
    test(`the worker gives the core's own bytes in ${mode} mode, for every output`, async () => {
        const params = SkinTexture.resolveParams({ width: 260, height: 190, rect: { x: 37, y: 21, width: 120, height: 90 },
            pxPerMm: 7, seed: 3, mode });
        const direct = SkinTexture.render(params);
        const message = await runWorker(params, ['main', 'pores', 'furrows']);
        for (const output of ['main', 'pores', 'furrows']) {
            const gray = grayFrom(message, output, params.rect);
            assert.deepEqual(Buffer.from(gray), Buffer.from(direct.layers[output]), `${mode} ${output}`);
            assert.deepEqual(message.checksums[output], SkinExchange.checksums(direct.layers[output]));
        }
        assert.equal(message.stats.nonFiniteReplacements, 0);
    });
}

test('a subset of outputs gives the same bytes as the full render', async () => {
    const params = SkinTexture.resolveParams({ width: 200, height: 160, rect: { x: 10, y: 15, width: 80, height: 70 }, pxPerMm: 6, mode: 'cells' });
    const direct = SkinTexture.render(params);
    const message = await runWorker(params, ['furrows']);
    assert.deepEqual(Object.keys(message.files), ['furrows']);
    assert.deepEqual(Buffer.from(grayFrom(message, 'furrows', params.rect)), Buffer.from(direct.layers.furrows));
});

test('a rect gives exactly the same pixels as that area of the whole document', async () => {
    const whole = SkinTexture.resolveParams({ width: 170, height: 130, pxPerMm: 6, seed: 2 });
    const rect = { x: 41, y: 33, width: 57, height: 46 };
    const part = SkinTexture.resolveParams({ width: 170, height: 130, rect, pxPerMm: 6, seed: 2 });
    const [wholeMessage, partMessage] = await Promise.all([runWorker(whole, ['main']), runWorker(part, ['main'])]);
    const wholeGray = grayFrom(wholeMessage, 'main', whole.rect);
    const partGray = grayFrom(partMessage, 'main', rect);
    for (let y = 0; y < rect.height; y++) {
        const row = wholeGray.subarray((rect.y + y) * 170 + rect.x, (rect.y + y) * 170 + rect.x + rect.width);
        assert.deepEqual(Buffer.from(partGray.subarray(y * rect.width, (y + 1) * rect.width)), Buffer.from(row), `row ${y}`);
    }
});

test('the exchange file round-trips and refuses every kind of damage', () => {
    const rect = { x: 3, y: 4, width: 20, height: 10 };
    const gray = new Uint8Array(200).map((_, i) => (i * 37) & 255);
    const meta = { jobId: 'skt-0123456789ab', taskId: 'task-1', output: 'main', document: { id: 5, width: 50, height: 40 }, rect };
    const bytes = SkinExchange.encode(meta, gray);
    const expect = { jobId: meta.jobId, taskId: 'task-1', output: 'main', documentId: 5, document: { width: 50, height: 40 }, rect };
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
    // A changed header byte is caught by the header checksum (or makes the JSON invalid).
    const headerChanged = bytes.slice();
    headerChanged[20] = headerChanged[20] === 0x31 ? 0x32 : 0x31;
    assert.throws(() => SkinExchange.decode(headerChanged, expect), /EXCHANGE_(HEADER_CRC|BAD_HEADER|LENGTH|HEADER_FIELD|WRONG|PAYLOAD)/);

    for (const [key, value, code] of [
        ['jobId', 'skt-ffffffffffff', 'EXCHANGE_WRONG_JOB'],
        ['taskId', 'task-2', 'EXCHANGE_WRONG_JOB'],
        ['output', 'pores', 'EXCHANGE_WRONG_JOB'],
        ['documentId', 6, 'EXCHANGE_WRONG_DOCUMENT'],
        ['document', { width: 51, height: 40 }, 'EXCHANGE_WRONG_DOCUMENT'],
        ['rect', { ...rect, x: 4 }, 'EXCHANGE_WRONG_RECT']
    ]) {
        assert.throws(() => SkinExchange.decode(bytes, { ...expect, [key]: value }), new RegExp(code), key);
    }
    // The source runs inside Photoshop, which has no TextDecoder: it stays plain ASCII.
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

test('requests are checked against the core before anything starts', () => {
    const good = { rect: { x: 0, y: 0, width: 100, height: 80 }, px_per_mm: 5 };
    assert.equal(adapter.checkRequestShape(good).outputs[0], 'main');
    const refused = [
        [{ ...good, rect: undefined }, 'INVALID_RECT'],
        [{ ...good, rect: { x: 0, y: 0, width: 10.5, height: 10 } }, 'INVALID_RECT'],
        [{ ...good, rect: { x: -1, y: 0, width: 10, height: 10 } }, 'INVALID_RECT'],
        [{ ...good, rect: { x: 0, y: 0, width: 10, height: 10, z: 1 } }, 'INVALID_RECT'],
        [{ ...good, rect: { x: 0, y: 0, width: 5000, height: 4000 } }, 'RECT_TOO_LARGE'],
        [{ ...good, px_per_mm: undefined }, 'INVALID_SCALE'],
        [{ ...good, px_per_mm: 0 }, 'INVALID_SCALE'],
        [{ ...good, px_per_mm: Infinity }, 'INVALID_SCALE'],
        [{ ...good, px_per_mm: Number.NaN }, 'INVALID_SCALE'],
        [{ ...good, params: { width: 4000 } }, 'INVALID_PARAMS'],
        [{ ...good, params: { rect: { x: 0 } } }, 'INVALID_PARAMS'],
        [{ ...good, params: { pxPerMm: 9 } }, 'INVALID_PARAMS'],
        [{ ...good, params: { elevationDeg: Infinity } }, 'INVALID_PARAMS'],
        [{ ...good, params: { elevationDeg: '45' } }, 'INVALID_PARAMS'],
        [{ ...good, params: { elevationDeg: 2 } }, 'INVALID_PARAMS'],
        [{ ...good, params: { mode: 'hexagons' } }, 'INVALID_PARAMS'],
        [{ ...good, params: { seed: 1.5 } }, 'INVALID_PARAMS'],
        [{ ...good, params: { poresTypo: 1 } }, 'INVALID_PARAMS'],
        [{ ...good, params: { pores: 'yes' } }, 'INVALID_PARAMS'],
        [{ ...good, params: [] }, 'INVALID_PARAMS'],
        [{ ...good, outputs: [] }, 'INVALID_OUTPUTS'],
        [{ ...good, outputs: ['height'] }, 'INVALID_OUTPUTS'],
        [{ ...good, outputs: ['main', 'main'] }, 'INVALID_OUTPUTS']
    ];
    for (const [args, code] of refused) {
        assert.throws(() => adapter.checkRequestShape(args), error => error.code === code, JSON.stringify(args));
    }
});

test('the document size is checked once Photoshop has reported it', () => {
    const request = adapter.checkRequestShape({ rect: { x: 50, y: 50, width: 100, height: 100 }, px_per_mm: 6 });
    assert.throws(() => adapter.normalizeForDocument(request, { width: 120, height: 400 }), error => error.code === 'RECT_OUTSIDE_DOCUMENT');
    const ok = adapter.normalizeForDocument(request, { width: 400, height: 400 });
    assert.equal(ok.coreParams.width, 400);
    assert.deepEqual(ok.coreParams.rect, request.rect);

    // At an extreme scale the neutralising blur needs a margin the core would refuse.
    const huge = adapter.checkRequestShape({ rect: { x: 0, y: 0, width: 4096, height: 4096 }, px_per_mm: 1000 });
    assert.throws(() => adapter.normalizeForDocument(huge, { width: 8000, height: 8000 }), error => error.code === 'WORK_AREA_TOO_LARGE');
});

test('the visibility notes say what a small scale suppressed', () => {
    const params = SkinTexture.resolveParams({ width: 120, height: 120, pxPerMm: 2.5 });
    const rendered = SkinTexture.render(params);
    const notes = adapter.visibilityNotes(params, rendered.stats, ['main']);
    assert.ok(notes.some(line => /primary furrows.*not drawn/.test(line)), notes.join('\n'));
    assert.ok(notes.some(line => /px_per_mm/.test(line)));
});
