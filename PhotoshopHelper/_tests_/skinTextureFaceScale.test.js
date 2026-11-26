'use strict';

/** The job view warns when the face points' scale disagrees with px_per_mm. Needs no binaries. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagnostics } = require('../skin-texture/recipe-job-view');

/** A finished three-formula job with the given face fit reported the way Fable and Gemini do. */
function job(pxPerMm, impliedPxPerMm, { fable = true, gemini = true } = {}) {
    const params = { pxPerMm };
    const fit = { yawDeg: 60, impliedPxPerMm };
    return {
        coreParams: { formula_1: params, formula_2: params, formula_3: params },
        stats: {
            formula_1: { layers: {}, diagnostics: fable ? { fields: { mode: 'face', faces: [fit] } } : {} },
            formula_2: { layers: {}, diagnostics: gemini ? { gemini4_stratum: { fits: [fit] } } : {} },
            formula_3: { layers: {}, diagnostics: {} }
        }
    };
}

const faceNotes = view => view.notes.filter(note => note.startsWith('Face map'));

test('a face fit far from px_per_mm is reported once', () => {
    // The call whose hidden eye was placed behind the nose bridge, before the fix of the map.
    const notes = faceNotes(buildDiagnostics(job(2.5, 1.4)));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /1\.40 px\/mm, but px_per_mm is 2\.5/);
});

test('a face fit close to px_per_mm is not reported', () => {
    assert.deepEqual(faceNotes(buildDiagnostics(job(2.65, 2.61))), []);
    // Natural spread of faces stays quiet.
    assert.deepEqual(faceNotes(buildDiagnostics(job(2.5, 2.9))), []);
});

test('either reporting formula is enough, and no fit means no note', () => {
    assert.equal(faceNotes(buildDiagnostics(job(2.65, 0.79, { fable: false }))).length, 1);
    assert.equal(faceNotes(buildDiagnostics(job(2.65, 0.79, { gemini: false }))).length, 1);
    assert.deepEqual(faceNotes(buildDiagnostics(job(2.65, 0.79, { fable: false, gemini: false }))), []);
});
