---
id: filter-and-adjustment-commands
title: Command names and parameters of filters, adjustments and workspaces, from real recordings
problem: applying a filter or an Image → Adjustments command from a script — the batchPlay name and parameter shape — and which workspaces cannot be recorded at all
confidence: author-verified
task: verified by the author in Photoshop — each recorded with Actions → Copy As JavaScript
photoshop: 27.10.1
date: 2026-09-22
helped: 0
failed: 0
---

## How to use this

Apply the command yourself, with values you choose, in one `batchPlay` call and no
`_options` — it runs silently. That is the default. Open a dialog for the person only when
they asked for it (`open-filter-dialog-for-the-person`).

What is verified: the name and the parameter shape of each command below came from a real
recording on Photoshop 27.10.1. Applying silently, with no dialog, is verified for Camera Raw
and for Gaussian Blur — the plugin itself applies Gaussian Blur this way in production
(`modules/ps.js`, place-back), with exactly the recorded shape. For the rest, look at the
result (`ps_get_image`) the first time you use one.

On a smart object a filter lands as a smart filter, not in the pixels — verified for
Gaussian Blur by the same plugin code.

**Image → Adjustments commands change the pixels of the layer.** Use an adjustment layer
instead — Levels, Curves, Hue/Saturation, Color Balance, Black & White, Photo Filter all
exist as adjustment layers: `make` with
`_target: [{ _ref: "adjustmentLayer" }]` and `using: { _obj: "adjustmentLayer", type: { _obj: "<name>", …the same parameters… } }`.
This form worked for Curves and Color Balance in an agent run. A variant with `_class`
instead of `_obj` and a `name` inside `using` was rejected with "The command “Make” is not
currently available" — which of the two broke it was not separated; rename the layer
afterwards through the DOM (`layer.name = …`). The recorded shapes below are what goes into
`type`.

## Traps

- **A filter goes to whatever channel is targeted.** Right after a layer mask is added, the
  mask is the target, and a filter would blur the mask instead of the image. Target the
  layer content first, as the plugin does before its Gaussian Blur:
  `{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "RGB" }], makeVisible: false }`.
- **Green is `grain`.** Wherever a descriptor names the green channel or a green component,
  the key or value is `grain`, not `green`: the green channel in Reduce Noise, the Greens
  slider in Black & White, the green component of an `RGBColor`.
- **A curve point is `_obj: "paint"`**, not `"point"`.

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

## Image → Adjustments

| adjustment | `_obj` | parameters as recorded |
| --- | --- | --- |
| Levels | `levels` | `adjustment: [{ _obj: "levelsAdjustment", channel: { _ref: "channel", _enum: "channel", _value: "composite" }, gamma: 0.75 }]`, `presetKind` custom |
| Curves | `curves` | `adjustment: [{ _obj: "curvesAdjustment", channel: composite as above, curve: [{ _obj: "paint", horizontal: 0, vertical: 0 }, { _obj: "paint", horizontal: 125, vertical: 183 }, { _obj: "paint", horizontal: 255, vertical: 255 }] }]`, `presetKind` custom |
| Hue/Saturation | `hueSaturation` | `adjustment: [{ _obj: "hueSatAdjustmentV2", hue: 72, saturation: 0, lightness: 0 }]`, `colorize: false`, `presetKind` custom. The recording also had `OriginalColors` and `GeneratedPreset`; whether they are needed was not checked |
| Color Balance | `colorBalance` | `shadowLevels`, `midtoneLevels`, `highlightLevels` — each `[cyan–red, magenta–green, yellow–blue]` (the first position verified), `preserveLuminosity: true` |
| Black & White | `blackAndWhite` | `red`, `yellow`, `grain` (= Greens), `cyan`, `blue`, `magenta`; `useTint`, `tintColor: { _obj: "RGBColor", red, grain, blue }`, `presetKind` custom |
| Photo Filter | `photoFilter` | `color: { _obj: "labColor", luminance, a, b }` — a named filter such as Warming (85) is sent as its Lab colour — `density`, `preserveLuminosity` |

## Selection and fill

| command | `_obj` | parameters as recorded |
| --- | --- | --- |
| Color Range | `colorRange` | `fuzziness`, `minimum` / `maximum` as `labColor`, `colorModel: 0` |
| Content-Aware Fill | `cafWorkspace` — **not** `contentAwareFill` | works on the current selection; `cafSamplingRegion: { _enum: "cafSamplingRegion", _value: "cafSamplingRegionRectangular" }`, `cafOutput: { _enum: "cafOutput", _value: "cafOutputToNewLayer" }`, `cafColorAdaptationLevel`, `cafRotationAmount`, `cafScale`, `cafMirror`, `cafSampleAllLayers` |
| Sky Replacement | `skyReplacement` | see below |

**Sky Replacement.** Keys: `brightness`, `temperature`, `shiftEdge`, `borderSmoothness`
(Fade Edge), `lightingMode` (a blend mode), `edgeLightingOpacity`,
`foregroundLightingOpacity`, `harmonizationOpacity`,
`skyReplacementOutput: { _enum: "skyReplacementOutput", _value: "skyReplacementOutputToNewSheets" }`.
The sky itself is `file: { _kind: "local", _path: … }` pointing to a JPEG in the
`Sky_Presets` folder of this machine's Photoshop settings, plus its `ID` (the same GUID as
the file name) and `name`. That path differs on every machine — take it from a recording
made here, never from somewhere else. Photoshop refuses when it detects no sky in the image.

## Cannot be recorded

Entering these workspaces silently stops the Actions recording: no step appears, although
the result lands in History. So there is no recorded name to use.

- **Select and Mask**
- **Blur Gallery** — tried with Iris Blur; Field Blur and Tilt-Shift are the same workspace
  and were not tried separately
- **Adaptive Wide Angle**
- **Vanishing Point** — reported the same by others ([Adobe Community](https://community.adobe.com/questions-712/automate-vanishing-point-tool-by-script-1178490)), not tried here

Not every workspace behaves this way — Content-Aware Fill and Sky Replacement record fine —
so try recording before giving up on one.

**Neural Filters** — undetermined: the test photos had no face the filters would accept.

If a job needs one of these, say plainly that it cannot be done by script and leave that
step to the person. Without a recorded name there is also nothing to open for them.
