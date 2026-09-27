---
id: mask-rewrite-image-not-updated
title: Rewriting an existing mask with imaging.putLayerMask — the data lands, the image may not update
problem: writing new pixels into a layer mask that already exists (e.g. an adjustment layer's default white mask), and the image does not change where it should
confidence: agent-written
task: found by an agent in task-1ee418; moved into the author layer without being reproduced by the author
photoshop: 25.3.1
date: 2026-09-27
helped: 0
failed: 0
---

## What happened

A new adjustment layer comes with a white mask. The agent wrote a full-canvas buffer into it
with `imaging.putLayerMask` (0 outside a small rectangle, real values inside,
`targetBounds` from 0,0). Reading the mask back with `imaging.getLayerMask` gave the right
values — 0 far outside the rectangle. But the image, checked with `ps_get_image`, still
showed the adjustment outside the rectangle, as if the mask were still white there: a
visible rectangular edge. Writing the same buffer again changed nothing, also when checked
in later, separate calls.

Cause not found. A guess, not verified: Photoshop keeps the area where a mask has non-uniform
content and does not widen it after a raw `putLayerMask` write.

For a **new** mask made with `hideAll` the plugin's own recipe works — see
`mask-add-from-pixels`.

## What worked

Edit the mask with ordinary Photoshop commands instead — these always redraw the image:

```js
// Target the layer and its mask channel.
await action.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }], { synchronousExecution: true });
await action.batchPlay([{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }] }], { synchronousExecution: true });

// Select the area that should stay, invert, fill the rest of the mask with black.
await doc.selection.selectRectangle({ top, left, bottom, right }, constants.SelectionType.REPLACE);
await doc.selection.inverse();
await action.batchPlay([{
    _obj: "fill",
    using: { _enum: "fillContents", _value: "black" },
    opacity: { _unit: "percentUnit", _value: 100 },
    mode: { _enum: "blendMode", _value: "normal" }
}], { synchronousExecution: true });

// Clean up: drop the selection, target the image again.
await doc.selection.deselect();
await action.batchPlay([{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "RGB" }], makeVisible: false }], { synchronousExecution: true });
```

`ps_get_image` afterwards showed the edge gone and the pixels outside the rectangle identical
to the original.

After any mask write, check the image with `ps_get_image`, not only the mask data with
`imaging.getLayerMask` — here the two disagreed.
