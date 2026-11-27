'use strict';

/**
 * Skin texture by body parts (task31): the body part words an agent may pass, the zones that
 * never get the general texture, the check of a start request's body part, and the guide the
 * agent reads before splitting a body into folders (ps_skin_texture_body_parts).
 *
 * Where the rules come from: the task29 research (two independent reports and their
 * consolidation, 27 November 2026, in the skin_texture planning folder) and the author's
 * decisions on it. The agent decides the split by looking at the picture; the guide gives
 * reasons and first-try numbers, not a fixed recipe. Numbers marked as a first try or an
 * average were not measured in Photoshop.
 *
 * The body part word is also what a future formula will receive as its zone (see
 * recipe-catalog.js zoneFor): the words here are the formula-facing vocabulary, so renaming
 * one later breaks that contract.
 */

// 2: the seed section (a random seed per task, kept for redoing parts of the same picture).
// 3: Helper adds the rect margin itself; the agent passes a rect just around the mask.
const GUIDE_VERSION = 3;

/** Below this scale pores are smaller than a pixel; the agent must ask the person first. */
const DEFAULT_MIN_BODY_PX_PER_MM = 2;

/** Folder names: short, printable, without the brackets Helper uses for its job marker. */
const PART_NAME_PATTERN = /^[^\[\]\u0000-\u001f\u007f]{1,40}$/;

const BODY_PARTS = Object.freeze({
    face: Object.freeze({
        folder: 'Face',
        covers: 'Facial skin from the hairline to the jaw and chin.',
        cut_out: 'Eyes with the eyelid rims, eyebrows, nostrils, lips, beard and hair. A small ear in focus may stay inside.',
        notes: 'Pass fields.face (six points) so both formulas use the face map; the hidden Face Map layer goes into this folder.'
    }),
    neck: Object.freeze({
        folder: 'Neck',
        covers: 'From the shadow under the jaw and behind the ears down to the collarbones in front and the base of the neck at the back.',
        cut_out: 'Hair, collars and jewellery.',
        notes: 'Light wraps around the neck; the shadow under the chin does not break the mask.'
    }),
    chest: Object.freeze({
        folder: 'Chest',
        covers: 'From the collarbones down to the fold under the breasts, the breasts included.',
        cut_out: 'Clothing. The areolas are cut out by Helper when fields.areolas is passed.',
        notes: 'One folder for both sides: do not cut at the breastbone. Pass fields.areolas here to get the areola groups and the soft cut-out of the general skin under them.'
    }),
    abdomen: Object.freeze({
        folder: 'Abdomen',
        covers: 'From under the breasts down to the groin folds and the hip bones, with the ribs, waist and sides.',
        cut_out: 'Pubic hair and genitals. The navel stays inside, weaker towards its depth.',
        notes: 'Bare pubic skin may be the lower edge of this folder, fading towards the groin.'
    }),
    back: Object.freeze({
        folder: 'Back',
        covers: 'From the base of the neck and the back of the shoulders down to the sacrum.',
        cut_out: 'Hair falling over the back and straps.',
        notes: 'One large surface; usually easy to select.'
    }),
    buttocks: Object.freeze({
        folder: 'Buttocks',
        covers: 'From the sacrum and the hip crest down to the fold under the buttocks.',
        cut_out: 'Genitals and the cleft depth when it is in shadow.',
        notes: 'Usually one folder; split the sides when their visibility or light differ.'
    }),
    arm: Object.freeze({
        folder: 'Arms',
        covers: 'From the shoulder joint through the elbow to the wrist crease.',
        cut_out: 'Sleeves, bracelets; the armpit is weakened or left out.',
        notes: 'No visible border between upper arm and forearm on bare skin: one folder per arm or per pair (Arms, Arm L, Arm R). Split the arm only when its parts are at clearly different depth.'
    }),
    hand_dorsal: Object.freeze({
        folder: 'Hands',
        covers: 'The back of the hand and the fingers from the wrist crease.',
        cut_out: 'Palm and the palm side of the fingers, nails, rings.',
        notes: 'A hand reaching towards the camera needs its own px_per_mm.'
    }),
    leg: Object.freeze({
        folder: 'Legs',
        covers: 'From the groin and buttock folds through the knee to the ankle.',
        cut_out: 'Stockings (even sheer ones), straps, shoes.',
        notes: 'Same rule as the arm: split thigh and shin only when they are at clearly different depth (sitting, strong foreshortening).'
    }),
    foot_dorsal: Object.freeze({
        folder: 'Feet',
        covers: 'The top of the foot and the toes from the ankle.',
        cut_out: 'Sole, heel, nails and shoes.',
        notes: 'Where the sole and the top of the foot meet is a hard border, not a soft band.'
    }),
    scalp: Object.freeze({
        folder: 'Scalp',
        covers: 'Bare scalp, and a large ear in focus that is not inside the Face folder.',
        cut_out: 'Hair, stubble that reads as hair, the ear canal.',
        notes: 'A small ear stays with the face or the neck.'
    })
});

