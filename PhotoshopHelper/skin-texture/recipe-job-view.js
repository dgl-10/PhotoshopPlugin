'use strict';

/**
 * Describe the three independent variants without inventing shared kernel diagnostics.
 * Startup identities are verified on disk; completed job identities come from the actual
 * formula workers and must match those pins before the job becomes ready.
 */
const catalog = require('./recipe-catalog');
const adapter = require('./core-adapter');

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

/** Preserve each variant's diagnostics while showing a common small layer summary. */
function buildDiagnostics(job) {
    const layers = {}, formulas = {}, notes = [];
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
    return { layers, formulas, notes };
}

module.exports = { publicCore, describeFormulas, buildDiagnostics };
