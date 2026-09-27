---
id: mask-gradient
title: Draw a gradient on a layer mask
problem: fading a layer out with a gradient on its mask from a script — the command and its parameters, and why it can wipe the mask that was there
confidence: author-verified
task: recorded by the author with Actions → Copy As JavaScript
photoshop: 25.3.1
date: 2026-09-29
helped: 0
failed: 0
---

## The trap first

A gradient **replaces the whole mask**, not just the stretch between its two points. On a
mask that already had a shape — the author's round mask — the shape was gone after one
gradient. To keep what is there, limit the gradient with a selection first: load the mask
as a selection (`mask-load-as-selection`), then draw the gradient; it fills only inside the
selection. Whether a blend mode such as Multiply on the gradient combines it with the mask
instead was not tried.

## The command

Target the mask channel of the active layer, then draw:

```js
{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }], makeVisible: false }

{ _obj: "gradientClassEvent",
  from: { _obj: "paint", horizontal: { _unit: "pixelsUnit", _value: 477 }, vertical: { _unit: "pixelsUnit", _value: 559 } },
  to:   { _obj: "paint", horizontal: { _unit: "pixelsUnit", _value: 445 }, vertical: { _unit: "pixelsUnit", _value: 1129 } },
  type: { _enum: "gradientType", _value: "linear" },
  dither: true,
  useMask: true,
  gradientsInterpolationMethod: { _enum: "gradientInterpolationMethodType", _value: "perceptual" },
  gradient: {
      _obj: "gradientClassEvent", name: "Custom",
      gradientForm: { _enum: "gradientForm", _value: "customStops" },
      interfaceIconFrameDimmed: 4096,
      colors: [
          { _obj: "colorStop", location: 0,    midpoint: 50, type: { _enum: "colorStopType", _value: "userStop" },
            color: { _obj: "grayscale", gray: 4.27 } },
          { _obj: "colorStop", location: 4096, midpoint: 80, type: { _enum: "colorStopType", _value: "userStop" },
            color: { _obj: "grayscale", gray: 41.05 } }
      ],
      transparency: [
          { _obj: "transferSpec", location: 0,    midpoint: 50, opacity: { _unit: "percentUnit", _value: 100 } },
          { _obj: "transferSpec", location: 4096, midpoint: 50, opacity: { _unit: "percentUnit", _value: 100 } }
      ] } }
```

- The command and the gradient inside it are both `gradientClassEvent`.
- `from` / `to` are document pixels; points are `_obj: "paint"`.
- On a mask the stops are `grayscale` with `gray` from 0 to 100 — check which end is black
  by reading the mask back (`ps_get_image` with `target: "layer_mask"`).
- `midpoint` (0–100) moves where the transition is halfway; stop positions run 0–4096.
- Only `linear` was recorded; record another `gradientType` before using it.

After drawing, target the image again:
`{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "RGB" }], makeVisible: false }`.
