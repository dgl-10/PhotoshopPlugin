'use strict';

/**
 * What a job with areolas (task20) means for the job manager: which binaries must have computed
 * it, which components and masks the Photoshop write carries, how the write's answer is checked,
 * and how the job is described to the agent. Kept out of job-manager.js, which calls these at
 * a few fixed points; a job without areolas goes through exactly the task15 values.
 */

const { FORMULA_DEFINITIONS, RECIPE_COMPONENTS } = require('./formula-definitions');
const { AREOLA_DEFINITIONS, CUTOUT_OUTPUT, groupNameOf } = require('./areola-definitions');
const { CUTOUT_VERSION } = require('./areola-engine');
const { ALLOW_AGENT_FORMULA_COMPARISON } = require('./recipe-tool-contract');

const SKIN_LAYOUT = Object.freeze({ components: RECIPE_COMPONENTS, cutout: false, skin: true, areolas: false });

/** Layout of the job; a request built without one has the plain skin layout of task15. */
function layoutOf(job) {
    return job.request.layout || SKIN_LAYOUT;
}

/**
 * Identities the computation must report, in order: areola variants first, then skin formulas.
 *
 * @param {object} job
 * @param {object} formulasCore - Verified identities of the skin formulas (job manager start-up).
 * @returns {object[]}
 */
function expectedCores(job, formulasCore) {
    const layout = layoutOf(job);
    const out = [];
    if (layout.areolas) {
        for (const definition of Object.values(AREOLA_DEFINITIONS)) {
            out.push({ formulaId: definition.id, name: definition.variant, version: definition.variantVersion, sha256: definition.sha256 });
        }
    }
    if (layout.skin) out.push(...formulasCore.formulas);
    return out;
}

/** Pinned identity of the group a component belongs to, skin formula or areola variant. */
function pinOf(component) {
    const formula = FORMULA_DEFINITIONS[component.formulaId];
    if (formula) return { name: formula.variant, version: formula.variantVersion, sha256: formula.sha256 };
    const areola = AREOLA_DEFINITIONS[component.formulaId];
    return { name: areola.variant, version: areola.variantVersion, sha256: areola.sha256 };
}

/**
 * Exchange outputs in the order their files are written: layer components, then the cut-out.
 *
 * @returns {string[]}
 */
function fileOutputs(job) {
    const layout = layoutOf(job);
    const keys = layout.components.map(c => c.componentKey);
    if (layout.cutout) keys.push(CUTOUT_OUTPUT);
    return keys;
}

/**
 * The part of the apply script's EXPECT that depends on the layout.
 *
 * @param {object} job
 * @param {string} recipe
 * @param {Object<string,string>} fileByOutput - Exchange file name of each output.
 * @returns {{ components: object[], masks: object[], rootName: string }}
 */
function applyExpectation(job, recipe, fileByOutput) {
    const layout = layoutOf(job);
    const region = job.areola ? job.areola.region.rect : null;
    const components = layout.components.map(c => {
        const pin = pinOf(c);
        const out = { ...c, file: fileByOutput[c.componentKey], recipeId: recipe,
            coreName: pin.name, coreVersion: pin.version, coreSha256: pin.sha256 };
        // An areola layer covers the region around the areolas, not the whole job rect.
        if (c.kind === 'areola') out.rect = region;
        return out;
    });
    const masks = layout.cutout ? [{
        componentKey: CUTOUT_OUTPUT, kind: 'mask', file: fileByOutput[CUTOUT_OUTPUT], recipeId: recipe,
        formulaId: CUTOUT_OUTPUT, formulaVersion: CUTOUT_VERSION, rect: region,
        // The cut-out goes on every skin formula group, so it follows whichever one is shown.
        targets: Object.keys(FORMULA_DEFINITIONS)
    }] : [];
    return { components, masks, rootName: layout.skin ? 'Skin' : 'Areolas' };
}

/**
 * Check a successful write's answer against the layout: one group per formula or variant, one
 * layer per component, each at its own rectangle, and the cut-out on every skin formula group.
 *
 * @returns {boolean}
 */
