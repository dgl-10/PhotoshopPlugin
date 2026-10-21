---
id: select-and-mask
title: Select and Mask from a script — refine the edge of a selection, Refine Hair included
problem: refining the edge of an existing selection from a script — hair, fur, a chopped or too hard edge — with Select and Mask: the batchPlay name, its slider keys, Refine Hair, and where the result goes
confidence: author-verified
task: verified by the author in Photoshop — recorded with Actions → Copy As JavaScript and replayed on other selections
photoshop: 25.3.1
date: 2026-10-24
helped: 0
failed: 0
---

## What it does from a script

`_obj: "smartBrushWorkspace"` is Select and Mask. Run through `batchPlay` as recorded, it
applies its settings to the current selection at once, without opening the workspace, and
it can be replayed on any other selection. Only the settings of the workspace's right-hand
panel are in the descriptor. Brush strokes made inside the workspace are not recorded and
cannot be replayed.

**Make the selection first.** With no selection, the command took the whole canvas as
selected: with output to a new layer it produced an almost full copy of the layer, which is
of no use. Start from Select Subject or Color Range (`select-subject-and-color-range`) or
any other selection, then refine it.

## Refine Hair

This is the Refine Hair button pressed with nothing else changed, and the result going
back to the selection. Replayed on another selection of a head, it changed the selection
along the hair:

```js
{ _obj: "smartBrushWorkspace",
  autoTrimap: true,
  presetKind: { _enum: "presetKindType", _value: "presetKindDefault" },
  refineEdgeOutput: { _enum: "refineEdgeOutput", _value: "selectionOutputToSelection" },
  sampleAllLayers: false,
  smartBrushContrast: { _unit: "percentUnit", _value: 0 },
  smartBrushDeconAmount: { _unit: "percentUnit", _value: 100 },
  smartBrushDecontaminate: false,
  smartBrushFeather: { _unit: "pixelsUnit", _value: 0 },
  smartBrushRadius: 0,
  smartBrushShiftEdge: { _unit: "percentUnit", _value: 0 },
  smartBrushSmooth: 0,
  smartBrushUseDeepMatte: true,
  smartBrushUseSmartRadius: false }
```

A changed edge is not proof of a right edge. Look at the selection with `ps_get_image`,
`target: "selection"`, over the hair at full size, next to the document over the same box.
If it is still wrong, an image generator can draw the mask: `select-with-ai-inpaint-mask`.

## Keys

| key | control in the workspace | as recorded |
| --- | --- | --- |
| `autoTrimap` | Refine Hair button | `true` after pressing it, `false` otherwise |
| `smartBrushRadius` | Radius | integer pixels: 0, 7 |
| `smartBrushUseSmartRadius` | Smart Radius | boolean |
| `smartBrushSmooth` | Smooth | integer: 0, 31, 54 |
| `smartBrushFeather` | Feather | `pixelsUnit`: 0, 29.1 |
| `smartBrushContrast` | Contrast | `percentUnit`: 0, 45 |
| `smartBrushShiftEdge` | Shift Edge: negative moves the edge inward, positive outward | `percentUnit`: −55, −11, 0, 9 |
| `smartBrushDecontaminate`, `smartBrushDeconAmount` | Decontaminate Colors and its Amount | `false` with 100, `true` with 48 |
| `sampleAllLayers` | Sample All Layers | boolean |
| `smartBrushUseDeepMatte` | not identified; probably Refine Mode Object Aware, not checked | `true` in every recording |
| `presetKind` | Preset | `presetKindDefault` when no slider was moved, `presetKindCustom` when any was |
| `refineEdgeOutput` | Output To | see below |

`refineEdgeOutput` values recorded:

- `selectionOutputToSelection` — Selection. The result stays a selection, which is the
  most convenient for further work.
- `selectionOutputToUserMask` — Layer Mask on the active layer.
- `selectionOutputToNewSheetAndMask` — New Layer with Layer Mask. Recorded with
  Decontaminate Colors on; Selection or Layer Mask output with Decontaminate Colors on was
  not tried.

Not tried yet: the other Output To values, running it on a layer mask with no selection,
and Photoshop versions other than 25.3.1.

## Opening the workspace for the person

Only when the person asks to have it opened (see the rules): the same `_obj` with
`_options: { dialogOptions: "display" }`, run with `interactive: true`. Not tried here.
