---
id: smart-filter-mask
title: Limit a smart filter to part of the layer — the filter mask
problem: a smart filter (Camera Raw, a blur, sharpening…) should change only part of a smart object — make the filter mask from a selection, or edit the filter mask afterwards; how to target it from a script (`filterMask`), and that one filter mask covers every smart filter on the layer
confidence: author-verified
task: filter mask target recorded by the author with Actions → Copy As JavaScript; both ways measured on pixels by an agent at the author's request (Camera Raw on a smart object, 2026-10-30)
photoshop: 25.3.1 (Camera Raw 18.7)
date: 2026-10-30
helped: 0
failed: 0
---

## Two ways

**Selection first — the simplest.** Make the selection, then apply the filter to the smart
object. Photoshop turns the active selection into the filter mask: the filter shows inside
the selection and is hidden outside it. Drop the selection afterwards.

```js
{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }
// Make the selection here, then apply the filter as usual:
// filter-commands for the command names, camera-raw-filter for Camera Raw.
// Then drop the selection: await doc.selection.deselect();
```

**Edit the mask afterwards.** In the test the smart filter came with a white filter mask
(`ps_get_layer` → `hasFilterMask: true`); check that before you target it. Target it, then
change it with ordinary commands: fill a selection with black to hide the filter there,
with white to show it again. Then target the image again.

```js
{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }
{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "filterMask" }], makeVisible: false }
// Make the selection of the area to hide, then:
{ _obj: "fill", using: { _enum: "fillContents", _value: "black" },
  opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } }
// Drop the selection (await doc.selection.deselect();), then target the image again:
{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "RGB" }], makeVisible: false }
```

`"filterMask"` is to the filter mask what `"mask"` is to a layer mask.

Measured: a Camera Raw exposure change on a smart object, limited to the right half once by
each way. Both gave pixel-identical results — the left half equal to the original, the right
half changed — and `ps_get_layer` showed `hasFilterMask: true`. A gradient or your own pixels
written into the filter mask were not tried.

## Where the selection comes from

This is where your own black-and-white mask goes: Select Subject or Color Range
(`select-subject-and-color-range`), a mask an image generator drew
(`select-with-ai-inpaint-mask`), or a layer mask loaded as a selection
(`mask-load-as-selection`). Refine a fine edge first if it needs it (`select-and-mask`).

## Limits

- **One filter mask per layer.** It covers every smart filter on that layer at once; one
  smart filter cannot have a mask of its own. For different areas with different settings,
  use separate smart objects, or masks inside Camera Raw (`camera-raw-local-masks`).
- **Prefer it to masks inside Camera Raw when one area is enough.** The person sees the
  filter mask in the Layers panel and can repaint it by hand; a mask inside Camera Raw can
  be changed only by opening the filter.
- **Target the image again when you are done.** A filter or a fill goes to whatever channel
  is targeted; with the filter mask still targeted, the next one lands in the mask
  (`filter-commands`, Traps).