function writeIsConsistent(job, structure, layers) {
    const layout = layoutOf(job);
    const rectOf = component => (component.kind === 'areola' ? job.areola.region.rect : job.request.rect);
    const groups = new Set(layout.components.map(c => c.formulaId));
    if (!structure || !structure.mainGroup || !structure.mainGroup.hasUserMask) return false;
    if (!Array.isArray(structure.subgroups) || structure.subgroups.length !== groups.size) return false;
    if (layers.length !== layout.components.length) return false;
    const fits = layers.every(layer => {
        const component = layout.components.find(c => c.componentKey === layer.componentKey);
        if (!component || !Number.isInteger(layer.id) || !layer.bounds) return false;
        const r = rectOf(component);
        return layer.bounds.left === r.x && layer.bounds.top === r.y
            && layer.bounds.right === r.x + r.width && layer.bounds.bottom === r.y + r.height;
    });
    if (!fits) return false;
    if (layout.cutout) {
        const cut = structure.cutout;
        if (!cut || !Array.isArray(cut.groups) || cut.groups.length !== Object.keys(FORMULA_DEFINITIONS).length) return false;
    }
    return true;
}

/**
 * Sentence for the agent after a successful write: what is in the document now.
 * Optional allowAgentComparison parameter exists for unit tests verifying both states.
 */
function appliedText(job, allowAgentComparison = ALLOW_AGENT_FORMULA_COMPARISON) {
    const layout = layoutOf(job);
    const parts = [];
    if (layout.areolas) {
        const ordered = Object.values(AREOLA_DEFINITIONS);
        const visibleGroup = groupNameOf(ordered.find(d => d.visible));
        const names = ordered.map(d => `"${groupNameOf(d)}" (${d.visible ? 'visible' : 'hidden'})`);
        const areolaAction = allowAgentComparison
            ? 'Compare them by showing exactly one areola group.'
            : `Leave "${visibleGroup}" visible and the other areola groups hidden; do not toggle or compare areola variants yourself — let the person compare them.`;
        parts.push(`${layout.skin ? 'Skin' : 'Areolas'} contains the areola groups ${names.join(', ')}, each with the variant's own Nipple, Tubercles and Skin layers at the variant's opacity. ${areolaAction}`);
    }
    if (layout.skin) {
        const skinAction = allowAgentComparison
            ? 'Compare by showing exactly one formula group.'
            : 'Leave Formula 1 visible and Formula 2 and Formula 3 hidden; do not toggle or compare formula variants yourself — let the person compare them.';
        parts.push(`Skin contains visible Formula 1 (Pores, Unevenness), hidden Formula 2 (Pores, Furrows) and hidden Formula 3 (Dermis). All five layers use Linear Light at 50% opacity. ${skinAction}`);
    }
    if (layout.cutout) {
        parts.push('Each formula group has a soft mask that removes the general skin texture under the areolas across the band the areola variants reported; outside that band the mask is white.');
    }
    const tailAction = allowAgentComparison
        ? 'Adjust strength with layer opacity using the returned IDs.'
        : 'Do not switch variants or tune opacity yourself unless the person explicitly asked.';
    parts.push(`One common mask from mask_source is on the outer group. One Undo removes the complete History step. Repeated apply never writes again. ${tailAction}`);
    return parts.join(' ');
}

/**
 * The areola part of a job description: variants and versions, what geometry went in (and which
 * members Helper filled), where it was computed and the bands each variant reported.
 */
function describeAreolas(job) {
    const layout = layoutOf(job);
    if (!layout.areolas) return null;
    const out = {
        strength: job.request.areolaStrength,
        records: job.request.fields.areolas,
        variants: Object.values(AREOLA_DEFINITIONS).map(d => {
            const core = job.computedCores && job.computedCores[d.id];
            const stats = job.stats && job.stats[d.id];
            const entries = stats && stats.diagnostics && Array.isArray(stats.diagnostics.areolas) ? stats.diagnostics.areolas : null;
            return {
                id: d.id, label: d.label, group: groupNameOf(d), visible: d.visible,
                variant: d.variant, variant_version: d.variantVersion, sha256: d.sha256,
                computed_sha256: core ? core.sha256 : null,
                layers: d.layers.map(l => l.layerName),
                transition: entries ? entries.map(e => e && e.transition) : null,
                understood: entries ? entries.map(e => e && {
                    diameterMm: e.diameterMm, diameterUsedMm: e.diameterUsedMm, pxPerMmUsed: e.pxPerMmUsed,
                    nippleMoved: e.nippleMoved, tubercles: e.tubercles }) : null
            };
        }),
        general_skin_cut_out: layout.cutout
    };
    if (job.areola) out.region = job.areola.region.rect;
    return out;
}

module.exports = { expectedCores, fileOutputs, applyExpectation, writeIsConsistent, appliedText, describeAreolas };
