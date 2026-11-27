'use strict';

/**
 * Guards embedded into the single Photoshop apply transaction.
 * Native creation/grouping can depend on active-layer context. Besides explicit placement,
 * compare every pre-existing layer after the write, including hidden descendants. A failed
 * invariant must roll back the original history state, not merely delete the new objects.
 */
const { SKIN_GROUP_GROWTH } = require('./body-part-uxp-script');

const SCENE_GUARD = `${SKIN_GROUP_GROWTH}
// Snapshot plain values, not live Layer objects whose properties change with the document.
function skinSceneSnapshot(container, ignoreCreated) {
    const owned = ignoreCreated ? new Set(created) : null;
    return Array.from(container.layers || []).filter(layer => !owned || !owned.has(layer.id)).map(layer => {
        // task31: skinGrowing (body-part-uxp-script.js) names the common Skin group a part is
        // written into and its parents; only their bounds may change. It is empty otherwise.
        const b = skinGrowing.has(layer.id) ? null : layer.bounds;
        return { id: layer.id, name: layer.name, kind: String(layer.kind), visible: layer.visible,
            opacity: layer.opacity, blendMode: String(layer.blendMode),
            bounds: b ? { left: +b.left, top: +b.top, right: +b.right, bottom: +b.bottom } : null,
            children: skinSceneSnapshot(layer, ignoreCreated) };
    });
}
const skinOriginalScene = JSON.stringify(skinSceneSnapshot(doc, false));
const skinPreviousHistoryState = doc.activeHistoryState || null;
function skinOriginalScenePreserved() {
    return JSON.stringify(skinSceneSnapshot(doc, true)) === skinOriginalScene;
}
`;

module.exports = { SCENE_GUARD };