/**
 * Words that name places the general texture never covers. An agent passing one of them gets
 * the reason instead of the generic "unknown body part".
 */
const NO_TEXTURE_RULES = Object.freeze({
    palms: 'Palms, the palm side of the fingers, soles and heels have ridged skin: the general texture would draw a wrong pattern there. Cut them out of the hand and foot masks; a formula of their own may come later.',
    face_features: 'Lips, eyes with the eyelid rims and eyebrows get no texture: cut them out of the Face mask.',
    genitals: 'Genitals and mucosa get no texture and stay out of every mask. Bare pubic skin may be the lower edge of Abdomen, fading towards the groin; pubic hair is cut out.',
    areolas: 'Areolas and nipples have their own formulas: pass fields.areolas with body_part "chest", or use recipe "areola_v1" and place it into the common Skin with skin_group_id at apply.',
    not_skin: 'Hair, nails, rings, clothing, sheer stockings and gloves are not skin: keep them out of every mask.'
});

const NO_TEXTURE_WORDS = Object.freeze({
    palm: 'palms', palms: 'palms', sole: 'palms', soles: 'palms', heel: 'palms', heels: 'palms',
    lip: 'face_features', lips: 'face_features', mouth: 'face_features', eye: 'face_features', eyes: 'face_features',
    eyelid: 'face_features', eyelids: 'face_features', eyebrow: 'face_features', eyebrows: 'face_features',
    genital: 'genitals', genitals: 'genitals', genitalia: 'genitals', mucosa: 'genitals', pubis: 'genitals', groin: 'genitals',
    areola: 'areolas', areolas: 'areolas', nipple: 'areolas', nipples: 'areolas',
    hair: 'not_skin', nail: 'not_skin', nails: 'not_skin'
});

/**
 * Check the body part members of a start request. Without body_part the request is the
 * unchanged single-group request of earlier tasks, so its companions are refused alone.
 *
 * @param {object} args - Tool arguments.
 * @param {object} context
 * @param {string} context.recipe - The request's recipe.
 * @param {string} context.areolaRecipe - The areola-only recipe id.
 * @param {object|null} context.fields - Normalized fields.
 * @param {(code: string, message: string) => never} fail - Throws the request error.
 * @returns {{ bodyPart: object|null, smallScaleConfirmed: boolean }}
 */
function normalizeBodyPart(args, { recipe, areolaRecipe, fields }, fail) {
    const confirmed = args.small_scale_confirmed;
    if (confirmed !== undefined && typeof confirmed !== 'boolean') {
        fail('INVALID_BODY_PART', 'small_scale_confirmed must be true or false.');
    }
    if (args.body_part === undefined) {
        if (args.part_name !== undefined) fail('INVALID_BODY_PART', 'part_name needs body_part.');
        if (confirmed !== undefined) fail('INVALID_BODY_PART', 'small_scale_confirmed belongs to a request with body_part.');
        return { bodyPart: null, smallScaleConfirmed: false };
    }
    if (typeof args.body_part !== 'string') fail('INVALID_BODY_PART', `body_part must be one of: ${Object.keys(BODY_PARTS).join(', ')}.`);
    const code = args.body_part.trim().toLowerCase();
    if (NO_TEXTURE_WORDS[code]) fail('NO_TEXTURE_ZONE', `body_part "${args.body_part}": ${NO_TEXTURE_RULES[NO_TEXTURE_WORDS[code]]} Nothing was computed.`);
    const part = BODY_PARTS[code];
    if (!part) {
        fail('INVALID_BODY_PART', `Unknown body_part "${args.body_part}". Use one of: ${Object.keys(BODY_PARTS).join(', ')}; `
            + 'ps_skin_texture_body_parts describes each of them.');
    }
    if (recipe === areolaRecipe) {
        fail('INVALID_BODY_PART', `recipe ${areolaRecipe} has its own folder "Areolas": leave body_part out, and place it into the common Skin with skin_group_id at ps_skin_texture_apply.`);
    }
    if (fields && fields.face && code !== 'face') fail('INVALID_FIELDS', `fields.face belongs to body_part "face", not "${code}".`);
    if (fields && fields.areolas && code !== 'chest') fail('INVALID_FIELDS', `fields.areolas belongs to body_part "chest", not "${code}".`);
    let name = part.folder;
    if (args.part_name !== undefined) {
        const trimmed = typeof args.part_name === 'string' ? args.part_name.trim() : '';
        if (!PART_NAME_PATTERN.test(trimmed)) {
            fail('INVALID_BODY_PART', 'part_name must be 1-40 printable characters without [ or ], for example "Arm L".');
        }
        name = trimmed;
    }
    return { bodyPart: { code, name }, smallScaleConfirmed: confirmed === true };
}

