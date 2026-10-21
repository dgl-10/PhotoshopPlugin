---
id: adjustment-layers
title: Make and change adjustment layers, and the recorded shape of each kind
problem: making an adjustment layer or changing its values from a script (Levels, Curves, Hue/Saturation including per colour range, Color Balance, Brightness/Contrast, Vibrance, Black & White, Photo Filter, Selective Color, Gradient Map), and clipping it to one layer — the batchPlay name and parameter shape, and why doc.createLayer does not work for this
confidence: author-verified
task: verified by the author in Photoshop — each recorded with Actions → Copy As JavaScript; Brightness/Contrast, Vibrance and Create Clipping Mask recorded by the author on 2026-10-24 in 25.3.1; making a layer inside an existing clipping group seen in an agent run (task-50bb06)
photoshop: 25.3.1, 27.10.1
date: 2026-10-24
helped: 0
failed: 0
---

## Prefer adjustment layers over Image → Adjustments

**Image → Adjustments commands change the pixels of the layer.** Use an adjustment layer
instead — it stays separate from the picture, and the person can switch it off, tune it, or
replace the picture underneath. See the rules for when a filter is the only option.

## Traps

- **A curve point is `_obj: "paint"`**, not `"point"`.
- **In Selective Color, Reds is `radius`** and the Yellow slider is `yellowColor`.
- **Green is `grain`.** Photoshop's name for green is `grain`: the Greens slider of Black &
  White, the green of an `RGBColor`, a Curves channel. In an agent run a per-channel Curves
  entry sent with `_value: "green"` was accepted and applied to the green channel, but read
  back with `ps_get_layer` as `"grain"` — that is the same channel, not a wrong target.
- **Contrast in Brightness/Contrast is `center`.** `brightnessEvent` has `brightness` and
  `center`; there is no `contrast` key. Confirmed by a recording where only Contrast was
  moved: `center` changed, and the `set` still carried `brightness` too — send both.
