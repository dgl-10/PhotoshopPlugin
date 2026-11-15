'use strict';

/**
 * The small variable portion of the Photoshop apply script.
 * Mask acquisition, exchange verification, rollback and history handling stay in their
 * existing paths. Only the hierarchy is driven by the five pinned component descriptors.
 */
const CREATE_HIERARCHY = `
    // Creation follows Photoshop's active insertion context, which may be a hidden
    // existing group. Own a root container before creating any texture components,
    // then place every new object explicitly rather than relying on that context.
    const rootAnchor = doc.layers.length ? doc.layers[0] : null;
    const skinGroup = await doc.createLayerGroup({ name: 'Skin ' + EXPECT.marker });
    created.push(skinGroup.id);
    if (rootAnchor) await skinGroup.move(rootAnchor, C.ElementPlacement.PLACEBEFORE);
    if (!Array.from(doc.layers).some(layer => layer.id === skinGroup.id)) {
        throw new Error('HIERARCHY_MISMATCH: Skin must be a root group');
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
