'use strict';

/**
 * Describe the independent variants without inventing shared kernel diagnostics.
 * Startup identities are verified on disk; completed job identities come from the actual
 * formula workers and must match those pins before the job becomes ready.
 */
const catalog = require('./recipe-catalog');
const adapter = require('./core-adapter');
const { AREOLA_DEFINITIONS } = require('./areola-definitions');

/** Translate internal camelCase identity fields to the MCP response convention. */
function publicCore(core) {
    const out = { name: core.name, version: core.version, sha256: core.sha256, matches_pinned: core.matchesPinned };
    if (core.fileName) out.file_name = core.fileName;
    if (core.formulas) out.formulas = core.formulas.map(item => ({ formula_id: item.formulaId, ...publicCore(item) }));
    return out;
}

/** Describe formula generation separately from the upstream variant's own version. */
function describeFormulas(job, identity, withParams) {
    return Object.fromEntries(Object.values(catalog.FORMULA_DEFINITIONS).map(formula => {
        const core = (job.computedCores && job.computedCores[formula.id]) || identity.formulas.find(item => item.formulaId === formula.id);
        return [formula.id, {
            formula_id: formula.id, formula_version: formula.version, name: formula.name,
            visible: formula.visible, outputs: formula.layers.map(layer => layer.output),
            variant: core.name, variant_version: core.version, sha256: core.sha256,
            core: publicCore(core),
            params: withParams && job.coreParams && job.coreParams[formula.id]
                ? adapter.publicParams(job.coreParams[formula.id]) : undefined
        }];
    }));
}

/** How far the face points' scale may stray from px_per_mm before the job says so. */
const FACE_SCALE_TOLERANCE = 0.25;

/**
 * The face map sizes its zones by the face points alone; px_per_mm sizes only the skin's
 * elements. A large disagreement means misplaced points (a guessed hidden eye, a wrong chin)
 * or a wrong px_per_mm, and it is better said before apply. All formulas share one face fit;
 * Fable reports it under fields.faces, Gemini under gemini4_stratum.fits.
 */
function faceScaleNotes(job) {
    for (const formula of Object.values(catalog.FORMULA_DEFINITIONS)) {
        const params = job.coreParams && job.coreParams[formula.id];
        const diagnostics = (job.stats && job.stats[formula.id] && job.stats[formula.id].diagnostics) || {};
        const fits = (diagnostics.fields && diagnostics.fields.faces)
            || (diagnostics.gemini4_stratum && diagnostics.gemini4_stratum.fits);
        if (!params || !(params.pxPerMm > 0) || !Array.isArray(fits) || !fits.length) continue;
        return fits.flatMap((fit, index) => {
            const implied = fit && fit.impliedPxPerMm;
            if (!(implied > 0) || Math.abs(implied / params.pxPerMm - 1) <= FACE_SCALE_TOLERANCE) return [];
            const which = fits.length > 1 ? ` (face ${index + 1})` : '';
            return [`Face map${which}: the face points imply ${implied.toFixed(2)} px/mm, but px_per_mm is `
                + `${params.pxPerMm}; the face zones are sized by the points. Check the eye and chin points or px_per_mm.`];
        });
    }
    return [];
}

/** Preserve each variant's diagnostics while showing a common small layer summary. */
function buildDiagnostics(job) {
    const layers = {}, formulas = {}, notes = [];
    // task20: areola variants report their layer statistics next to the formulas; their bands and
    // geometry are in the job's "areolas" view. An areola-only job lists no skin formula here.
    const layout = job.request && job.request.layout;
    if (layout && layout.areolas) {
        for (const id of Object.keys(AREOLA_DEFINITIONS)) {
            const stats = (job.stats && job.stats[id]) || {};
            for (const [output, layer] of Object.entries(stats.layers || {})) {
                layers[`${id}_${output}`] = { ...layer, mean: Math.round(layer.mean * 1000) / 1000 };
            }
        }
        if (!layout.skin) return { layers, formulas, notes };
    }
    for (const formula of Object.values(catalog.FORMULA_DEFINITIONS)) {
        const stats = (job.stats && job.stats[formula.id]) || {};
        for (const [output, layer] of Object.entries(stats.layers || {})) {
            layers[`${formula.id}_${output}`] = { ...layer, mean: Math.round(layer.mean * 1000) / 1000 };
        }
        const formulaNotes = job.coreParams && job.coreParams[formula.id]
            ? adapter.visibilityNotes(job.coreParams[formula.id], stats) : [];
        formulas[formula.id] = { variant: formula.variant, diagnostics: stats.diagnostics || {}, notes: formulaNotes };
        notes.push(...formulaNotes.map(note => `${formula.name}: ${note}`));
    }
    notes.push(...faceScaleNotes(job));
    return { layers, formulas, notes };
}

module.exports = { publicCore, describeFormulas, buildDiagnostics };
