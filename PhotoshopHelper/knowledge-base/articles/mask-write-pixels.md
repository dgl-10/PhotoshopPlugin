---
id: mask-write-pixels
title: Write your own pixels into a layer mask — a new mask, or one the layer already has
problem: writing your own grayscale data into a layer mask from a script — a new mask, or one the layer already has (every new adjustment layer comes with a white mask), where imaging.putLayerMask lands the data but the image may not update
confidence: agent-written
task: merged from mask-add-from-pixels (seeded from the plugin's own code) and mask-rewrite-image-not-updated (found by an agent in task-1ee418), with an agent report from task-0b130a; the merged text is not reviewed by the author yet
photoshop: 24.0 and later; the existing-mask trap was seen on 25.3.1
date: 2026-10-09
helped: 0
failed: 0
---

## A new mask: two steps

There is no single call for "add a mask with these pixels". A mask has to exist before you
can write into it, so it is two steps: create an empty mask with `batchPlay`, then write
the pixels with the Imaging API. This is the code the plugin uses daily to place a
generated result back into a document (`modules/ps.js`).

```js
// 1. Create an empty mask on the currently selected layer.
await action.batchPlay([{
    _obj: 'make',
    at: { _ref: 'channel', _enum: 'channel', _value: 'mask' },
    new: { _class: 'channel' },
    using: { _enum: 'userMaskEnabled', _value: 'hideAll' }
}], { synchronousExecution: true });

// 2. Write the pixels into it.
await imaging.putLayerMask({
    documentID: doc.id,
    layerID: layer.id,
    imageData: psImageData,
    targetBounds: { left, top, right, bottom }
});
```

`using` takes `hideAll` for a black mask or `revealAll` for a white one. Start from
`hideAll` when your data covers only part of the document: everything you do not write
stays hidden, which is usually what you want.

## Building the pixel data

`putLayerMask` wants a `PhotoshopImageData`, not a raw buffer. A mask is one grayscale
component:

```js
const psImageData = await imaging.createImageDataFromBuffer(maskBuffer, {
    width: maskWidth,
    height: maskHeight,
    components: 1,
    chunky: false,
    colorProfile: 'Gray Gamma 2.2',
    colorSpace: 'Grayscale'
});
```

`maskBuffer` is a `Uint8Array` of `width * height` bytes: 255 where the layer shows
through, 0 where it is hidden.

## The trap: the layer already has a mask

Every new adjustment layer comes with a white mask. An agent wrote a full-canvas buffer into
such a mask with `imaging.putLayerMask` (0 outside a small rectangle, real values inside,
`targetBounds` from 0,0). Reading the mask back with `imaging.getLayerMask` gave the right
values. But the image, checked with `ps_get_image`, still showed the adjustment outside the
rectangle, as if the mask were still white there: a visible rectangular edge. Writing the
same buffer again changed nothing, also in later, separate calls (task-1ee418, Photoshop
25.3.1).

Cause not found. A guess, not verified: Photoshop keeps the area where a mask has
non-uniform content and does not widen it after a raw `putLayerMask` write.

There are two ways round it.

### Your own pixels: delete the mask, then make a new one

With the layer selected, delete its mask, then do the two steps above as for a new mask:

```js
await action.batchPlay([{
    _obj: 'delete',
    _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }]
}], { synchronousExecution: true });
```

Reported by an agent (task-0b130a, Photoshop 27): delete, then `make` with `hideAll`, then
`putLayerMask` worked on 8 adjustment layers, and the image updated. Not checked by the
author.

### A shape: edit the mask with ordinary commands

When what you need is a shape rather than your own pixels, edit the existing mask with
ordinary Photoshop commands instead; these always redraw the image:

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

In task-1ee418, `ps_get_image` afterwards showed the edge gone and the pixels outside the
rectangle identical to the original.

## Check the image, not only the mask

After any mask write, look at the image with `ps_get_image`, not only at the mask data with
`imaging.getLayerMask`: in the case above the two disagreed.

## Feathering

If the person may want to adjust the softness afterwards, Photoshop's own mask feather
suits better than blurring the buffer: it stays live and can be dragged in the Properties
panel:

```js
layer.layerMaskFeather = radiusInPixels;
```
