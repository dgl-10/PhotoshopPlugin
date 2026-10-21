---
id: placed-piece-tone-match
title: Match the tone of a placed generated piece to the picture around it
problem: after to_ps_place_back the generated piece is a little lighter or darker, flatter or punchier, more or less saturated, or tinted compared with the picture around it — nearly always when the picture comes from Midjourney; the author's usual order of fixes: the prompt, then adjustment layers clipped to the placed layer — Brightness/Contrast, then Vibrance, then Color Balance — not through its mask
confidence: agent-written
task: the author's own workflow and practice (the order of the fixes; pieces of a Midjourney picture nearly always need them) and the author's recordings (Actions → Copy As JavaScript) of Brightness/Contrast, Vibrance and Color Balance layers clipped to a placed smart object; written up by an agent, not reviewed by the author yet; agent run task-3762c7
photoshop: 25.3.1
date: 2026-10-28
helped: 0
failed: 0
---

## Why it happens

The generator sees only the captured piece, so even a good result often comes back a shade
off: lighter or darker, with more or less contrast or saturation, or with a slight colour
cast. The soft edge of Place Back's mask hides the line of the seam but not that difference:
it shows as a lighter, darker or differently coloured halo along the border.

When the picture was made in Midjourney, expect it. In the author's practice image editors
almost never keep the tone of the background of a Midjourney picture, and the placed pieces
nearly always need correcting; why is not known. Midjourney downloads are named after the
prompt and its parameters, for example
`name_prompt_words_--ar_916_--stylize_800_--v_8.2_<id>_2.png`: `--ar`, `--v`, `--stylize` or
`--chaos` in the document name point to Midjourney. If the name does not tell, the person
may.

## The order

This is how the author usually works: each step only when the ones before have not removed
the difference, with a look at the close-up (Look for it, below) after each.

1. **The prompt.** Before generating, say what to change, then that everything else stays
   exactly as it is and the changed part keeps the colours, light and tone of the rest of
   the picture. Models follow it unevenly, so check after every place back.
2. **Brightness/Contrast**, clipped to the placed layer — for a piece that is lighter or
   darker, flatter or punchier. Often it alone is enough.
3. **Vibrance**, clipped — for a piece that is more or less saturated. It has both a
   Vibrance and a Saturation slider.
4. **Color Balance**, clipped — for a colour cast that is still there; midtones first.

Each step adds its own layer on top of the ones before; keep those. It is a usual order, not
a rule: Curves (per channel for a cast), Levels or another adjustment are fine when they
suit the case better — their shapes are in `adjustment-layers`.

## Look for it

Take a full-size close-up of the border with `ps_get_image` and `bounds`, at a place where
one surface runs across it: background, a wall, skin, sky. Compare that surface just inside
the border with the same surface just outside. Do not compare the fixed thing with what is
next to it — a hand and a wall differ anyway.

Compare what is seen: the document as it shows, not the placed layer's own pixels. Outside
its mask the layer is hidden, so a difference there cannot be seen and is no reason to
correct anything. If you measure numbers, measure the merged picture on both sides of the
visible edge of the mask. A result that equals the original exactly means you measured where
the piece does not show: in task-3762c7 an agent corrected a difference in hidden pixels
and then "confirmed" it at such a spot.

If the two sides match, there is nothing to correct. Do not add adjustment layers just in
case — not even for a Midjourney picture.

## Adjustment layers clipped to the placed layer

Not through the mask, not with a filter, and not with Image → Adjustments on the smart
object. An adjustment layer clipped to the placed layer acts only where that layer shows,
and the person can switch it off or tune it.

The difference is slight, so the values are small: move a little, look at the close-up
again, repeat. The author's own case needed Brightness/Contrast and then Vibrance.

## Commands

From the author's recording; the values are changed to small examples. `make` puts the new
adjustment layer directly above the active layer, and `groupEvent` (Layer → Create Clipping
Mask) clips the active layer to the one below. So make the placed layer active first — its
id is in the `to_ps_place_back` answer. After each `make` and `groupEvent` the new
adjustment layer is active, so the next one lands on top of the group and its own
`groupEvent` clips it too.

When you come back later and layers are already clipped to the placed layer, make the top
one of them active instead. A layer made right above the placed layer joins the group by
itself, and `groupEvent` on it is rejected with -25920 (`adjustment-layers`).

```js
// The placed layer, by the id from the to_ps_place_back answer (not part of the recording)
{ _obj: "select", _target: [{ _ref: "layer", _id: placedId }], makeVisible: false }

// Brightness/Contrast, clipped
{ _obj: "make", _target: [{ _ref: "adjustmentLayer" }],
  using: { _obj: "adjustmentLayer", type: { _obj: "brightnessEvent", useLegacy: false } } }
{ _obj: "groupEvent", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }
{ _obj: "set", _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
  to: { _obj: "brightnessEvent", brightness: -6, center: 4, useLegacy: false } }

// Vibrance, clipped
{ _obj: "make", _target: [{ _ref: "adjustmentLayer" }],
  using: { _obj: "adjustmentLayer", type: { _class: "vibrance" } } }
{ _obj: "groupEvent", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }
{ _obj: "set", _target: [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }],
  to: { _obj: "vibrance", vibrance: 6, saturation: -4 } }
```

Color Balance goes the same way: its shape is in `adjustment-layers`.

## Traps

- **Contrast is `center`.** `brightnessEvent` has `brightness` and `center`; there is no
  `contrast` key. Confirmed by a recording where only Contrast was moved; that `set` still
  carried `brightness` too, so send both.
- **Keep `useLegacy: false`**, as recorded: the Use Legacy checkbox switches to the old
  Brightness/Contrast, which works differently.
- **Vibrance's `make` was recorded with `_class: "vibrance"`**, not `_obj`; `_obj` there was
  not tried. Its `set` uses `_obj: "vibrance"`.
- **`groupEvent` clips to whatever layer is directly below.** If the adjustment changes the
  whole picture instead of the piece, the placed layer was not active before `make`.
- Put each step of the correction into one script with a history name a person understands
  (`one-history-step-per-script`).

## Then

Look at the close-up again: the halo along the border should be gone. In the report, name
the adjustment layers and their values so the person can tune them.
