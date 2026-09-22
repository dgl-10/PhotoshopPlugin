---
id: camera-raw-filter
title: Apply the Camera Raw Filter with your own values, and what its descriptor keys are
problem: applying Camera Raw adjustments (exposure, contrast, HSL, colour grading, sharpening, grain…) from a script, when none of its descriptor keys are documented
confidence: author-verified
task: verified by the author in Photoshop — keys recorded with Actions → Copy As JavaScript, each slider set to a distinct value
photoshop: 25.3.1, 27.10.1 (Camera Raw 18.6)
date: 2026-09-22
helped: 0
failed: 0
---

## Apply it yourself

Tone and colour belong in adjustment layers, not here (see the rules). Use Camera Raw for
what adjustment layers cannot do: texture, clarity, dehaze, noise reduction, sharpening,
grain, vignette.

This is the normal way: the agent picks the values and applies the filter silently.

```js
return await action.batchPlay([{
    _obj: "Adobe Camera Raw Filter",
    "$CrVe": "18.6",
    "$PrVN": 6,
    "$PrVe": 251920384,
    "$Ex12": 0.35,     // exposure
    "$Cl12": 12,       // clarity
    "$Vibr": 18        // vibrance
}], {});
```

No dialog, about a second. Send only the keys you want to change; a recording carries only
the sliders that were moved plus a few neighbours at their defaults. `$CrVe`, `$PrVN`,
`$PrVe` are the Camera Raw engine and process version: send them exactly as they came from
a recording or from a dialog on this machine, do not invent or round them.

A recording of Camera Raw replays silently with its recorded values. It shows a dialog only
with `_options: { dialogOptions: "display" }` — and that is for the case when the person
asked to have the dialog opened; see `open-filter-dialog-for-the-person`. Then OK returns
exactly the settings the person changed, and you can replay them silently on other layers
or documents (verified).

On a smart object the filter is expected to land as a smart filter rather than in the
pixels — not verified here; check the layer after applying if it matters.

## Keys

"Moved" means the slider was set to a unique value in the recording and that value came
back under this key — a checked fact. "Default" means the key came along at its default
value; its meaning is read from the name and the default, not proven.

**Basic**

| setting | key | moved |
| --- | --- | --- |
| White balance mode | `$WBal` — `{ _enum: "$WBal", _value: "customEnum" }` when set by hand | yes |
| Temperature | `$Temp` | yes |
| Tint | `$Tint` | yes |
| Exposure | `$Ex12` (real, e.g. `1.23`) | yes |
| Contrast | `$Cr12` | yes |
| Highlights | `$Hi12` | yes |
| Shadows | `$Sh12` | yes |
| Whites | `$Wh12` | yes |
| Blacks | `$Bk12` | yes |
| Texture | `$CrTx` | yes |
| Clarity | `$Cl12` | yes |
| Dehaze | `$Dhze` | yes |
| Vibrance | `$Vibr` | yes |
| Saturation | `saturation` — a plain string key, **not** `$Strt` | yes |

`$PGTM`, `$TMMs`, `RGBSetupClass` (all `0`) came along with Texture…Saturation; meaning
unknown, leave them out.

**Curve**

| setting | key | moved |
| --- | --- | --- |
| Point curve, composite | `curve` — flat list `[x0, y0, x1, y1, …]`, e.g. `[0, 0, 80, 140, 255, 255]` | yes |
| Point curve per channel | `$CrvR`, `$CrvG`, `$CrvB` — same flat format | default `[0, 0, 255, 255]` |
| Parametric Highlights / Lights / Darks / Shadows | `$PC_H` / `$PC_L` / `$PC_D` / `$PC_S` | yes |
| Parametric split points | `$PC_1`, `$PC_2`, `$PC_3` (defaults 25 / 50 / 75) | `$PC_2` yes |

`$crfs` (`100`) came along; meaning unknown.

**Color Mixer (HSL)** — `$HA_x` hue, `$SA_x` saturation, `$LA_x` luminance, where `x` is
`R` Red, `O` Orange, `Y` Yellow, `G` Green, `A` Aqua, `B` Blue, `P` Purple, `M` Magenta.
Moved for R, O and B; the other letters follow the same pattern.

**Color Grading**

| setting | key | moved |
| --- | --- | --- |
| Shadows hue / saturation | `$STSH` / `$STSS` | yes |
| Midtones hue / saturation | `$CgMH` / `$CgMS` | yes |
| Highlights hue / saturation | `$STHH` / `$STHS` | yes |
| Blending | `$CgBl` | yes |
| Balance | `$STB` | yes |
| Shadows / midtones / highlights luminance | `$CgSL` / `$CgML` / `$CgHL` | default |
| Global hue / saturation / luminance | `$CgGH` / `$CgGS` / `$CgGL` | default |

**Detail**

| setting | key | moved |
| --- | --- | --- |
| Sharpening amount | `sharpen` — a plain string key | yes |
| Sharpening radius / detail / masking | `$ShpR` (1.0) / `$ShpD` (25) / `$ShpM` (0) | default |
| Noise reduction (luminance) | `$LNR` | yes |
| Luminance detail / contrast | `$LNRD` (50) / `$LNRC` (0) | default |
| Color noise reduction | `$CNR` | yes |
| Color detail / smoothness | `$CNRD` (50) / `$CNRS` (50) | default |

**Effects**

| setting | key | moved |
| --- | --- | --- |
| Vignette amount | `$PCVA` | yes |
| Vignette midpoint / feather / roundness / highlights / style | `$PCVM` (50) / `$PCVF` (50) / `$PCVR` (0) / `$PCVH` (0) / `$PCVS` (1) | default |
| Grain amount | `$GRNA` | yes |
| Grain size / roughness | `$GRNS` (25) / `$GRNF` (50) | default |

**Optics**

| setting | key | moved |
| --- | --- | --- |
| Defringe purple amount | `$DfPA` | yes |
| Defringe green amount | `$DfGA` | default |
| Purple hue range / green hue range | `$DPHL`–`$DPHH` (30–70) / `$DPGL`–`$DPGH` (40–60) | default |
| Remove chromatic aberration | `$AuCA` (0/1) | default |

Lens profile correction produced no keys on a non-raw test image; unknown.

**Calibration** — Red / Green / Blue primary hue and saturation: `$RHue`, `$RSat`,
`$GHue`, `$GSat`, `$BHue`, `$BSat`, all moved. Shadows tint was not captured; `$BlkB` came
along at `0` and may be it — not proven.

## A key that is not in the tables

Record it: Actions panel → record → Filter → Camera Raw Filter → move only that slider to
an unusual value → OK → stop → right-click the step → Copy As JavaScript. The key that
carries your value is the one. Or ask the person to do it. Then mark this article with
`ps_kb_mark_failed` and put the key and the setting it belongs to in the note: the tables
did not have what you needed, and the note is kept next to this article, where the next
agent will look.

The forum-derived guess `$Strt` for Saturation, which an earlier version of this article
carried, was wrong in Camera Raw 18.6 — a reminder that a key is known only once it has
come back with a value you set.
