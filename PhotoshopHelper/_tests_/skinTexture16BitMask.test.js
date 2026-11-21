'use strict';

/**
 * Regression for a task15 defect found live in task20 (21 November 2026): in a 16-bit document
 * Photoshop hands the selection over as 8-bit values but reads the written Skin mask back in its
 * 16-bit range, so the post-write mask check compared 255 with 32768 and rolled every 16-bit apply
 * back with MASK_DATA_MISMATCH, with or without areolas. The fake now answers like Photoshop
 * (8-bit selection, 16-bit mask readback); the check compares both on the 8-bit scale.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHarness } = require('./skinTextureFakes');
const { missingBinaryReason } = require('./skinTextureTestSupport');

const skip = missingBinaryReason();

/** A selection with a soft edge, so intermediate values go through the 8 -> 16-bit conversion. */
function softSelection(width, height) {
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const d = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) / (width / 2);
            data[y * width + x] = Math.max(0, Math.min(255, Math.round(255 * (1.2 - d) / 0.4)));
        }
    }
    return data;
}

test('skin_three_v2 without areolas applies on a 16-bit document with a soft 8-bit selection', { skip }, async t => {
    const selection = { x: 40, y: 30, width: 96, height: 96, data: softSelection(96, 96) };
    const harness = makeHarness(t, { limits: { responseBudgetMs: 10_000 },
        document: { width: 200, height: 160, bits: 16, hasSelection: true, selection } });
    const taskId = await harness.startTask();
    const start = await harness.call('ps_skin_texture_start', { task_id: taskId, request_id: 'sixteen-1',
        rect: { x: 40, y: 30, width: 96, height: 96 }, px_per_mm: 4 });
    assert.equal(start.isError, false, start.text);
    await harness.waitForPhase(taskId, start.json.job_id, 'ready', 120_000);
    const applied = await harness.call('ps_skin_texture_apply', { task_id: taskId, job_id: start.json.job_id,
        mask_source: { kind: 'selection' } });
    assert.equal(applied.isError, false, applied.text);
    assert.equal(applied.json.phase, 'applied', applied.text);

    // The Skin mask holds the selection (stored as the fake received it), value for value.
    const skin = harness.fake.findLayerById(applied.json.apply.structure.mainGroup.id);
    assert.ok(skin.mask, 'Skin has a user mask');
    const patch = skin.mask.data;
    assert.ok(patch && patch.length === 96 * 96, 'the mask patch covers the selection');
    for (let i = 0; i < patch.length; i += 97) {
        const stored = patch instanceof Uint16Array ? Math.round(patch[i] * 255 / 32768) : patch[i];
        assert.ok(Math.abs(stored - selection.data[i]) <= 1, `mask value ${stored} at ${i} follows the selection ${selection.data[i]}`);
    }
});
