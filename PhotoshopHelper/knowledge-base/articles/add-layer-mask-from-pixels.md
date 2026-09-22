---
id: add-layer-mask-from-pixels
title: Put a layer mask on a layer from pixels you generated
problem: adding a layer mask and filling it with your own grayscale data
confidence: author-verified
task: seeded from the plugin's own code
photoshop: 24.0 and later
date: 2026-09-20
helped: 0
failed: 0
---

## The two steps

There is no single call for "add a mask with these pixels". A mask has to exist before you
can write into it, so it is two steps: create an empty mask with `batchPlay`, then write
the pixels with the Imaging API.

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

## Feathering

Do not blur the buffer yourself if the person may want to adjust the softness afterwards.
Photoshop's own mask feather stays live and can be dragged in the Properties panel:

```js
layer.layerMaskFeather = radiusInPixels;
```

## Source

This is the code the plugin uses to place a generated result back into a document, in
`modules/ps.js`.
