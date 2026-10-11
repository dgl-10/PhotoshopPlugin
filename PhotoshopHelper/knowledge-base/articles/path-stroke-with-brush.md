---
id: path-stroke-with-brush
title: Paint a brush stroke from a script — stroke a path with the brush
problem: painting a real brush stroke (a line, a curve, strands) from a script, when a script cannot move the mouse
confidence: author-verified
task: brush size and colour recorded by the author with Actions → Copy As JavaScript; strokePath is documented; the active-layer trap was found by an agent in task-38d2a3
photoshop: 25.3.1
date: 2026-09-29
helped: 0
failed: 0
---

## Why this way

Brush strokes made with the mouse are not recorded in Actions, and a script has no mouse.
A script paints a stroke by building a path and stroking it with a tool — Photoshop then
paints along it with the current brush and the foreground colour. For soft areas rather than
strokes, a feathered selection with a fill, or pixels written with the Imaging API, is
usually simpler.

## Steps

```js
// 1. Foreground colour (recorded).
await action.batchPlay([{ _obj: "set",
    _target: [{ _ref: "color", _property: "foregroundColor" }],
    to: { _obj: "RGBColor", red: 204, grain: 51, blue: 51 },
    source: "photoshopPicker" }], {});

// 2. Brush size (recorded; the brush tool was selected first).
await action.batchPlay([
    { _obj: "select", _target: [{ _ref: "paintbrushTool" }] },
    { _obj: "set", _target: [{ _ref: "brush", _enum: "ordinal", _value: "targetEnum" }],
      to: { _obj: "brush", masterDiameter: { _unit: "pixelsUnit", _value: 130 } } }
], {});

// 3. Make the layer to paint on active — without an active layer strokePath fails with
//    "You must have one layer active for strokePath" (seen by an agent).
await action.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }], {});

// 4. Build the path, stroke it, remove it (documented DOM calls).
const path = await doc.pathItems.add("Stroke", [subPathInfo]);   // see path-bezier-handles
await path.strokePath(constants.ToolType.BRUSH, false);          // true = simulate pressure
await path.remove();
```

`strokePath` also takes `PENCIL`, `ERASER`, `DODGE`, `BURN`, `SMUDGE`, `CLONESTAMP` and others
(`constants.ToolType`); `CLONESTAMP` and `HEALINGBRUSH` need a `sourceOrigin`.

## Not known yet

Hardness, opacity and flow of the brush did not record in Actions — only the size did. Their
keys are unknown. Record them another way or leave them as the person set them.
