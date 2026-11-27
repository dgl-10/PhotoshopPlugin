'use strict';

/**
 * Fragments of the single-history-step apply script (recipe-uxp-builder.js) for task31: a body
 * part folder written into the common Skin group.
 *
 * EXPECT.part is null for a job written as before (its own root group). For a body part job,
 * and for an areola-only job placed into a common Skin, it is
 * { folderName, skinGroupId, skinName, seed, seedChangeConfirmed }: skinGroupId is null when this
 * write creates the common root group itself (named skinName), or the id the agent passed as
 * skin_group_id.
 *
 * SKIN_GROUP_GROWTH runs with the scene guard, before the try block: adding a folder to an
 * existing group grows that group's bounds and those of its parent groups, which is this
 * write's own change and not a change of the person's layers. Their bounds are therefore left
 * out of the scene snapshot; everything else about them (name, visibility, opacity, blend
 * mode, children) is still compared. Without a skin_group_id the set is empty.
 *
 * FIND_SKIN_GROUP runs before anything is created: the named group must be a group of this
 * document without a mask of its own (a masked group, such as the root of an older single
 * Skin, would hide the new part outside that mask), and the seed in its name, when it has one,
 * must be the part's seed unless the person asked for another pattern (EXPECT.part.seed,
 * seedChangeConfirmed). Output: skinTargetGroup (or null).
 */
const SKIN_GROUP_GROWTH = `
const skinGrowing = new Set();
if (EXPECT.part && Number.isInteger(EXPECT.part.skinGroupId)) {
    (function skinMarkGrowing(container, chain) {
        for (const layer of Array.from(container.layers || [])) {
            const path = chain.concat(layer.id);
            if (layer.id === EXPECT.part.skinGroupId) path.forEach(id => skinGrowing.add(id));
            else if (layer.layers) skinMarkGrowing(layer, path);
        }
    })(doc, []);
}
`;

const FIND_SKIN_GROUP = `
    let skinTargetGroup = null;
    if (EXPECT.part && EXPECT.part.skinGroupId !== null) {
        const wanted = EXPECT.part.skinGroupId;
        skinTargetGroup = skinAllLayers(doc).find(layer => layer.id === wanted) || null;
        if (!skinTargetGroup) {
            return skinRefuse('SKIN_GROUP_NOT_FOUND', 'skin_group_id ' + wanted + ' is not a layer of this document. Pass the id of the common Skin group (apply.structure.skinGroup.id of an earlier body part), or leave skin_group_id out to create a new Skin group. Nothing was changed.');
        }
        if (skinTargetGroup.kind !== C.LayerKind.GROUP || !skinTargetGroup.layers) {
            return skinRefuse('SKIN_GROUP_NOT_A_GROUP', 'skin_group_id ' + wanted + ' ("' + skinTargetGroup.name + '") is not a layer group. Pass the id of the common Skin group. Nothing was changed.');
        }
        let skinTargetDesc = null;
        try {
            [skinTargetDesc] = await action.batchPlay([{ _obj: 'get',
                _target: [{ _ref: 'layer', _id: wanted }, { _ref: 'document', _id: doc.id }] }], { synchronousExecution: false });
        } catch (err) {
            return skinRefuse('SKIN_GROUP_READ_FAILED', 'Could not read group ' + wanted + ': ' + String((err && err.message) || err) + '. Nothing was changed.');
        }
        if (skinTargetDesc && skinTargetDesc.hasUserMask === true) {
            return skinRefuse('SKIN_GROUP_HAS_MASK', 'Group "' + skinTargetGroup.name + '" (' + wanted + ') has its own mask, which would hide this part outside it. Pass the common Skin group created by the first body part (it has no mask), or leave skin_group_id out to create a new one. Nothing was changed.');
        }
        // The seed in the common group's name is the picture's pattern; a part with another seed
        // would not line up with its neighbours. A group without a seed in its name is not checked.
        const skinSeedMatch = /(?:^|\\s)seed (\\d+)(?:\\s|$)/.exec(String(skinTargetGroup.name));
        if (skinSeedMatch && Number(skinSeedMatch[1]) !== EXPECT.part.seed && !EXPECT.part.seedChangeConfirmed) {
            return skinRefuse('SEED_MISMATCH', 'Group "' + skinTargetGroup.name + '" uses seed ' + skinSeedMatch[1] + ', but this part was computed with seed ' + EXPECT.part.seed + ', so its pattern would not line up with its neighbours. Start this part again with params.seed ' + skinSeedMatch[1] + '. Only if the person asked for a different pattern for this part, apply again with seed_change_confirmed: true. Nothing was changed.');
        }
    }
`;

module.exports = { SKIN_GROUP_GROWTH, FIND_SKIN_GROUP };
