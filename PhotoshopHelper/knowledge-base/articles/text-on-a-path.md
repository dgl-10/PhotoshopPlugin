---
id: text-on-a-path
title: Make an editable text layer that runs along a path (Type on a Path)
problem: putting live, editable text along a curve or a contour from a script — the DOM has no call for it
confidence: agent-written
task: found by an agent in task-b62d55; moved into the author layer without being reproduced by the author
photoshop: 25.3.1
date: 2026-09-29
helped: 0
failed: 0
---

## What works

The DOM cannot bind text to a path, and selecting a path before `doc.createTextLayer()`
does not help — that makes ordinary point text. Type on a path is a text layer whose
`textShape` has `char: "onACurve"` and carries the path inside it:

```js
const pathPoints = [
    { _obj: "pathPoint",
      anchor:   { _obj: "paint", horizontal: { _unit: "pixelsUnit", _value: 750 }, vertical: { _unit: "pixelsUnit", _value: 1000 } },
      backward: { _obj: "paint", horizontal: { _unit: "pixelsUnit", _value: 750 }, vertical: { _unit: "pixelsUnit", _value: 1000 } },
      forward:  { _obj: "paint", horizontal: { _unit: "pixelsUnit", _value: 680 }, vertical: { _unit: "pixelsUnit", _value: 850 } },
      smooth: false },
    { _obj: "pathPoint",
      anchor:   { _obj: "paint", horizontal: { _unit: "pixelsUnit", _value: 610 }, vertical: { _unit: "pixelsUnit", _value: 560 } },
      backward: { _obj: "paint", horizontal: { _unit: "pixelsUnit", _value: 630 }, vertical: { _unit: "pixelsUnit", _value: 700 } },
      forward:  { _obj: "paint", horizontal: { _unit: "pixelsUnit", _value: 610 }, vertical: { _unit: "pixelsUnit", _value: 560 } },
      smooth: true }
];
const minX = 610, minY = 560;   // top-left of the path's points

await action.batchPlay([{
    _obj: "make",
    _target: [{ _ref: "textLayer" }],
    using: {
        _obj: "textLayer",
        textKey: "TEXT FLOWING ON PATH",
        antiAlias: { _enum: "antiAliasType", _value: "antiAliasSharp" },
        orientation: { _enum: "orientation", _value: "horizontal" },
        textShape: [{
            _obj: "textShape",
            char: { _enum: "char", _value: "onACurve" },
            orientation: { _enum: "orientation", _value: "horizontal" },
            path: { _obj: "pathClass", pathComponents: [{
                _obj: "pathComponent",
                shapeOperation: { _enum: "shapeOperation", _value: "xor" },
                subpathListKey: [{ _obj: "subpathsList", points: pathPoints }]
            }] },
            pathTypeAlignTo: { _enum: "pathTypeAlignTo", _value: "toPathTop" },
            pathTypeAlignment: { _enum: "pathTypeAlignment", _value: "baselineAlignment" },
            pathTypeEffect: { _enum: "pathTypeEffect", _value: "rainbowEffect" },
            pathTypeSpacing: 0, pathTypeSpacingReal: 0,
            flip: false,                        // true puts the text on the other side of the path
            tRange: { _obj: "range", saturation: 0, end: pathPoints.length - 1 },
            transform: { _obj: "transform", tx: -minX, ty: -minY, xx: 1, xy: 0, yx: 0, yy: 1 },
            columnCount: 1, rowCount: 1, rowMajorOrder: true,
            columnGutter: { _unit: "pointsUnit", _value: 0 }, rowGutter: { _unit: "pointsUnit", _value: 0 },
            spacing: { _unit: "pointsUnit", _value: 0 },
            firstBaselineMinimum: { _unit: "pointsUnit", _value: 0 },
            frameBaselineAlignment: { _enum: "frameBaselineAlignment", _value: "alignByAscent" }
        }],
        textStyleRange: [{ _obj: "textStyleRange", from: 0, to: 20, textStyle: {
            _obj: "textStyle", fontPostScriptName: "Arial-BoldMT", fontName: "Arial-BoldMT", fontStyleName: "Bold",
            size: { _unit: "pointsUnit", _value: 14 }, tracking: 40,
            color: { _obj: "RGBColor", red: 255, grain: 255, blue: 255 } } }]
    }
}], {});

// The embedded path is offset by (-minX, -minY), so the layer lands at 0,0: move it back.
await doc.activeLayers[0].translate(minX, minY);
```

Afterwards `layer.textItem.contents = "New text"` keeps the path and reflows along it.

## Traps

- `char: "path"` is not an error — it is silently turned into point text. The value is
  `"onACurve"`.
- `tRange.end` is the number of segments: points − 1. The start of the range is called
  `saturation` — Photoshop's name for "start", like `grain` for green.
- The points use `backward` / `forward` handles, not the DOM's `leftDirection` /
  `rightDirection`.