- **Color Balance has no `presetKind`.** Its recording carries none, and a `make` with
  `presetKind` in its `type` was rejected ("The parameters for command “Make” are not
  currently valid"); without it the same `make` worked.

## Make and set

Recorded on Photoshop 25.3.1 for Hue/Saturation, Selective Color and Levels. Photoshop
makes the layer with defaults, then sets its values on the layer that is now active (leave
`presetKind` out for Color Balance — see Traps):

```js
{ _obj: "make", _target: [{ _ref: "adjustmentLayer" }],
  using: { _obj: "adjustmentLayer", type: { _obj: "<name>", presetKind: { _enum: "presetKindType", _value: "presetKindDefault" } } } }

{ _obj: "set", _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
  to: { _obj: "<name>", …values…, presetKind: { _enum: "presetKindType", _value: "presetKindCustom" } } }
```

Values can also go straight into `type` of the `make` — seen working for Curves and Color
Balance in an agent run. A `make` written with `_class` instead of `_obj` and with a
`name` inside `using` was rejected ("The command “Make” is not currently available"); which
of the two broke it was not separated — rename the layer afterwards (`layer.name = …`).
`doc.createLayer(constants.LayerKind.<adjustment kind>)` does not make adjustment layers:
agents got "Unknown kind … somehow passed validation" for Hue/Saturation, Black & White and
Vibrance.

## Clip it to one layer

Layer → Create Clipping Mask is `groupEvent` on the active layer; it clips that layer to the
one directly below:

```js
{ _obj: "groupEvent", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }
```

`make` puts the new adjustment layer directly above the active layer, so make the layer to
correct active first, then `make`, `groupEvent`, `set`. The new adjustment layer stays
active, so the next `make` lands on top of the group and its own `groupEvent` clips it into
the same group — the author's recording did exactly this. A worked example is in
`placed-piece-tone-match`.

**A layer made inside an existing clipping group is clipped already.** When layers are
already clipped to the base and you make a new one with the base active, Photoshop puts it
between them and clips it by itself; `groupEvent` on it is then rejected with -25920
("Create Clipping Mask is not currently available"). Seen in an agent run (task-50bb06,
25.3.1). The layer is fine: skip `groupEvent`, or make the top layer of the group active
before `make`.

To check whether a layer is clipped, read its `group` property; `layer.grouped` in the DOM
returned `undefined` in the same run:

```js
{ _obj: "get", _target: [{ _ref: "property", _property: "group" }, { _ref: "layer", _id: layerId }] }
// returns { group: true } for a clipped layer
```

## What goes into `type` (make) and `to` (set)

The shapes below were recorded from Image → Adjustments on Photoshop 27.10.1 — the panel
records the same descriptor shape whether it changes pixels there or is placed into an
adjustment layer's `type`/`to`.

| adjustment | `_obj` | parameters as recorded |
| --- | --- | --- |
| Levels | `levels` | `adjustment: [{ _obj: "levelsAdjustment", channel: { _ref: "channel", _enum: "channel", _value: "composite" }, gamma: 0.75 }]`, `presetKind` custom |
| Curves | `curves` | `adjustment: [{ _obj: "curvesAdjustment", channel: composite as above, curve: [{ _obj: "paint", horizontal: 0, vertical: 0 }, { _obj: "paint", horizontal: 125, vertical: 183 }, { _obj: "paint", horizontal: 255, vertical: 255 }] }]`, `presetKind` custom |
| Hue/Saturation (Master) | `hueSaturation` | `adjustment: [{ _obj: "hueSatAdjustmentV2", hue: 72, saturation: 0, lightness: 0 }]`, `colorize: false`, `presetKind` custom. The recording also had `OriginalColors` and `GeneratedPreset`; whether they are needed was not checked |
| Color Balance | `colorBalance` | `shadowLevels`, `midtoneLevels`, `highlightLevels` — each `[cyan–red, magenta–green, yellow–blue]` (the first position verified), `preserveLuminosity: true` |
| Brightness/Contrast | `brightnessEvent` | `brightness`, `center` (= Contrast), `useLegacy: false`; the `make` carried only `useLegacy: false`. Recorded as an adjustment layer |
| Vibrance | `vibrance` | `vibrance`, `saturation` (the Saturation slider); the `make` was recorded as `type: { _class: "vibrance" }` with no values. Recorded as an adjustment layer |
| Black & White | `blackAndWhite` | `red`, `yellow`, `grain` (= Greens), `cyan`, `blue`, `magenta`; `useTint`, `tintColor: { _obj: "RGBColor", red, grain, blue }`, `presetKind` custom |
| Photo Filter | `photoFilter` | `color: { _obj: "labColor", luminance, a, b }` — a named filter such as Warming (85) is sent as its Lab colour — `density`, `preserveLuminosity` |

## Hue/Saturation per colour range

One `hueSatAdjustmentV2` entry per range in `adjustment`; the Master entry is the one without
`localRange` (see the table above).

```js
to: { _obj: "hueSaturation", adjustment: [
    { _obj: "hueSatAdjustmentV2", localRange: 1, hue: 16, saturation: -23, lightness: 11,
      beginRamp: 315, beginSustain: 345, endSustain: 15, endRamp: 45 },     // Reds
    { _obj: "hueSatAdjustmentV2", localRange: 5, hue: -17, saturation: 37, lightness: -13,
      beginRamp: 287, beginSustain: 342, endSustain: 59, endRamp: 91 }      // Blues, range dragged
], presetKind: … }
```

`localRange` 1 = Reds and 5 = Blues were recorded; they follow the order of the list in the
panel (Reds, Yellows, Greens, Cyans, Blues, Magentas), so 2, 3, 4, 6 are presumably the rest
— check by reading the layer back with `ps_get_layer`. The four angles are the range on the
hue wheel; the Reds values are Photoshop's defaults, the Blues range had been dragged.

## Selective Color

```js
to: { _obj: "selectiveColor", colorCorrection: [
    { _obj: "colorCorrection", colors: { _enum: "colors", _value: "radius" },     // Reds
      cyan: { _unit: "percentUnit", _value: -24 }, magenta: { _unit: "percentUnit", _value: 26 } },
    { _obj: "colorCorrection", colors: { _enum: "colors", _value: "neutrals" },
      yellowColor: { _unit: "percentUnit", _value: 28 }, black: { _unit: "percentUnit", _value: -13 } }
], presetKind: … }
```

Only Reds (`radius`) and Neutrals were recorded; record another colour group before using
its name — `radius` shows the names are not the obvious ones.

## Gradient Map

`_obj: "gradientMapClass"`, not `gradientMap`:

```js
to: { _obj: "gradientMapClass", reverse: true, gradient: {
    _obj: "gradientClassEvent", name: "Custom", gradientForm: { _enum: "gradientForm", _value: "customStops" },
    interfaceIconFrameDimmed: 4096,
    colors: [
        { _obj: "colorStop", location: 0,    midpoint: 50, type: { _enum: "colorStopType", _value: "userStop" },
          color: { _obj: "RGBColor", red: 99, grain: 163, blue: 255 } },
        { _obj: "colorStop", location: 4096, midpoint: 50, type: { _enum: "colorStopType", _value: "userStop" },
          color: { _obj: "RGBColor", red: 114, grain: 190, blue: 255 } }
    ],
    transparency: [
        { _obj: "transferSpec", location: 0,    midpoint: 50, opacity: { _unit: "percentUnit", _value: 100 } },
        { _obj: "transferSpec", location: 4096, midpoint: 50, opacity: { _unit: "percentUnit", _value: 100 } }
    ] } }
```

Stop positions run from 0 to 4096, not 0–100. Choosing a preset in the panel was recorded as
a `select` of the gradient by name followed by a `set` with all its colours — send the
colours directly. The `make` also carried
`gradientsInterpolationMethod: { _enum: "gradientInterpolationMethodType", _value: "perceptual" }`.

## Levels

The black and white points are pairs:
`{ _obj: "levelsAdjustment", channel: composite, input: [23, 226], gamma: 1.22, output: [17, 241] }`.
