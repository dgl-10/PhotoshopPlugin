'use strict';

/**
 * Fragment of the single-history-step apply script (recipe-uxp-builder.js) for task20: the soft
 * cut-out of the general skin texture under the areolas.
 *
 * Where it runs: after the hierarchy exists and the common mask is on the outer group, inside
 * the same try block, so any failure rolls the whole write back like every other step.
 *
 * What it does: every skin formula group named by the cut-out gets its own pixel mask, white
 * (reveal all) everywhere, with the cut-out's gray values written over the region around the
 * areolas. The mask goes on each formula group rather than on Skin, so Skin keeps exactly the
 * common mask from mask_source (its meaning, including the limits of the edited area, does not
 * change), and the cut-out follows whichever formula group is shown. The written mask is read
 * back and compared value by value; a mismatch is a failed write, never a silent difference.
 *
 * 8-bit documents take the 8-bit mask as it is; 16-bit documents take Photoshop's reduced
 * 16-bit range through the same mapping the texture layers use (exchange.js to16 / from16).
 *
 * Inputs from the enclosing script: EXPECT.masks, planes, formulaGroups, doc, imaging, action,
 * sixteen, X (the exchange module). Output: the array cutoutGroups (group ids that got the mask).
 */
const CUTOUT_MASKS = `
    const cutoutGroups = [];
    for (const maskItem of (EXPECT.masks || [])) {
        const plane = planes[maskItem.componentKey];
        if (!plane) throw new Error('MISSING_COMPONENT: cut-out ' + maskItem.componentKey + ' not prepared');
        const mr = maskItem.rect;
        const targets = formulaGroups.filter(item => maskItem.targets.indexOf(item.formulaId) !== -1);
        if (targets.length !== maskItem.targets.length) throw new Error('HIERARCHY_MISMATCH: a formula group for the cut-out is missing');
        let values;
        if (sixteen) {
            values = new Uint16Array(plane.gray.length);
            for (let i = 0; i < plane.gray.length; i++) values[i] = X.to16(plane.gray[i]);
        } else {
            values = new Uint8Array(plane.gray);
        }
        for (const target of targets) {
            const group = target.group;
            const made = await action.batchPlay([
                { _obj: 'select', _target: [{ _ref: 'layer', _id: group.id }], makeVisible: false },
                {
                    _obj: 'make',
                    at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
                    new: { _class: 'channel' },
                    using: { _enum: 'userMaskEnabled', _value: 'revealAll' }
                }
            ], { synchronousExecution: true });
            const madeError = (made || []).find(item => item && item._obj === 'error');
            if (madeError) throw new Error('CUTOUT_MASK_INIT_FAILED: ' + madeError.message);
            const maskData = await imaging.createImageDataFromBuffer(values, {
                width: mr.width, height: mr.height, components: 1, chunky: false,
                colorProfile: 'Gray Gamma 2.2', colorSpace: 'Grayscale'
            });
            try {
                await imaging.putLayerMask({ documentID: doc.id, layerID: group.id, kind: 'user',
                    imageData: maskData, replace: false, targetBounds: { left: mr.x, top: mr.y } });
            } finally {
                maskData.dispose();
            }
            const back = await imaging.getLayerMask({ documentID: doc.id, layerID: group.id, kind: 'user',
                sourceBounds: { left: mr.x, top: mr.y, right: mr.x + mr.width, bottom: mr.y + mr.height } });
            if (!back || !back.imageData) throw new Error('CUTOUT_MASK_WRITE_FAILED: no mask on ' + group.name);
            const data = await back.imageData.getData();
            const sb = back.sourceBounds;
            back.imageData.dispose();
            if (!sb || sb.left !== mr.x || sb.top !== mr.y || sb.right !== mr.x + mr.width || sb.bottom !== mr.y + mr.height) {
                throw new Error('CUTOUT_MASK_BOUNDS_MISMATCH: ' + JSON.stringify(sb) + ' on ' + group.name);
            }
            if (!data || data.length !== plane.gray.length) throw new Error('CUTOUT_MASK_DATA_MISMATCH: length ' + (data && data.length) + ' on ' + group.name);
            const wide = data instanceof Uint16Array;
            for (let i = 0; i < data.length; i++) {
                const got = wide ? X.from16(data[i]) : data[i];
                if (got !== plane.gray[i]) throw new Error('CUTOUT_MASK_DATA_MISMATCH: value ' + got + ' instead of ' + plane.gray[i] + ' on ' + group.name);
            }
            // Adding a mask must not change what the person sees first: Formula 1 visible only.
            group.visible = EXPECT.components.find(item => item.formulaId === target.formulaId).visible;
            cutoutGroups.push(group.id);
        }
    }
`;

module.exports = { CUTOUT_MASKS };
