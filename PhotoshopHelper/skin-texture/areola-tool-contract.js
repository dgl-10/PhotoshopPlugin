'use strict';

/**
 * Tool texts and schemas added by task20 (areolas). Proposed to the author on 20 November 2026
 * (task20-output/mcp-texts-proposal.md in the planning folder); the approved task15 texts in
 * recipe-tool-contract.js are extended, not rewritten: each addition is appended to its text.
 */

const { AREOLA_DEFINITIONS, groupNameOf } = require('./areola-definitions');

// Group names and their order come from the pinned definitions, so the text always names what
// Photoshop shows: the visible group first, then the hidden ones, top to bottom.
const ORDERED = Object.values(AREOLA_DEFINITIONS);
const VISIBLE_GROUP = groupNameOf(ORDERED.find(d => d.visible));
const HIDDEN_GROUPS = ORDERED.filter(d => !d.visible).map(d => `"${groupNameOf(d)}"`).join(' and ');
const AUTHORS = ORDERED.map(d => `${groupNameOf(d)} is ${d.label} (${d.variant} ${d.variantVersion})`).join(', ');

const ADDITIONS = Object.freeze({
    start: ` Optional fields.areolas (1 or 2 records, document pixels, as returned by ps_skin_texture_find_areolas): { areola: { center: [x,y], radii: [rx,ry], angleDeg }, nipple: [x,y], nippleRadiusPx }. With them the job also computes three nipple and areola micro-relief variants on the region around the areolas: Skin then also contains "${VISIBLE_GROUP}" (visible), ${HIDDEN_GROUPS} (hidden) in the order of the face formulas (${AUTHORS}), each with its own Nipple, Tubercles and areola Skin layers, and every formula group gets a soft mask that removes the general texture under the areolas.` + ' recipe "areola_three_v1" computes the areola groups only, inside a group "Areolas". Each areola with its edge band must lie inside rect. params.areolaStrength (0-20, default 1) is the variants\' strength. Optional sources records where geometry, nipple, scale and light came from, each { kind: measured | given | estimated | default, note }; the job result repeats it. Light left out is reported as the default.',
    status: ' With areolas, "areolas" lists each variant, its version and SHA-256, the geometry sent, the region computed and the transition band each variant reported, and "sources" says what was measured, given, estimated or default.',
    apply: ` With areolas the same single write also creates the areola groups (only "${VISIBLE_GROUP}" visible) and the soft cut-out mask on every formula group; for recipe areola_three_v1 the outer group is "Areolas". Compare areola variants by showing exactly one areola group.`,
    params: ' areolaStrength (0-20, default 1, only with fields.areolas).',
    recipe: 'Optional recipe. Default "skin_three_v2": three generation-2 formulas and five texture layers, plus the areola groups when fields.areolas is given. "areola_three_v1": the areola groups only.',
    fields: 'Optional fields. face (six facial landmarks, Formula 1 only) and/or areolas (1-2 records for the areola variants). Use the same document coordinates for every rectangle of one document.'
});

const FIND_DESCRIPTION = 'Find and measure the areolas and nipples of the task\'s document locally in Helper, for fields.areolas of ps_skin_texture_start. You get numbers only, never pixels. source "image" (default) analyses the document pixels: pass hints with the rough centre of each areola you see (and its rough radius if you can tell), in document pixels, so Helper measures the right place; without hints Helper searches by itself, which is less reliable. source "selection" fits an ellipse to each separate part of the active selection: use it when the person selected the areola (Elliptical Marquee or Lasso); a hole cut out of a selected part marks the nipple, otherwise Helper measures the nipple and the light on the pixels inside and around the selected outline. The answer gives, per areola: the record for fields.areolas, a confidence (high, medium, low) with its reasons, whether the nipple was found, and how much of the edge is visible. It also gives the light direction (estimated from the nipple and the breast shading, or the default 315/45 when they disagree), a px_per_mm estimated from a typical 40 mm areola (always an estimate; use the person\'s measure when there is one), a ready sources object for ps_skin_texture_start, and next_step with what to do and what to tell the person: apply (compute and apply, then report in one line what was estimated), apply_then_check (apply, then ask the person to look), ask_first (one question before computing), or ask_for_selection (ask the person to select the areola with the Elliptical Marquee or Lasso, then call again with source "selection"). Light azimuth is measured in document pixels from the x axis towards y (y down): 0 is light from the right, 270 from above.';

/** Apply the task20 additions to the rendered task15 descriptions. */
function extendDescriptions(descriptions) {
    return {
        ...descriptions,
        start: descriptions.start + ADDITIONS.start,
        status: descriptions.status + ADDITIONS.status,
        apply: descriptions.apply + ADDITIONS.apply,
        params: descriptions.params + ADDITIONS.params,
        recipe: ADDITIONS.recipe,
        fields: ADDITIONS.fields,
        find: FIND_DESCRIPTION
    };
}

const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };

/** fields with the task15 face and the task20 areolas; at least one of them. */
function buildFieldsSchema(descriptions, faceSchema) {
    return {
        type: 'object', description: descriptions.fields,
        properties: {
            face: faceSchema.properties.face,
            areolas: {
                type: 'array', minItems: 1, maxItems: 2,
                description: 'Areola records in document pixels (SkinBench contract section 10).',
                items: {
                    type: 'object',
                    properties: {
                        areola: {
                            type: 'object',
                            properties: {
                                center: point,
                                radii: { type: 'array', items: { type: 'number', minimum: 1 }, minItems: 2, maxItems: 2 },
                                angleDeg: { type: 'number' }
                            },
                            required: ['center', 'radii'], additionalProperties: false
                        },
                        nipple: point,
                        nippleRadiusPx: { type: 'number', minimum: 0.25 }
                    },
                    required: ['areola'], additionalProperties: false
                }
            }
        },
        additionalProperties: false
    };
}

const SOURCE_ENTRY = {
    type: 'object',
    properties: { kind: { type: 'string', enum: ['measured', 'given', 'estimated', 'default'] }, note: { type: 'string', maxLength: 300 } },
    required: ['kind'], additionalProperties: false
};

const SOURCES_SCHEMA = {
    type: 'object',
    description: 'Where each parameter came from; repeated in the job result.',
    properties: { geometry: SOURCE_ENTRY, nipple: SOURCE_ENTRY, scale: SOURCE_ENTRY, light: SOURCE_ENTRY },
    additionalProperties: false
};

function buildFindTool(description) {
    return {
        name: 'ps_skin_texture_find_areolas',
        description,
        inputSchema: {
            type: 'object',
            properties: {
                task_id: { type: 'string' },
                source: { type: 'string', enum: ['image', 'selection'], description: 'image (default): measure on the document pixels; selection: fit to the active selection.' },
                hints: {
                    type: 'array', minItems: 1, maxItems: 2,
                    description: 'Rough areola positions you see, document pixels; image source only.',
                    items: {
                        type: 'object',
                        properties: { center: point, radius: { type: 'number', minimum: 3 } },
                        required: ['center'], additionalProperties: false
                    }
                },
                area: {
                    type: 'object', description: 'Optional search area in integer document pixels; image source only.',
                    properties: { x: { type: 'integer' }, y: { type: 'integer' }, width: { type: 'integer', minimum: 8 }, height: { type: 'integer', minimum: 8 } },
                    required: ['x', 'y', 'width', 'height'], additionalProperties: false
                }
            },
            required: ['task_id'],
            additionalProperties: false
        }
    };
}

module.exports = { extendDescriptions, buildFieldsSchema, SOURCES_SCHEMA, buildFindTool };
