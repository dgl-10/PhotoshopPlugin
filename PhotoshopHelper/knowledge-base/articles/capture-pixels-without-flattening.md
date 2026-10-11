---
id: capture-pixels-without-flattening
title: Read pixels with the Imaging API instead of duplicating and flattening the document
problem: getting the pixels of a document, a layer or a region, quickly and without touching the document
confidence: author-verified
task: seeded from the plugin's own code and the stage 2 testbench
photoshop: 24.0 and later
date: 2026-09-20
helped: 0
failed: 0
---

## Do not duplicate and flatten

The obvious route — `doc.duplicate()`, `flatten()`, save as PNG, read the file — works and
is a trap. On the stage 2 testbench one preview of a 768 × 1152 document took 18 to 25
seconds that way. It also opens a document in front of the person and changes which
document is active.

`imaging.getPixels` reads the composite without touching anything:

```js
const shot = await imaging.getPixels({
    documentID: doc.id,
    sourceBounds: { left, top, right, bottom },  // optional; whole document without it
    targetSize: { width: 512 },                  // optional; scales proportionally
    applyAlpha: true,
    componentSize: 8
});
// shot.imageData, shot.sourceBounds
```

Add `layerID` to read one layer instead of the composite. `getLayerMask` reads a mask,
`getSelection` reads the selection as grayscale.

## Two things that will bite you

**High bit depth and wide-gamut profiles.** A 16- or 32-bit document, or one in ProPhoto,
Adobe RGB or Display P3, comes back in a form that later steps mishandle. Force it:

```js
componentSize: 8,
colorSpace: 'RGB',
colorProfile: 'sRGB IEC61966-2.1'
```

**The encoder wants RGB.** `imaging.encodeImageData` refuses grayscale data — masks,
selections, single channels. Spread the one component across three and rebuild the image
data before encoding:

```js
const rgb = new Uint8Array(width * height * 3);
// fill each pixel's three bytes with the same grayscale value
const asRgb = await imaging.createImageDataFromBuffer(rgb, {
    width, height, components: 3, chunky: true, colorSpace: 'RGB'
});
const base64 = await imaging.encodeImageData({
    imageData: asRgb, format: 'image/png', base64: true
});
```

## Release the pixels

`PhotoshopImageData` holds native memory. Call `dispose()` on everything you get from the
Imaging API and everything you build with `createImageDataFromBuffer`, in a `finally`.

## You do not normally need any of this

`ps_get_image` does all of the above. Reach for the Imaging API directly only when you
need something that tool does not offer.

## Source

`modules/ps.js` and `modules/agent-capture.js` in this plugin, plus the stage 2 testbench
timings.