/**
 * The scale check of a body part request: below the limit nothing is computed until the
 * agent has told the person and passes the person's yes.
 *
 * @returns {string|null} The refusal text, or null when the request may be computed.
 */
function smallScaleRefusal(bodyPart, pxPerMm, smallScaleConfirmed, minPxPerMm = DEFAULT_MIN_BODY_PX_PER_MM) {
    if (!bodyPart || smallScaleConfirmed || pxPerMm >= minPxPerMm) return null;
    return `px_per_mm ${pxPerMm} is below ${minPxPerMm} px/mm: at this scale pores are smaller than a pixel and the `
        + 'formulas fade them, so the texture may be hardly visible. Nothing was computed. Tell the person this '
        + `scale for "${bodyPart.name}" and ask whether to apply the texture anyway. Do not raise px_per_mm to make the `
        + 'texture visible. Only if the person says yes, call ps_skin_texture_start again with the same arguments '
        + 'and small_scale_confirmed: true.';
}

/**
 * The guide returned by ps_skin_texture_body_parts.
 *
 * @param {number} [minPxPerMm] - The scale limit the job manager uses.
 * @returns {object}
 */
function buildGuide(minPxPerMm = DEFAULT_MIN_BODY_PX_PER_MM) {
    return {
        guide_version: GUIDE_VERSION,
        summary: [
            'Split the visible skin into body part folders inside one common Skin group. Each folder is one ps_skin_texture_start plus one ps_skin_texture_apply: its own rect, mask and px_per_mm, and in Photoshop its own opacity.',
            'You decide the split by looking at the picture. The rules below give the reasons; they are not a fixed recipe.',
            'The formulas do not distinguish body parts yet: every part gets the base skin texture now. Still pass the right body_part: it names the folder and future formulas will use it.'
        ],
        parts: Object.entries(BODY_PARTS).map(([body_part, p]) => ({ body_part, default_folder: p.folder, covers: p.covers, cut_out: p.cut_out, notes: p.notes })),
        no_texture: Object.values(NO_TEXTURE_RULES),
        folders: [
            'A folder is what you capture together in one mask: a whole arm is one folder, an arm done in pieces is several; both arms together are one folder, done separately they are two. Name it with part_name.',
            'Start a new folder only where something changes: the kind of skin (another body_part), the shape and the light, the distance to the camera (another px_per_mm), or at a natural fold where the seam hides by itself (jaw, armpit, fold under the breasts, wrist, groin, fold under the buttocks, ankle).',
            'Pairs (arms, hands, legs, feet, breasts, buttocks): one folder by default. Split into sides when they differ in scale, focus or light, or when one overlaps the other. Name the sides by the person\'s own left and right: "Arm L", "Arm R".',
            'Elbows, knees, the navel and skin folds stay inside the neighbouring parts.',
            'Only visible skin gets a folder. A fully hidden part gets no folder and no question. A sliver of a far side only a few pixels wide is better left out of the mask than covered with unreadable noise.',
            'Pass a rect just around the folder\'s mask. Helper itself widens it on every side by a margin of skin, so the person can widen a mask that came out too tight and still find texture under it. Do not add a margin of your own.',
            'One rect holds at most 4096 x 4096 pixels. A part that does not fit becomes two folders split at a fold, with complementary masks. Near that limit Helper reduces the margin and says so.',
            'Areolas: pass fields.areolas with body_part "chest" (the Chest folder then holds the areola groups and the cut-out), or compute recipe "areola_v1" and place it into the same Skin with skin_group_id.'
        ],
        masks: [
            'First build one mask of all visible skin, with an outer edge as crisp as the photo\'s own edge (about 0.5-1.5 px), against the background, clothing, hair, nails and the no-texture zones.',
            'Then split that one mask between neighbouring folders so that at every pixel their shares add up to the skin mask: 70% for one part means 30% for its neighbour. A gap leaves a smooth band, an overlap a harsher one. Where three parts meet (shoulder, neck, back) the same rule holds for all three.',
            'Put the border into a natural fold where there is one. On smooth skin without a fold (top of the shoulder between chest and arm, the side between abdomen and back) use a shared soft band.',
            'Band width, a first try not yet checked in Photoshop: about 8-20 mm of skin when both sides use the same px_per_mm; 3-8 mm, and not less than 3-4 px, when the scales differ. Count it in millimetres through px_per_mm, not as one pixel radius for the whole body.',
            'Skin over skin (a hand on the belly, an arm in front of the chest, crossed legs): a hard cut along the edge of the front part, 1-2 px. The back part has a hole there and shows again in the gaps, between fingers for example. A cast shadow does not break a mask.',
            'Keep tattoos, moles and scars inside the mask; the person may weaken the texture over them.',
            'The pattern on both sides of a seam is not guaranteed to line up, even with the same seed: look at the seams at 100% after applying.',
            'Each folder takes its mask through mask_source, as an active selection or the pixel mask of a layer. Masks are yours to make and the person\'s to correct: when the person has edited a mask, do not re-split its neighbours yourself.'
        ],
        scale: [
            'Give every folder its own px_per_mm, measured on a size in the same plane as that part. A limb reaching towards the camera needs its own value.',
            'Averages from the task29 research (sources not checked; use them only when nothing better is visible): pupil distance 63 mm (reliable); head from chin to crown 220-230 mm; standing height without heels about 1650 mm for women and 1770 mm for men (wrong for a sitting figure); hand from the wrist crease to the middle fingertip about 175 / 190 mm; areola diameter about 40 mm (it varies from 25 to 60 mm: a rough estimate).',
            'When your estimate may be off by more than about 30%, tell the person in one line which measure you used.',
            'Never raise px_per_mm to make the texture more visible.',
            `Below ${minPxPerMm} px/mm (a full-length figure about 1700 px tall is about 1 px/mm) pores are smaller than a pixel and the formulas fade them. Helper refuses such a part until you have told the person and asked whether to apply it anyway; pass small_scale_confirmed: true only after the person said yes.`
        ],
        seed: [
            'The seed decides where pores and furrows lie. Never make one up. Leave params.seed out and Helper picks a random seed once per task, the same for every part of that task. It is written into the folder names, for example "Arm L [skt-...] seed 48213", and into the common group, "Skin seed 48213".',
            'Parts of one picture share one seed: with the same seed and the same px_per_mm the pattern of neighbouring parts lines up across their seams, and a part redone with a larger rect keeps exactly the same pattern where it already was.',
            'To redo or add a part of a picture that already has a Skin group, in this task or a new one, pass the seed from that group\'s name as params.seed. A part with another seed is refused when it is placed into that Skin.',
            'A new seed only when the person asks for a different pattern: then pass seed_change_confirmed: true at apply. Different pictures, even of the same person, get different seeds: the pattern is tied to the pixels of the picture, not to the body.'
        ],
        light_and_focus: [
            'Use the same light (azimuthDeg, elevationDeg) for every part of one picture.',
            'Strongly blurred skin (far out of focus) is better left out of the mask. Moderately blurred skin goes into its own folder; tell the person it may need a lower opacity.',
            'Leave every folder at 100% opacity unless the person asks: the person tunes the strength of each folder.'
        ],
        asking_the_person: [
            'Ask about the one disputed piece, not about the whole mask, for example "Outline the edge of the near forearm from the wrist to the elbow". Carry on with the other parts meanwhile.',
            'Typical cases: skin over skin, strands of hair over skin, stockings or fabric in skin tone, very pale edges, and a vision model that refuses to look at an explicit crop (the person then paints the area locally in Photoshop; nothing is sent anywhere).',
            `Below ${minPxPerMm} px/mm: tell the person and ask before computing.`
        ],
        workflow: [
            'Look at the picture and plan the folders: body_part, part_name, rect and px_per_mm for each.',
            'Build the skin mask and split it into the folder masks.',
            'For each folder: ps_skin_texture_start with body_part, part_name, rect, px_per_mm and the shared light (Face: fields.face; Chest with areolas: fields.areolas; params.seed only as described under seed). Poll ps_skin_texture_status until ready, then ps_skin_texture_apply with mask_source. One computation runs per task at a time and only two ready results are kept, so apply each part before starting more.',
            'The first apply creates the common group ("Skin seed N") and returns its id in apply.structure.skinGroup.id. Pass it as skin_group_id to every later apply, so all parts land in the same Skin.',
            'Look at the result with ps_get_image, the seams above all, and tell the person in one line what was estimated (scales, borders).'
        ],
        certainty: 'Checked by automated tests: Helper builds the folders as described. Not yet checked in Photoshop on a full-length picture: band widths, the averages for scale, and how well masks made by an agent work.'
    };
}

module.exports = {
    GUIDE_VERSION,
    DEFAULT_MIN_BODY_PX_PER_MM,
    BODY_PARTS,
    NO_TEXTURE_RULES,
    NO_TEXTURE_WORDS,
    normalizeBodyPart,
    smallScaleRefusal,
    buildGuide
};
