'use strict';

/**
 * The small variable portion of the Photoshop apply script.
 * Mask acquisition, exchange verification, rollback and history handling stay in their
 * existing paths. Only the hierarchy is driven by the four pinned component descriptors.
 */
const CREATE_HIERARCHY = `
    // Creation follows Photoshop's active insertion context, which may be a hidden
    // existing group. Own a root container before creating any texture components,
    // then place every new object explicitly rather than relying on that context.
    const rootAnchor = doc.layers.length ? doc.layers[0] : null;
    // task31: a body part folder goes inside the common Skin group, either the one checked by
    // FIND_SKIN_GROUP (skin_group_id) or a new root group created here without a mask.
    let partParent = null;
    if (EXPECT.part) {
        partParent = skinTargetGroup;
        if (!partParent) {
            partParent = await doc.createLayerGroup({ name: EXPECT.part.skinName });
            created.push(partParent.id);
            if (rootAnchor) await partParent.move(rootAnchor, C.ElementPlacement.PLACEBEFORE);
            if (!Array.from(doc.layers).some(layer => layer.id === partParent.id)) {
                throw new Error('HIERARCHY_MISMATCH: the common Skin must be a root group');
            }
            partParent.blendMode = C.BlendMode.PASSTHROUGH;
            partParent.opacity = 100;
        }
    }
    // task20: an areola-only job names its outer group "Areolas"; every other job keeps "Skin".
    // task31: a part folder is named by the body part. The masked group is skinGroup either way.
    // Its name ends with the job marker and the seed (" seed 48213"), so the pattern can be redone.
    const skinGroup = await doc.createLayerGroup({ name: (EXPECT.part ? EXPECT.part.folderName : (EXPECT.rootName || 'Skin')) + ' ' + EXPECT.marker + (EXPECT.seedLabel || '') });
    created.push(skinGroup.id);
    if (partParent) {
        await skinGroup.move(partParent, C.ElementPlacement.PLACEINSIDE);
        if (!Array.from(partParent.layers || []).some(layer => layer.id === skinGroup.id)) {
            throw new Error('HIERARCHY_MISMATCH: the part folder must be inside the common Skin');
        }
    } else {
        if (rootAnchor) await skinGroup.move(rootAnchor, C.ElementPlacement.PLACEBEFORE);
        if (!Array.from(doc.layers).some(layer => layer.id === skinGroup.id)) {
            throw new Error('HIERARCHY_MISMATCH: Skin must be a root group');
        }
    }
    skinGroup.blendMode = C.BlendMode.PASSTHROUGH;
    skinGroup.opacity = 100;

    // Inserting inside a group puts the new child first. Build bottom to top while
    // retaining the public descriptors in the Layers panel's top-to-bottom order.
    const formulaIds = Array.from(new Set(EXPECT.components.map(item => item.formulaId)));
    const formulaGroups = [];
    for (const formulaId of formulaIds.slice().reverse()) {
        const components = EXPECT.components.filter(item => item.formulaId === formulaId);
        const group = await doc.createLayerGroup({ name: components[0].formulaName });
        created.push(group.id);
        await group.move(skinGroup, C.ElementPlacement.PLACEINSIDE);
        group.blendMode = C.BlendMode.PASSTHROUGH;
        group.opacity = 100;
        for (const component of components.slice().reverse()) {
            // Select only a group created by this attempt. makeVisible:false prevents
            // selection from revealing other layers or hidden ancestors.
            const selected = await action.batchPlay([{ _obj: 'select',
                _target: [{ _ref: 'layer', _id: group.id }], makeVisible: false
            }], { synchronousExecution: true });
            if ((selected || []).some(item => item && item._obj === 'error')) {
                throw new Error('HIERARCHY_MISMATCH: Could not select the new formula group');
            }
            const layer = await createTexturePixelLayer(component.componentKey);
            await layer.move(group, C.ElementPlacement.PLACEINSIDE);
        }
        group.visible = components[0].visible;
        formulaGroups.unshift({ formulaId, group });
    }
    if (skinGroup.layers.length !== formulaGroups.length || formulaGroups.some(({ formulaId, group }) =>
        !skinGroup.layers.some(child => child.id === group.id)
        || group.layers.length !== EXPECT.components.filter(item => item.formulaId === formulaId).length)) {
        throw new Error('HIERARCHY_MISMATCH: New formula groups have unexpected parents or children');
    }
`;

/** Describe the actual created groups in the same order as the component contract. */
const DESCRIBE_GROUPS = `formulaGroups.map(({ formulaId, group }) => ({
                id: group.id, name: group.name, formulaId,
                blendMode: String(group.blendMode), opacity: group.opacity,
                visible: Boolean(group.visible),
                layers: EXPECT.components.filter(item => item.formulaId === formulaId)
                    .map(item => written.find(layer => layer.componentKey === item.componentKey))
            }))`;

module.exports = { CREATE_HIERARCHY, DESCRIBE_GROUPS };
