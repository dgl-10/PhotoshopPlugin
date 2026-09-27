---
id: filter-commands
title: Command names and parameters of filters, from real recordings
problem: applying a filter (Gaussian Blur, Unsharp Mask, Smart Sharpen, Reduce Noise, Lens Correction, Filter Gallery…) from a script — the batchPlay name and parameter shape
confidence: author-verified
task: verified by the author in Photoshop — each recorded with Actions → Copy As JavaScript
photoshop: 27.10.1
date: 2026-09-27
helped: 0
failed: 0
---

## How to use this

Apply the command yourself, with values you choose, in one `batchPlay` call and no
`_options` — it runs silently. That is the default. Open a dialog for the person only when
they asked for it (`open-filter-dialog-for-the-person`).

What is verified: the name and the parameter shape of each command below came from a real
recording on Photoshop 27.10.1. Applying silently, with no dialog, is verified for Camera Raw
(see `camera-raw-filter`) and for Gaussian Blur — the plugin itself applies Gaussian Blur
this way in production (`modules/ps.js`, place-back), with exactly the recorded shape. For
the rest, look at the result (`ps_get_image`) the first time you use one.

On a smart object a filter lands as a smart filter, not in the pixels — verified for
Gaussian Blur by the same plugin code.

## Traps

- **A filter goes to whatever channel is targeted.** Right after a layer mask is added, the
  mask is the target, and a filter would blur the mask instead of the image. Target the
  layer content first, as the plugin does before its Gaussian Blur:
  `{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "RGB" }], makeVisible: false }`.
- **Green is `grain`.** Wherever a descriptor names the green channel or a green component,
  the key or value is `grain`, not `green` — for example the green channel in Reduce Noise
  below.

## Filters

| filter | `_obj` | parameters as recorded |
| --- | --- | --- |
| Gaussian Blur | `gaussianBlur` | `radius: { _unit: "pixelsUnit", _value: 18.5 }` |
| Unsharp Mask | `unsharpMask` | `amount` (percentUnit), `radius` (pixelsUnit), `threshold` (integer) |
| Smart Sharpen | `smartSharpen` | `amount` (percentUnit), `radius` (pixelsUnit), `noiseReduction` (percentUnit), `blur: { _enum: "blurType", _value: "lensBlur" }`, `useLegacy: false`, `presetKind: { _enum: "presetKindType", _value: "presetKindCustom" }` |
| High Pass | `highPass` | `radius` (pixelsUnit) |
| Dust & Scratches | `dustAndScratches` | `radius`, `threshold` (plain integers) |
| Add Noise | `addNoise` | `noise` (percentUnit), `distort: { _enum: "distort", _value: "gaussianDistribution" }`, `monochromatic` (bool), `$FlRs` — the random seed of that run |
| Reduce Noise | `denoise` — **not** `reduceNoise` | see below |
| Camera Raw Filter | `Adobe Camera Raw Filter` | see `camera-raw-filter` |
| Lens Correction | `$LnCr` — **not** `lensCorrection` | see below |
| Filter Gallery | `$GEfc` | see below |
| Liquify | `$LqFy` | the mesh cannot be scripted — see `open-filter-dialog-for-the-person` |

**Reduce Noise.** Strength is `amount` of the composite entry:

```js
{
    _obj: "denoise",
    channelDenoise: [
        { _obj: "channelDenoiseParams", channel: { _ref: "channel", _enum: "channel", _value: "composite" }, amount: 9, edgeFidelity: 60 },
        { _obj: "channelDenoiseParams", channel: { _ref: "channel", _enum: "channel", _value: "red" },   amount: 0 },
        { _obj: "channelDenoiseParams", channel: { _ref: "channel", _enum: "channel", _value: "grain" }, amount: 0 },
        { _obj: "channelDenoiseParams", channel: { _ref: "channel", _enum: "channel", _value: "blue" },  amount: 0 }
    ],
    colorNoise: { _unit: "percentUnit", _value: 45 },
    sharpen: { _unit: "percentUnit", _value: 25 },
    removeJPEGArtifact: false,
    preset: "Default"
}
```

Only Strength was moved; `edgeFidelity` (Preserve Details), `colorNoise` and `sharpen`
(Sharpen Details) came along at the dialog's defaults.

**Lens Correction.** Dozens of `$Ln…` keys. Moving Remove Distortion changed the polynomial
`$LnI0`…`$LnI3`, not `$LnRc`. Do not build this by hand: record the exact correction you need.

**Filter Gallery.** The effect is chosen by `$GEfk`, then the effect's own parameters:

```js
{ _obj: "$GEfc", "$GEfk": { _enum: "$GEft", _value: "notePaper" }, graininess: 20, imageBalance: 25, relief: 11 }
```

Other effects: record one to get its `$GEft` value and parameter names.
