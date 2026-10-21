---
id: path-stroke-with-brush
title: Paint a brush stroke from a script — stroke a path with the brush
problem: painting a real brush stroke (a line, a curve, strands) from a script, when a script cannot move the mouse
confidence: author-verified
task: brush size, colour and Stroke Path with the brush recorded by the author with Actions → Copy As JavaScript; the path built with pathItems.add and stroked as the current path in agent run task-c1de50; the active-layer trap was found by an agent in task-38d2a3
photoshop: 25.3.1
date: 2026-10-28
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

// 3. Make the layer to paint on active: the stroke goes onto the active layer. (An agent saw
//    strokePath fail without one: "You must have one layer active for strokePath".)
await action.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false }], {});

// 4. Build the path (documented DOM call; see path-bezier-handles). The new path becomes
//    the current one.
await doc.pathItems.add("Stroke", [subPathInfo]);

// 5. Stroke the current path with the brush, then remove the path (recorded).
await action.batchPlay([
    { _obj: "stroke", _target: [{ _ref: "path", _enum: "ordinal", _value: "targetEnum" }],
      using: { _class: "paintbrushTool" } },
    { _obj: "delete", _target: [{ _ref: "path", _enum: "ordinal", _value: "targetEnum" }] }
], {});
```

The recording points at the path with `{ _ref: "path", _property: "workPath" }`, because the
author drew it with the Pen tool, and that makes the Work Path. A path from `pathItems.add`
is a named path, not the Work Path, so step 5 points at the current path instead; that is
how the agent in task-c1de50 stroked it, and the line was drawn.

## Traps

- **Paint on a pixel layer.** When the active layer is a smart object, text or a shape,
  Photoshop wants to rasterize it before the stroke — the author's recording got a
  Rasterize step that way. Do not rasterize the person's layer: make a new empty layer above
  it and paint there. What a script gets in that case instead of the question was not tried.
- **Not `strokePath`.** The DOM documents `PathItem.strokePath(tool, simulatePressure)`
  (Photoshop 23.3 and later), and this article used it before. In task-c1de50, on 25.3.1,
  the path from `pathItems.add` had no such method: `TypeError: pathItem.strokePath is not a
  function`. Yet the agent in task-38d2a3 did get a Photoshop error from it, so it is not
  missing everywhere; why it was missing is not known. Use the recorded `stroke`.

## Not known yet

- Hardness, opacity and flow of the brush did not record in Actions — only the size did.
  Their keys are unknown. Record them another way or leave them as the person set them.
- Only the brush was recorded in Stroke Path, with Simulate Pressure off. The other tools of
  that dialog (Pencil, Eraser, Smudge and so on) and the key for Simulate Pressure were not.
